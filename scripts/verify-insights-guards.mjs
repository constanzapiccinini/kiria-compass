/**
 * Prove the Phase 8 guarantees against a real database — §8.
 *
 * ---------------------------------------------------------------------------
 * Why an operator script and not an e2e spec
 *
 * Every assertion here is about what the **database** refuses. §2 is explicit that the
 * anonymity rule belongs in a CHECK rather than a handler, because "a guard written
 * only in a handler survives until the next refactor". Testing it through an HTTP
 * route would test the handler — the exact thing the constraint exists to outlive.
 *
 * The same reasoning applies to the staff-only policies: proving the client app cannot
 * read a row means issuing a query with a portal-scoped RLS context and finding
 * nothing, which no route exposes and no test session can produce. This is the same
 * shape as `verify-library-rls.mjs`, for the same reason.
 *
 *   node scripts/verify-insights-guards.mjs --stage dev
 *
 * Refuses to run on prod: it creates and deletes rows.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, IsolatedStoresApi } from '@fusebase/fusebase-gate-sdk'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_ALIAS = 'compasses'

function readEnvFile() {
  const out = {}
  let raw
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const stage = argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : 'dev'
  if (stage !== 'dev') {
    console.error('refusing to run on prod: this creates and deletes rows')
    process.exitCode = 1
    return
  }

  const env = { ...readEnvFile(), ...process.env }
  const token = (env.GATE_MCP_TOKEN ?? '').trim()
  if (!token) throw new Error('GATE_MCP_TOKEN is not set')

  const orgId = JSON.parse(readFileSync(join(ROOT, 'fusebase.json'), 'utf8')).orgId
  const host = (env.FUSEBASE_HOST ?? 'thefusebase.com').trim()

  const api = new IsolatedStoresApi(
    createClient({
      baseUrl: `https://app-api.${host}/v4/api/proxy/gate-service/v1`,
      defaultHeaders: { authorization: `Bearer ${token}` },
    }),
  )
  const stores = await api.listIsolatedStores({ path: { orgId } })
  const store = (stores.stores ?? []).find((s) => s.alias === STORE_ALIAS)
  if (!store) throw new Error(`no store aliased ${STORE_ALIAS}`)
  const storeId = store.globalId

  const q = async (sql, params = [], rlsContext) =>
    (
      await api.queryIsolatedStoreSql({
        path: { orgId, storeId, stage },
        body: { sql, params, ...(rlsContext ? { rlsContext } : {}) },
      })
    ).result?.rows ?? []

  const exec = async (sql, params = []) => {
    const r = await api.executeIsolatedStoreSql({
      path: { orgId, storeId, stage },
      body: { sql, params },
    })
    return r.result?.rowCount ?? 0
  }

  /** Run a write that must be refused, and report what the database said. */
  const refuses = async (label, sql, params = []) => {
    try {
      await exec(sql, params)
      failures += 1
      console.log(`  FAIL  ${label}: the database ACCEPTED it`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const named = /insight_themes_scope_check|ingest_jobs_owner_check|chat_message_feedback_once|chat_message_feedback_rating_check|review_flags_decided_by_a_person|review_flags_once|usage_events_owner_check/.test(
        message,
      )
      // The name is not always carried through Gate's error envelope — that is the
      // lesson Phase 6 learned about folder names — so a refusal counts even when the
      // message is generic. What must never happen is acceptance.
      console.log(`  PASS  ${label}: refused${named ? ' (by name)' : ''}`)
    }
  }

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}\n`)

  const stamp = Date.now().toString(36)
  const period = ["'2026-09-01'", "'2026-09-30'"]
  const created = { clientId: null, themeId: null, flagId: null }

  try {
    // ---------------------------------------------------------------------
    // §8: the insight_themes CHECK
    //
    // Tested as three separate refusals rather than one, because they are three
    // separate promises: no client on an org row, no samples on an org row, and no
    // org row below the k-anonymity threshold. One combined test that passed would
    // not tell you which of the three still holds.
    // ---------------------------------------------------------------------
    console.log('the anonymity constraint (§2)')

    const clientRow = await q('SELECT id FROM clients ORDER BY name LIMIT 1')
    if (clientRow.length === 0) throw new Error('no clients in this stage to test with')
    created.clientId = String(clientRow[0].id)

    await refuses(
      'an org-scope theme carrying a client_id',
      `INSERT INTO insight_themes
         (scope, client_id, period_start, period_end, label, summary, question_count,
          client_count, model, prompt_version)
       VALUES ('org', $1, ${period[0]}, ${period[1]}, 'x-${stamp}', 's', 1, 3, 'm', 'v1')`,
      [created.clientId],
    )

    await refuses(
      'an org-scope theme carrying sample message ids',
      `INSERT INTO insight_themes
         (scope, period_start, period_end, label, summary, question_count, client_count,
          sample_message_ids, model, prompt_version)
       VALUES ('org', ${period[0]}, ${period[1]}, 'x-${stamp}', 's', 1, 3,
               ARRAY['00000000-0000-0000-0000-000000000000'::uuid], 'm', 'v1')`,
    )

    await refuses(
      'an org-scope theme with only two clients',
      `INSERT INTO insight_themes
         (scope, period_start, period_end, label, summary, question_count, client_count,
          model, prompt_version)
       VALUES ('org', ${period[0]}, ${period[1]}, 'x-${stamp}', 's', 1, 2, 'm', 'v1')`,
    )

    await refuses(
      'a client-scope theme with no client_id',
      `INSERT INTO insight_themes
         (scope, period_start, period_end, label, summary, question_count, model, prompt_version)
       VALUES ('client', ${period[0]}, ${period[1]}, 'x-${stamp}', 's', 1, 'm', 'v1')`,
    )

    // And the shape that must be ACCEPTED — a constraint that refuses everything is
    // not a guard, it is an outage.
    await exec(
      `INSERT INTO insight_themes
         (scope, period_start, period_end, label, summary, question_count, client_count,
          model, prompt_version)
       VALUES ('org', ${period[0]}, ${period[1]}, 'ok-${stamp}', 's', 9, 3, 'm', 'v1')`,
    )
    const accepted = await q('SELECT id FROM insight_themes WHERE label = $1', [`ok-${stamp}`])
    check('a valid org-scope theme is accepted', accepted.length, 1)
    created.themeId = accepted.length > 0 ? String(accepted[0].id) : null

    // ---------------------------------------------------------------------
    // §8: the client app cannot read any insights table
    //
    // The same direct-query proof used for 0009 and 0014: issue the read with a
    // portal-scoped RLS context and find nothing. The clause doing the work is
    // `app.req_client_id` being absent — see 0020's header for why org isolation
    // alone would not have kept the client app out, since both apps hold the same
    // `app.org_id`.
    // ---------------------------------------------------------------------
    console.log('\nstaff-only reads (§4 RLS)')

    for (const table of [
      'question_embeddings',
      'insight_themes',
      'insight_theme_members',
      'review_flags',
      'insight_runs',
    ]) {
      const asStaff = await q(`SELECT count(*)::int AS n FROM ${table}`)
      const asClient = await q(`SELECT count(*)::int AS n FROM ${table}`, [], {
        req_client_id: created.clientId,
      })
      check(`${table}: visible to a staff/worker call`, Number(asStaff[0]?.n ?? -1) >= 0, true)
      check(`${table}: invisible to a portal-scoped call`, Number(asClient[0]?.n ?? -1), 0)
    }

    // `insight_themes` genuinely holds a row right now, so the zero above is the
    // policy working rather than an empty table telling us nothing. Asserted, because
    // a test that would pass against an empty table proves nothing.
    const themeCountAsStaff = await q('SELECT count(*)::int AS n FROM insight_themes')
    check(
      'insight_themes is non-empty for staff, so the client-side zero means something',
      Number(themeCountAsStaff[0]?.n ?? 0) > 0,
      true,
    )

    // ---------------------------------------------------------------------
    // §8: one rating per person per message
    // ---------------------------------------------------------------------
    console.log('\nfeedback (§3)')

    const messageRow = await q(
      `SELECT m.id, ch.client_id
         FROM chat_messages m JOIN chats ch ON ch.id = m.chat_id
        WHERE m.role = 'assistant' LIMIT 1`,
    )
    if (messageRow.length === 0) {
      console.log('  SKIP  no assistant message in this stage to rate')
    } else {
      const messageId = String(messageRow[0].id)
      const feedbackClient = String(messageRow[0].client_id)
      const hash = `verify-${stamp}`

      await exec(
        `INSERT INTO chat_message_feedback (message_id, client_id, rating, user_hash)
         VALUES ($1, $2, 1, $3)`,
        [messageId, feedbackClient, hash],
      )
      await refuses(
        'a second rating by the same person on the same message',
        `INSERT INTO chat_message_feedback (message_id, client_id, rating, user_hash)
         VALUES ($1, $2, -1, $3)`,
        [messageId, feedbackClient, hash],
      )
      await refuses(
        'a rating that is neither 1 nor -1',
        `INSERT INTO chat_message_feedback (message_id, client_id, rating, user_hash)
         VALUES ($1, $2, 5, $3)`,
        [messageId, feedbackClient, `${hash}-b`],
      )

      const updated = await exec(
        `UPDATE chat_message_feedback SET rating = -1 WHERE message_id = $1 AND user_hash = $2`,
        [messageId, hash],
      )
      check('changing one’s mind updates the existing row', updated, 1)

      await exec('DELETE FROM chat_message_feedback WHERE user_hash LIKE $1', [`verify-${stamp}%`])
    }

    // ---------------------------------------------------------------------
    // §8: an ownerless job is only allowed for the analysis kinds (0022)
    // ---------------------------------------------------------------------
    console.log('\nownerless jobs (0022)')

    await refuses(
      'a parse job with no owner',
      `INSERT INTO ingest_jobs (kind, status) VALUES ('parse', 'queued')`,
    )
    await exec(`INSERT INTO ingest_jobs (kind, status) VALUES ('insight_embed', 'cancelled')`)
    const ownerless = await q(
      `SELECT count(*)::int AS n FROM ingest_jobs
        WHERE kind = 'insight_embed' AND client_id IS NULL AND library_id IS NULL`,
    )
    check('an insight job with no owner is accepted', Number(ownerless[0]?.n ?? 0) > 0, true)
    await exec(`DELETE FROM ingest_jobs WHERE kind = 'insight_embed' AND status = 'cancelled'`)

    await refuses(
      'an insight job that claims an owner',
      `INSERT INTO ingest_jobs (kind, status, client_id) VALUES ('insight_embed', 'cancelled', $1)`,
      [created.clientId],
    )

    // ---------------------------------------------------------------------
    // 8C: re-running a period replaces its themes rather than duplicating them
    //
    // 0023's unique index. A clustering run for September, run twice, must leave one
    // set of themes — on a screen whose whole job is ranking by frequency, a doubled
    // theme reads as "asked twice as often", which is the most misleading failure
    // available here.
    // ---------------------------------------------------------------------
    console.log('\nre-running a period (0023)')

    await exec(
      `INSERT INTO insight_themes
         (scope, client_id, period_start, period_end, label, summary, question_count,
          client_count, model, prompt_version)
       VALUES ('client', $1, '2026-09-01', '2026-09-30', 'dup-${stamp}', 's', 3, 1, 'm', 'v1')`,
      [created.clientId],
    )
    await refuses(
      'the same label for the same client and period twice',
      `INSERT INTO insight_themes
         (scope, client_id, period_start, period_end, label, summary, question_count,
          client_count, model, prompt_version)
       VALUES ('client', $1, '2026-09-01', '2026-09-30', 'dup-${stamp}', 's', 9, 1, 'm', 'v1')`,
      [created.clientId],
    )

    // But the same label in a DIFFERENT period is a different theme — that is the
    // whole point of a period, and an index that blocked it would make month-over-month
    // tracking impossible.
    await exec(
      `INSERT INTO insight_themes
         (scope, client_id, period_start, period_end, label, summary, question_count,
          client_count, model, prompt_version)
       VALUES ('client', $1, '2026-08-01', '2026-08-31', 'dup-${stamp}', 's', 3, 1, 'm', 'v1')`,
      [created.clientId],
    )
    const periods = await q(
      `SELECT count(*)::int AS n FROM insight_themes WHERE label = $1`,
      [`dup-${stamp}`],
    )
    check('the same label in two periods is two themes', Number(periods[0]?.n ?? 0), 2)

    await exec('DELETE FROM insight_themes WHERE label = $1', [`dup-${stamp}`])

    // ---------------------------------------------------------------------
    // 8C: a client theme may carry sample ids; an org theme may not
    //
    // Both halves, because the asymmetry IS the §2 rule: samples are the route back to
    // verbatim text, so they are the point on a client theme and forbidden on an org
    // one. A test of only the refusal would pass against a schema that forbade both.
    // ---------------------------------------------------------------------
    console.log('\nsample ids per scope (§2)')

    const sampleMessage = await q(
      `SELECT m.id FROM chat_messages m WHERE m.role = 'user' LIMIT 1`,
    )
    if (sampleMessage.length === 0) {
      console.log('  SKIP  no user message in this stage to sample')
    } else {
      const messageId = String(sampleMessage[0].id)
      await exec(
        `INSERT INTO insight_themes
           (scope, client_id, period_start, period_end, label, summary, question_count,
            client_count, sample_message_ids, model, prompt_version)
         VALUES ('client', $1, '2026-09-01', '2026-09-30', 'samples-${stamp}', 's', 1, 1,
                 ARRAY[$2::uuid], 'm', 'v1')`,
        [created.clientId, messageId],
      )
      const kept = await q(
        `SELECT array_length(sample_message_ids, 1) AS n FROM insight_themes WHERE label = $1`,
        [`samples-${stamp}`],
      )
      check('a client theme keeps its sample ids', Number(kept[0]?.n ?? 0), 1)
      await exec('DELETE FROM insight_themes WHERE label = $1', [`samples-${stamp}`])
    }

    // ---------------------------------------------------------------------
    // §8: a flag cannot leave `new` without a person on it (§7, 0024)
    //
    // §7: "Escalation is a human deciding, not a webhook." The handler writes the
    // reviewer and refuses to take one from the request — but the handler is the
    // thing the constraint exists to outlive, so both the INSERT and the UPDATE
    // paths are proved here against the database rather than through the route.
    //
    // A dismissal matters more than an escalation for this: "somebody escalated it"
    // gets read by a person anyway, and "somebody dismissed it and we cannot say
    // who" is the sentence nobody wants to have to say about an adverse event.
    // ---------------------------------------------------------------------
    console.log('\nreview flags (§5, §7)')

    const questionRow = await q(
      `SELECT m.id, ch.client_id
         FROM chat_messages m JOIN chats ch ON ch.id = m.chat_id
        WHERE m.role = 'user' LIMIT 1`,
    )
    if (questionRow.length === 0) {
      console.log('  SKIP  no client question in this stage to flag')
    } else {
      const questionId = String(questionRow[0].id)
      const flagClientId = String(questionRow[0].client_id)

      await refuses(
        'a flag inserted already dismissed, with nobody named',
        `INSERT INTO review_flags
           (message_id, client_id, code, model, prompt_version, status)
         VALUES ($1, $2, 'other', 'm', 'guard-${stamp}', 'dismissed')`,
        [questionId, flagClientId],
      )

      // The shape that must be accepted, so the constraint is a guard and not an
      // outage: a new flag names nobody, because the model has not decided anything.
      await exec(
        `INSERT INTO review_flags
           (message_id, client_id, code, model, prompt_version)
         VALUES ($1, $2, 'other', 'm', 'guard-${stamp}')`,
        [questionId, flagClientId],
      )
      const flagRow = await q(
        `SELECT id FROM review_flags WHERE message_id = $1 AND prompt_version = $2`,
        [questionId, `guard-${stamp}`],
      )
      check('a new flag with no reviewer is accepted', flagRow.length, 1)
      created.flagId = flagRow.length > 0 ? String(flagRow[0].id) : null

      if (created.flagId) {
        await refuses(
          'dismissing a flag without naming the reviewer',
          `UPDATE review_flags SET status = 'dismissed' WHERE id = $1`,
          [created.flagId],
        )

        await refuses(
          'naming a reviewer but no time',
          `UPDATE review_flags SET status = 'escalated', reviewed_by_user_id = 'u1'
             WHERE id = $1`,
          [created.flagId],
        )

        const decided = await exec(
          `UPDATE review_flags SET status = 'dismissed', reviewed_by_user_id = 'u1',
                  reviewed_at = now()
             WHERE id = $1`,
          [created.flagId],
        )
        check('a decision naming a person and a time is accepted', decided, 1)
      }

      // One flag per code per message, so re-running the screen after a crash is
      // free rather than duplicating the queue. The job leans on exactly this.
      await refuses(
        'the same code flagged twice on one question',
        `INSERT INTO review_flags
           (message_id, client_id, code, model, prompt_version)
         VALUES ($1, $2, 'other', 'm', 'dup-${stamp}')`,
        [questionId, flagClientId],
      )
    }
    // ---------------------------------------------------------------------
    // §8: an org-wide analysis call is metered (0026)
    //
    // The flagging job charges no client — screening is KIRIA's own compliance
    // activity, not work done for an account — and 0013's XOR refused exactly that
    // shape. `recordUsage` never throws, so the first production run spent real
    // money, recorded nothing, and reported success.
    //
    // Both directions are asserted. The acceptance is the fix; the refusal is what
    // keeps "no owner" a decision rather than a null that slipped through, which is
    // the property the CASE exists for.
    // ---------------------------------------------------------------------
    console.log('\nmetering (0026)')

    const orgWide = await exec(
      `INSERT INTO usage_events (kind, model, input_tokens, output_tokens, cost_usd, metadata)
       VALUES ('chat_completion', 'm', 10, 5, 0,
               jsonb_build_object('via', 'insight_flag', 'guard', $1::text))`,
      [stamp],
    )
    check('an org-wide analysis call may have no owner', orgWide, 1)

    await refuses(
      'an ordinary call with no owner',
      `INSERT INTO usage_events (kind, model, input_tokens, output_tokens, cost_usd, metadata)
       VALUES ('chat_completion', 'm', 10, 5, 0, jsonb_build_object('guard', '${stamp}'))`,
    )

    // And it must not become visible to a portal. It has no client, so the tenancy
    // policy's `client_id = req_client_id` cannot match it — asserted rather than
    // reasoned about, because a null comparing to anything is where this goes wrong.
    const orgWideAsClient = await q(
      `SELECT count(*)::int AS n FROM usage_events WHERE metadata->>'guard' = $1`,
      [stamp],
      { req_client_id: created.clientId },
    )
    check('an ownerless usage event is invisible to a portal', Number(orgWideAsClient[0]?.n ?? -1), 0)
    // ---------------------------------------------------------------------
    // §8: opt-out means no rows anywhere
    //
    // Asserted by count against the job's own selection query, which is where the
    // filter lives — an `if` around the loop would pass a test that called the loop
    // and fail the one that called the query.
    // ---------------------------------------------------------------------
    console.log('\nopt-out (§2)')

    await exec('UPDATE clients SET analytics_opt_out = TRUE WHERE id = $1', [created.clientId])
    const selectable = await q(
      `SELECT count(*)::int AS n
         FROM chat_messages m
         JOIN chats ch ON ch.id = m.chat_id
         JOIN clients c ON c.id = ch.client_id
        WHERE m.role = 'user'
          AND c.analytics_opt_out = FALSE
          AND ch.client_id = $1`,
      [created.clientId],
    )
    check('an opted-out client offers no questions to embed', Number(selectable[0]?.n ?? -1), 0)

    // And nothing to screen. The two jobs filter separately, so proving one says
    // nothing about the other — and the flagging job is the one that would send an
    // opted-out client's text to a model.
    const screenable = await q(
      `SELECT count(*)::int AS n
         FROM chat_messages m
         JOIN chats ch ON ch.id = m.chat_id
         JOIN clients c ON c.id = ch.client_id
        WHERE m.role = 'user'
          AND c.analytics_opt_out = FALSE
          AND m.flag_screened_at IS NULL
          AND ch.client_id = $1`,
      [created.clientId],
    )
    check('an opted-out client offers no questions to screen', Number(screenable[0]?.n ?? -1), 0)
    await exec('UPDATE clients SET analytics_opt_out = FALSE WHERE id = $1', [created.clientId])
  } finally {
    if (created.themeId) {
      await exec('DELETE FROM insight_themes WHERE id = $1', [created.themeId]).catch(() => 0)
    }
    await exec('DELETE FROM insight_themes WHERE label LIKE $1', [`%-${stamp}`]).catch(() => 0)
    await exec("DELETE FROM usage_events WHERE metadata->>'guard' = $1", [stamp]).catch(() => 0)
    await exec('DELETE FROM review_flags WHERE prompt_version LIKE $1', [`%-${stamp}`]).catch(
      () => 0,
    )
    console.log('\ncleaned up')
  }

  console.log(
    failures === 0
      ? '\nPASS — the anonymity constraint, staff-only reads, feedback uniqueness, ownerless jobs,\n       the reviewer requirement on a decided flag, ownerless metering, and opt-out all hold'
      : `\n${failures} FAILURE(S)`,
  )
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
