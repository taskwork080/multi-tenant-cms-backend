import { ENV } from "./env";
import { tokenFor } from "./token";

/**
 * HTTP client for the QA suite.
 *
 * The whole suite comes from one IP and the server's ThrottlerGuard is
 * ttl:60_000 / limit:300 (app.module.ts). A self-imposed budget below that
 * keeps a long run from tripping the limiter and turning real assertions into
 * 429 noise. 99-throttler.spec.ts opts out via `noRetry` because exceeding the
 * limit is the thing it asserts.
 */

const BUDGET_PER_MIN = 240;
const WINDOW_MS = 60_000;
const stamps: number[] = [];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reserveSlot() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
    if (stamps.length < BUDGET_PER_MIN) {
      stamps.push(now);
      return;
    }
    await sleep(WINDOW_MS - (now - stamps[0]) + 50);
  }
}

export type Actor = { email: string; password: string } | { token: string } | null;

export type Res<T = any> = {
  status: number;
  ok: boolean;
  body: T;
  headers: Headers;
  /** Server-supplied error code (`CAPABILITY_REQUIRED`, `TENANT_SUSPENDED`, ...). */
  code?: string;
  message?: string;
};

export type ReqOpts = {
  as?: Actor;
  body?: unknown;
  headers?: Record<string, string>;
  /** Disables the single 429 retry — only 99-throttler.spec.ts sets this. */
  noRetry?: boolean;
};

async function authHeader(as: Actor): Promise<Record<string, string>> {
  if (!as) return {};
  if ("token" in as) return { Authorization: `Bearer ${as.token}` };
  return { Authorization: `Bearer ${await tokenFor(as.email, as.password)}` };
}

export async function req<T = any>(method: string, path: string, opts: ReqOpts = {}): Promise<Res<T>> {
  const url = path.startsWith("http") ? path : `${ENV.apiUrl}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(await authHeader(opts.as ?? null)),
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const send = async (): Promise<Response> => {
    await reserveSlot();
    return fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

  let res = await send();
  if (res.status === 429 && !opts.noRetry) {
    const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 5_000;
    console.warn(`[qa] 429 on ${method} ${path} — waiting ${wait}ms and retrying once`);
    await sleep(wait);
    res = await send();
  }

  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON responses stay as text so failures are readable */
  }

  return {
    status: res.status,
    ok: res.ok,
    body,
    headers: res.headers,
    code: body?.code ?? body?.error?.code,
    message: typeof body?.message === "string" ? body.message : undefined,
  };
}

export const GET = <T = any>(p: string, o: ReqOpts = {}) => req<T>("GET", p, o);
export const POST = <T = any>(p: string, o: ReqOpts = {}) => req<T>("POST", p, o);
export const PATCH = <T = any>(p: string, o: ReqOpts = {}) => req<T>("PATCH", p, o);
export const PUT = <T = any>(p: string, o: ReqOpts = {}) => req<T>("PUT", p, o);
export const DEL = <T = any>(p: string, o: ReqOpts = {}) => req<T>("DELETE", p, o);

/** Polls until `fn` returns true — used for the 30s AccessService cache windows. */
export async function until(
  fn: () => Promise<boolean>,
  { timeout = 45_000, interval = 2_000, label = "condition" } = {},
): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - start;
    if (Date.now() - start > timeout) throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
    await sleep(interval);
  }
}
