/**
 * Failure notification — §10.
 *
 * The rule: any failure a client could notice, or that leaves a portal serving stale
 * or incomplete content, writes a `system_alerts` row and notifies staff. A silent
 * retry is allowed only while attempts remain.
 *
 * Three properties matter more than the plumbing:
 *
 * 1. **Raising must never break the thing that failed.** Every path here is
 *    best-effort: a broken alert channel, an unreachable store, a bad recipient list
 *    — none of it may turn a handled failure into an unhandled one, or a retryable
 *    job into a lost one. So `raiseAlert` never throws.
 *
 * 2. **Deduplication, not suppression.** A repeated failure bumps `occurrences` and
 *    `last_seen_at` on one row rather than filling the inbox, but it is never
 *    dropped: the count is what distinguishes "a blip" from "this has failed 400
 *    times since Tuesday". Notification is throttled to once per 30 minutes per
 *    alert; the row is always updated.
 *
 * 3. **Every code carries hand-written remediation.** §10.2 is explicit that a
 *    generic "an error occurred" fails review, so the registry below holds real
 *    instructions naming the screen to open, and callers add the specifics — which
 *    table, which column, which rows.
 */

import { createHash } from 'node:crypto'
import { orgId, serviceGateAuth } from './config.js'
import { createEmailsApi } from './gate.js'
import { logStep } from './observability.js'
import { alertsPaused } from './alert-pause.js'
import {
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from './store.js'

export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical'
export type AlertScope = 'org' | 'client' | 'portal' | 'source' | 'document' | 'chat'

/** The seed codes from §10.4. Adding one means adding its text here. */
export type AlertCode =
  | 'PORTAL_NOT_BOUND'
  | 'PORTAL_NO_SOURCE'
  | 'SOURCE_SYNC_FAILED'
  | 'SOURCE_CONFIG_INVALID'
  | 'DOC_OCR_FAILED'
  | 'DOC_EMBED_FAILED'
  | 'BATCH_EXPIRED'
  | 'OCR_BUDGET_REACHED'
  | 'TOKEN_BUDGET_REACHED'
  | 'LLM_TIMEOUT_REPEATED'
  | 'STORE_UNAVAILABLE'
  | 'TENANCY_PROBE'
  | 'PORTAL_MISSING'
  | 'PORTAL_RECONCILE_FAILED'
  | 'INSIGHT_RUN_FAILED'

interface AlertDefinition {
  severity: AlertSeverity
  scope: AlertScope
  /** The inbox's headline. Says what happened, not which subsystem reported it. */
  title: string
  /** Default remediation: what to do, naming the screen. Callers may extend it. */
  remediation: string
  /** Safe text for a client, when a client is waiting on this. */
  clientMessage?: string
}

/**
 * Per-code severity, scope and remediation.
 *
 * The remediation strings are numbered steps on purpose: the person reading them is
 * usually mid-incident and should not have to work out the order.
 */
const DEFINITIONS: Record<AlertCode, AlertDefinition> = {
  /**
   * An analysis run failed (Phase 8 §5).
   *
   * `warning`, not `error`, and the severity is the judgement here: a failed insight
   * run means the internal screens are stale. **No client is affected** — nothing in
   * this phase touches an answer, a document or a portal — so waking someone at night
   * for it would be miscalibrating every other alert in the list by comparison.
   *
   * `clientMessage` is **omitted**, not empty. There is no client-facing consequence,
   * and a message here would eventually be shown to somebody for whom nothing is
   * wrong. The field is optional rather than nullable, so omitting it is how "there is
   * nothing to say" is expressed.
   */
  INSIGHT_RUN_FAILED: {
    severity: 'warning',
    scope: 'org',
    title: 'A conversation-analysis run failed',
    remediation:
      '1. Open Insights → Runs and find the failed run. 2. Read its error — the row ' +
      'carries the cause, so there is no need to go to the logs. 3. Fix and re-run. ' +
      'Nothing a client can see is affected; only the insights screens are stale.',
  },
  PORTAL_NOT_BOUND: {
    severity: 'error',
    scope: 'portal',
    title: 'Portal is not bound to a client',
    remediation:
      '1. Open Admin → Portals. 2. Find this portal in the list. 3. Bind it to the client it belongs to. Until then the portal resolves to no client and its viewers see nothing.',
    clientMessage: 'This page is not ready yet. Your KIRIA team has been notified.',
  },
  PORTAL_NO_SOURCE: {
    severity: 'warning',
    scope: 'portal',
    title: 'Portal has no document sources',
    remediation:
      '1. Open Admin → Portals → Bindings for this portal. 2. Attach at least one source. A bound portal with no sources shows an empty document list even though it is configured correctly.',
    clientMessage: 'No documents have been published to this page yet.',
  },
  SOURCE_SYNC_FAILED: {
    severity: 'error',
    scope: 'source',
    title: 'Source sync failed',
    remediation:
      '1. Open Admin → Sources and select this source. 2. Press Preview to see what the current mapping resolves to. 3. Correct the table or column mapping, or fix the offending rows in the source table. 4. Press Sync now.',
    clientMessage: 'Some documents are still being prepared.',
  },
  SOURCE_CONFIG_INVALID: {
    severity: 'error',
    scope: 'source',
    title: 'Source column mapping no longer matches its table',
    remediation:
      '1. Open Admin → Sources → Column mapping for this source. 2. The cause below names the column that does not match the table. 3. Remap it and press Preview to confirm before saving.',
    clientMessage: 'Some documents are still being prepared.',
  },
  DOC_OCR_FAILED: {
    severity: 'error',
    scope: 'document',
    title: 'Document could not be read',
    remediation:
      '1. Check the PDF opens and is not password protected. 2. Check the client OCR page cap in Admin → Settings has room. 3. Check the AWS credentials and region are still valid. 4. Press Re-index on the document.',
    clientMessage: 'This document could not be prepared. Your KIRIA team has been notified.',
  },
  DOC_EMBED_FAILED: {
    severity: 'error',
    scope: 'document',
    title: 'Document could not be indexed',
    remediation:
      '1. Check the OpenAI key is valid and the account has credit — a quota error is permanent and will not clear by retrying. 2. Once it does, press Re-index on the document.',
    clientMessage: 'This document could not be prepared. Your KIRIA team has been notified.',
  },
  BATCH_EXPIRED: {
    severity: 'warning',
    scope: 'client',
    title: 'Batch embedding job expired before finishing',
    remediation:
      '1. Open Admin → Documents for this client. 2. Re-index the documents that are still unsearchable. An expired batch loses no document, only the queued embedding work.',
    clientMessage: 'Some documents are still being prepared.',
  },
  OCR_BUDGET_REACHED: {
    severity: 'warning',
    scope: 'client',
    title: 'Monthly OCR page budget reached',
    remediation:
      '1. Open Admin → Settings for this client. 2. Raise the monthly OCR page budget, or wait for the next period. Source syncs are paused rather than allowed to exceed it, so nothing is being charged past the cap.',
    clientMessage: 'Some documents are still being prepared.',
  },
  TOKEN_BUDGET_REACHED: {
    severity: 'warning',
    scope: 'client',
    title: 'Monthly token budget reached',
    remediation:
      '1. Open Admin → Settings for this client. 2. Raise the monthly token budget, or wait for the next period. Questions are refused before any paid call is made.',
    clientMessage:
      'This page has reached its monthly usage limit. Your KIRIA team has been notified.',
  },
  LLM_TIMEOUT_REPEATED: {
    severity: 'error',
    scope: 'client',
    title: 'Answers are repeatedly timing out',
    remediation:
      '1. Check the OpenAI status page. 2. If the provider is healthy, switch this client to Economy mode in Admin → Settings — it retrieves less context and answers faster. 3. Re-check after the next few questions.',
    clientMessage: 'Answers are slower than usual right now. Your KIRIA team has been notified.',
  },
  STORE_UNAVAILABLE: {
    severity: 'critical',
    scope: 'org',
    title: 'Database is unreachable',
    remediation:
      '1. Check Gate health. 2. The app is degraded until the store returns: documents and chats cannot be read or written. No data is lost — nothing is being written while it is down.',
    clientMessage: 'The service is temporarily unavailable. Your KIRIA team has been notified.',
  },
  /**
   * FuseBase no longer lists this portal (§6A.4).
   *
   * The portal has already stopped serving — `portal_visible_documents` filters on
   * `status = active` — so this alert is not a warning of something about to happen.
   * It is a report that a client lost access, and the only question left is whether
   * that was intended.
   */
  PORTAL_MISSING: {
    severity: 'error',
    scope: 'portal',
    title: 'Portal no longer exists in FuseBase',
    remediation:
      '1. Check in FuseBase whether the portal was deleted on purpose. 2. If it was not, restoring it there brings this one back automatically on the next reconcile. 3. If it was, Admin → Portals offers Remove permanently once the grace period has passed — nothing is deleted before that.',
    clientMessage: 'This page is no longer available. Please contact your KIRIA team.',
  },
  /**
   * The platform could not be read, so the reconcile changed nothing.
   *
   * Worth an alert precisely because nothing happened: the portal list on screen is
   * the previous state, and a stale list that looks current is how someone concludes
   * a portal is fine when it is gone.
   */
  PORTAL_RECONCILE_FAILED: {
    severity: 'warning',
    scope: 'org',
    title: 'Could not read the portal list from FuseBase',
    remediation:
      '1. The portal list in Admin → Portals is the last known state, not the current one — nothing was changed. 2. Press Sync now to retry. 3. If it keeps failing, check that portals.read is still granted to this app (fusebase app update <appId> --sync-gate-permissions).',
  },
  TENANCY_PROBE: {
    severity: 'critical',
    scope: 'org',
    title: 'A request tried to override tenancy',
    remediation:
      '1. Open Admin → Audit log and filter by action "tenancy_probe_denied". 2. Investigate the actor and IP immediately — a request carried a tenant identifier, which the app refuses but which no legitimate client ever sends. 3. The request was denied; no data was exposed.',
  },
}

export interface RaiseAlertInput {
  code: AlertCode
  /** Specific, hand-written detail: what went wrong, with the real names and numbers. */
  cause: string
  title?: string
  /** Appended to the code's standard remediation when the fix needs specifics. */
  remediationDetail?: string
  clientId?: string | null
  portalRowId?: string | null
  sourceId?: string | null
  documentId?: string | null
  metadata?: Record<string, unknown>
  /** Overrides the registry, for a code whose severity genuinely varies. */
  severity?: AlertSeverity
  /**
   * Extra dedupe discriminator for a scope that is not a row in this database.
   *
   * `PORTAL_NOT_BOUND` is the case that forces this to exist: an unbound portal has
   * no `portals` row by definition, so without the platform portal id here every
   * unbound portal in the org would collapse into one alert and only the first would
   * ever be named.
   */
  dedupeExtra?: string
}

/** Re-notify at most this often per alert (§10.2). */
const NOTIFY_THROTTLE_MS = 30 * 60 * 1000

/**
 * Dedupe key: the code plus whatever scope ids identify the thing that failed.
 *
 * Hashed so the key is a fixed length regardless of how many ids a scope carries,
 * and so it can be a unique constraint without worrying about column limits.
 */
function dedupeKey(input: RaiseAlertInput): string {
  const parts = [
    input.code,
    input.clientId ?? '',
    input.portalRowId ?? '',
    input.sourceId ?? '',
    input.documentId ?? '',
    input.dedupeExtra ?? '',
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

interface StoredAlert {
  id: string
  code: string
  severity: string
  title: string
  cause: string
  remediation: string
  clientId: string | null
  occurrences: number
  lastNotifiedAt: string | null
}

interface AlertShape {
  key: string
  severity: AlertSeverity
  title: string
  remediation: string
  scope: AlertScope
  clientMessage: string | null
}

/**
 * How many times to re-read and retry when another writer got there first.
 *
 * **Eight because three was measured to be too few.** With the compare-and-set in
 * place, a 14-raise burst across three replicas counted 9 — better than the 3 the
 * naive version managed, but still lossy: each retry costs a round trip, and callers
 * that keep colliding run out of attempts.
 *
 * Bounded either way, so a pathological burst degrades to "the count is low" rather
 * than "the request hangs" — the alert row itself is never at risk, only this
 * occurrence's contribution to the tally.
 */
const UPSERT_ATTEMPTS = 8

/**
 * Jittered pause between contended attempts.
 *
 * Without it, callers that collide once tend to collide again: they retry in lockstep
 * because they were released by the same commit. A few tens of milliseconds of random
 * spread is enough to break up the convoy, and is negligible next to the ~200-300ms
 * floor on an isolated-store round trip.
 */
function contentionBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60))
}

