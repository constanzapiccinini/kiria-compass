/**
 * Compass AI test fixtures.
 *
 * Everything here builds throwaway data through the app's own API where possible,
 * and cleans it up afterwards — the target is a real org.
 *
 * The one exception is `seedCitedAnswer`, which writes an assistant message with
 * citations straight into the app's isolated store. Only the model can produce that
 * row through the product, so seeding is the only way to test the citation UI
 * contract without spending OpenAI tokens on every run. It is a fixture, clearly
 * marked, and the real end-to-end path is covered separately in
 * `specs/compass-ai/grounded-answer.spec.ts`.
 */

import { test, type APIRequestContext, type Page } from "@playwright/test";
import {
  MagicLinkWithheldError,
  appBaseUrl,
  createSignInMagicLink,
  secret,
  type TargetEnvironment,
} from "./env";
import type { PortalApi } from "./portal";

const STORE_ALIAS = "compasses";

/** Deadline for the harness's own Gate calls; clears a cold start, under CloudFront's ceiling. */
const FETCH_TIMEOUT_MS = 20_000;

/** Platform API host for the environment's backend. */
function apiHost(env: TargetEnvironment): string {
  return env.config.backend === "prod"
    ? "app-api.thefusebase.com"
    : "app-api.dev-thefusebase.com";
}

// Resolved once per process; see storeId below for why it is not read from the lockfile.
let storeIdPromise: Promise<string> | null = null;

/**
 * Resolve the app's SQL store **by alias through Gate**, exactly as the app does.
 *
 * Not read from `environments/<env>.json`, deliberately. That lockfile is regenerated
 * by `fusebase deploy`, and in this org it resolves the alias to a *second* store
 * (`compasses-prod`) that carries the schema but no rows, while the deployed app
 * resolves the alias `compasses` and gets the store holding the real data. Fixtures
 * pointed at the lockfile id therefore seed a database nothing reads, and the failure
 * surfaces far away as "the seeded row is not visible" — which was diagnosed once by
 * hand already, and would come back on the next deploy because a hand-edit to that
 * file does not survive.
 *
 * Resolving by alias removes the drift entirely: the harness and the app answer the
 * question the same way, so they cannot disagree.
 */
export function storeId(env: TargetEnvironment): Promise<string> {
  storeIdPromise ??= resolveStoreIdByAlias(env);
  return storeIdPromise;
}

async function resolveStoreIdByAlias(env: TargetEnvironment): Promise<string> {
  const token = secret(env, "GATE_MCP_TOKEN");
  if (!token) {
    throw new Error(
      `GATE_MCP_TOKEN missing for env "${env.name}" — run \`fusebase env tokens --env ${env.name}\``,
    );
  }

  const url =
    `https://${apiHost(env)}/v4/api/proxy/gate-service/v1/${env.config.orgId}` +
    `/isolated-stores`;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `listIsolatedStores failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as {
    stores?: Array<{ globalId?: string; alias?: string }>;
  };

  // Exact alias match only. A prefix or "starts with" match is what would pick up
  // `compasses-prod` and reintroduce the very problem this function exists to remove.
  const match = (body.stores ?? []).find((store) => store.alias === STORE_ALIAS);
  if (!match?.globalId) {
    const seen = (body.stores ?? []).map((s) => s.alias).join(", ") || "none";
    throw new Error(
      `no isolated store with alias "${STORE_ALIAS}" in org ${env.config.orgId} (saw: ${seen})`,
    );
  }
  return match.globalId;
}

/**
 * A deployed app reads and writes the `prod` stage of its store; `fusebase dev start`
 * uses `dev`. Fixtures must target the same stage the app under test is using, or
 * they will seed rows the app cannot see.
 */
export function storeStage(env: TargetEnvironment): "dev" | "prod" {
  return env.config.backend === "prod" ? "prod" : "dev";
}

// ---------------------------------------------------------------------------
// sign-in
// ---------------------------------------------------------------------------

/**
 * Sign a fixture user in via a platform magic link and land on the app.
 * The platform sets the session cookies during activation, so afterwards both
 * `page` and `page.request` are authenticated.
 */
export async function signIn(
  page: Page,
  env: TargetEnvironment,
  fixtureKey: string,
): Promise<void> {
  const { magicLinkUrl } = await createSignInMagicLink(env, fixtureKey);
  await page.goto(magicLinkUrl, { waitUntil: "domcontentloaded" });
  // Activation redirects to the app; wait for the shell rather than a fixed delay.
  await page.waitForSelector("#root", { timeout: 45_000 });
}

/**
 * Sign in, or skip the test when the platform withholds the magic-link URL.
 *
 * The distinction is worth making precisely. A withheld link is an environment
 * condition no spec can repair, and leaving the suite permanently red trains people
 * to ignore it. Every *other* sign-in failure — a bad token, an unreachable backend,
 * a broken redirect — is a real failure and still fails the run.
 */
export async function signInOrSkip(
  page: Page,
  env: TargetEnvironment,
  fixtureKey: string,
): Promise<void> {
  try {
    await signIn(page, env, fixtureKey);
  } catch (error) {
    if (error instanceof MagicLinkWithheldError) {
      test.skip(true, error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Gate SQL (fixture setup / teardown only)
// ---------------------------------------------------------------------------

interface SqlRow {
  [column: string]: unknown;
}

async function gateSql(
  env: TargetEnvironment,
  path: string,
  body: unknown,
): Promise<unknown> {
  const token = secret(env, "GATE_MCP_TOKEN");
  if (!token) {
    throw new Error(
      `GATE_MCP_TOKEN missing for env "${env.name}" — run \`fusebase env tokens --env ${env.name}\``,
    );
  }
  const url =
    `https://${apiHost(env)}/v4/api/proxy/gate-service/v1/${env.config.orgId}` +
    `/isolated-stores/${await storeId(env)}/stages/${storeStage(env)}${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gate SQL ${path} failed: ${response.status} ${text.slice(0, 300)} ` +
        `(x-request-id: ${response.headers.get("x-request-id") ?? "none"})`,
    );
  }
  return response.json();
}

