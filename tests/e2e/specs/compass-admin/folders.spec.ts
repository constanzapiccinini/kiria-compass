/**
 * Folder organisation from the admin — §7, end to end.
 *
 * These are the rules that carry all the difficulty, so they are tested against the
 * real database rather than reasoned about:
 *
 *   - a cycle (moving a folder under its own descendant) must be refused, and refused
 *     WITHOUT changing anything — a half-applied move detaches a subtree from the root
 *     permanently, and the rows survive with nothing able to list them again;
 *   - a delete lifts children to the deleted folder's parent rather than cascading,
 *     and recomputes their depth;
 *   - reorder is a statement about a whole sibling set, so a partial list is refused.
 *
 * §6A.2 moved the owner from the client to the library, which is why this creates its
 * own library rather than borrowing a portal's tenancy key. That is not only tidier:
 * a folder created under a portal's private library is visible to that client, and a
 * spec that builds five levels of `e2e-…` folders in a real client's portal is
 * leaving something a person sees. Its own library is ticked to nobody.
 *
 * Two rules that only exist per owner are asserted here too:
 *
 *   - two libraries may each hold a folder of the same name, and those are different
 *     folders — the library is the disambiguator (§2);
 *   - within one library, two siblings may not share a name, **including at the root**.
 *     The pre-0015 constraint was `UNIQUE (client_id, parent_id, name)`, which never
 *     caught two root folders because NULL parents do not compare equal.
 *
 * Everything it creates is deleted at the end, and the cleanup is **asserted**.
 */

import { expect, test } from '@playwright/test'
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

interface Folder {
  id: string
  parentId: string | null
  name: string
  position: number
  depth: number
}