/**
 * Insert the alert, or increment the existing one — safe against concurrent writers.
 *
 * **This was measured, not theorised.** The first version did a plain read-then-write:
 * read for an open row, insert if absent, otherwise write `occurrences = read + 1`.
 * Running the tenancy suite against prod produced 14 audited probes and an alert
 * reading `occurrences: 3`. Eleven raises were silently lost, because the app runs on
 * up to three replicas and the test drove six concurrent clients:
 *
 *   - Several callers find no row, all attempt the insert, one wins, and the rest get
 *     a unique-constraint violation that the outer catch swallows as "could not
 *     record".
 *   - Two callers that both find the row read the same `occurrences` and both write
 *     the same `N + 1`, so one increment vanishes.
 *
 * A dropped alert is much worse than a low count, and for `TENANCY_PROBE` the count
 * *is* the signal — undercounting a probe sweep by 4× actively misleads.
 *
 * So both races are closed:
 *
 *   - The insert's unique violation is treated as "someone else created it", and the
 *     loop re-reads and increments instead of giving up.
 *   - The increment is a **compare-and-set** — the update is filtered on the
 *     `occurrences` value that was read, so a concurrent increment matches zero rows
 *     and this caller retries against the new value. Same pattern as `claimSource`,
 *     and necessary for the same reason: `updateRows` writes literals, and
 *     `occurrences = occurrences + 1` needs `isolated_store.execute`, which this
 *     backend deliberately does not hold.
 */
