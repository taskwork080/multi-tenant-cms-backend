import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { adminUserCreateSchema, resetPasswordSchema } from "./dto";
import { PlatformUsersService } from "./platform-users.service";

/**
 * The forced-password-change contract.
 *
 * `app_metadata.must_change_password` is the only thing standing between "an
 * admin issued a password" and "an admin holds working credentials for someone
 * else's account". Every assertion below is a rule that looks removable in
 * isolation and is not:
 *
 *  - a password an admin picks is temporary unless a provisioning script says
 *    otherwise;
 *  - `temp` must NOT be gated on PLATFORM_ALLOW_PASSWORD_SET, or the feature is
 *    off by default in every deployment;
 *  - `set` must STAY gated, or that flag protects nothing;
 *  - `set` and `link` must CLEAR the flag, or they strand the user on
 *    /change-password with no password that will get them off it.
 */

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CTX = { actorId: "", actorEmail: "test", userAgent: "test" };
const STAFF = { id: "s1", authUserId: "auth-1", email: "user@x.test", tenantId: TENANT_ID, name: "User" };

/**
 * A drizzle-shaped transaction: every builder method chains, and awaiting the
 * chain yields the next canned result. Enough to drive create()'s two
 * transactions without a database.
 */
function fakeTx(queue: unknown[][]) {
  let i = 0;
  const node: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          const rows = queue[i++] ?? [];
          return (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
        }
        return () => node;
      },
    },
  );
  return node;
}

/** A service with every collaborator stubbed — no database is reached. */
function makeService(opts: { allowPasswordSet?: boolean; queue?: unknown[][] } = {}) {
  const supabase = {
    allowPasswordSet: opts.allowPasswordSet ?? false,
    createUser: vi.fn(async () => ({ id: "auth-1" })),
    updateUserById: vi.fn(async () => ({ id: "auth-1" })),
    generateLink: vi.fn(async () => ({ actionLink: "https://example.test/recover" })),
    findByEmail: vi.fn(async () => null),
    deleteUser: vi.fn(async () => undefined),
  };
  const tx = fakeTx(opts.queue ?? []);
  const tdb = { asPlatform: vi.fn((fn: (t: unknown) => unknown) => Promise.resolve(fn(tx))) };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { get: vi.fn(() => undefined) };

  const svc = new PlatformUsersService(tdb as never, supabase as never, audit as never, config as never);
  return { svc, supabase, audit };
}

/** The app_metadata handed to GoTrue, whichever call shape the mode used. */
function metaOf(patch: Record<string, unknown>): Record<string, unknown> {
  return (patch.app_metadata ?? patch.appMetadata ?? {}) as Record<string, unknown>;
}

function patchOf(supabase: ReturnType<typeof makeService>["supabase"]) {
  const [, patch] = supabase.updateUserById.mock.calls[0] as unknown as [string, Record<string, unknown>];
  return patch;
}

