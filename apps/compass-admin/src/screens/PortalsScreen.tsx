/**
 * Screen 1 — Portals (§5A.5).
 *
 * One row per portal, registered or not. The separate "waiting to be connected"
 * panel is gone with the concept it served: there is no connecting step any more, so
 * an unregistered portal is not a portal in a different state of a workflow — it is
 * simply a portal nobody has clicked Provision on, and usually not even that,
 * because opening it registers it by itself.
 *
 * `Last seen` is the most useful column here. A portal that exists and has never
 * been opened is the commonest "why doesn't it work", and it is invisible without
 * this.
 *
 * FuseBase is the source of truth for which portals exist and what they are called
 * (§6A.4). Loading this screen reconciles against the platform list, at most every
 * fifteen minutes, and "Sync now" forces one. There is no rename here: the name is
 * rewritten from the platform on every reconcile, so an edit made here would revert
 * within the quarter-hour, and an edit that silently reverts is worse than none.
 *
 * A portal FuseBase no longer lists is marked **missing** and keeps everything — its
 * tenant, its documents, its chats. That is the whole point: deleting on absence is
 * how a client's history vanishes because someone's page half-loaded. Removal is a
 * separate, deliberate action, available only after the portal has been missing for
 * the grace period, and it makes the operator type the name.
 *
 * The preview is the other reason this screen exists. "Why can the viewer not see
 * the document I uploaded" is the most common question, and the answer is almost
 * always a binding or a status — both invisible from the client app. So the preview
 * lists every document the bindings resolve and marks, per row, whether a viewer
 * will actually see it.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { Eye, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, type PortalPreviewRow, type PortalRow } from '@/lib/client'
import {
  AsyncState,
  Button,
  Cell,
  Panel,
  Pill,
  Table,
  useLoader,
} from '@/components/primitives'

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function PortalsScreen({ onChanged }: { onChanged: () => void }): React.ReactElement {
  const { data, loading, error, reload } = useLoader(() => api.portals(), [])
  const [previewFor, setPreviewFor] = useState<{ id: string; label: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const portals = data?.portals ?? []
  const discovery = data?.discovery
  const reconcile = data?.reconcile

  const act = async (key: string, run: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    setBusy(key)
    try {
      await run()
      reload()
      // The shell's picker and badge counts come from the session, so a new tenant or
      // a status change has to refresh both or the rail disagrees with the table.
      onChanged()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  /**
   * Give a portal a tenant.
   *
   * Not confirmed: it creates and takes nothing away, it is idempotent, and the
   * portal was going to register itself on its first visitor anyway. The one thing
   * worth saying is what the click produces, which the button's label does.
   */
  const provision = (portal: PortalRow): void => {
    void act(portal.portalId, async () => {
      await api.provisionPortal(portal.portalId)
    })
  }

  /** Force a reconcile now, rather than waiting for the next screen load. */
  const syncNow = (): void => {
    void act('__reconcile__', async () => {
      const outcome = await api.reconcilePortals()
      // A failed read is reported as `ok: false` rather than thrown, because the run
      // deliberately changes nothing in that case — treating it as success would
      // show "0 changes" for what is actually "could not look".
      if (!outcome.ok) {
        throw new Error(
          outcome.error ??
            'The platform portal list could not be read, so nothing was changed.',
        )
      }
    })
  }

  /**
   * Remove a missing portal permanently.
   *
   * Two steps, and the first is a read: the impact is fetched so the confirmation can
   * state real numbers. A generic "this cannot be undone" is exactly the wording an
   * operator learns to click through, and this deletes a client's chat history.
   *
   * The name has to be typed. Not a checkbox — the one guard that reliably stops a
   * mis-click on the wrong row is having to reproduce that row's name. The backend
   * requires it too, so a UI mistake cannot bypass it.
   */
  const removePermanently = (portal: PortalRow): void => {
    if (!portal.id) return
    const portalRowId = portal.id
    void (async () => {
      setActionError(null)
      setBusy(portal.portalId)
      try {
        const impact = await api.removalImpact(portalRowId)
        if (!impact.removable) {
          throw new Error(
            impact.status !== 'missing'
              ? `"${impact.label}" is ${impact.status}, not missing. Only a portal FuseBase ` +
                'no longer lists can be removed — pause it instead.'
              : `"${impact.label}" has been missing for ${impact.missingForDays ?? 0} of the ` +
                `${impact.graceDays} days required before it can be removed.`,
          )
        }

        const typed = window.prompt(
          `Remove "${impact.label}" permanently?\n\n` +
            `This deletes ${impact.chats} chat(s), ${impact.documents} document(s) and ` +
            `${impact.privateLibraries} private library/libraries. ` +
            `${impact.sharedLibraries} shared library/libraries stay — they belong to other ` +
            'portals too, and only this portal\u2019s access to them is removed.\n\n' +
            `Type the portal name to confirm: ${impact.label}`,
        )
        if (typed === null) return

        await api.removePortalPermanently(portalRowId, typed.trim())
        reload()
        onChanged()
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : 'Removal failed')
      } finally {
        setBusy(null)
      }
    })()
  }

  return (
    <Stack gap="4">
      {actionError ? (
        <Box borderWidth="1px" borderColor="red.400" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="red.500">
            {actionError}
          </Text>
        </Box>
      ) : null}

      {/* A short list caused by a missing grant must not read as "no portals". */}
      {discovery && !discovery.ok ? (
        <Box borderWidth="1px" borderColor="warn.border" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" fontWeight="medium">
            The platform portal list could not be read
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {discovery.note}
          </Text>
          {discovery.error ? (
            <Text fontSize="xs" color="fg.muted" mt="1">
              {discovery.error}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* What the sync knows, and when it last actually looked.
          A blank here would read as "everything is fine" for both "nothing changed"
          and "this has not run since Tuesday", which are very different. */}
      <HStack justify="space-between" borderWidth="1px" borderRadius="card" p="3" bg="bg.surface">
        <Stack gap="0">
          <Text fontSize="sm">
            FuseBase decides which portals exist and what they are called.
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {reconcile
              ? reconcile.error !== null
                ? `Last attempt failed: ${reconcile.error}`
                : reconcile.ran
                  ? `Synced just now — ${reconcile.renamed} renamed, ${reconcile.markedMissing} ` +
                    `marked missing, ${reconcile.restored} restored.`
                  : `Last synced ${formatWhen(reconcile.lastRunAt)}` +
                    (reconcile.lastRunOk === false ? ' (that run failed)' : '')
              : 'Sync state unknown.'}
          </Text>
        </Stack>
        <Button
          onClick={syncNow}
          disabled={busy === '__reconcile__'}
          label="Re-read the portal list from FuseBase now"
        >
          <HStack gap="1">
            <RefreshCw size={13} />
            <Text>{busy === '__reconcile__' ? 'Syncing…' : 'Sync now'}</Text>
          </HStack>
        </Button>
      </HStack>

      <Panel title={`Portals (${portals.length})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={portals.length === 0}
          emptyMessage="This organization has no portals yet. Create one in FuseBase and open the app in it."
        >
          <Table
            headers={['Portal', 'State', 'Sources', 'Libraries', 'Viewer sees', 'Last seen', '']}
          >
            {portals.map((portal) => (
              <Box as="tr" key={portal.portalId}>
                <Cell>
                  <Stack gap="0">
                    <Text fontWeight="medium">{portal.name}</Text>
                    <Text fontSize="xs" color="fg.muted">
                      {portal.portalId}
                    </Text>
                  </Stack>
                </Cell>
                <Cell>
                  {portal.registered ? (
                    <HStack gap="2">
                      <Pill value={portal.status ?? 'active'} />
                      {/* A portal deleted in FuseBase keeps its row and its
                          documents on purpose. Saying so is the whole point: the
                          alternative — deleting the tenant — is how a client's
                          document list empties with nobody able to explain it. */}
                      {portal.status === 'missing' || portal.missingFromPlatform ? (
                        <Text fontSize="xs" color="warn.fg">
                          {portal.missingForDays === null || portal.missingForDays === undefined
                            ? 'not listed by FuseBase'
                            : `not listed by FuseBase for ${portal.missingForDays} day(s)`}
                          {portal.removable ? ' — removable' : ''}
                        </Text>
                      ) : null}
                    </HStack>
                  ) : (
                    <Stack gap="0">
                      <Text fontSize="sm" color="fg.muted">
                        not registered
                      </Text>
                      {portal.seenCount ? (
                        <Text fontSize="xs" color="warn.fg">
                          opened {portal.seenCount}×
                        </Text>
                      ) : null}
                    </Stack>
                  )}
                </Cell>
                <Cell muted>{portal.registered ? portal.bindingCount : '—'}</Cell>
                <Cell>
                  {/* The same relationship the Libraries screen shows from the
                      other side, so "why does this portal show 40 documents" has
                      one place to answer it. */}
                  {!portal.registered ? (
                    <Text color="fg.muted">—</Text>
                  ) : (portal.libraries ?? []).length === 0 ? (
                    <Text fontSize="sm" color="fg.muted">
                      none
                    </Text>
                  ) : (
                    <Text fontSize="sm">
                      {(portal.libraries ?? []).map((library) => library.name).join(', ')}
                    </Text>
                  )}
                </Cell>
                <Cell>
                  {/* Zero visible documents with sources bound is the shape of a
                      real problem, so it is called out rather than left as a 0. */}
                  {portal.registered &&
                  portal.documentsVisible === 0 &&
                  (portal.bindingCount ?? 0) > 0 ? (
                    <Text color="warn.fg" fontSize="sm">
                      0 — nothing indexed yet
                    </Text>
                  ) : (
                    <Text>{portal.registered ? portal.documentsVisible : '—'}</Text>
                  )}
                </Cell>
                <Cell muted nowrap>
                  {formatWhen(portal.lastSeenAt)}
                </Cell>
                <Cell nowrap>
                  <HStack gap="2">
                    {portal.registered && portal.id ? (
                      <>
                        <Button
                          onClick={() =>
                            setPreviewFor({
                              id: portal.id as string,
                              label: portal.name,
                            })
                          }
                          label={`Preview what ${portal.name} sees`}
                        >
                          <HStack gap="1">
                            <Eye size={13} />
                            <Text>Preview</Text>
                          </HStack>
                        </Button>
                        {/* Only offered for a portal FuseBase no longer lists. A
                            portal that still exists is paused, never removed — and
                            the button being absent is a clearer statement of that
                            than a button that explains why it refuses. */}
                        {portal.status === 'missing' ? (
                          <Button
                            variant="danger"
                            onClick={() => removePermanently(portal)}
                            disabled={busy === portal.portalId}
                            label={`Remove ${portal.name} and its private files permanently`}
                          >
                            <HStack gap="1">
                              <Trash2 size={13} />
                              <Text>Remove permanently</Text>
                            </HStack>
                          </Button>
                        ) : null}
                        {/* Hidden for a missing portal: resuming one would set it
                            active while FuseBase does not list it, and the next
                            reconcile would mark it missing again. */}
                        {portal.status === 'missing' ? null : (
                        <Button
                          onClick={() =>
                            void act(portal.portalId, () =>
                              api.setPortalStatus(
                                portal.id as string,
                                portal.status === 'active' ? 'paused' : 'active',
                              ),
                            )
                          }
                          label={`${portal.status === 'active' ? 'Pause' : 'Resume'} ${portal.name}`}
                        >
                          <HStack gap="1">
                            {portal.status === 'active' ? (
                              <Pause size={13} />
                            ) : (
                              <Play size={13} />
                            )}
                            <Text>{portal.status === 'active' ? 'Pause' : 'Resume'}</Text>
                          </HStack>
                        </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() => provision(portal)}
                        disabled={busy === portal.portalId}
                        label={`Provision ${portal.name} so it can serve viewers`}
                      >
                        <HStack gap="1">
                          <Plus size={13} />
                          <Text>{busy === portal.portalId ? 'Provisioning…' : 'Provision'}</Text>
                        </HStack>
                      </Button>
                    )}
                  </HStack>
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>

      <Text fontSize="sm" color="fg.muted">
        A portal registers itself the first time someone opens the app in it — there is
        nothing to set up. Provision only if you want it ready before anyone visits.
        Rename a portal in FuseBase, not here: the name is re-read on every sync.
      </Text>

      {previewFor ? (
        <PortalPreview
          portalRowId={previewFor.id}
          label={previewFor.label}
          onClose={() => setPreviewFor(null)}
        />
      ) : null}
    </Stack>
  )
}

function PortalPreview({
  portalRowId,
  label,
  onClose,
}: {
  portalRowId: string
  label: string
  onClose: () => void
}): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.portalPreview(portalRowId), [portalRowId])
  const documents: PortalPreviewRow[] = data?.documents ?? []
  const hidden = documents.filter((document) => !document.clientVisible).length

  return (
    <Panel
      title={`What "${label}" sees`}
      actions={
        <Button onClick={onClose} label="Close the preview">
          Close
        </Button>
      }
    >
      <AsyncState
        loading={loading}
        error={error}
        empty={documents.length === 0}
        emptyMessage="This portal's sources and libraries resolve to no documents at all."
      >
        <Stack gap="0">
          {hidden > 0 ? (
            // Stated up front: the difference between what the bindings resolve and
            // what a viewer sees is exactly what this screen is for.
            <Box px="4" py="2" bg="bg.subtle" borderBottomWidth="1px">
              <Text fontSize="xs" color="fg.muted">
                {documents.length - hidden} of {documents.length} visible to the viewer.{' '}
                {hidden} hidden because they are still processing, failed, or orphaned by a
                removed source.
              </Text>
            </Box>
          ) : null}

          <Table headers={['Document', 'How it got here', 'Status', 'Sync', 'Viewer sees it']}>
            {documents.map((document) => (
              <Box as="tr" key={document.id}>
                <Cell>{document.name}</Cell>
                <Cell muted>{document.origin}</Cell>
                <Cell>
                  <Pill value={document.status} />
                </Cell>
                <Cell>
                  <Text color={document.clientVisible ? 'ok.fg' : 'fg.muted'}>
                    {document.clientVisible ? 'yes' : 'no'}
                  </Text>
                </Cell>
              </Box>
            ))}
          </Table>
        </Stack>
      </AsyncState>
    </Panel>
  )
}
