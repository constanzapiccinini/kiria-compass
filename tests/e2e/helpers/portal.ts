/**
 * Portal-context helpers for the Phase 4A tenancy specs.
 *
 * The app is only reachable through a portal embed, and the embed's
 * `portalFeatureContextToken` is the one input the test harness cannot mint. Gate
 * deliberately never returns it: it is created when a portal brick is saved, and
 * `getPortalBlock` withholds bricks and share keys. So specs that need a *successful*
 * resolution read the token from the environment, and skip with an actionable message
 * when it is absent, rather than pretending to cover ground they do not.
 *
 * Two slots, because §15's exit criterion is a cross-portal read: slot A and slot B
 * must come from two different portals bound to two different clients.
 *
 * How to obtain one: open the portal page as a member, and read the
 * `portalFeatureContextToken` query parameter from the embedded app's iframe URL.
 * Put it in `.env.<environment>` as `COMPASS_PORTAL_TOKEN_A` / `_B`.
 *
 * The token is a *portal* artifact, not a user credential — it carries no user and is
 * identical for every viewer of the page. It still belongs in the gitignored secrets
 * file rather than in a spec or a committed fixture, because possession of it plus a
 * valid session is what selects a tenant.
 */

import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { secret, type TargetEnvironment } from "./env";

export type PortalSlot = "A" | "B";

/** Header the backend reads the portal context from. Never a body field. */
export const PORTAL_HEADER = "x-portal-context";

/**
 * The portal context token for a slot, or null when it is not configured.
 *
 * Specs must branch on null with `test.skip` rather than failing: an unconfigured
 * environment is a missing fixture, not a product defect.
 */
export function portalToken(
  env: TargetEnvironment,
  slot: PortalSlot,
): string | null {
  const value = secret(env, `COMPASS_PORTAL_TOKEN_${slot}`);
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Message shown when a spec is skipped for want of a token. */
export function missingTokenReason(slot: PortalSlot): string {
  return `COMPASS_PORTAL_TOKEN_${slot} is not set — add it to .env.<environment>; see helpers/portal.ts for how to read it from the portal iframe URL`;
}

/** Headers carrying a portal context, for a request that should resolve. */
export function portalHeaders(token: string): Record<string, string> {
  return { [PORTAL_HEADER]: token };
}

/**
 * A syntactically plausible but unsigned context token.
 *
 * Deliberately shaped like the real thing — three base64url segments, real-looking
 * claims — so that a spec asserting rejection is testing Gate's signature check and
 * not merely its input validation. The claims name a genuinely existing portal, which
 * is the case that would actually be dangerous if it were ever accepted.
 */
export function forgedToken(portalId: string, workspaceId: string): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    portalId,
    workspaceId,
    iat: Math.floor(Date.now() / 1000),
  });
  // A structurally valid signature segment that was not produced by Gate's key.
  const signature = encode({ not: "a real signature" });

  return `${header}.${payload}.${signature}`;
}

/**
 * A request context bound to one portal.
 *
 * Every call carries the portal header, which is what replaces the v2 habit of
 * threading a `workspaceId` through helpers and query strings. That habit is now
 * actively harmful: a tenant id in a query or body is a `TENANCY_PROBE` and the
 * request is refused, so a helper that still passes one turns every spec using it
 * red for the wrong reason.
 *
 * Wrapping rather than creating a new Playwright context is deliberate — a fresh
 * context would not carry the signed-in session cookies.
 */
export interface PortalApi {
  readonly token: string;
  get(path: string, headers?: Record<string, string>): Promise<APIResponse>;
  post(path: string, data?: unknown): Promise<APIResponse>;
  put(path: string, data?: unknown): Promise<APIResponse>;
  patch(path: string, data?: unknown): Promise<APIResponse>;
  delete(path: string): Promise<APIResponse>;
  /** Multipart upload; the portal context still travels in the header. */
  upload(path: string, multipart: MultipartForm): Promise<APIResponse>;
}

/** One multipart field: a scalar, or a file given as bytes. */
export type MultipartField =
  | string
  | number
  | boolean
  | { name: string; mimeType: string; buffer: Buffer };

export type MultipartForm = Record<string, MultipartField>;

export function portalApi(
  request: APIRequestContext,
  token: string,
): PortalApi {
  const headers = portalHeaders(token);

  return {
    token,
    get: (path, extra = {}) =>
      request.get(path, { headers: { ...headers, ...extra } }),
    post: (path, data) =>
      request.post(path, data === undefined ? { headers } : { headers, data }),
    put: (path, data) =>
      request.put(path, data === undefined ? { headers } : { headers, data }),
    patch: (path, data) =>
      request.patch(path, data === undefined ? { headers } : { headers, data }),
    delete: (path) => request.delete(path, { headers }),
    upload: (path, multipart) => request.post(path, { headers, multipart }),
  };
}

/**
 * Open the app as the portal embed does, and wait for the shell.
 *
 * Specs must use this rather than `page.goto("/")` or `page.reload()`. `signIn`
 * lands on the app root with no portal context, so a plain reload leaves the SPA
 * context-less and it renders the portal-error screen instead of the app. The token
 * belongs in the URL because that is exactly how the platform delivers it to an
 * embed; the SPA captures it once and strips it from the visible URL.
 */
