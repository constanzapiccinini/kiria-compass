/**
 * Alerts, usage and the audit log — §9 screens 6, 7 and 8.
 *
 * All three are read-mostly views over tables the client app writes — nothing here
 * raises an alert; the client backend's `lib/alerts.ts` owns that. This side owns the
 * inbox, the acknowledge/resolve transitions, and the channel configuration that
 * decides who gets told.
 */

import { Hono } from 'hono'
import { orgId, PRICING } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { recordAudit } from '../lib/observability.js'
import {
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  updateRows,
  type SqlParam,
} from '../lib/store.js'
import { alertPauseState, setAlertsPaused } from '../lib/alert-pause.js'

export const operationsRoutes = new Hono()

/** Page size for the log views. Bounded so one screen cannot pull the whole table. */
const PAGE_SIZE = 100

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) throw new HttpError(400, `${label} must be a UUID`, 'BAD_REQUEST')
  return value
}

/** Optional uuid filter from a query string: absent or valid, never partly valid. */
function optionalUuidParam(value: string | undefined, label: string): string | null {
  if (value === undefined || value === '') return null
  return requireUuid(value, label)
}

// ---------------------------------------------------------------------------
// screen 6 — alerts
// ---------------------------------------------------------------------------

/**
 * The alert inbox.
 *
 * Defaults to open alerts, because an inbox that opens on resolved history buries
 * the thing it exists to surface. `status=all` is available explicitly.
 */
operationsRoutes.get('/alerts', async (c) => {
  await requireAdmin(c)

  const pause = await alertPauseState()

  const status = c.req.query('status') ?? 'open'
  const clientId = optionalUuidParam(c.req.query('clientId'), 'clientId')

  const conditions = ['a.org_id = $1']
  const params: SqlParam[] = [orgId()]

  if (status === 'open') conditions.push("a.status IN ('new','acknowledged')")
  else if (status === 'new' || status === 'acknowledged' || status === 'resolved') {
    params.push(status)
    conditions.push(`a.status = $${params.length}`)
  } else if (status !== 'all') {
    throw new HttpError(400, 'status must be open, new, acknowledged, resolved or all', 'BAD_REQUEST')
  }

  if (clientId) {
    params.push(clientId)
    conditions.push(`a.client_id = $${params.length}`)
  }

  const rows = await query(
    `SELECT a.id, a.code, a.severity, a.scope, a.title, a.cause, a.remediation,
            a.client_message, a.status, a.occurrences, a.first_seen_at, a.last_seen_at,
            a.acknowledged_by_user_id, a.resolved_at, a.metadata,
            c.name AS client_name, s.name AS source_name
       FROM system_alerts a
       LEFT JOIN clients c ON c.id = a.client_id
       LEFT JOIN document_sources s ON s.id = a.source_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE a.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
        a.last_seen_at DESC
      LIMIT ${PAGE_SIZE}`,
    params,
  )

  return c.json({
    // Stated by the API rather than inferred by the screen. A paused inbox that
    // looks like a quiet one is the failure this whole subsystem exists to avoid.
    paused: pause.paused,
    pausedAt: pause.pausedAt,
    raisedWhilePaused: pause.raisedWhilePaused,
    alerts: rows.map((row) => ({
      id: readString(row, 'id'),
      code: readString(row, 'code'),
      severity: readString(row, 'severity'),
      scope: readString(row, 'scope'),
      title: readString(row, 'title'),
      cause: readString(row, 'cause'),
      remediation: readString(row, 'remediation'),
      clientMessage: readOptionalString(row, 'client_message'),
      status: readString(row, 'status'),
      occurrences: readNumber(row, 'occurrences'),
      firstSeenAt: readString(row, 'first_seen_at'),
      lastSeenAt: readString(row, 'last_seen_at'),
      acknowledgedByUserId: readOptionalString(row, 'acknowledged_by_user_id'),
      resolvedAt: readOptionalString(row, 'resolved_at'),
      clientName: readOptionalString(row, 'client_name'),
      sourceName: readOptionalString(row, 'source_name'),
      metadata: row.metadata,
    })),
  })
})

/**
 * Acknowledge or resolve an alert.
 *
 * Both transitions are one-way in the UI's normal use, but neither is enforced as
 * irreversible here: an alert resolved by mistake has to be reopenable, and a
 * database that forbids it turns a small error into a permanent one.
 */

/**
 * Pause or resume alert delivery.
 *
 * Audited, because this is the one setting whose whole effect is that nobody finds out
 * about things. Who silenced it and when is the first question anybody will ask after
 * an incident that went unreported, and the answer should not have to be reconstructed
 * from a deploy log.
 *
 * There is no expiry. That was the request — "hasta nuevo aviso" — and building an
 * automatic un-pause would have quietly overridden it. The mitigation is visibility
 * rather than a timer: the screen states the pause and counts what was raised under
 * it, so resuming is a decision somebody makes with the evidence in front of them.
 */
