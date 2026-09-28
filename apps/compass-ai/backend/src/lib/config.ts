/**
 * Runtime configuration for the Compass AI backend.
 *
 * Platform-resolved identifiers (orgId, store alias) are NOT secrets and are not
 * read from `fusebase secret`. Real credentials (OpenAI, AWS) are secrets and come
 * from `process.env` after `fusebase secret create`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Stage = 'dev' | 'prod'

/** Stable alias of the FuseBase PostgreSQL Database backing this app. */
export const STORE_ALIAS = 'compasses'

/** Embedding model + dimensionality. 256 dims is a deliberate choice — see docs. */
export const EMBEDDING_MODEL = 'text-embedding-3-large'
export const EMBEDDING_DIMENSIONS = 256

/** Chat model. Temperature stays in the deterministic 0.0-0.2 band. */
export const CHAT_MODEL = 'gpt-4.1-mini'
export const CHAT_TEMPERATURE = 0.1

/** Chunking: ~400 tokens with ~15% overlap keeps paragraphs coherent and citable. */
export const CHUNK_TARGET_TOKENS = 400
export const CHUNK_OVERLAP_TOKENS = 60
export const CHUNK_MIN_TOKENS = 24

/** Retrieval defaults per mode; client settings can tighten the token budget. */
export const RETRIEVAL_PRESETS = {
  precision: { candidateK: 60, topK: 10, minScore: 0.18 },
} as const

/**
 * Published prices (USD) used for cost metering. Kept in code, not the database,
 * so historical usage rows keep the cost that was computed at the time.
 */
export const PRICING = {
  'text-embedding-3-large': { inputPerMillion: 0.13, outputPerMillion: 0 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  textract: { perPage: 0.0015 },
} as const

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim()
  return out && out.length > 0 ? out : undefined
}

/** Required secret/env value; throws with an actionable message when absent. */
function required(name: string): string {
  const value = trimmed(process.env[name])
  if (!value) {
    throw new Error(
      `${name} is not configured. Register it with: fusebase secret create --app apps/compass-ai --secret "${name}:<description>"`,
    )
  }
  return value
}

/**
 * Gate token for backend calls.
 *   deployed  -> FBS_FEATURE_TOKEN (sent as x-app-feature-token)
 *   local dev -> GATE_MCP_TOKEN    (sent as Authorization: Bearer)
 */
export interface GateAuth {
  token: string
  transport: 'feature' | 'bearer'
}

export function serviceGateAuth(): GateAuth {
  const featureToken = trimmed(process.env.FBS_FEATURE_TOKEN)
  if (featureToken) return { token: featureToken, transport: 'feature' }

  const devToken = trimmed(process.env.GATE_MCP_TOKEN)
  if (devToken) return { token: devToken, transport: 'bearer' }

  throw new Error(
    'No Gate service token in env (expected FBS_FEATURE_TOKEN on deploy, GATE_MCP_TOKEN in local dev)',
  )
}

interface ProjectConfig {
  orgId?: string
  productId?: string
  appId?: string
}

let projectConfig: ProjectConfig | null = null

/**
 * Read `orgId` / `productId` from the project's `fusebase.json`.
 *
 * These are public configuration, not secrets, and the platform injects them as
 * `FBS_ORG_ID` / `FBS_PRODUCT_ID` only on a real deploy. `fusebase dev start` does
 * not, so local dev reads the same values from the file the CLI already owns —
 * registering them as app secrets would be wrong.
 */
function readProjectConfig(): ProjectConfig {
  if (projectConfig) return projectConfig
  projectConfig = {}

  // backend/ lives at <repo>/apps/<app>/backend, so walk up looking for the file.
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'fusebase.json')
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null) {
          const config = parsed as ProjectConfig
          const apps = (parsed as { apps?: Array<{ id?: unknown }> }).apps
          const firstAppId = Array.isArray(apps) && typeof apps[0]?.id === 'string' ? apps[0].id : undefined
          projectConfig = {
            orgId: typeof config.orgId === 'string' ? config.orgId : undefined,
            productId: typeof config.productId === 'string' ? config.productId : undefined,
            appId: firstAppId,
          }
        }
      } catch {
        // A malformed project file is not worth crashing the backend over; the env
        // vars are authoritative on deploy anyway.
      }
      return projectConfig
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return projectConfig
}

/** Org id. Injected by the platform on deploy; read from fusebase.json in local dev. */
export function orgId(): string {
  const resolved =
    trimmed(process.env.FBS_ORG_ID) ??
    trimmed(process.env.FUSEBASE_ORG_ID) ??
    trimmed(readProjectConfig().orgId)

  if (!resolved) {
    throw new Error(
      'Could not resolve the organization id. On deploy the platform injects FBS_ORG_ID; ' +
        'locally it is read from fusebase.json ("orgId"). This is public config — do not ' +
        'create a secret for it.',
    )
  }
  return resolved
}

