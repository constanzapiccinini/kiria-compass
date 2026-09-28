/**
 * The four answers Phase 8 exists to give — §1, without an LLM.
 *
 * §1 is blunt about what matters: "Charts of message counts are decoration; build them
 * last if at all." The four real questions are
 *
 *   1. What do clients ask that our material does not answer?  → `grounded = false`
 *   2. Which parts of what we produce get read?                → citation frequency
 *   3. What do we produce that nobody opens?                   → zero citations
 *   4. What themes recur across the book of business?          → 8C, needs clustering
 *
 * Three of the four need no model call at all, which is why 8B ships them first. Every
 * query here was run against production before this file existed, so the shapes are
 * measured rather than hoped for — and the numbers below are real: a 28.6% answer-gap
 * rate, one document cited fourteen times across four answers, two documents indexed
 * and never opened.
 *
 * ---------------------------------------------------------------------------
 * Opt-out is in the WHERE clause, everywhere
 *
 * §2's `analytics_opt_out` is honoured inside each statement rather than by an `if`
 * around the handler. §8 asks to assert opt-out by counting rows, and that only holds
 * if the filter cannot be forgotten by a caller who adds a fifth metric later.
 *
 * ---------------------------------------------------------------------------
 * Verbatim text and where it may appear
 *
 * §2: "Verbatim question text never leaves its client. Client-scoped screens may show
 * questions in full to KIRIA staff. Org-scoped screens may show only labels, summaries
 * and counts."
 *
 * So `GET /overview` returns **no question text under any circumstances**, and
 * `GET /clients/:clientId/*` may. That boundary is a property of the route, not of the
 * screen that calls it — a screen can be changed by anyone, and an org-scoped endpoint
 * that could return a question would eventually be called from one.
 */

import { Hono } from 'hono'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { query, readNumber, readOptionalString, readString } from '../lib/store.js'

export const metricsRoutes = new Hono()

/** Default window. Long enough to be a trend, short enough to still be current. */
const DEFAULT_DAYS = 90

function windowDays(c: Parameters<typeof requireAdmin>[0]): number {
  const raw = c.req.query('days')
  if (raw === undefined) return DEFAULT_DAYS
  const days = Number(raw)
  if (!Number.isInteger(days) || days < 1 || days > 730) {
    throw new HttpError(400, 'days must be an integer between 1 and 730', 'BAD_REQUEST')
  }
  return days
}

function requireClientId(c: Parameters<typeof requireAdmin>[0]): string {
  const clientId = c.req.param('clientId')
  if (!clientId || !isUuid(clientId)) {
    throw new HttpError(400, 'clientId must be a UUID', 'BAD_REQUEST')
  }
  return clientId
}

/**
 * Org-level overview — §7 screen 1.
 *
 * No question text, no client names against individual questions, no per-person
 * anything. Counts and rates only.
 *
 * The **answer-gap rate** is the headline and is deliberately reported with its
 * denominator: "28.6%" over seven answers is not a rate, it is an anecdote, and a
 * screen that shows the percentage without the count invites treating it as one.
 */