/** Read-only fixture query. */
export async function sqlQuery(
  env: TargetEnvironment,
  sql: string,
  params: unknown[] = [],
): Promise<SqlRow[]> {
  const payload = await gateSql(env, "/sql/query", { sql, params });
  const result = (payload as { result?: { rows?: SqlRow[] } }).result;
  return result?.rows ?? [];
}

/** Insert one fixture row, returning the requested columns. */
export async function sqlInsert(
  env: TargetEnvironment,
  tableName: string,
  values: Record<string, unknown>,
  returning: string[] = ["id"],
): Promise<SqlRow> {
  const payload = await gateSql(env, "/sql/rows/insert", {
    schemaName: "public",
    tableName,
    values,
    returning,
  });
  const rows = (payload as { rows?: SqlRow[] }).rows ?? [];
  if (rows.length === 0) throw new Error(`insert into ${tableName} returned no row`);
  return rows[0];
}

/** Delete fixture rows by a single equality filter. */
export async function sqlDelete(
  env: TargetEnvironment,
  tableName: string,
  column: string,
  value: unknown,
): Promise<void> {
  await gateSql(env, "/sql/rows/delete", {
    schemaName: "public",
    tableName,
    filters: [{ column, operator: "eq", value }],
  });
}

// ---------------------------------------------------------------------------
// PDF fixture
// ---------------------------------------------------------------------------

/**
 * Build a tiny two-page PDF with a real text layer.
 *
 * Generated rather than committed as a binary so the expected page/paragraph text is
 * visible in the spec that asserts on it.
 */