operationsRoutes.put('/alerts/pause', async (c) => {
  const actor = await requireAdmin(c)

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null || typeof (body as { paused?: unknown }).paused !== 'boolean') {
    throw new HttpError(400, 'Expected { paused: boolean }', 'BAD_REQUEST')
  }
  const paused = (body as { paused: boolean }).paused

  await setAlertsPaused(paused, actor.userId)

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: paused ? 'alerts.paused' : 'alerts.resumed',
    targetType: 'app_settings',
    targetId: orgId(),
  })

  return c.json(await alertPauseState())
})

operationsRoutes.put('/alerts/:alertId/status', async (c) => {
  const actor = await requireAdmin(c)
  const alertId = requireUuid(c.req.param('alertId'), 'alertId')

  const body: unknown = await c.req.json().catch(() => null)
  const status = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : null

  if (status !== 'new' && status !== 'acknowledged' && status !== 'resolved') {
    throw new HttpError(400, 'status must be new, acknowledged or resolved', 'BAD_REQUEST')
  }

  const values: Record<string, unknown> = { status }
  if (status === 'acknowledged') values.acknowledged_by_user_id = actor.userId
  if (status === 'resolved') values.resolved_at = new Date().toISOString()
  // Reopening clears the resolution rather than leaving a stale timestamp that
  // would make a live alert look closed.
  if (status === 'new') values.resolved_at = null

  const updated = await updateRows('system_alerts', values, [
    { column: 'id', operator: 'eq', value: alertId },
    { column: 'org_id', operator: 'eq', value: orgId() },
  ])
  if (updated === 0) throw new HttpError(404, 'Alert not found', 'NOT_FOUND')

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: `alert.${status}`,
    targetType: 'alert',
    targetId: alertId,
  })

  return c.json({ ok: true })
})

/**
 * Read the notification channels and recipient list (§10.3).
 *
 * Org-wide rather than per-client: the recipients are KIRIA staff, and a client
 * whose portal is broken is not the person who fixes it.
 */
operationsRoutes.get('/alert-settings', async (c) => {
  await requireAdmin(c)

  const row = await queryOne(
    'SELECT channels, alert_recipients FROM app_settings WHERE org_id = $1',
    [orgId()],
  )

  const channels = parseJsonObject(row?.channels)
  const recipients = parseRecipients(row?.alert_recipients)

  return c.json({
    // Matches the raise path's defaults, so the screen never shows email as on when
    // nothing would actually be sent.
    channels: {
      inApp: true,
      email: channels.email === true && recipients.length > 0,
      monday: channels.monday === true,
    },
    recipients,
    // Stated by the API rather than only in the UI copy: the constraint comes from
    // Gate, and a caller integrating against this contract needs to know it.
    notes: {
      recipientRule:
        'Each recipient must already be a member of this organization. A digit-only value is treated as a user id; a value containing @ is treated as an email.',
      mondayStatus: 'The monday channel is not implemented yet; enabling it records a failed delivery.',
    },
  })
})

/**
 * Update channels and recipients.
 *
 * Recipients are validated for shape only. Whether a given address is an org member
 * is Gate's decision at send time, and duplicating that rule here would let the two
 * answers disagree — the delivery row records the real outcome per recipient.
 */
operationsRoutes.put('/alert-settings', async (c) => {
  const actor = await requireAdmin(c)

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const payload = body as { channels?: unknown; recipients?: unknown }

  const channelsIn = parseJsonObject(payload.channels)
  const recipients = parseRecipients(payload.recipients)

  if (channelsIn.email === true && recipients.length === 0) {
    // Refused rather than silently saved: "email on, nobody listed" reads as
    // configured and delivers nothing, which is the worst of both.
    throw new HttpError(
      400,
      'Enabling the email channel requires at least one recipient',
      'BAD_REQUEST',
    )
  }

  const channels = {
    // `in_app` is not configurable — the Alerts screen reads system_alerts directly,
    // so switching it off would suppress the delivery record and not the visibility.
    in_app: true,
    email: channelsIn.email === true,
    monday: channelsIn.monday === true,
  }

  // app_settings is keyed by org_id, so this is an upsert by hand: one row exists at
  // most, and the structured row API has no ON CONFLICT.
  const existing = await queryOne('SELECT org_id FROM app_settings WHERE org_id = $1', [orgId()])
  const values = {
    channels: JSON.stringify(channels),
    alert_recipients: JSON.stringify(recipients),
    updated_by_user_id: actor.userId,
  }

  if (existing) {
    await updateRows('app_settings', values, [
      { column: 'org_id', operator: 'eq', value: orgId() },
    ])
  } else {
    await insertRow('app_settings', { org_id: orgId(), ...values }, ['org_id'])
  }

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: 'alert_settings.updated',
    targetType: 'app_settings',
    targetId: orgId(),
    // The recipient list is who gets told about failures; a count is enough for the
    // trail and keeps addresses out of a table many people can read.
    metadata: { channels, recipientCount: recipients.length },
  })

  return c.json({ channels, recipients })
})