test.describe('compass admin — folder organisation', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test('creates, reorders, refuses a cycle, and cleans up', async ({ page }) => {
    // Every folder call pays the isolated store's ~250ms round-trip floor, and this
    // test makes roughly forty of them on top of a magic-link sign-in. The default
    // 60s budget is not a meaningful signal here — it fires on infrastructure
    // latency rather than on anything this test asserts. Raised rather than split in
    // two, because a second test means a second sign-in and magic-link activations
    // are rate limited per address.
    test.setTimeout(180_000)

    await signInOrSkip(page, env, STAFF_FIXTURE)
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })

    const stamp = Date.now().toString(36)
    // `{ id, owner }`, not a bare id: the delete route is scoped to the owning
    // library, so cleaning up with the wrong one is a 404 the teardown swallows and a
    // folder that outlives the test. That is what happened — the folder created in
    // the second library survived, and the cleanup assertion is what said so.
    const created: Array<{ id: string; owner: string }> = []
    const libraries: string[] = []

    // Its own library, ticked to no portal, so nothing built here is visible to a
    // real client while the test runs.
    const newLibrary = async (suffix: string): Promise<string> => {
      const response = await page.request.post('/api/libraries', {
        data: { name: `e2e-${stamp}-${suffix}` },
      })
      const body = await response.text()
      expect(response.status(), `create library -> ${response.status()}: ${body}`).toBe(201)
      const id = (JSON.parse(body) as { id: string }).id
      libraries.push(id)
      return id
    }

    const libraryId = await newLibrary('lib')

    const createIn = async (
      owner: string,
      name: string,
      parentId: string | null,
    ): Promise<Folder> => {
      const response = await page.request.post('/api/documents/folders', {
        data: { libraryId: owner, parentId, name },
      })
      const body = await response.text()
      expect(response.status(), `create ${name} -> ${response.status()}: ${body}`).toBe(201)
      const folder = (JSON.parse(body) as { folder: Folder }).folder
      created.push({ id: folder.id, owner })
      return folder
    }

    const create = (name: string, parentId: string | null): Promise<Folder> =>
      createIn(libraryId, name, parentId)

    const listIn = async (owner: string): Promise<Folder[]> => {
      const response = await page.request.get(
        `/api/documents/folders?libraryId=${encodeURIComponent(owner)}`,
      )
      expect(response.status()).toBe(200)
      return ((await response.json()) as { folders: Folder[] }).folders
    }

    const list = (): Promise<Folder[]> => listIn(libraryId)

    try {
      const a = await create(`e2e-${stamp}-A`, null)
      const b = await create(`e2e-${stamp}-B`, a.id)
      const c = await create(`e2e-${stamp}-C`, b.id)
      const sibling = await create(`e2e-${stamp}-Z`, null)

      expect(a.depth, 'root folder depth').toBe(0)
      expect(c.depth, 'third level depth').toBe(2)

      // --- the cycle rule ---------------------------------------------------
      const cycle = await page.request.put(`/api/documents/folders/${a.id}/parent`, {
        data: { libraryId, parentId: c.id },
      })
      expect(
        cycle.ok(),
        `moving A under its own descendant C was ACCEPTED (${cycle.status()}) — that detaches the subtree permanently`,
      ).toBe(false)

      // Refused is not enough: it must have changed nothing. A move that validates
      // late writes some rows before failing, and that is the state this asserts is
      // impossible.
      const afterCycle = await list()
      expect(
        afterCycle.find((folder) => folder.id === a.id)?.parentId,
        "A's parent changed despite the refusal",
      ).toBe(null)
      expect(
        afterCycle.find((folder) => folder.id === c.id)?.depth,
        "C's depth changed despite the refusal",
      ).toBe(2)

      // Its own parent is the degenerate case of the same rule.
      const self = await page.request.put(`/api/documents/folders/${b.id}/parent`, {
        data: { libraryId, parentId: b.id },
      })
      expect(self.ok(), 'a folder was allowed to become its own parent').toBe(false)

      // --- reorder ----------------------------------------------------------
      const roots = (await list()).filter((folder) => folder.parentId === null)
      const mine = roots.filter((folder) => folder.name.startsWith(`e2e-${stamp}-`))
      expect(mine.length, 'expected both root folders').toBe(2)

      // The complete sibling set includes any pre-existing root folders, so the order
      // sent is mine reversed followed by the rest, relative order preserved.
      const reversed = [...mine].reverse().map((folder) => folder.id)
      const others = roots
        .filter((folder) => !reversed.includes(folder.id))
        .map((folder) => folder.id)

      const reorder = await page.request.put('/api/documents/folders/order', {
        data: { libraryId, parentId: null, orderedIds: [...reversed, ...others] },
      })
      expect(reorder.status(), `reorder -> ${await reorder.text()}`).toBe(200)

      const afterReorder = (await list()).filter((folder) => folder.parentId === null)
      const positions = new Map(afterReorder.map((folder) => [folder.id, folder.position]))
      expect(
        (positions.get(reversed[0]) ?? 0) < (positions.get(reversed[1]) ?? 0),
        'the sibling order did not change',
      ).toBe(true)

      const partial = await page.request.put('/api/documents/folders/order', {
        data: { libraryId, parentId: null, orderedIds: [reversed[0]] },
      })
      expect(partial.ok(), 'a partial sibling order was accepted').toBe(false)

      // --- a legal reparent still works, and recomputes depth ---------------
      const legal = await page.request.put(`/api/documents/folders/${sibling.id}/parent`, {
        data: { libraryId, parentId: a.id },
      })
      expect(legal.status(), `legal reparent -> ${await legal.text()}`).toBe(200)
      expect(
        (await list()).find((folder) => folder.id === sibling.id)?.depth,
        'depth was not recomputed on reparent',
      ).toBe(1)

      // --- delete lifts children rather than cascading ----------------------
      const removeB = await page.request.delete(
        `/api/documents/folders/${b.id}?libraryId=${encodeURIComponent(libraryId)}`,
      )
      expect(removeB.status(), `delete -> ${await removeB.text()}`).toBe(200)

      const afterDelete = await list()
      const cAfter = afterDelete.find((folder) => folder.id === c.id)
      expect(cAfter, "deleting a folder deleted its child too").toBeTruthy()
      expect(cAfter?.parentId, "C did not move up to B's parent").toBe(a.id)
      expect(cAfter?.depth, "C's depth was not recomputed after the lift").toBe(1)

      // --- the depth-overflow rule (§5D.3) ----------------------------------
      //
      // The other half of the subtle logic that used to be duplicated in both apps.
      // §5C left this app's `folders.ts` as the only implementation, and §5D asks for
      // a test that fails if either guard is lost — the cycle rule is asserted above,
      // and this is the depth one.
      //
      // `MAX_DEPTH` is 4, so five levels (depth 0–4) are legal and a sixth must be
      // refused. What is tested is that a limit is enforced at all and that the
      // refusal names itself, rather than the specific number — so the chain is
      // extended from whatever depth already exists instead of being rebuilt, which
      // also keeps this test inside its time budget: every folder call pays the
      // isolated store's ~250ms floor, and rebuilding five levels from scratch was
      // enough to push the whole test past the timeout.
      let deepest = cAfter as Folder // depth 1, under A
      while (deepest.depth < 4) {
        deepest = await create(`e2e-${stamp}-d${deepest.depth + 1}`, deepest.id)
      }
      expect(deepest.depth, 'five levels should be legal').toBe(4)

      const tooDeep = await page.request.post('/api/documents/folders', {
        data: { libraryId, parentId: deepest.id, name: `e2e-${stamp}-d5` },
      })
      const tooDeepBody = await tooDeep.text()
      expect(
        tooDeep.status(),
        `a sixth folder level was accepted: ${tooDeepBody.slice(0, 200)}`,
      ).toBe(400)
      expect(tooDeepBody, 'the refusal did not identify itself').toContain('FOLDER_TOO_DEEP')

      // And the same limit must hold on a move, not only on a create — otherwise a
      // legal-looking reparent could push a whole subtree past the limit.
      const overflowByMove = await page.request.put(
        `/api/documents/folders/${a.id}/parent`,
        { data: { libraryId, parentId: deepest.id } },
      )
      expect(
        overflowByMove.ok(),
        'moving a subtree past the depth limit was accepted',
      ).toBe(false)
      // --- sibling names are unique per owner, roots included (§6A.2) ------
      //
      // The pre-0015 constraint was `UNIQUE (client_id, parent_id, name)`, and two
      // root folders both have `parent_id IS NULL`, which never compares equal — so
      // duplicate roots were accepted and rendered as two identical rows in a
      // viewer's sidebar. 0015 replaced it with a partial index over
      // `COALESCE(parent_id, '000…')`, and this is the case that would have missed.
      const duplicateRoot = await page.request.post('/api/documents/folders', {
        data: { libraryId, parentId: null, name: `e2e-${stamp}-A` },
      })
      const duplicateBody = await duplicateRoot.text()
      expect(
        duplicateRoot.status(),
        `a second root folder named the same was accepted: ${duplicateBody.slice(0, 200)}`,
      ).toBe(409)
      expect(duplicateBody, 'the refusal did not identify itself').toContain('FOLDER_NAME_TAKEN')

      // --- but the SAME name in another library is a different folder ------
      //
      // The library is what disambiguates a folder name (§2), which is why the client
      // sidebar renders the library as a node and never collapses it away. If this
      // were refused, two clients could not each have a "Contracts" folder.
      const otherLibrary = await newLibrary('lib2')
      const twin = await createIn(otherLibrary, `e2e-${stamp}-A`, null)
      expect(twin.depth, 'a root folder in the second library').toBe(0)

      const otherTree = await listIn(otherLibrary)
      expect(
        otherTree.map((folder) => folder.name),
        "the second library's tree leaked or lost its folder",
      ).toEqual([`e2e-${stamp}-A`])

      // And the first library's tree is unchanged by any of it: a folder read is
      // scoped to its owner, so the twin must not appear here.
      expect(
        (await list()).filter((folder) => folder.id === twin.id),
        "the other library's folder appeared in this library's tree",
      ).toEqual([])

    } finally {
      // Children before parents, so a remaining nesting does not block a delete.
      for (const folder of [...created].reverse()) {
        await page.request
          .delete(
            `/api/documents/folders/${folder.id}?libraryId=${encodeURIComponent(folder.owner)}`,
          )
          .catch(() => undefined)
      }
      const leftover: string[] = []
      for (const owner of libraries) {
        for (const folder of await listIn(owner)) {
          if (folder.name.includes(stamp)) leftover.push(folder.name)
        }
      }
      expect(leftover, 'cleanup left folders behind').toEqual([])

      // The libraries themselves. Deletion is refused while a library holds documents
      // or has cost anything, and these hold neither — a refusal here would mean the
      // test created something it did not account for, so it is asserted rather than
      // swallowed.
      for (const owner of libraries) {
        const response = await page.request.delete(`/api/libraries/${owner}`)
        expect(
          response.status(),
          `library ${owner} could not be deleted: ${await response.text()}`,
        ).toBe(200)
      }
    }
  })
})