export async function openPortalApp(page: Page, token: string): Promise<void> {
  await page.goto(`/?portalFeatureContextToken=${encodeURIComponent(token)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#root", { timeout: 45_000 });
}

/** The session a portal resolves to. Replaces the v2 `firstWorkspace`. */
export interface PortalSession {
  clientId: string;
  clientName: string;
  actor: "employee" | "client";
  userId: string;
}

/**
 * Resolve the session, or skip when the caller's session is not portal-bound.
 *
 * A magic-link sign-in authenticates against the **app host**. Gate returns a
 * `userId` from `verifyPortalFeatureContextToken` only when the caller's session was
 * established **through the portal** — the `/api/portal/app-launch` launcher the
 * portal page wraps the embed in. Without that binding the backend gets a verified
 * token and no user, and refuses with `PORTAL_SESSION_ANONYMOUS`.
 *
 * That refusal is the design working, not a defect: the context token is static, has
 * no `exp`, and is served identically to every viewer, so possession of it must never
 * establish who the caller is. Any spec needing a *resolved* portal therefore needs a
 * session minted by the portal itself, which this harness cannot currently produce —
 * see PHASE-4A.md, "Portal-bound sessions".
 *
 * Skipping rather than failing keeps that gap visible without turning a harness
 * limitation into a red build. Every other failure still fails.
 */
export async function portalBoundSessionOrSkip(
  api: PortalApi,
): Promise<PortalSession> {
  const response = await api.get("/api/session");

  if (response.status() === 401) {
    const code = await errorCode(response);
    if (code === "PORTAL_SESSION_ANONYMOUS") {
      test.skip(
        true,
        "the caller's session is not portal-bound: magic-link sign-in authenticates " +
          "against the app host, while Gate returns a userId only for a session minted " +
          "through the portal launcher. Needs a portal login in the harness.",
      );
    }
  }

  expect(
    response.status(),
    `GET /api/session: ${await response.text()}`,
  ).toBe(200);

  const body = (await response.json()) as {
    client: { id: string; name: string };
    actor: "employee" | "client";
    user: { id: string };
  };
  return {
    clientId: body.client.id,
    clientName: body.client.name,
    actor: body.actor,
    userId: body.user.id,
  };
}

export async function portalSession(api: PortalApi): Promise<PortalSession> {
  const response = await api.get("/api/session");
  if (!response.ok()) {
    throw new Error(
      `GET /api/session failed: ${response.status()} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    client: { id: string; name: string };
    actor: "employee" | "client";
    user: { id: string };
  };
  return {
    clientId: body.client.id,
    clientName: body.client.name,
    actor: body.actor,
    userId: body.user.id,
  };
}

/** Body shape every error response uses, so specs assert on codes not prose. */
export interface ApiError {
  error: { code: string; message: string };
}

/** Read the machine code from an error response, or null when absent. */
export async function errorCode(response: APIResponse): Promise<string | null> {
  try {
    const body = (await response.json()) as Partial<ApiError>;
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Every tenant-selecting key the backend must refuse.
 *
 * Both spellings of each, because the SQL columns and the JSON fields differ and a
 * probe would try whichever the attacker guessed.
 */
export const TENANT_KEYS = [
  "clientId",
  "workspaceId",
  "portalId",
  "client_id",
  "workspace_id",
  "portal_id",
] as const;

/** GET a path with an arbitrary query parameter appended. */
export function getWithQuery(
  request: APIRequestContext,
  path: string,
  key: string,
  value: string,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  const separator = path.includes("?") ? "&" : "?";
  return request.get(
    `${path}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    { headers },
  );
}

/**
 * Whether this run may attempt specs that need a portal-BOUND session.
 *
 * Gate returns a `userId` for a portal context token only when the caller's session
 * was minted through the portal launcher (`/api/portal/app-launch`). A magic-link
 * sign-in authenticates against the app host instead, and Gate exposes no operation
 * to mint a portal session — which is the tenancy property working, not a gap to
 * route around. Confirmed again with an org `manager` who is a member of both
 * portals: still anonymous.
 *
 * So those specs skip. What matters is **where** they skip: checked at describe level,
 * before `signInOrSkip`, because signing in first costs a magic-link activation per
 * spec and the platform serves a limited number for one address. Ignoring that is not
 * theoretical — it produced five `waitForSelector('#root')` timeouts across unrelated
 * specs, which read as a broken deployment and were nothing of the sort.
 *
 * Set `COMPASS_PORTAL_BOUND_SESSION=1` to attempt them anyway, for the day a portal
 * session becomes obtainable. `portalBoundSessionOrSkip` still runs after sign-in as
 * the precise second check.
 */
export function portalBoundSessionAvailable(): boolean {
  return (process.env.COMPASS_PORTAL_BOUND_SESSION ?? '').trim() === '1';
}

/** The reason shown when the gate above closes a spec. */
export const PORTAL_BOUND_SESSION_REASON =
  'needs a portal-launcher session, which Gate does not expose to tests — a magic-link ' +
  'sign-in is never portal-bound. Coverage for these paths is the manual runbook, ' +
  'tests/manual/portal-isolation.md. Set COMPASS_PORTAL_BOUND_SESSION=1 to attempt anyway.';
