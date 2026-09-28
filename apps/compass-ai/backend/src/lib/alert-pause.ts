/**
 * The alert pause.
 *
 * Operations asked for alerts to be paused "hasta nuevo aviso" ahead of a product
 * demo. This is that switch, and the shape of it is the interesting part.
 *
 * ---------------------------------------------------------------------------
 * What it does and does not stop
 *
 * Paused means **delivery stops; recording does not.** `raiseAlert` still writes the
 * row, still increments the occurrence count, still logs. What is suppressed is the
 * notification — nobody's inbox, and no badge on the admin rail.
 *
 * The alternative — not recording at all — was rejected for one reason: this pause has
 * no expiry, because the request had none. A switch with no expiry that also destroys
 * evidence means that whatever breaks while it is on is not merely unreported, it is
 * unknowable afterwards. Recording-but-quiet costs nothing and keeps un-pausing
 * informative: everything raised in the meantime is right there with its real count
 * and its real first-seen time.
 *
 * ---------------------------------------------------------------------------
 * Why it must be loud in the UI
 *
 * A silent mute is the failure mode this whole subsystem exists to avoid — §6.3.5's
 * "an inbox that only ever grows stops being read" has an exact twin in "an inbox that
 * was switched off and nobody remembers". So the admin Alerts screen states the pause
 * in a banner, and states how many alerts were raised while it has been on.
 *
 * ---------------------------------------------------------------------------
 * Where the flag lives
 *
 * `app_settings.defaults.alertsPaused`, beside `portalRemovalGraceDays`, because that
 * is already the org-scoped place for policy that must be changeable without a deploy.
 * Turning alerts back on must not require a release; if it did, the pause would
 * outlive its reason.
 */

import { queryOne, updateRows, insertRow } from './store.js'
import { orgId } from './config.js'

export interface AlertPauseState {
  paused: boolean
  /** When it was paused, so the banner can say how long it has been on. */
  pausedAt: string | null
  pausedBy: string | null
}

/** Read `app_settings.defaults`, tolerating a missing row and a non-object value. */
async function readDefaults(): Promise<Record<string, unknown>> {
  const row = await queryOne('SELECT defaults FROM app_settings WHERE org_id = $1', [orgId()])
  const raw = row?.defaults
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

export async function alertPauseState(): Promise<AlertPauseState> {
  const defaults = await readDefaults()
  return {
    paused: defaults.alertsPaused === true,
    pausedAt: typeof defaults.alertsPausedAt === 'string' ? defaults.alertsPausedAt : null,
    pausedBy: typeof defaults.alertsPausedBy === 'string' ? defaults.alertsPausedBy : null,
  }
}

/**
 * Are alerts paused right now?
 *
 * Deliberately **not** cached. The obvious optimisation is a 60-second memo like
 * `admin-auth` uses, and it is wrong here: the whole value of this switch is that
 * turning alerts back on takes effect immediately, and a cache means the first minute
 * after un-pausing still swallows everything. The read is one indexed primary-key
 * lookup on a table with one row.
 */
export async function alertsPaused(): Promise<boolean> {
  try {
    return (await alertPauseState()).paused
  } catch (error) {
    // Fail **open**: if the flag cannot be read, deliver the alert. A pause is a
    // convenience and a missed critical alert is not, so the ambiguous case resolves
    // towards being told.
    console.error('[alerts] could not read the pause flag; delivering anyway', error)
    return false
  }
}

/** Turn the pause on or off, recording who and when. */
export async function setAlertsPaused(paused: boolean, actorUserId: string | null): Promise<void> {
  const defaults = await readDefaults()
  const next: Record<string, unknown> = { ...defaults, alertsPaused: paused }

  if (paused) {
    next.alertsPausedAt = new Date().toISOString()
    next.alertsPausedBy = actorUserId
  } else {
    // Cleared rather than kept: a stale "paused at" beside `alertsPaused: false` is
    // the kind of contradiction that makes somebody distrust the whole record.
    delete next.alertsPausedAt
    delete next.alertsPausedBy
  }

  const existing = await queryOne('SELECT org_id FROM app_settings WHERE org_id = $1', [orgId()])
  if (existing) {
    await updateRows('app_settings', { defaults: JSON.stringify(next) }, [
      { column: 'org_id', operator: 'eq', value: orgId() },
    ])
  } else {
    await insertRow('app_settings', { org_id: orgId(), defaults: JSON.stringify(next) }, ['org_id'])
  }
}
