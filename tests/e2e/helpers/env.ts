/**
 * Environment-aware test harness.
 *
 * Resolves the TARGET environment for a test run and exposes everything specs
 * need: base URLs per app, test-user fixtures, and a stage assertion. The same
 * spec set runs against any environment — select it with:
 *
 *   FUSEBASE_ENV=dev npx playwright test
 *
 * Sources (all owned by the `fusebase env` tooling — do not hand-edit ids):
 *  - `environments/<name>.json` — backend, org, per-app subdomains, fixtures
 *  - `.env.<name>`              — secrets (e.g. PW_USER_<KEY>_PASSWORD)
 *  - `fusebase.json`            — app declarations (default subdomains)
 *  - `.fusebase/state.json`     — active env fallback when FUSEBASE_ENV unset
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Deadline for the harness's own fetches: clears a ~10s cold start, stays
// under CloudFront's 30s ceiling, so a hung call fails with a clear message.
const FETCH_TIMEOUT_MS = 20_000;

/**
 * The platform declined to return a magic-link URL.
 *
 * A distinct type because it is an *environment* condition rather than a product
 * defect: no spec can fix it, so specs skip on it instead of failing red forever.
 * Every other magic-link failure stays a plain Error and still fails the run.
 */
export class MagicLinkWithheldError extends Error {
  readonly name = "MagicLinkWithheldError";
}

export interface EnvFixtureUser {
  key: string;
  email: string;
  role?: string;
  /**
   * Set false when this address is known NOT to get its magic-link URL inline.
   *
   * Without it, every suite run calls `createAppMagicLink` for the fixture, the
   * platform withholds the URL and **emails the link instead**, and the spec skips
   * anyway — so the only observable effect is an unwanted email to a real inbox on
   * every run. Marking the fixture skips the call entirely: same skip, no mail.
   *
   * Flip it to true (or delete it) once that address has activated an emailed link
   * for this org, after which Gate returns URLs inline for good.
   */
  magicLinkInline?: boolean;
}

export interface EnvironmentFile {
  backend: "dev" | "prod" | "local";
  orgId: string;
  productId?: string;
  protected?: boolean;
  subdomainSuffix?: string;
  apps?: Record<
    string,
    { id?: string; subdomain?: string; stores?: Record<string, string> }
  >;
  fixtures?: { testUsers?: EnvFixtureUser[] };
}

export interface TargetEnvironment {
  name: string;
  projectRoot: string;
  config: EnvironmentFile;
  /** Parsed .env.<name> (secrets; never log values). */
  secrets: Record<string, string>;
}

/** Walk up from cwd until fusebase.json is found. */
export function findProjectRoot(startDir = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "fusebase.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "fusebase.json not found — run tests from inside a Fusebase project",
      );
    }
    dir = parent;
  }
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * Resolve the target environment: FUSEBASE_ENV > .fusebase/state.json >
 * the only environment in environments/. Fails loud otherwise — a test run
 * must never silently target the wrong stage.
 */