async function upsertAlert(
  input: RaiseAlertInput,
  shape: AlertShape,
): Promise<StoredAlert | null> {
  for (let attempt = 1; attempt <= UPSERT_ATTEMPTS; attempt += 1) {
    // The unique constraint is (org_id, dedupe_key, status), so a resolved alert does
    // not block a new one when the same failure recurs later — which is what makes
    // recurrence visible.
    const existing = await queryOne(
      `SELECT id, occurrences, last_notified_at
         FROM system_alerts
        WHERE org_id = $1 AND dedupe_key = $2 AND status IN ('new', 'acknowledged')`,
      [orgId(), shape.key],
    )

    if (existing) {
      const seen = readNumber(existing, 'occurrences')
      const id = readString(existing, 'id')
      const updated = await updateRows(
        'system_alerts',
        {
          occurrences: seen + 1,
          last_seen_at: new Date().toISOString(),
          // The newest cause replaces the old one: for a recurring failure the latest
          // detail is the useful one, and the count already records the history.
          cause: input.cause.slice(0, 4000),
          severity: shape.severity,
        },
        [
          { column: 'id', operator: 'eq', value: id },
          // The compare half of compare-and-set.
          { column: 'occurrences', operator: 'eq', value: seen },
        ],
      )

      // Zero rows means another writer incremented between the read and the write.
      // Retry against the value they left.
      if (updated === 0) {
        await contentionBackoff()
        continue
      }

      return {
        id,
        code: input.code,
        severity: shape.severity,
        title: shape.title,
        cause: input.cause,
        remediation: shape.remediation,
        clientId: input.clientId ?? null,
        occurrences: seen + 1,
        lastNotifiedAt: readOptionalString(existing, 'last_notified_at'),
      }
    }

    try {
      const created = await insertRow(
        'system_alerts',
        {
          org_id: orgId(),
          code: input.code,
          severity: shape.severity,
          scope: shape.scope,
          client_id: input.clientId ?? null,
          portal_row_id: input.portalRowId ?? null,
          source_id: input.sourceId ?? null,
          document_id: input.documentId ?? null,
          title: shape.title.slice(0, 300),
          cause: input.cause.slice(0, 4000),
          remediation: shape.remediation.slice(0, 4000),
          client_message: shape.clientMessage,
          dedupe_key: shape.key,
          metadata: JSON.stringify(input.metadata ?? {}),
        },
        ['id'],
      )
      if (!created) return null

      return {
        id: readString(created, 'id'),
        code: input.code,
        severity: shape.severity,
        title: shape.title,
        cause: input.cause,
        remediation: shape.remediation,
        clientId: input.clientId ?? null,
        occurrences: 1,
        lastNotifiedAt: null,
      }
    } catch (error) {
      // Lost the insert race: the row now exists, so go round and increment it. Any
      // other failure is real and belongs to the caller's catch.
      if (!isUniqueViolation(error)) throw error
      await contentionBackoff()
    }
  }

  // Contention outlasted the retries. The row exists either way — only this
  // occurrence went uncounted — so this is logged rather than thrown.
  console.error('[alerts] gave up incrementing after contention', input.code)
  return null
}