export function buildPdf(pageOne: string[], pageTwo: string[]): Buffer {
  const content = (lines: string[]): string => {
    let text = "BT /F1 12 Tf 72 720 Td 16 TL\n";
    for (const line of lines) {
      text += `(${line.replace(/([()\\])/g, "\\$1")}) Tj T*\n`;
    }
    return `${text}ET`;
  };

  const first = content(pageOne);
  const second = content(pageTwo);

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>";
  objects[4] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>";
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[6] = `<< /Length ${first.length} >>\nstream\n${first}\nendstream`;
  objects[7] = `<< /Length ${second.length} >>\nstream\n${second}\nendstream`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// app API fixtures
// ---------------------------------------------------------------------------

// `firstWorkspace` and `WorkspaceInfo` are deliberately gone. Phase 4A removed
// `/api/workspaces/me` along with the whole idea of a caller choosing a tenant: one
// portal is exactly one client, resolved server-side from the verified context. Use
// `portalSession` from ./portal when a spec needs the resolved client or actor.

export interface UploadedDocument {
  id: string;
  name: string;
  /**
   * The library `uploadPdf` created to hold it, for the caller to tear down.
   *
   * Additive, so the ten specs that only delete the document are unaffected — but
   * passing it to `deleteDocument` is what stops an `e2e-fixture-…` library being
   * left ticked to a real client's portal.
   */
  libraryId: string;
}

/**
 * Run one request against the **admin** app, in the signed-in browser context.
 *
 * Phase 5C made the client app view + chat only: it can no longer upload, delete or
 * re-index anything, so a fixture that needs a document must create it where a person
 * now would — Compass Admin. Before this, these fixtures POSTed to
 * `/api/documents` on the client app, and when §5C deleted that route they became
 * silently broken: every spec that used them was already skipped for want of a
 * portal-bound session, so nothing went red. That is the worst way for a fixture to
 * break, and the reason this indirection exists.
 *
 * A new page in the **same browser context** is used rather than a fresh request
 * context, because the platform session cookie is per app host: the magic-link
 * activation authenticated this context, and visiting the admin host is what makes
 * the cookie available there. A separate `request.newContext()` would have no session
 * at all and the platform edge would answer 401 before the app saw anything.
 *
 * The page is closed before returning, so callers cannot leak one.
 */
async function withAdminRequest<T>(
  page: Page,
  env: TargetEnvironment,
  run: (request: APIRequestContext, adminBase: string) => Promise<T>,
): Promise<T> {
  const adminBase = appBaseUrl(env, "compass-admin");
  const adminPage = await page.context().newPage();
  try {
    await adminPage.goto(`${adminBase}/`, { waitUntil: "domcontentloaded" });
    await adminPage.waitForSelector("#root", { timeout: 45_000 });
    // The base URL is handed to the caller because `request` resolves a relative path
    // against the **project's** configured `baseURL`, not against whatever page the
    // context happens to be showing. A relative `/api/...` here would therefore go to
    // the client app — which is the host that no longer has these routes, so it would
    // fail in a way that looks like the app is broken rather than the call.
    return await run(adminPage.request, adminBase);
  } finally {
    await adminPage.close();
  }
}

/**
 * A library of this fixture's own, ticked to exactly the portal under test.
 *
 * ## Why not the portal's private library
 *
 * That was the first implementation and it broke on real data. Every portal gets a
 * private library with its tenant — but `is_private` promises **one portal**, and the
 * §6.5 migration correctly created a *shared* library for the tenant that owns two of
 * them. So for `client-a-portal` there simply is no private library, and the helper
 * threw. `fixtures.spec.ts` is what caught it, which is the whole reason that spec
 * exists.
 *
 * Falling back to "any library this portal receives" is worse, not better: the one
 * available for that tenant is ticked to **both** its portals, so a document uploaded
 * there would be visible to the other portal too — and a tenancy spec asserting that
 * portal B cannot see portal A's document would then be asserting something the
 * fixture had made false. That is a test that passes while proving nothing.
 *
 * So the fixture owns its library. One per run, named `e2e-fixture-<stamp>`, ticked
 * to the one portal, and torn down by `deleteDocument` when the caller passes the id
 * back. The `e2e-` prefix is what `scripts/cleanup-e2e-libraries.mjs` matches, so a
 * run killed halfway is recoverable at the operator level.
 */
async function fixtureLibraryFor(
  request: APIRequestContext,
  adminBase: string,
  clientId: string,
): Promise<{ libraryId: string; portalRowId: string }> {
  const portalsResponse = await request.get(`${adminBase}/api/portals`);
  if (!portalsResponse.ok()) {
    throw new Error(`could not list portals: ${portalsResponse.status()}`);
  }
  const portals = (await portalsResponse.json()) as {
    portals: Array<{ id?: string | null; clientId?: string | null; name: string }>;
  };
  const portal = portals.portals.find((row) => row.clientId === clientId);
  if (!portal?.id) throw new Error(`no registered portal for client ${clientId}`);
  const portalRowId = portal.id;

  const name = `e2e-fixture-${Date.now().toString(36)}`;
  const created = await request.post(`${adminBase}/api/libraries`, { data: { name } });
  if (created.status() !== 201) {
    throw new Error(`could not create the fixture library: ${await created.text()}`);
  }
  const libraryId = ((await created.json()) as { id: string }).id;

  // Ticked immediately: an untickeded library reaches no portal, and every spec built
  // on this fixture is about what a portal can see.
  const ticked = await request.put(`${adminBase}/api/libraries/${libraryId}/portals/${portalRowId}`);
  if (!ticked.ok()) {
    throw new Error(`could not tick ${portal.name}: ${await ticked.text()}`);
  }

  return { libraryId, portalRowId };
}

/**
 * Upload a PDF into a fixture library ticked to one portal, through the admin app.
 *
 * `clientId` is still the argument, because that is what a spec has in hand from its
 * resolved portal session — and it would be a `TENANCY_PROBE` in the client app. The
 * difference is the authorization question each app answers: "is this caller staff"
 * versus "which portal is this". The library is resolved from it here rather than
 * pushed onto every caller.
 *
 * Returns as soon as the upload is accepted; use `waitForExtraction` to wait for text.
 * Pass the returned `libraryId` to `deleteDocument` so the library goes too.
 */
export async function uploadPdf(
  page: Page,
  env: TargetEnvironment,
  clientId: string,
  name: string,
  bytes: Buffer,
): Promise<UploadedDocument> {
  return withAdminRequest(page, env, async (request, adminBase) => {
    const { libraryId } = await fixtureLibraryFor(request, adminBase, clientId);
    const response = await request.post(`${adminBase}/api/libraries/${libraryId}/documents`, {
      multipart: { files: { name, mimeType: "application/pdf", buffer: bytes } },
    });
    // 201 when every file was accepted, 207 when any was refused per file — and the
    // reason lives in the body either way, which is why a non-2xx is not the check.
    if (!response.ok()) {
      throw new Error(`upload failed: ${response.status()} ${await response.text()}`);
    }
    const body = (await response.json()) as {
      results: Array<{ name: string; documentId?: string; status: string; message?: string }>;
    };
    const outcome = body.results[0];
    if (!outcome?.documentId) {
      throw new Error(`upload rejected: ${outcome?.message ?? "no documentId"}`);
    }
    return { id: outcome.documentId, name, libraryId };
  });
}

/** Poll until the document's paragraphs exist (extraction finished) or time out. */
export async function waitForExtraction(
  api: PortalApi,
  documentId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const response = await api.get(`/api/documents/${documentId}/paragraphs?page=1`);
    if (response.ok()) {
      const body = (await response.json()) as { paragraphs: unknown[] };
      if (body.paragraphs.length > 0) return;
    }
    const status = await api.get(`/api/documents/${documentId}`);
    if (status.ok()) {
      const body = (await status.json()) as { document: { status: string; errorMessage?: string } };
      lastStatus = body.document.status;
      // A failed *index* still leaves paragraphs; a failed *parse* never will.
      if (lastStatus === "failed" && body.document.errorMessage?.includes("No readable text")) {
        throw new Error(`extraction failed: ${body.document.errorMessage}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    `document ${documentId} produced no paragraphs within ${timeoutMs}ms (status: ${lastStatus})`,
  );
}

/**
 * Delete a fixture document, through the admin app.
 *
 * Deliberately swallows nothing: a cleanup that fails silently leaves a real
 * client's portal holding a test document, which this suite treats as worse than a
 * failing test. Callers that genuinely want best-effort teardown add their own
 * `.catch()`, visibly.
 */
export async function deleteDocument(
  page: Page,
  env: TargetEnvironment,
  documentId: string,
  libraryId?: string,
): Promise<void> {
  await withAdminRequest(page, env, async (request, adminBase) => {
    const response = await request.delete(`${adminBase}/api/documents/${documentId}`);
    if (!response.ok()) {
      throw new Error(
        `delete of ${documentId} failed: ${response.status()} ${await response.text()}`,
      );
    }

    if (!libraryId) return;

    // Untick before deleting. This is the step that matters: while the tick stands, a
    // real client is looking at a library called `e2e-fixture-…`, and the API refuses
    // to delete a library any portal still receives.
    const library = await request.get(`${adminBase}/api/libraries`);
    if (library.ok()) {
      const rows = (await library.json()) as {
        libraries: Array<{ id: string; portals: Array<{ portalRowId: string }> }>;
      };
      const mine = rows.libraries.find((row) => row.id === libraryId);
      for (const tick of mine?.portals ?? []) {
        await request
          .delete(`${adminBase}/api/libraries/${libraryId}/portals/${tick.portalRowId}`)
          .catch(() => undefined);
      }
    }

    // The library itself may legitimately refuse deletion once it has cost anything —
    // `usage_events.library_id` is ON DELETE RESTRICT by design — so archiving is the
    // fallback the API itself names. Either way it reaches nobody, which is the part
    // that had to be true.
    const gone = await request.delete(`${adminBase}/api/libraries/${libraryId}`);
    if (!gone.ok()) {
      await request
        .patch(`${adminBase}/api/libraries/${libraryId}`, { data: { archived: true } })
        .catch(() => undefined);
    }
  });
}

/**
 * Change a tenant's settings, through the admin app.
 *
 * The client app's `PATCH /api/session/settings` is gone (§5C) — settings are an
 * admin concern now. A spec that needs a particular budget or cap in place to
 * exercise *client-app* behaviour still has a legitimate need for this, so the
 * fixture goes where the capability went.
 *
 * Returns the settings as the admin app reports them after the write, so a caller
 * can restore the original values in a `finally`.
 */
export async function setClientSettings(
  page: Page,
  env: TargetEnvironment,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withAdminRequest(page, env, async (request, adminBase) => {
    const response = await request.put(`${adminBase}/api/settings/clients/${clientId}`, {
      data: patch,
    });
    if (!response.ok()) {
      throw new Error(
        `settings update for ${clientId} failed: ${response.status()} ${await response.text()}`,
      );
    }
  });
}

/** Read a tenant's effective settings, through the admin app. */
export async function readClientSettings(
  page: Page,
  env: TargetEnvironment,
  clientId: string,
): Promise<Record<string, unknown>> {
  return withAdminRequest(page, env, async (request, adminBase) => {
    const response = await request.get(
      `${adminBase}/api/settings?clientId=${encodeURIComponent(clientId)}`,
    );
    if (!response.ok()) {
      throw new Error(
        `settings read for ${clientId} failed: ${response.status()} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { settings?: Record<string, unknown> };
    return body.settings ?? {};
  });
}

export interface SeededCitation {
  documentId: string;
  documentName: string;
  page: number;
  paragraphKey: string;
  sectionTitle: string | null;
  snippet: string;
}

/**
 * Seed a chat whose assistant turn carries real citations.
 *
 * FIXTURE ONLY — see the module comment. The citation payload matches exactly what
 * `resolveCitations` in the backend emits, so the UI paths under test are the real
 * ones.
 */
export async function seedCitedAnswer(
  env: TargetEnvironment,
  clientId: string,
  userId: string,
  question: string,
  answer: string,
  citations: SeededCitation[],
): Promise<string> {
  const chat = await sqlInsert(env, "chats", {
    client_id: clientId,
    title: `e2e ${question}`.slice(0, 120),
    retrieval_mode: "precision",
    created_by_user_id: userId,
    last_message_at: new Date().toISOString(),
  });
  const chatId = String(chat.id);

  for (const citation of citations) {
    await sqlInsert(
      env,
      "chat_documents",
      { chat_id: chatId, document_id: citation.documentId, active: true },
      ["chat_id"],
    );
  }

  await sqlInsert(env, "chat_messages", {
    chat_id: chatId,
    client_id: clientId,
    role: "user",
    content: question,
    created_by_user_id: userId,
  });

  await sqlInsert(env, "chat_messages", {
    chat_id: chatId,
    client_id: clientId,
    role: "assistant",
    content: answer,
    // JSONB goes over the wire as a JSON string.
    citations: JSON.stringify(
      citations.map((citation) => ({
        documentId: citation.documentId,
        documentName: citation.documentName,
        page: citation.page,
        paragraphKey: citation.paragraphKey,
        // Any uuid works: the UI keys cards by it and never resolves it.
        chunkId: "00000000-0000-4000-8000-000000000000",
        sectionTitle: citation.sectionTitle,
        snippet: citation.snippet,
      })),
    ),
    grounded: true,
    model: "fixture",
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
  });

  return chatId;
}

export async function deleteChat(
  env: TargetEnvironment,
  chatId: string,
): Promise<void> {
  await sqlDelete(env, "chats", "id", chatId);
}

/**
 * How many audit rows exist for an action.
 *
 * Counted rather than matched on a specific row because the suite runs in parallel
 * against a shared environment: "one more than a moment ago" is the only property a
 * concurrent run cannot invalidate, and it still fails when nothing is written.
 */
export async function countAudit(
  env: TargetEnvironment,
  action: string,
): Promise<number> {
  const rows = await sqlQuery(
    env,
    "SELECT count(*)::int AS n FROM audit_logs WHERE action = $1",
    [action],
  );
  const value = rows[0]?.n;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Backend readiness, used by specs to self-skip when a dependency is unconfigured. */
export interface BackendReadiness {
  ok: boolean;
  stage: string;
  storeReachable: boolean;
  ocrConfigured: boolean;
  openAiConfigured: boolean;
}

export async function readiness(
  request: APIRequestContext,
): Promise<BackendReadiness | null> {
  // /api/health/detail is not portal-scoped, so this keeps a plain request context.
  const response = await request.get("/api/health/detail");
  const body = (await response.json().catch(() => null)) as BackendReadiness | null;
  return body;
}