describe("resetPassword — which modes are gated, and what each does to the flag", () => {
  const forUser = (allowPasswordSet = false) => {
    const made = makeService({ allowPasswordSet });
    made.svc.load = vi.fn(async () => STAFF as never);
    return made;
  };

  it("issues a temporary password with PLATFORM_ALLOW_PASSWORD_SET off", async () => {
    const { svc, supabase } = forUser(false);
    const res = await svc.resetPassword("s1", { mode: "temp", password: "Temp1234" }, CTX as never);

    expect(res.mode).toBe("temp");
    // No link: the admin hands the password over directly.
    expect(res.actionLink).toBeNull();
    expect(supabase.generateLink).not.toHaveBeenCalled();

    const patch = patchOf(supabase);
    expect(patch.password).toBe("Temp1234");
    expect(metaOf(patch).must_change_password).toBe(true);
  });

  it("still refuses a PERMANENT password with the flag off", async () => {
    const { svc, supabase } = forUser(false);
    await expect(svc.resetPassword("s1", { mode: "set", password: "Perm1234" }, CTX as never)).rejects.toThrow(
      ForbiddenException,
    );
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it("clears the flag when a permanent password is deliberately set", async () => {
    const { svc, supabase } = forUser(true);
    await svc.resetPassword("s1", { mode: "set", password: "Perm1234" }, CTX as never);
    expect(metaOf(patchOf(supabase)).must_change_password).toBe(false);
  });

  it("clears the flag when a recovery link supersedes a pending forced change", async () => {
    const { svc, supabase } = forUser(false);
    const res = await svc.resetPassword("s1", { mode: "link" }, CTX as never);

    expect(res.actionLink).toBe("https://example.test/recover");
    const patch = patchOf(supabase);
    expect(metaOf(patch).must_change_password).toBe(false);
    // The existing password is left alone — the link is what replaces it.
    expect(patch.password).toBeUndefined();
  });

  it("records every mode under one audit action, and never the password", async () => {
    const { svc, audit } = forUser(true);
    await svc.resetPassword("s1", { mode: "temp", password: "Temp1234" }, CTX as never);

    const [, , entry] = audit.record.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(entry.action).toBe("user.reset_password");
    expect(entry.after).toEqual({ mode: "temp" });
    expect(JSON.stringify(entry)).not.toContain("Temp1234");
  });
});

describe("create — a password an admin chooses is temporary", () => {
  const base = { tenantId: TENANT_ID, name: "A", email: "a@x.test" };

  /** queue: tenant lookup, email-free check, then the staff insert. */
  const forCreate = () => {
    const made = makeService({
      queue: [[{ id: TENANT_ID, slug: "acme", name: "Acme" }], [], [{ id: "s1", email: "a@x.test", name: "A" }]],
    });
    made.svc.assertRoleInTenant = vi.fn(async () => undefined);
    made.svc.writeTenantActivity = vi.fn(async () => undefined);
    return made;
  };

  const metaSentToCreateUser = (supabase: ReturnType<typeof makeService>["supabase"]) => {
    const [input] = supabase.createUser.mock.calls[0] as unknown as [{ appMetadata: Record<string, unknown> }];
    return input.appMetadata;
  };

  it("marks a new account must-change when a password is supplied", async () => {
    const { svc, supabase } = forCreate();
    await svc.create({ ...base, password: "Temp1234" }, CTX as never);
    expect(metaSentToCreateUser(supabase).must_change_password).toBe(true);
  });

  it("does not mark an invited account — the invite link is where they pick one", async () => {
    const { svc, supabase } = forCreate();
    await svc.create({ ...base, sendInvite: true }, CTX as never);
    expect(metaSentToCreateUser(supabase).must_change_password).toBe(false);
  });

  it("lets the provisioning scripts opt out — there the operator IS the holder", async () => {
    const { svc, supabase } = forCreate();
    await svc.create({ ...base, password: "Seed1234", mustChangePassword: false }, CTX as never);
    expect(metaSentToCreateUser(supabase).must_change_password).toBe(false);
  });
});

describe("the schemas the two flows are parsed with", () => {
  const base = { tenantId: TENANT_ID, name: "A", email: "a@x.test" };

  it("defaults create to a temporary password rather than an invite", () => {
    expect(adminUserCreateSchema.parse({ ...base, password: "Temp1234" }).sendInvite).toBe(false);
  });

  it("rejects a create with neither an invite nor a password", () => {
    expect(() => adminUserCreateSchema.parse(base)).toThrow();
  });

  it("still accepts the invite path with no password", () => {
    expect(() => adminUserCreateSchema.parse({ ...base, sendInvite: true })).not.toThrow();
  });

  it("requires a password for temp as well as set", () => {
    expect(() => resetPasswordSchema.parse({ mode: "temp" })).toThrow();
    expect(() => resetPasswordSchema.parse({ mode: "set" })).toThrow();
  });

  it("keeps link the default, so an empty body is still a valid reset", () => {
    // resend-invite posts {} through this path; making temp the default would
    // turn that into a validation error.
    expect(resetPasswordSchema.parse({}).mode).toBe("link");
  });
});