/**
 * Whether a write failed because the row already exists.
 *
 * Message matching, because Gate surfaces the Postgres error as text rather than as a
 * typed error with `code === '23505'`. Both the SQLSTATE and the constraint name are
 * accepted so this keeps working if only one of them is passed through.
 */
function isUniqueViolation(error: unknown): boolean {
  const text = (
    error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)
  ).toLowerCase()
  return (
    text.includes('23505') ||
    text.includes('duplicate key') ||
    text.includes('unique constraint') ||
    text.includes('system_alerts_dedupe_key')
  )
}

/**
 * Write or update the alert row, then notify — never throwing.
 *
 * Returns the alert id when one was recorded, or null when even that failed. The
 * caller is always a failure path already, so a thrown error here would replace a
 * diagnosable problem with an opaque one.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<string | null> {
  const definition = DEFINITIONS[input.code]

  try {
    const key = dedupeKey(input)
    const severity = input.severity ?? definition.severity
    const remediation = input.remediationDetail
      ? `${definition.remediation}\n\n${input.remediationDetail}`
      : definition.remediation
    const title = input.title ?? definition.title

    const alert = await upsertAlert(input, {
      key,
      severity,
      title,
      remediation,
      scope: definition.scope,
      clientMessage: definition.clientMessage ?? null,
    })
    if (!alert) return null

    logStep('alert.raised', {
      code: input.code,
      severity,
      alertId: alert.id,
      occurrences: alert.occurrences,
    })

    await notify(alert)
    return alert.id
  } catch (error) {
    // Last resort: the alert could not be recorded at all. The log line is the only
    // remaining trace, so it carries the whole payload.
    console.error('[alerts] failed to raise', input.code, input.cause, error)
    return null
  }
}

/**
 * Auto-resolve every open alert matching a code and scope.
 *
 * Called when the thing that was failing succeeds — §6.3.5 requires a successful
 * sync to clear its own `SOURCE_SYNC_FAILED`. An inbox that only ever grows stops
 * being read.
 */
