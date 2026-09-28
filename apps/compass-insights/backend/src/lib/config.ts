/**
 * Runtime configuration for the Compass Admin backend.
 *
 * Deliberately narrower than the client app's config. This app never embeds in a
 * portal, never calls OpenAI and never runs OCR, so none of the model, retrieval or
 * Textract configuration belongs here — carrying it would imply capabilities this
 * app does not have, and would put an unused `OPENAI_API_KEY` in its secret list.
 *
 * The admin app shares the `compasses` store with the client app by **alias**, not by
 * a copied id. Platform-resolved identifiers are not secrets and are not read from
 * `fusebase secret`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Stage = 'dev' | 'prod'

/** Stable alias of the shared FuseBase PostgreSQL Database. */
export const STORE_ALIAS = 'compasses'

/**
 * Published prices (USD), used to render historical cost on the usage screen.
 *
 * Kept in code rather than the database so a usage row keeps the cost that was
 * computed when it was written, even after a price change.
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
}

let projectConfig: ProjectConfig | null = null

/**
 * Read `orgId` / `productId` from the project's `fusebase.json`.
 *
 * Public configuration, not secrets. The platform injects `FBS_ORG_ID` on a real
 * deploy but `fusebase dev start` does not, so local dev reads the file the CLI
 * already owns rather than asking for a secret that would be wrong to create.
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
          projectConfig = {
            orgId: typeof config.orgId === 'string' ? config.orgId : undefined,
            productId: typeof config.productId === 'string' ? config.productId : undefined,
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
 * Client id used to scope isolated-store discovery.
 *
 * The store belongs to the *product*, which both apps share, so this resolves the
 * product id rather than either app's own id — that is what makes the admin app find
 * the same store the client app uses.
 */
export function appClientId(): string | undefined {
  return (
    trimmed(process.env.FBS_PRODUCT_ID) ??
    trimmed(readProjectConfig().productId) ??
    trimmed(process.env.FBS_APP_ID)
  )
}

/** Isolated-store stage: `dev` under `fusebase dev start`, `prod` when deployed. */
export function stage(): Stage {
  const explicit = trimmed(process.env.COMPASS_STORE_STAGE)
  if (explicit === 'dev' || explicit === 'prod') return explicit
  // The platform sets NODE_ENV=production in a deployed container.
  return process.env.NODE_ENV === 'production' ? 'prod' : 'dev'
}

export function fusebaseHost(): string {
  return trimmed(process.env.FUSEBASE_HOST) ?? 'thefusebase.com'
}

export function gateBaseUrl(): string {
  return `https://app-api.${fusebaseHost()}/v4/api/proxy/gate-service/v1`
}