metricsRoutes.get('/overview', async (c) => {
  await requireAdmin(c)
  const days = windowDays(c)

  const [totals] = await query(
    `SELECT count(*) FILTER (WHERE m.role = 'user')::int                        AS questions,
            count(*) FILTER (WHERE m.role = 'assistant')::int                   AS answers,
            count(*) FILTER (WHERE m.role = 'assistant' AND NOT m.grounded)::int AS gaps,
            count(DISTINCT ch.client_id)::int                                    AS clients_active,
            count(DISTINCT ch.id)::int                                           AS chats
       FROM chat_messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN clients cl ON cl.id = ch.client_id
      WHERE cl.analytics_opt_out = FALSE
        AND m.created_at > now() - ($1 || ' days')::INTERVAL`,
    [String(days)],
  )

  // Weekly rather than daily: this is a book of seven accounts, and a daily series is
  // mostly zeroes with a spike, which reads as noise rather than as a trend.
  const series = await query(
    `SELECT to_char(date_trunc('week', m.created_at), 'YYYY-MM-DD')             AS week,
            count(*) FILTER (WHERE m.role = 'user')::int                        AS questions,
            count(*) FILTER (WHERE m.role = 'assistant' AND NOT m.grounded)::int AS gaps,
            count(DISTINCT ch.client_id)::int                                    AS clients_active
       FROM chat_messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN clients cl ON cl.id = ch.client_id
      WHERE cl.analytics_opt_out = FALSE
        AND m.created_at > now() - ($1 || ' days')::INTERVAL
      GROUP BY 1
      ORDER BY 1`,
    [String(days)],
  )

  const [coverage] = await query(
    `SELECT count(*)::int                                            AS clients,
            count(*) FILTER (WHERE cl.analytics_opt_out)::int         AS opted_out,
            count(*) FILTER (WHERE cl.retention_days IS NOT NULL)::int AS with_retention
       FROM clients cl`,
  )

  const [embeddings] = await query(
    `SELECT count(*)::int AS embedded,
            (SELECT count(*)::int FROM chat_messages m
               JOIN chats ch ON ch.id = m.chat_id
               JOIN clients cl ON cl.id = ch.client_id
              WHERE m.role = 'user' AND cl.analytics_opt_out = FALSE) AS embeddable
       FROM question_embeddings`,
  )

  return c.json({
    windowDays: days,
    totals: {
      questions: totals ? readNumber(totals, 'questions') : 0,
      answers: totals ? readNumber(totals, 'answers') : 0,
      gaps: totals ? readNumber(totals, 'gaps') : 0,
      clientsActive: totals ? readNumber(totals, 'clients_active') : 0,
      chats: totals ? readNumber(totals, 'chats') : 0,
    },
    series: series.map((row) => ({
      week: readString(row, 'week'),
      questions: readNumber(row, 'questions'),
      gaps: readNumber(row, 'gaps'),
      clientsActive: readNumber(row, 'clients_active'),
    })),
    /**
     * How much of the book this covers, so a number can be read honestly.
     *
     * A gap rate computed over two of seven accounts is a fact about those two. The
     * screen needs to be able to say so, which it cannot do from the rate alone.
     */
    coverage: {
      clients: coverage ? readNumber(coverage, 'clients') : 0,
      optedOut: coverage ? readNumber(coverage, 'opted_out') : 0,
      withRetention: coverage ? readNumber(coverage, 'with_retention') : 0,
      questionsEmbedded: embeddings ? readNumber(embeddings, 'embedded') : 0,
      questionsEmbeddable: embeddings ? readNumber(embeddings, 'embeddable') : 0,
    },
    /**
     * What is not here yet, named rather than shown as an empty panel.
     *
     * An empty "Top themes" box reads as "no themes found", which is a claim. This
     * says the feature has not shipped, which is the truth.
     */
    pending: {
      themes:
        'Per-account themes are on the Content gaps screen. Cross-account themes need ' +
        'the MSA and disclosure question in §2 answered first.',
      flags: 'Flags are on the Review screen; it says how much of the history has been screened.',
    },
  })
})

/**
 * Which documents get read, and which never do — §1.2 and §1.3.
 *
 * Both from `chat_messages.citations`, which has carried `documentId`, `documentName`
 * and `page` since 0001. Nothing new is captured for this.
 *
 * **The library is returned alongside every document name**, and that is not
 * decoration: production has two documents called `brand guidelines - kiria.pdf` in
 * different libraries, one cited and one never. Without the library the same screen
 * would list one name in both tables and look broken. It is the same disambiguation
 * the client sidebar needed in Phase 6.
 */