export function resolveTargetEnvironment(): TargetEnvironment {
  const projectRoot = findProjectRoot();
  const envsDir = join(projectRoot, "environments");
  if (!existsSync(envsDir)) {
    throw new Error(
      "environments/ not found — adopt environments first (fusebase env init)",
    );
  }
  const available = readdirSync(envsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"));

  let name = process.env.FUSEBASE_ENV;
  if (!name) {
    const statePath = join(projectRoot, ".fusebase", "state.json");
    if (existsSync(statePath)) {
      try {
        name = JSON.parse(readFileSync(statePath, "utf-8")).activeEnvironment;
      } catch {
        // fall through
      }
    }
  }
  if (!name && available.length === 1) name = available[0];
  if (!name) {
    throw new Error(
      `No target environment. Set FUSEBASE_ENV=<name> (available: ${available.join(", ")})`,
    );
  }

  const configPath = join(envsDir, `${name}.json`);
  if (!existsSync(configPath)) {
    throw new Error(
      `Environment "${name}" not found (available: ${available.join(", ")})`,
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as EnvironmentFile;

  const dotenvPath = join(projectRoot, `.env.${name}`);
  const secrets = existsSync(dotenvPath)
    ? parseDotenv(readFileSync(dotenvPath, "utf-8"))
    : {};

  return { name, projectRoot, config, secrets };
}

/**
 * Resolve a secret for the target environment. Local runs read `.env.<name>`;
 * CI has no dotenv files (they are gitignored), so process env is the
 * fallback — first with an env-name suffix for matrix jobs, then plain:
 *
 *   1. `.env.<name>` file value
 *   2. process.env[`<KEY>_<ENV_NAME>`]  (env name uppercased, "-" → "_",
 *      e.g. GATE_MCP_TOKEN_PROD_TEST)
 *   3. process.env[<KEY>]
 */
export function secret(
  env: TargetEnvironment,
  key: string,
): string | undefined {
  if (env.secrets[key]) return env.secrets[key];
  const suffix = env.name.toUpperCase().replace(/-/g, "_");
  return process.env[`${key}_${suffix}`] ?? process.env[key];
}

function appHostForBackend(backend: string): string {
  return backend === "prod" ? "thefusebase.app" : "dev-thefusebase-app.com";
}

/**
 * Every app key declared in fusebase.json (`key` > `subdomain` > `id` >
 * basename(path)). One Playwright project is generated per key so each app is
 * tested against its own URL and isolated in the report.
 */
export function listAppKeys(projectRoot: string): string[] {
  const fuseConfig = JSON.parse(
    readFileSync(join(projectRoot, "fusebase.json"), "utf-8"),
  ) as {
    apps?: Array<{ key?: string; subdomain?: string; id?: string; path?: string }>
  };
  return (fuseConfig.apps ?? [])
    .map((a) => a.key ?? a.subdomain ?? a.id ?? (a.path ? basename(a.path) : ""))
    .filter((k): k is string => k.length > 0);
}

/**
 * Base URL of an app in the target environment. `appKey` is the fusebase.json
 * app key (subdomain by default); omit it when the project has a single app.
 */
export function appBaseUrl(env: TargetEnvironment, appKey?: string): string {
  const fuseConfig = JSON.parse(
    readFileSync(join(env.projectRoot, "fusebase.json"), "utf-8"),
  ) as { apps?: Array<{ key?: string; subdomain?: string; id?: string; path?: string }> };
  const apps = fuseConfig.apps ?? [];

  const entry = appKey
    ? apps.find(
        (a) =>
          (a.key ?? a.subdomain ?? a.id ?? (a.path ? basename(a.path) : "")) ===
          appKey,
      )
    : apps[0];
  if (!entry) {
    throw new Error(`App "${appKey ?? "(first)"}" not found in fusebase.json`);
  }
  const key = entry.key ?? entry.subdomain ?? entry.id ?? basename(entry.path ?? "");

  const envApp = env.config.apps?.[key];
  const subdomain =
    envApp?.subdomain ??
    (entry.subdomain
      ? `${entry.subdomain}${env.config.subdomainSuffix ?? ""}`
      : undefined);
  if (!subdomain) {
    throw new Error(`No subdomain resolvable for app "${key}" in env "${env.name}"`);
  }
  return `https://${subdomain}.${appHostForBackend(env.config.backend)}`;
}

/**
 * Fixture user by key. Password (`PW_USER_<KEY>_PASSWORD` in .env.<name>) is
 * optional — magic-link sign-in needs no password at all.
 */
export function fixtureUser(
  env: TargetEnvironment,
  key: string,
): { email: string; password?: string; role?: string } | null {
  const user = env.config.fixtures?.testUsers?.find((u) => u.key === key);
  if (!user) return null;
  return {
    email: user.email,
    password: secret(env, `PW_USER_${key.toUpperCase()}_PASSWORD`),
    role: user.role,
  };
}

/**
 * Sign a fixture user into the app via a platform magic link — no password,
 * no mailbox: Gate's `createAppMagicLink` returns the activation URL directly
 * and the platform sets session cookies on activation.
 *
 * Requires `GATE_MCP_TOKEN` in `.env.<name>` (policy includes
 * `app_magic_link.write`; refresh stale tokens with `fusebase env tokens`).
 * NOTE: the Gate route's `:appId` is the legacy naming for today's PRODUCT id.
 *
 * ## The inline link for a new address is SINGLE USE — do not spend it on a probe
 *
 * For an address with no FuseBase account, the first call provisions the user record
 * and returns the URL inline. That provisioning is what makes every *later* call
 * withhold it: the address now has an account that has never activated a link for this
 * org. The link is always emailed as well, so the recovery is to activate the emailed
 * one once, after which URLs come back inline for good.
 *
 * The practical rule: never call this to "check whether a new fixture works". Checking
 * is what consumes it. Run the real suite — a passing sign-in *is* the check, and it
 * activates the account as a side effect.
 */
export async function createSignInMagicLink(
  env: TargetEnvironment,
  fixtureKey: string,
): Promise<{ magicLinkUrl: string; email: string }> {
  const user = env.config.fixtures?.testUsers?.find(
    (u) => u.key === fixtureKey,
  );
  if (!user) {
    throw new Error(
      `fixture "${fixtureKey}" not configured for env "${env.name}"`,
    );
  }
  // Refuse before calling, when the environment already records that this address
  // does not get its URL inline. The call would withhold the URL and email the link,
  // so making it costs a real inbox an email per suite run and changes nothing about
  // the outcome: the spec skips either way.
  if (user.magicLinkInline === false) {
    throw new MagicLinkWithheldError(
      `fixture "${fixtureKey}" (${user.email}) is marked magicLinkInline:false in ` +
        `environments/${env.name}.json, so no magic link was requested — the platform ` +
        `would have withheld the URL and emailed the link instead. Have that address ` +
        `activate one emailed link for org "${env.config.orgId}" and then set ` +
        `magicLinkInline: true, or point the fixture at an address with no FuseBase account.`,
    );
  }

  const gateToken = secret(env, "GATE_MCP_TOKEN");
  if (!gateToken) {
    throw new Error(
      `GATE_MCP_TOKEN missing for env "${env.name}" — locally run ` +
        `\`fusebase env tokens --env ${env.name}\`; in CI set the ` +
        `GATE_MCP_TOKEN_${env.name.toUpperCase().replace(/-/g, "_")} variable`,
    );
  }
  // Platform host derives from the env's backend — never from build-time or
  // dotenv values (CI has no dotenv files).
  const host =
    env.config.backend === "prod" ? "thefusebase.com" : "dev-thefusebase.com";
  if (!env.config.productId) {
    throw new Error(
      `environment "${env.name}" has no productId — deploy it first`,
    );
  }
  const res = await fetch(
    `https://app-api.${host}/v4/api/proxy/gate-service/v1/${env.config.orgId}/apps/${env.config.productId}/magic-links`,
    {
      method: "POST",
      headers: {
        "x-gate-token": gateToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: user.email }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `createAppMagicLink failed: ${res.status} ${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { magicLinkUrl?: string };
  if (!data.magicLinkUrl) {
    // NIM-42663 / NIM-43179: the platform emails the link instead of returning it
    // whenever the address already has a FuseBase account that has never activated a
    // magic link for this org, so nobody can mint a session for someone else's
    // account.
    //
    // Org membership alone is NOT enough — an org *owner* is withheld just the same.
    // An earlier version of this message said the account was "outside the org" and
    // advised adding it, which is misleading: the advice is already satisfied for
    // every fixture in this project and following it does not help.
    throw new MagicLinkWithheldError(
      `createAppMagicLink withheld the link for "${user.email}". The platform ` +
        `returns a URL only for an address with no FuseBase account, or one that has ` +
        `already activated a link for org "${env.config.orgId}"; it emails the link ` +
        `otherwise. Being an org member — owner included — does not lift this. ` +
        `Either use a brand-new address as the fixture, or have this recipient ` +
        `activate an emailed link once so subsequent runs are returned inline.`,
    );
  }
  return { magicLinkUrl: data.magicLinkUrl, email: user.email };
}

/**
 * Shape of `fusebase-env.json` baked into every environment-aware deploy
 * (also available synchronously as `window.__FUSEBASE_ENV__`).
 */
export interface DeployedEnvInfo {
  env: string;
  backend: string;
  orgId: string;
  appId?: string;
  protected?: boolean;
}

/**
 * Fetch the deployed bundle's env info. Specs MUST assert
 * `info.env === env.name` before doing anything else — cheap protection
 * against pointing a run at the wrong stage.
 */
export async function fetchDeployedEnvInfo(
  baseUrl: string,
): Promise<DeployedEnvInfo | null> {
  try {
    const res = await fetch(`${baseUrl}/fusebase-env.json`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as DeployedEnvInfo;
  } catch (err) {
    // A timeout is NOT "no env info" — report it, otherwise a cold/hung
    // backend is misread as a bundle deployed without environment mode.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `${baseUrl}/fusebase-env.json did not answer within ${FETCH_TIMEOUT_MS}ms ` +
          `— cold backend beyond the expected start-up, or the app is down`,
      );
    }
    return null;
  }
}
