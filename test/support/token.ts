import { ENV, artifactPath } from "./env";
import fs from "node:fs";

/**
 * Supabase password-grant tokens, cached in two tiers.
 *
 * The caching is a CORRECTNESS requirement, not an optimization: GoTrue
 * rate-limits password grants per IP (~30 per 5 minutes). The suite drives 11
 * QA accounts, so uncached logins would 429 the auth server and the failures
 * would present as "invalid credentials" — a false red that costs an hour to
 * diagnose. One token per account per hour is the budget.
 */

type Session = { access_token: string; refresh_token: string; expires_at: number };

const L1 = new Map<string, Session>();
const L2_FILE = "tokens.json";
const REFRESH_MARGIN_S = 120;

/**
 * The index signature is `| undefined` deliberately: a miss on this map is the
 * normal case (first login of a run), and typing it as always-present makes the
 * `fresh()` guard narrow the miss branch to `never`, so reading the refresh
 * token off it — the whole point of the L2 tier — stops type-checking.
 */
function loadL2(): Record<string, Session | undefined> {
  const p = artifactPath(L2_FILE);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveL2(all: Record<string, Session | undefined>) {
  fs.writeFileSync(artifactPath(L2_FILE), JSON.stringify(all, null, 2));
}

/**
 * Returns a plain boolean, NOT a `s is Session` type predicate.
 *
 * A predicate would read better at the call sites but narrows wrongly: `false`
 * from this function overwhelmingly means "present but EXPIRED", while
 * `!(s is Session)` tells the compiler the value is `undefined` for the whole
 * rest of the scope — which is precisely the branch that needs to read the
 * expired session's refresh_token.
 */
const fresh = (s: Session | undefined): boolean =>
  !!s && s.expires_at - Math.floor(Date.now() / 1000) > REFRESH_MARGIN_S;

async function grant(body: Record<string, string>, type: "password" | "refresh_token"): Promise<Session> {
  const res = await fetch(`${ENV.supabaseUrl}/auth/v1/token?grant_type=${type}`, {
    method: "POST",
    headers: { apikey: ENV.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    throw new Error(`Supabase ${type} grant failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return {
    access_token: String(json.access_token),
    refresh_token: String(json.refresh_token ?? ""),
    expires_at: Number(json.expires_at ?? Math.floor(Date.now() / 1000) + 3600),
  };
}

/** Returns a valid access token for `email`, minting or refreshing only if needed. */
export async function tokenFor(email: string, password: string): Promise<string> {
  const key = email.toLowerCase();

  if (fresh(L1.get(key))) return L1.get(key)!.access_token;

  const l2 = loadL2();
  // Bound to a local rather than re-indexed so the expired session below is
  // still reachable — see `fresh`.
  const cached = l2[key];
  if (cached && fresh(cached)) {
    L1.set(key, cached);
    return cached.access_token;
  }

  // A stale-but-present session can usually be refreshed without spending a
  // password grant against the rate limit.
  let session: Session | null = null;
  if (cached?.refresh_token) {
    try {
      session = await grant({ refresh_token: cached.refresh_token }, "refresh_token");
    } catch {
      session = null;
    }
  }
  session ??= await grant({ email, password }, "password");

  L1.set(key, session);
  l2[key] = session;
  saveL2(l2);
  return session.access_token;
}

/** Drops a cached session — used after a password change invalidates it. */
export function forgetToken(email: string) {
  const key = email.toLowerCase();
  L1.delete(key);
  const l2 = loadL2();
  delete l2[key];
  saveL2(l2);
}

/** Decodes a JWT payload without verifying — for asserting claims in tests. */
export function decodeClaims(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}