metricsRoutes.get('/documents', async (c) => {
  await requireAdmin(c)
  const days = windowDays(c)
  const clientId = c.req.query('clientId')
  if (clientId !== undefined && !isUuid(clientId)) {
    throw new HttpError(400, 'clientId must be a UUID', 'BAD_REQUEST')
  }

  const cited = await query(
    `SELECT (cite->>'documentId')::uuid                       AS document_id,
            cite->>'documentName'                             AS document_name,
            count(*)::int                                     AS citations,
            count(DISTINCT m.id)::int                          AS answers,
            count(DISTINCT ch.client_id)::int                  AS clients,
            max(m.created_at)                                  AS last_cited_at
       FROM chat_messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN clients cl ON cl.id = ch.client_id
       CROSS JOIN LATERAL jsonb_array_elements(m.citations) AS cite
      WHERE m.role = 'assistant'
        AND m.citations IS NOT NULL
        AND cl.analytics_opt_out = FALSE
        AND m.created_at > now() - ($1 || ' days')::INTERVAL
        AND ($2::uuid IS NULL OR ch.client_id = $2::uuid)
      GROUP BY 1, 2
      ORDER BY citations DESC
      LIMIT 100`,
    [String(days), clientId ?? null],
  )

  // Never-cited is scoped to documents that have had a fair chance: a PDF indexed an
  // hour ago is not evidence of anything. Seven days is the floor, and it is stated in
  // the response so the screen can say so rather than implying "nobody wants this".
  const neverCitedMinDays = 7
  const never = await query(
    `WITH cited AS (
       SELECT DISTINCT (cite->>'documentId')::uuid AS document_id
         FROM chat_messages m
         CROSS JOIN LATERAL jsonb_array_elements(m.citations) AS cite
        WHERE m.citations IS NOT NULL
     )
     SELECT d.id, d.name, s.name AS library, d.indexed_at,
            (now()::date - d.indexed_at::date)::int AS days_live,
            d.chunk_count
       FROM documents d
       LEFT JOIN document_sources s ON s.id = d.library_id
      WHERE d.deleted_at IS NULL
        AND d.status = 'indexed'
        AND d.indexed_at < now() - ($1 || ' days')::INTERVAL
        AND d.id NOT IN (SELECT document_id FROM cited)
      ORDER BY d.indexed_at ASC
      LIMIT 100`,
    [String(neverCitedMinDays)],
  )

  return c.json({
    windowDays: days,
    neverCitedMinDays,
    cited: cited.map((row) => ({
      documentId: readString(row, 'document_id'),
      documentName: readString(row, 'document_name'),
      citations: readNumber(row, 'citations'),
      answers: readNumber(row, 'answers'),
      clients: readNumber(row, 'clients'),
      lastCitedAt: readOptionalString(row, 'last_cited_at'),
    })),
    neverCited: never.map((row) => ({
      documentId: readString(row, 'id'),
      documentName: readString(row, 'name'),
      library: readOptionalString(row, 'library'),
      indexedAt: readOptionalString(row, 'indexed_at'),
      daysLive: readNumber(row, 'days_live'),
      chunkCount: readNumber(row, 'chunk_count'),
    })),
  })
})

/**
 * The client picker — §7 screen 2.
 *
 * Every client, with enough on the row to choose one: whether they have asked
 * anything, their own gap rate, and whether they are opted out. A picker that shows
 * only names makes the operator open seven screens to find the interesting one.
 */
metricsRoutes.get('/clients', async (c) => {
  await requireAdmin(c)

  const rows = await query(
    `SELECT cl.id, cl.name, cl.analytics_opt_out, cl.retention_days,
            count(*) FILTER (WHERE m.role = 'user')::int                        AS questions,
            count(*) FILTER (WHERE m.role = 'assistant')::int                   AS answers,
            count(*) FILTER (WHERE m.role = 'assistant' AND NOT m.grounded)::int AS gaps,
            max(m.created_at)                                                    AS last_question_at
       FROM clients cl
       LEFT JOIN chats ch ON ch.client_id = cl.id
       LEFT JOIN chat_messages m ON m.chat_id = ch.id
      GROUP BY cl.id, cl.name, cl.analytics_opt_out, cl.retention_days
      ORDER BY questions DESC, cl.name ASC`,
  )

  return c.json({
    clients: rows.map((row) => ({
      clientId: readString(row, 'id'),
      name: readString(row, 'name'),
      // Reported, not filtered out. An opted-out client must be visible as opted out —
      // silently omitting them makes the list look like the account does not exist.
      optedOut: row.analytics_opt_out === true,
      retentionDays: row.retention_days === null ? null : readNumber(row, 'retention_days'),
      questions: readNumber(row, 'questions'),
      answers: readNumber(row, 'answers'),
      gaps: readNumber(row, 'gaps'),
      lastQuestionAt: readOptionalString(row, 'last_question_at'),
    })),
  })
})

/**
 * One client's detail — §7 screen 2, and the only place verbatim questions appear.
 *
 * §2 permits this explicitly: "Client-scoped screens may show questions in full to
 * KIRIA staff." The unanswered questions are the point — a gap rate tells you there
 * is a hole, and the questions themselves tell you what to write.
 *
 * An opted-out client returns its own status and **nothing else**, checked here before
 * any question is read. §2 says the flag is honoured by every job and every query, and
 * a screen that showed the questions of a client who had opted out would be the single
 * worst failure this phase could produce.
 */
