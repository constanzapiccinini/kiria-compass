/**
 * Compass Insights, end to end — Phase 8B.
 *
 * Two kinds of assertion here, and the second is the one that matters.
 *
 * **The screens have data.** Four endpoints, 200 for a staff session, with the shapes
 * the screens read. Shape assertions are cheap and catch a rename; they are the floor.
 *
 * **The §2 boundary holds.** "Verbatim question text never leaves its client.
 * Client-scoped screens may show questions in full to KIRIA staff. Org-scoped screens
 * may show only labels, summaries and counts."
 *
 * That is tested directly rather than by reading the code: fetch a real question from
 * the client-scoped endpoint where it is allowed, then assert that exact string does
 * **not** appear anywhere in the org-scoped payloads. A boundary described in a
 * comment survives until someone adds a helpful field to an overview response; a test
 * that greps for a real question does not.
 *
 * The insights app is staff-only at three layers, so unlike the client app there is no
 * portal-bound-session problem here — a staff magic link is all it needs, which is why
 * this suite can assert what `compass-ai`'s cannot.
 */

import { expect, test } from '@playwright/test'
import { fixtureUser, resolveTargetEnvironment, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

interface Overview {
  windowDays: number
  totals: { questions: number; answers: number; gaps: number; clientsActive: number; chats: number }
  series: Array<{ week: string; questions: number; gaps: number; clientsActive: number }>
  coverage: {
    clients: number
    optedOut: number
    withRetention: number
    questionsEmbedded: number
    questionsEmbeddable: number
  }
  pending: { themes: string; flags: string }
}

test.describe('compass insights', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })
  })

  test('the overview answers with internally consistent numbers', async ({ page }) => {
    const response = await page.request.get('/api/metrics/overview')
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as Overview

    // Invariants rather than fixed values: the data is live, and a test that pins
    // "2 gaps" fails the next time somebody asks a question.
    expect(body.totals.gaps, 'more gaps than answers').toBeLessThanOrEqual(body.totals.answers)
    expect(
      body.totals.clientsActive,
      'more accounts active than exist',
    ).toBeLessThanOrEqual(body.coverage.clients)
    expect(
      body.coverage.questionsEmbedded,
      'more questions embedded than are embeddable — the opt-out filter is not being applied ' +
        'consistently between the two counts',
    ).toBeLessThanOrEqual(body.coverage.questionsEmbeddable)

    // The weekly series must not contradict the totals it is a breakdown of.
    const seriesQuestions = body.series.reduce((total, week) => total + week.questions, 0)
    expect(
      seriesQuestions,
      'the weekly series and the totals disagree, so one of them is computed over a ' +
        'different window than it claims',
    ).toBe(body.totals.questions)

    // What has not shipped is named rather than shown as an empty panel. 8C shipped
    // the per-account half, so the themes note now points at the screen and names what
    // is still gated instead of naming a phase.
    expect(body.pending.themes).toContain('Cross-account')
    expect(body.pending.flags).toContain('Review')
  })

  /**
   * §2's boundary, checked two ways — and the second exists because the first is not
   * enough.
   *
   * **Sampling** takes every unanswered question from every account that has one and
   * greps the org-scoped payloads for each. That is direct and readable, and it was
   * the whole test at first. Then a deliberate leak was planted — the most recent
   * question added to the overview response — and **the test passed**, because the
   * leaked question belonged to an account with no gaps and so was never sampled. A
   * guard that only catches a leak of the specific rows it happened to look at is not
   * a guard.
   *
   * **The structural check** is the one that would have caught it: an org-scoped
   * response may contain numbers, short labels, and a small set of fixed explanatory
   * sentences. Nothing else. A question is unbounded prose from a client, so any long
   * string that is not on the list fails — whichever question it is, and whether or
   * not this test ever sampled it.
   */
  test('org-scoped payloads carry no question text', async ({ page }) => {
    const clients = (await (await page.request.get('/api/metrics/clients')).json()) as {
      clients: Array<{ clientId: string; questions: number; gaps: number; optedOut: boolean }>
    }

    // Every account with an unanswered question, not just the worst one: a leak of
    // any client's text is the same failure.
    const fragments: string[] = []
    for (const client of clients.clients) {
      if (client.optedOut || client.gaps === 0) continue
      const detail = (await (
        await page.request.get(`/api/metrics/clients/${client.clientId}`)
      ).json()) as { unanswered: Array<{ question: string | null }> }
      for (const row of detail.unanswered) {
        if (typeof row.question === 'string' && row.question.trim().length > 12) {
          fragments.push(row.question.trim().slice(0, 24))
        }
      }
    }

    const ORG_SCOPED = ['/api/metrics/overview', '/api/metrics/documents', '/api/metrics/runs']

    for (const path of ORG_SCOPED) {
      const payload = await (await page.request.get(path)).text()
      for (const fragment of fragments) {
        expect(
          payload.includes(fragment),
          `${path} contains verbatim question text ("${fragment}…"), which §2 forbids ` +
            'for an org-scoped response',
        ).toBe(false)
      }
    }

    /**
     * Which string-valued fields an org-scoped response may carry.
     *
     * **This replaced a length threshold, which was wrong.** The first structural
     * check flagged any string over 64 characters on the theory that a question is
     * prose and a label is short. Then the real questions were measured: 22 to 51
     * characters — "what are their locations", "cuantos candidatos hay". Length does
     * not distinguish a client's question from a column header, and a check built on
     * that premise passed a deliberately planted leak.
     *
     * The field name does distinguish them. Every string in an org payload comes from
     * a known key, so a **new** string-valued field fails until it is added here —
     * which is the property that matters: the leak that got through was a new field
     * called `leakedForTest`, and this catches it whatever it contains and however
     * long it is.
     *
     * What it does not catch is a question stuffed into an already-sanctioned field.
     * The sampling check above covers that for every question it can see, and the two
     * together are the coverage. Neither alone was enough, which is why both are here.
     */
    const ALLOWED_STRING_FIELDS = new Set([
      // overview
      'week',
      'themes',
      'flags',
      // documents
      'documentId',
      'documentName',
      'library',
      'lastCitedAt',
      'indexedAt',
      // runs — `lastError` is our own exception text, never a client's
      'id',
      'kind',
      'status',
      'lastError',
      'startedAt',
      'finishedAt',
    ])

    const unexpectedFields = (
      value: unknown,
      key: string | null = null,
      path: string[] = [],
    ): Array<[string, string]> => {
      if (typeof value === 'string') {
        if (key !== null && ALLOWED_STRING_FIELDS.has(key)) return []
        return [[path.join('.') || '(root)', value]]
      }
      if (Array.isArray(value)) {
        return value.flatMap((item, index) => unexpectedFields(item, key, [...path, String(index)]))
      }
      if (typeof value === 'object' && value !== null) {
        return Object.entries(value).flatMap(([childKey, item]) =>
          unexpectedFields(item, childKey, [...path, childKey]),
        )
      }
      return []
    }

    for (const path of ORG_SCOPED) {
      const payload: unknown = await (await page.request.get(path)).json()
      const offenders = unexpectedFields(payload)
      expect(
        offenders,
        `${path} carries string fields an org-scoped response has not sanctioned: ` +
          offenders.map(([where, text]) => `${where} = "${text.slice(0, 50)}"`).join('; ') +
          '. An org payload may hold counts, dates and the named labels only — add the ' +
          'field to ALLOWED_STRING_FIELDS in this spec if it is a deliberate addition, ' +
          'and check first that it cannot carry a client\u2019s own words.',
      ).toEqual([])
    }
  })

  test('the content screen distinguishes documents by library', async ({ page }) => {
    const response = await page.request.get('/api/metrics/documents')
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      neverCitedMinDays: number
      cited: Array<{ documentName: string; citations: number; clients: number }>
      neverCited: Array<{ documentName: string; library: string | null; daysLive: number }>
    }

    // The floor is stated, not implied: a document indexed an hour ago is not
    // evidence that nobody wants it.
    expect(body.neverCitedMinDays).toBeGreaterThan(0)
    for (const row of body.neverCited) {
      expect(
        row.daysLive,
        `"${row.documentName}" is in the never-cited list but has only been live ` +
          `${row.daysLive} days, under the ${body.neverCitedMinDays}-day floor`,
      ).toBeGreaterThanOrEqual(body.neverCitedMinDays);

      // Every never-cited row carries its library. Production holds two documents
      // called `brand guidelines - kiria.pdf` in different libraries, one cited
      // fourteen times and one never — without the library the same name appears in
      // both tables and the screen looks broken.
      expect(
        row.library !== undefined,
        `"${row.documentName}" has no library field, so an identically-named document ` +
          'in another library cannot be told apart',
      ).toBe(true)
    }

    for (const row of body.cited) {
      expect(row.citations).toBeGreaterThan(0)
      expect(row.clients).toBeGreaterThan(0)
    }
  })

  /**
   * Content gaps — §7 screen 3, "the screen that pays for the phase".
   *
   * Deliberately **not** in `ORG_SCOPED` above: this route is client-scoped and its
   * rows carry verbatim questions, which §2 permits for a client-scoped screen shown
   * to KIRIA staff. Adding it to that list would be asserting the opposite of the
   * design.
   *
   * What is asserted instead is that it says which scope it is, that its ranking is
   * actually applied, and that every row can be traced back — a theme a person cannot
   * check is a theme they cannot act on, and §7 asks for traceability by name.
   */
  test('content gaps are ranked and traceable', async ({ page }) => {
    const response = await page.request.get('/api/metrics/gaps')
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      scope: string
      scopeNote: string
      themes: Array<{
        label: string
        summary: string
        clientName: string
        questionCount: number
        clientCount: number
        unansweredShare: number | null
        periodStart: string
        periodEnd: string
        promptVersion: string
        sampleQuestions: string[]
      }>
    }

    // The screen states its own scope rather than leaving it to be inferred from an
    // absence of cross-account rows.
    expect(body.scope).toBe('client')
    expect(body.scopeNote).toContain('Cross-account')

    test.skip(
      body.themes.length === 0,
      'no themes with unanswered questions yet — clustering runs daily in the ' +
        'Compass AI worker',
    )

    for (const theme of body.themes) {
      // Only gaps belong here. A theme that was fully answered is content that works,
      // and listing it on the gaps screen would bury the ones that need writing.
      expect(
        theme.unansweredShare,
        `"${theme.label}" is on the gaps screen with nothing unanswered`,
      ).toBeGreaterThan(0)

      // Traceable, per §7 — unless retention removed the questions and the aggregate
      // survived (§6), which the screen says explicitly.
      expect(
        theme.sampleQuestions.length > 0 || theme.questionCount === 0,
        `"${theme.label}" carries no sample questions, so nobody can check it`,
      ).toBe(true)

      // The period and the prompt version are what make two months comparable — or
      // honestly incomparable. A row without them is a number with no provenance.
      expect(theme.promptVersion, `"${theme.label}" has no prompt version`).toBeTruthy()
      expect(theme.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(theme.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    // The ranking §7 specifies — frequency × accounts affected × unanswered share —
    // must actually be applied, not just documented. A screen whose first row is not
    // its most important one is worse than an unsorted list, because it implies an
    // order that is not there.
    const priorities = body.themes.map(
      (theme) => theme.questionCount * theme.clientCount * (theme.unansweredShare ?? 0),
    )
    const sorted = [...priorities].sort((a, b) => b - a)
    expect(
      priorities,
      'the gaps are not ordered by frequency × accounts × unanswered share',
    ).toEqual(sorted)
  })


  /**
   * The review queue — §7 screen 5.
   *
   * Deliberately **not** in `ORG_SCOPED`. Every row carries its own `clientId`, which
   * is what makes it client-scoped under §2: the rule is about scope, not about
   * sensitivity, and a reviewer cannot judge an adverse-event mention from a summary.
   * Adding this route to that list would assert the opposite of the design.
   */
  test('the review queue is client-scoped and says how much has been screened', async ({
    page,
  }) => {
    const response = await page.request.get('/api/flags')
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      status: string
      byStatus: Record<string, number>
      screening: { screened: number; eligible: number }
      flags: Array<{
        flagId: string
        clientId: string
        clientName: string
        question: string
        status: string
        promptVersion: string
      }>
    }

    // An empty queue means one of two very different things, and the screen has to be
    // able to tell them apart: nothing was flagged, or nothing has been screened.
    expect(
      body.screening.screened,
      'more questions screened than are eligible, so the two counts are computed over ' +
        'different populations — most likely the opt-out filter is on one and not the other',
    ).toBeLessThanOrEqual(body.screening.eligible)

    for (const status of ['new', 'reviewed', 'dismissed', 'escalated']) {
      expect(typeof body.byStatus[status], `byStatus is missing ${status}`).toBe('number')
    }

    for (const flag of body.flags) {
      // The property that makes verbatim text permissible here at all.
      expect(flag.clientId, 'a flag with no account is not client-scoped').toBeTruthy()
      expect(flag.clientName).toBeTruthy()
      expect(flag.question.length, 'a flag with no question cannot be reviewed').toBeGreaterThan(0)
      // Which classifier said so. Two flags from different prompt versions are not the
      // same evidence, and a reviewer comparing them should be able to see it.
      expect(flag.promptVersion).toBeTruthy()
      expect(flag.status).toBe('new')
    }
  })

  /**
   * The two refusals that keep the record worth having — §7, and 0024's CHECK.
   *
   * Both are rejected on the payload, before the flag is looked up, so a
   * nonexistent id is enough and this test never writes to a real queue. The 404 at
   * the end is the control: it proves the route was reached and the earlier 400s are
   * the handler's judgement rather than a missing route answering the same way.
   */
  test('a decision must name a reason to escalate, and cannot be undone', async ({ page }) => {
    const absent = '00000000-0000-0000-0000-000000000000'
    const patch = (body: Record<string, unknown>) =>
      page.request.patch(`/api/flags/${absent}`, {
        headers: { 'content-type': 'application/json' },
        data: body,
      })

    const escalation = await patch({ status: 'escalated', notes: '' })
    expect(
      escalation.status(),
      'an escalation with no note was accepted — "somebody escalated this and we do not ' +
        'know what they saw" is worse than not having the row',
    ).toBe(400)
    expect((await escalation.json()).error.code).toBe('NOTE_REQUIRED')

    const undo = await patch({ status: 'new' })
    expect(
      undo.status(),
      'a flag was returned to \'new\' — a compliance record should not be able to reach ' +
        '"undecided again"; the honest way to change a decision is to make a different one',
    ).toBe(400)

    // The control. Same route, a well-formed decision, a flag that does not exist.
    const missing = await patch({ status: 'dismissed', notes: 'e2e control' })
    expect(missing.status(), await missing.text()).toBe(404)
  })

  test('the runs screen reports a failure with its cause', async ({ page }) => {
    const response = await page.request.get('/api/metrics/runs')
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      runs: Array<{ kind: string; status: string; lastError: string | null }>
    }

    // Not "there are runs" — the invariant that makes the alert's remediation ("read
    // its error") true. A failed run with no cause sends an operator to the logs,
    // which is what the row exists to avoid, and the schema's CHECK says the same.
    for (const run of body.runs) {
      if (run.status !== 'failed') continue
      expect(
        run.lastError,
        `a failed ${run.kind} run carries no error, so the Runs screen cannot explain it`,
      ).toBeTruthy()
    }
  })
})