/**
 * This App's (feature) id — the `appId` path param for portal-context verification.
 * Distinct from productId: a product may contain several apps.
 */
export function appId(): string {
  // FBS_APP_ID is injected with the PRODUCT id on deploy (legacy platform naming),
  // so the feature-specific variable is checked first to make this match its name.
  const resolved =
    trimmed(process.env.FBS_APP_FEATURE_GLOBAL_ID) ??
    trimmed(readProjectConfig().appId) ??
    trimmed(process.env.FBS_APP_ID)
  if (!resolved) {
    throw new Error(
      'Could not resolve the app id. On deploy the platform injects FBS_APP_ID; ' +
        'locally it is read from fusebase.json (apps[0].id). This is public config.',
    )
  }
  return resolved
}

/** Product id that owns this app. Distinct from the app (feature) id. */
export function productId(): string | undefined {
  return trimmed(process.env.FBS_PRODUCT_ID) ?? trimmed(readProjectConfig().productId)
}

/** App/client id used to scope isolated-store discovery. Optional. */
export function appClientId(): string | undefined {
  return (
    trimmed(process.env.FBS_APP_ID) ??
    trimmed(process.env.FBS_PRODUCT_ID) ??
    trimmed(readProjectConfig().productId)
  )
}

/** Isolated-store stage: `dev` under `fusebase dev start`, `prod` when deployed. */
export function stage(): Stage {
  const explicit = trimmed(process.env.COMPASS_STORE_STAGE)
  if (explicit === 'dev' || explicit === 'prod') return explicit
  // The platform injects FBS_FEATURE_TOKEN only on real deploys.
  return trimmed(process.env.FBS_FEATURE_TOKEN) ? 'prod' : 'dev'
}

export function fusebaseHost(): string {
  return trimmed(process.env.FUSEBASE_HOST) ?? 'thefusebase.com'
}

export function gateBaseUrl(): string {
  return `https://app-api.${fusebaseHost()}/v4/api/proxy/gate-service/v1`
}

/**
 * Dashboard service, for `dashboard_view` sources.
 *
 * Same proxy, different service path — derived from the same host so a deploy against
 * a different backend cannot end up reading dashboards from one environment and the
 * store from another.
 */
export function dashboardsBaseUrl(): string {
  return `https://app-api.${fusebaseHost()}/v4/api/proxy/dashboard-service/v1`
}

export function openAiApiKey(): string {
  return required('OPENAI_API_KEY')
}

/** AWS Textract config. Optional — OCR is disabled (not broken) when absent. */
export interface AwsOcrConfig {
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export function awsOcrConfig(): AwsOcrConfig | null {
  const region = trimmed(process.env.AWS_REGION)
  const accessKeyId = trimmed(process.env.AWS_ACCESS_KEY_ID)
  const secretAccessKey = trimmed(process.env.AWS_SECRET_ACCESS_KEY)
  const bucket = trimmed(process.env.TEXTRACT_S3_BUCKET)
  if (!region || !accessKeyId || !secretAccessKey || !bucket) return null
  return { region, accessKeyId, secretAccessKey, bucket }
}

/** Whether indexing and answering can run at all. Never exposes the key itself. */
export function isOpenAiConfigured(): boolean {
  return trimmed(process.env.OPENAI_API_KEY) !== undefined
}

export function isOcrConfigured(): boolean {
  return awsOcrConfig() !== null
}

/**
 * Every distinct id this environment can offer for Gate's `/apps/{id}` path segment,
 * in preference order.
 *
 * Gate's naming here is legacy-ambiguous and the platform makes it worse: on deploy
 * `FBS_APP_ID` is injected with the PRODUCT id, not the App (feature) id, so
 * `appId()` alone can never produce the feature id in a container. Callers that must
 * be right rather than lucky try each of these and keep the one Gate accepts.
 */
export function appPathIdCandidates(): Array<{ label: string; id: string }> {
  const project = readProjectConfig()
  const ordered: Array<{ label: string; id: string }> = [
    // The App (feature) global id. Confirmed present in the deployed container and
    // listed first because Gate's portal-feature-context route is feature-scoped —
    // its `:appId` segment wants this, not the product id that FBS_APP_ID carries.
    {
      label: 'env:FBS_APP_FEATURE_GLOBAL_ID',
      id: trimmed(process.env.FBS_APP_FEATURE_GLOBAL_ID) ?? '',
    },
    { label: 'env:FBS_APP_ID', id: trimmed(process.env.FBS_APP_ID) ?? '' },
    { label: 'project:apps[0].id', id: trimmed(project.appId) ?? '' },
    { label: 'env:FBS_PRODUCT_ID', id: trimmed(process.env.FBS_PRODUCT_ID) ?? '' },
    { label: 'project:productId', id: trimmed(project.productId) ?? '' },
  ]

  const seen = new Set<string>()
  return ordered.filter((candidate) => {
    if (candidate.id.length === 0 || seen.has(candidate.id)) return false
    seen.add(candidate.id)
    return true
  })
}