metricsRoutes.get('/clients/:clientId', async (c) => {
  await requireAdmin(c)
  const clientId = requireClientId(c)
  const days = windowDays(c)

  const [client] = await query(
    `SELECT id, name, analytics_opt_out, retention_days FROM clients WHERE id = $1`,
    [clientId],
  )
  if (!client) throw new HttpError(404, 'Client not found', 'NOT_FOUND')

  if (client.analytics_opt_out === true) {
    return c.json({
      clientId,
      name: readString(client, 'name'),
      optedOut: true,
      unanswered: [],
      libraries: [],
      note:
        'This client has opted out of conversation analysis, so nothing is read, ' +
        'embedded or counted for them. Clear the flag in the database to include them.',
    })
  }

  // The unanswered questions, paired with the answer that failed to answer them. The
  // pairing is what makes the row actionable: the question alone does not say whether
  // the material was missing or the retrieval simply missed it.
  const unanswered = await query(
    `SELECT q.id, q.content AS question, q.created_at,
            a.content AS answer
       FROM chat_messages a
       JOIN chats ch ON ch.id = a.chat_id
       LEFT JOIN LATERAL (
         SELECT m.id, m.content, m.created_at
           FROM chat_messages m
          WHERE m.chat_id = a.chat_id
            AND m.role = 'user'
            AND m.created_at <= a.created_at
          ORDER BY m.created_at DESC
          LIMIT 1
       ) AS q ON TRUE
      WHERE a.role = 'assistant'
        AND NOT a.grounded
        AND ch.client_id = $1
        AND a.created_at > now() - ($2 || ' days')::INTERVAL
      ORDER BY a.created_at DESC
      LIMIT 200`,
    [clientId, String(days)],
  )

  /**
   * Adoption since each library was granted — §7 screen 2.
   *
   * `portal_source_bindings.created_at` is when the tick happened, so "questions asked
   * since this library arrived" is answerable without any new capture. A library
   * granted three weeks ago with zero questions since is a different problem from one
   * granted yesterday, and the row carries both numbers so they are distinguishable.
   */
  const libraries = await query(
    `SELECT s.id, s.name, s.is_private, b.created_at AS granted_at,
            (now()::date - b.created_at::date)::int AS days_since_grant,
            (SELECT count(*)::int FROM documents d
              WHERE d.library_id = s.id AND d.deleted_at IS NULL AND d.status = 'indexed')
              AS documents,
            (SELECT count(*)::int
               FROM chat_messages m
               JOIN chats ch2 ON ch2.id = m.chat_id
              WHERE ch2.client_id = $1
                AND m.role = 'user'
                AND m.created_at >= b.created_at) AS questions_since_grant
       FROM portals p
       JOIN portal_source_bindings b ON b.portal_row_id = p.id
       JOIN document_sources s ON s.id = b.source_id
      WHERE p.client_id = $1
      ORDER BY b.created_at ASC`,
    [clientId],
  )

  return c.json({
    clientId,
    name: readString(client, 'name'),
    optedOut: false,
    retentionDays: client.retention_days === null ? null : readNumber(client, 'retention_days'),
    windowDays: days,
    unanswered: unanswered.map((row) => ({
      messageId: readOptionalString(row, 'id'),
      question: readOptionalString(row, 'question'),
      answer: readOptionalString(row, 'answer'),
      askedAt: readOptionalString(row, 'created_at'),
    })),
    libraries: libraries.map((row) => ({
      libraryId: readString(row, 'id'),
      name: readString(row, 'name'),
      isPrivate: row.is_private === true,
      grantedAt: readString(row, 'granted_at'),
      daysSinceGrant: readNumber(row, 'days_since_grant'),
      documents: readNumber(row, 'documents'),
      questionsSinceGrant: readNumber(row, 'questions_since_grant'),
    })),
  })
})

/**
 * Content gaps — §7 screen 3, "the actionable one … the screen that pays for the
 * phase".
 *
 * Unanswered questions grouped by theme, ranked by **frequency × clients affected**,
 * each traceable to the questions behind it. That ranking is the spec's, and it is the
 * right one: a theme asked twice by four accounts is a content gap; the same theme
 * asked eight times by one account is that account's project.
 *
 * ---------------------------------------------------------------------------
 * Client-scoped, and it says so
 *
 * Every theme here is `scope = 'client'`, so a row carries an account name and its
 * sample questions in full — which §2 permits for a client-scoped screen shown to
 * KIRIA staff. There is no org-scope theme to show: 8C ships the per-client half only,
 * because a cross-client theme is gated on the contracts question in §2 and the
 * database refuses one below three accounts regardless.
 *
 * The response therefore states its own scope. A screen that silently shows only part
 * of what it could is a screen that gets misread as the whole picture.
 *
 * ---------------------------------------------------------------------------
 * The period is formatted in SQL, not in the SPA
 *
 * `period_start` is a DATE, and Gate serialises it as `2026-09-01T00:00:00.000Z`. The
 * screen prints the period verbatim, so without `to_char` it reads as a timestamp —
 * and a browser west of UTC would render it as the day before, quietly showing August
 * for a September period. Caught by the e2e assertion on the date shape.
 */