export async function resolveAlerts(input: {
  code: AlertCode
  clientId?: string | null
  portalRowId?: string | null
  sourceId?: string | null
  documentId?: string | null
  dedupeExtra?: string
}): Promise<number> {
  try {
    const key = dedupeKey({ ...input, cause: '' })
    return await updateRows(
      'system_alerts',
      { status: 'resolved', resolved_at: new Date().toISOString() },
      [
        { column: 'org_id', operator: 'eq', value: orgId() },
        { column: 'dedupe_key', operator: 'eq', value: key },
        // Only open alerts: re-resolving an already-resolved row would move its
        // timestamp and lose when it actually cleared.
        { column: 'status', operator: 'ne', value: 'resolved' },
      ],
    )
  } catch (error) {
    console.error('[alerts] failed to resolve', input.code, error)
    return 0
  }
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export interface AlertRecipient {
  userId?: string
  email?: string
}

interface ChannelSettings {
  email: boolean
  inApp: boolean
  monday: boolean
  recipients: AlertRecipient[]
}

/**
 * Read the org's channel configuration.
 *
 * Defaults to in-app only. Email needs recipients to mean anything, and inventing a
 * recipient would send a stranger someone else's failure detail.
 */
async function readChannelSettings(): Promise<ChannelSettings> {
  const fallback: ChannelSettings = { email: false, inApp: true, monday: false, recipients: [] }

  const row = await queryOne(
    'SELECT channels, alert_recipients FROM app_settings WHERE org_id = $1',
    [orgId()],
  ).catch(() => null)
  if (!row) return fallback

  const channels = readJson(row.channels)
  const recipientsRaw = readJson(row.alert_recipients)

  const recipients: AlertRecipient[] = Array.isArray(recipientsRaw)
    ? recipientsRaw.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const shaped = entry as { userId?: unknown; email?: unknown }
        const userId = typeof shaped.userId === 'string' ? shaped.userId : undefined
        const email = typeof shaped.email === 'string' ? shaped.email : undefined
        return userId || email ? [{ userId, email }] : []
      })
    : []

  const flags = typeof channels === 'object' && channels !== null && !Array.isArray(channels)
    ? (channels as Record<string, unknown>)
    : {}

  return {
    // in_app is always on (§10.3): the Alerts screen reads the table directly, so
    // disabling it would only stop the delivery record, not the visibility.
    inApp: true,
    email: flags.email === true && recipients.length > 0,
    monday: flags.monday === true,
    recipients,
  }
}

function readJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

async function recordDelivery(
  alertId: string,
  channel: 'email' | 'in_app' | 'monday',
  status: 'sent' | 'failed' | 'skipped',
  target: string | null,
  error?: string,
): Promise<void> {
  await insertRow(
    'alert_deliveries',
    {
      alert_id: alertId,
      channel,
      target,
      status,
      attempts: 1,
      last_error: error ? error.slice(0, 1000) : null,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    },
    ['id'],
  ).catch(() => undefined)
}

/**
 * Notify staff, subject to the 30-minute throttle.
 *
 * The throttle governs *notification*, never the row — the alert and its occurrence
 * count are already updated by the time this runs.
 */
async function notify(alert: StoredAlert): Promise<void> {
  // Paused: the row above is already written and its occurrence count already
  // incremented, so nothing is lost — only the telling stops. Checked here rather than
  // at the top of `raiseAlert` for exactly that reason; see `alert-pause.ts` for why
  // recording continues while a pause with no expiry is in force.
  if (await alertsPaused()) {
    logStep('alert.notify_paused', { alertId: alert.id, code: alert.code })
    return
  }

  if (!(await claimNotificationSlot(alert))) {
    logStep('alert.notify_throttled', { alertId: alert.id, code: alert.code })
    return
  }

  const settings = await readChannelSettings()

  // in_app: the screen reads system_alerts, so there is nothing to send. The delivery
  // row exists for the audit trail (§10.3).
  if (settings.inApp) await recordDelivery(alert.id, 'in_app', 'sent', null)

  if (settings.email) {
    for (const recipient of settings.recipients) {
      const target = recipient.userId ?? recipient.email ?? null
      if (!target) continue
      try {
        await sendEmail(alert, target)
        await recordDelivery(alert.id, 'email', 'sent', target)
      } catch (error) {
        // Recorded and moved on: one bad recipient must not stop the others, and a
        // channel being down must never lose the alert (§10.3).
        await recordDelivery(
          alert.id,
          'email',
          'failed',
          target,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  } else {
    await recordDelivery(alert.id, 'email', 'skipped', null)
  }

  if (settings.monday) {
    // Stubbed in v1 (§10.3). Recorded as failed with the reason rather than silently
    // skipped, so an operator who enabled the channel can see why nothing arrived.
    await recordDelivery(alert.id, 'monday', 'failed', null, 'monday channel is not implemented yet')
  }
}

/**
 * Win the right to notify for this alert, or decline.
 *
 * The naive form of this — compare the timestamp that was read, then stamp it after
 * sending — has the same race as the occurrence counter, and it was measured the same
 * way: the tenancy run produced **ten** `in_app` deliveries for an alert that should
 * have notified once, because every concurrent caller read `last_notified_at` as NULL
 * and all of them passed the check. With email configured that is ten emails about one
 * failure, which defeats the entire purpose of the throttle.
 *
 * So the slot is *claimed* rather than checked: the update is filtered on the exact
 * timestamp that was read (or on it being NULL), so only one caller's write matches a
 * row and the rest get zero and stand down.
 *
 * The stamp is therefore written **before** sending, not after. That is the right
 * trade: if a send then fails it is recorded on `alert_deliveries` and retried by the
 * worker sweep, whereas stamping afterwards is what allows the duplicate flood.
 */
async function claimNotificationSlot(alert: StoredAlert): Promise<boolean> {
  const lastNotified = alert.lastNotifiedAt ? Date.parse(alert.lastNotifiedAt) : 0
  if (Number.isFinite(lastNotified) && lastNotified > 0) {
    if (Date.now() - lastNotified < NOTIFY_THROTTLE_MS) return false
  }

  try {
    const claimed = await updateRows(
      'system_alerts',
      { last_notified_at: new Date().toISOString() },
      [
        { column: 'id', operator: 'eq', value: alert.id },
        // The compare half: match only the state this caller actually observed.
        alert.lastNotifiedAt
          ? { column: 'last_notified_at', operator: 'eq', value: alert.lastNotifiedAt }
          : { column: 'last_notified_at', operator: 'is_null' },
      ],
    )
    return claimed > 0
  } catch (error) {
    // Never let the throttle bookkeeping be the reason an alert goes unnotified: on a
    // failure here, notify. A duplicate notification is recoverable; silence is not.
    console.error('[alerts] could not claim notification slot', alert.id, error)
    return true
  }
}

/**
 * The KIRIA brand values this email is allowed to use — Phase 9 §1.
 *
 * Written out as hexes because an email cannot import a theme: the HTML leaves this
 * process and is rendered weeks later by a mail client that has never heard of Chakra.
 * They are the same values as `scripts/generate-kiria-tokens.mjs`'s `BRAND`, and the
 * only copies of them outside a generated file and the two pre-paint stylesheets.
 */
const BRAND = {
  blue: '#004AAD',
  ink: '#010104',
  inkMuted: '#6a6c6f',
  paperGray: '#F4F6FA',
  paper: '#FFFFFF',
  border: '#e1e3e7',
  red: '#D7263D',
}

/**
 * One email per recipient — the Gate operation takes exactly one.
 *
 * ---------------------------------------------------------------------------
 * Branded, and what that does and does not mean here (§4)
 *
 * These go to staff, but they go out under KIRIA's name, so §4 asks for "a simple
 * branded HTML template — blue header bar, white wordmark, ink body".
 *
 * **The wordmark is set in type, not fetched as an image**, and that is a better answer
 * for email rather than a compromise. Most clients block remote images by default, so
 * an image wordmark is a broken-image icon in the header of an alert the first time
 * anyone sees it. Type always renders. (It is also the only option available: the brand
 * asset folder is not in this repository — see the phase doc.)
 *
 * **A true plain-text alternative is not possible through this API.** `sendOrgEmail`
 * takes exactly one `body` string, not a multipart pair, so there is no text/plain part
 * to send. What §4 actually asks for — that it "still reads correctly" — is achieved the
 * other way: every piece of meaning is in text inside a semantic element, and the
 * styling is inline decoration on top. Strip every style and the email still reads as a
 * title, what went wrong, how to fix it, and a reference. Nothing is carried by colour
 * or by layout alone.
 *
 * **Severity is the one place colour carries anything**, and it is red or nothing —
 * §1's law with only one hue available in an email: yellow is unreadable as text and
 * has no highlight to sit behind here.
 */
async function sendEmail(alert: StoredAlert, target: string): Promise<void> {
  const api = createEmailsApi(serviceGateAuth())

  const isCritical = alert.severity === 'critical'
  const cell = `padding:20px 24px;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`
  const label =
    `margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:0.08em;` +
    `text-transform:uppercase;color:${BRAND.inkMuted}`
  const para = `margin:0 0 18px;font-size:14px;line-height:1.6;color:${BRAND.ink}`

  const body = [
    `<div style="background:${BRAND.paperGray};padding:24px 0">`,
    `<div style="max-width:560px;margin:0 auto;background:${BRAND.paper};` +
      `border:1px solid ${BRAND.border};border-radius:10px;overflow:hidden">`,

    // The blue bar with the wordmark, §4. The severity rides in the same bar rather
    // than in a badge below it: it is the first thing that decides whether the reader
    // keeps reading, so it belongs where the eye already is.
    `<div style="${cell};background:${BRAND.blue};color:${BRAND.paper}">`,
    `<span style="font-size:15px;font-weight:800;letter-spacing:0.06em">KIRIA</span>`,
    `<span style="font-size:15px;font-weight:400;opacity:0.85"> · Compass</span>`,
    `<div style="margin-top:2px;font-size:11px;font-weight:800;letter-spacing:0.08em;` +
      `text-transform:uppercase;opacity:0.9">${escapeHtml(alert.severity)} alert</div>`,
    `</div>`,

    `<div style="${cell}">`,
    `<h1 style="margin:0 0 18px;font-size:17px;line-height:1.35;font-weight:700;` +
      `color:${isCritical ? BRAND.red : BRAND.ink}">${escapeHtml(alert.title)}</h1>`,

    `<p style="${label}">What went wrong</p>`,
    `<p style="${para}">${escapeHtml(alert.cause)}</p>`,

    `<p style="${label}">How to fix it</p>`,
    `<p style="${para}">${escapeHtml(alert.remediation).replaceAll('\n', '<br>')}</p>`,

    alert.occurrences > 1
      ? `<p style="${para}"><strong>This has now happened ${alert.occurrences} times.</strong></p>`
      : '',

    `<p style="${para}">Open Compass Admin → Alerts to acknowledge or resolve this.</p>`,
    `</div>`,

    `<div style="${cell};padding-top:14px;padding-bottom:14px;border-top:1px solid ${BRAND.border};` +
      `background:${BRAND.paperGray};font-size:11px;color:${BRAND.inkMuted}">`,
    `Alert ${escapeHtml(alert.id)} · ${escapeHtml(alert.code)}`,
    `</div>`,

    `</div></div>`,
  ]
    .filter(Boolean)
    .join('\n')

  await api.sendOrgEmail({
    path: { orgId: orgId() },
    body: {
      recipient: target,
      subject: `[KIRIA Compass] ${alert.severity}: ${alert.title}`,
      body,
    },
  })
}

/**
 * Escape for HTML.
 *
 * The cause text contains table names, column names and row ids that came from a
 * source table — data, not markup. Gate sanitizes the body too, but escaping here
 * means a stray `<` in a document name renders as itself rather than vanishing.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Retry deliveries that failed, oldest first.
 *
 * Called from the worker sweep. Bounded attempts with a widening delay: a mail
 * service that is down should not be hammered, and an alert whose delivery can never
 * succeed must not retry forever.
 */
export async function retryFailedDeliveries(maxAttempts = 4): Promise<number> {
  try {
    const rows = await query(
      `SELECT d.id, d.alert_id, d.channel, d.target, d.attempts,
              a.code, a.severity, a.title, a.cause, a.remediation, a.occurrences
         FROM alert_deliveries d
         JOIN system_alerts a ON a.id = d.alert_id
        WHERE d.status = 'failed'
          AND d.channel = 'email'
          AND d.attempts < $1
          AND d.created_at < now() - make_interval(mins => d.attempts * 5)
        ORDER BY d.created_at
        LIMIT 20`,
      [maxAttempts],
    )

    let sent = 0
    for (const row of rows) {
      const target = readOptionalString(row, 'target')
      if (!target) continue

      const attempts = readNumber(row, 'attempts') + 1
      try {
        await sendEmail(
          {
            id: readString(row, 'alert_id'),
            code: readString(row, 'code'),
            severity: readString(row, 'severity'),
            title: readString(row, 'title'),
            cause: readString(row, 'cause'),
            remediation: readString(row, 'remediation'),
            clientId: null,
            occurrences: readNumber(row, 'occurrences'),
            lastNotifiedAt: null,
          },
          target,
        )
        await updateRows(
          'alert_deliveries',
          { status: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null },
          [{ column: 'id', operator: 'eq', value: readString(row, 'id') }],
        )
        sent += 1
      } catch (error) {
        await updateRows(
          'alert_deliveries',
          {
            attempts,
            last_error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
          },
          [{ column: 'id', operator: 'eq', value: readString(row, 'id') }],
        )
      }
    }

    if (sent > 0) logStep('alert.deliveries_retried', { sent })
    return sent
  } catch (error) {
    console.error('[alerts] delivery retry sweep failed', error)
    return 0
  }
}