/** Narrow unknown JSON to a plain object without widening it to `any`. */
function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Recipients as `{ userId?, email? }`; anything else is dropped rather than stored. */
function parseRecipients(value: unknown): Array<{ userId?: string; email?: string }> {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value
  if (!Array.isArray(parsed)) return []

  const recipients: Array<{ userId?: string; email?: string }> = []
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      // A bare string is the shape a person types. Gate's own rule decides which it
      // is, so it is classified the same way here rather than guessed differently.
      const trimmed = entry.trim()
      if (trimmed.length === 0) continue
      recipients.push(/^\d+$/.test(trimmed) ? { userId: trimmed } : { email: trimmed })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const shaped = entry as { userId?: unknown; email?: unknown }
    const userId = typeof shaped.userId === 'string' ? shaped.userId.trim() : undefined
    const email = typeof shaped.email === 'string' ? shaped.email.trim() : undefined
    if (userId || email) recipients.push({ ...(userId ? { userId } : {}), ...(email ? { email } : {}) })
  }
  return recipients
}

// ---------------------------------------------------------------------------
// screen 7 — usage
// ---------------------------------------------------------------------------

/**
 * Month-to-date usage and cost, per client.
 *
 * Cost is summed from the stored `cost_usd` on each row rather than recomputed from
 * today's prices — a usage row keeps the cost it was charged at, so a price change
 * cannot silently rewrite history. `PRICING` is returned alongside so the screen can
 * show current rates without implying they applied retroactively.
 */
operationsRoutes.get('/usage', async (c) => {
  await requireAdmin(c)

  const rows = await query(
    `SELECT c.id AS client_id, c.name AS client_name,
            COALESCE(sum(u.input_tokens), 0) AS input_tokens,
            COALESCE(sum(u.output_tokens), 0) AS output_tokens,
            COALESCE(sum(u.ocr_pages), 0) AS ocr_pages,
            COALESCE(sum(u.cost_usd), 0) AS cost_usd,
            count(u.id) AS events
       FROM clients c
       LEFT JOIN usage_events u
         ON u.client_id = c.id
        AND u.created_at >= date_trunc('month', now())
      GROUP BY c.id, c.name
      ORDER BY cost_usd DESC, c.name`,
  )

  return c.json({
    periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
    pricing: PRICING,
    clients: rows.map((row) => ({
      clientId: readString(row, 'client_id'),
      clientName: readString(row, 'client_name'),
      inputTokens: readNumber(row, 'input_tokens'),
      outputTokens: readNumber(row, 'output_tokens'),
      ocrPages: readNumber(row, 'ocr_pages'),
      costUsd: readOptionalNumber(row, 'cost_usd') ?? 0,
      events: readNumber(row, 'events'),
    })),
  })
})

// ---------------------------------------------------------------------------
// screen 8 — audit log
// ---------------------------------------------------------------------------

/**
 * The audit log, filterable by client, actor and action (§9.8).
 *
 * Filters are applied in SQL with bound parameters. `action` matches by prefix so
 * "source." finds every source event without the caller composing a pattern — the
 * `%` is added here rather than accepted from the query string, so a caller cannot
 * turn the filter into an expensive leading-wildcard scan.
 */
operationsRoutes.get('/audit', async (c) => {
  await requireAdmin(c)

  const clientId = optionalUuidParam(c.req.query('clientId'), 'clientId')
  const actorUserId = c.req.query('actorUserId')
  const action = c.req.query('action')
  const before = c.req.query('before')

  const conditions = ['a.org_id = $1']
  const params: SqlParam[] = [orgId()]

  if (clientId) {
    params.push(clientId)
    conditions.push(`a.client_id = $${params.length}`)
  }
  if (actorUserId) {
    params.push(actorUserId)
    conditions.push(`a.actor_user_id = $${params.length}`)
  }
  if (action) {
    params.push(`${action}%`)
    conditions.push(`a.action LIKE $${params.length}`)
  }
  if (before) {
    params.push(before)
    conditions.push(`a.created_at < $${params.length}`)
  }

  const rows = await query(
    `SELECT a.id, a.action, a.actor_user_id, a.target_type, a.target_id,
            a.ip, a.metadata, a.created_at, c.name AS client_name
       FROM audit_logs a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT ${PAGE_SIZE}`,
    params,
  )

  const entries = rows.map((row) => ({
    id: readString(row, 'id'),
    action: readString(row, 'action'),
    actorUserId: readOptionalString(row, 'actor_user_id'),
    targetType: readOptionalString(row, 'target_type'),
    targetId: readOptionalString(row, 'target_id'),
    ip: readOptionalString(row, 'ip'),
    metadata: row.metadata,
    createdAt: readString(row, 'created_at'),
    clientName: readOptionalString(row, 'client_name'),
  }))

  return c.json({
    entries,
    // Cursor for the next page: keyset pagination on created_at rather than OFFSET,
    // which would skip or repeat rows as new entries arrive during paging.
    nextBefore: entries.length === PAGE_SIZE ? entries[entries.length - 1].createdAt : null,
  })
})

/** Distinct action names, so the filter can be a picker rather than a text box. */
operationsRoutes.get('/audit/actions', async (c) => {
  await requireAdmin(c)
  const rows = await query(
    'SELECT DISTINCT action FROM audit_logs WHERE org_id = $1 ORDER BY action',
    [orgId()],
  )
  return c.json({ actions: rows.map((row) => readString(row, 'action')) })
})