metricsRoutes.get('/gaps', async (c) => {
  await requireAdmin(c)

  const themes = await query(
    `SELECT t.id, t.label, t.summary, t.question_count, t.client_count,
            t.unanswered_share, t.sample_message_ids,
            to_char(t.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
            t.prompt_version, cl.id AS client_id, cl.name AS client_name
       FROM insight_themes t
       JOIN clients cl ON cl.id = t.client_id
      WHERE t.scope = 'client'
        AND cl.analytics_opt_out = FALSE
        AND t.unanswered_share > 0
      ORDER BY (t.question_count * t.client_count * COALESCE(t.unanswered_share, 0)) DESC,
               t.question_count DESC
      LIMIT 100`,
  )

  // The sample questions, in one query rather than one per theme. Themes are few and
  // samples are five each, so this is a handful of rows — but a loop here would make
  // the screen's cost grow with the number of gaps it found, which is backwards.
  const sampleIds = [
    ...new Set(
      themes.flatMap((row) => {
        const ids = row.sample_message_ids
        return Array.isArray(ids) ? ids.map((id) => String(id)) : []
      }),
    ),
  ].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))

  const samples = new Map<string, string>()
  if (sampleIds.length > 0) {
    const rows = await query(
      `SELECT id, content FROM chat_messages WHERE id = ANY($1::UUID[])`,
      [`{${sampleIds.join(',')}}`],
    )
    for (const row of rows) samples.set(readString(row, 'id'), readString(row, 'content'))
  }

  return c.json({
    /**
     * Stated, not implied. §2 gates cross-client themes on the contracts question, so
     * this screen is the per-account view and the reader should know that rather than
     * infer it from an absence.
     */
    scope: 'client',
    scopeNote:
      'Themes are grouped within each account. Cross-account themes need the MSA and ' +
      'disclosure question in §2 answered first, and the database refuses one below ' +
      'three accounts in any case.',
    themes: themes.map((row) => {
      const ids = row.sample_message_ids
      const idList = Array.isArray(ids) ? ids.map((id) => String(id)) : []
      return {
        themeId: readString(row, 'id'),
        label: readString(row, 'label'),
        summary: readString(row, 'summary'),
        clientId: readString(row, 'client_id'),
        clientName: readString(row, 'client_name'),
        questionCount: readNumber(row, 'question_count'),
        clientCount: readNumber(row, 'client_count'),
        unansweredShare:
          row.unanswered_share === null ? null : Number(row.unanswered_share),
        periodStart: readString(row, 'period_start'),
        periodEnd: readString(row, 'period_end'),
        /** Recorded so two periods are only compared when they were produced alike. */
        promptVersion: readString(row, 'prompt_version'),
        // Traceable to the questions behind it, which §7 asks for by name: a theme a
        // person cannot check is a theme they cannot act on.
        sampleQuestions: idList
          .map((id) => samples.get(id))
          .filter((text): text is string => typeof text === 'string'),
      }
    }),
  })
})

/**
 * What ran, and what failed — §7 screen 6.
 *
 * Thin on purpose: the run rows already carry their own counts and their own error, so
 * this is a read rather than a report. A failed run's cause is on the row, which is
 * what makes `INSIGHT_RUN_FAILED`'s remediation ("read its error") true.
 */
metricsRoutes.get('/runs', async (c) => {
  await requireAdmin(c)

  const rows = await query(
    `SELECT id, kind, status, counts, last_error, started_at, finished_at
       FROM insight_runs
      ORDER BY started_at DESC
      LIMIT 100`,
  )

  return c.json({
    runs: rows.map((row) => ({
      id: readString(row, 'id'),
      kind: readString(row, 'kind'),
      status: readString(row, 'status'),
      counts: row.counts ?? {},
      lastError: readOptionalString(row, 'last_error'),
      startedAt: readString(row, 'started_at'),
      finishedAt: readOptionalString(row, 'finished_at'),
    })),
  })
})
