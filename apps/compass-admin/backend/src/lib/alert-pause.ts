/**
 * Reading and setting the alert pause, from the staff side.
 *
 * The client app's `lib/alerts.ts` owns **raising** an alert and therefore owns
 * honouring the pause when it decides whether to notify. This module owns the other
 * two halves: showing an operator that the pause is on, and letting them turn it off.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a verbatim copy of the client app's `alert-pause.ts`
 *
 * It would have been the established pattern here — `folders.ts`, the Chakra
 * primitives and the four backend helpers are all copied byte-for-byte with a drift
 * test holding them together. This one is deliberately not, because the two sides do
 * genuinely different jobs: the client app asks one question on a failure path
 * ("should I stay quiet?") and this side reads the whole state and writes it.
 *
 * **The contract they share is the database field, not the code.**
 * `app_settings.defaults.alertsPaused` is the interface, and it is one boolean with an
 * obvious meaning. Copying a module so that two apps can agree on the spelling of a
 * JSON key would add a drift test that guards nothing the field does not already
 * guarantee.
 */

import { queryOne, updateRows, insertRow, readNumber } from './store.js'
import { orgId } from './config.js'

export interface AlertPauseState {
  paused: boolean
  pausedAt: string | null
  pausedBy: string | null
  /**
   * Alerts first raised since the pause began.
   *
   * The number that makes un-pausing an informed decision rather than a leap. A pause
   * with no expiry — which is what was asked for — needs this, or "turn alerts back
   * on" is a question nobody has the evidence to answer.
   */
  raisedWhilePaused: number
}

async function readDefaults(): Promise<Record<string, unknown>> {
  const row = await queryOne('SELECT defaults FROM app_settings WHERE org_id = $1', [orgId()])
  const raw = row?.defaults
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

export async function alertPauseState(): Promise<AlertPauseState> {
  const defaults = await readDefaults()
  const paused = defaults.alertsPaused === true
  const pausedAt = typeof defaults.alertsPausedAt === 'string' ? defaults.alertsPausedAt : null

  let raisedWhilePaused = 0
  if (paused && pausedAt) {
    // `first_seen_at`, not `last_seen_at`: an alert that was already open before the
    // pause and merely ticked its counter is not news, and counting it would inflate
    // the number that is supposed to mean "things you have not been told about".
    const row = await queryOne(
      `SELECT count(*)::int AS n FROM system_alerts
        WHERE org_id = $1 AND first_seen_at >= $2`,
      [orgId(), pausedAt],
    )
    raisedWhilePaused = row ? readNumber(row, 'n') : 0
  }

  return {
    paused,
    pausedAt,
    pausedBy: typeof defaults.alertsPausedBy === 'string' ? defaults.alertsPausedBy : null,
    raisedWhilePaused,
  }
}

export async function setAlertsPaused(paused: boolean, actorUserId: string | null): Promise<void> {
  const defaults = await readDefaults()
  const next: Record<string, unknown> = { ...defaults, alertsPaused: paused }

  if (paused) {
    next.alertsPausedAt = new Date().toISOString()
    next.alertsPausedBy = actorUserId
  } else {
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
