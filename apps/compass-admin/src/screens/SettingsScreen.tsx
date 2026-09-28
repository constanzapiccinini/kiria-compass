/**
 * Screen 5 — Settings, with provenance.
 *
 * The whole point of this screen is the "from" column. Three layers resolve to one
 * effective value, and the support question is never "what is this set to" — it is
 * "why is it set to that". A settings form without provenance sends people reading
 * three tables to answer it.
 *
 * Rejected keys are surfaced after a save rather than swallowed: a silently ignored
 * cap is how someone concludes a limit is in force when it never applied.
 */

import { useEffect, useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { Save } from 'lucide-react'
import { api, type SettingsLayer, type SettingsResponse } from '@/lib/client'
import {
  AsyncState,
  Button,
  Cell,
  NeedsClient,
  Panel,
  Table,
  useLoader,
} from '@/components/primitives'
import { PlainInput, PlainSelect } from '@/components/ui/native'

/** Editable keys with their shapes, so the form can render the right control. */
const FIELDS: Array<{ key: string; label: string; kind: 'text' | 'number' | 'boolean' | 'mode'; hint?: string }> = [
  { key: 'maxAnswerTokens', label: 'Max answer tokens', kind: 'number' },
  { key: 'maxRetrievedTokens', label: 'Max retrieved tokens', kind: 'number' },
  { key: 'maxOcrPagesPerUpload', label: 'Max OCR pages per upload', kind: 'number' },
  { key: 'monthlyTokenBudget', label: 'Monthly token budget', kind: 'number', hint: 'Empty means no cap.' },
  { key: 'monthlyOcrPageBudget', label: 'Monthly OCR page budget', kind: 'number', hint: 'Empty means no cap. When reached, source syncs pause.' },
  { key: 'ocrTablesEnabled', label: 'OCR: tables', kind: 'boolean' },
  { key: 'ocrFormsEnabled', label: 'OCR: forms', kind: 'boolean' },
  { key: 'ocrQueriesEnabled', label: 'OCR: queries', kind: 'boolean' },
  { key: 'batchEmbeddingEnabled', label: 'Batch embedding', kind: 'boolean', hint: 'Half price, up to 24h.' },
  { key: 'batchEmbeddingMinChunks', label: 'Batch threshold (chunks)', kind: 'number' },
  { key: 'retentionDays', label: 'Retention (days)', kind: 'number', hint: 'Empty means keep indefinitely.' },
]

/**
 * The shape returned before a client is chosen.
 *
 * Typed rather than an inline `{}`: an untyped empty object makes every later
 * `settings[key]` an implicit any, which is how a renamed settings key would stop
 * being a compile error.
 */
const EMPTY_SETTINGS: SettingsResponse = { settings: {}, sources: {} }

const LAYER_LABEL: Record<SettingsLayer, string> = {
  default: 'built-in default',
  org: 'org default',
  client: 'client',
  portal: 'portal override',
}

export function SettingsScreen({ clientId }: { clientId: string | null }): React.ReactElement {
  const [portalRowId, setPortalRowId] = useState<string>('')
  const portals = useLoader(
    () => (clientId ? api.settingsPortals(clientId) : Promise.resolve({ portals: [] })),
    [clientId],
  )
  const settings = useLoader(
    () =>
      clientId
        ? api.settings(clientId, portalRowId || undefined)
        : Promise.resolve(EMPTY_SETTINGS),
    [clientId, portalRowId],
  )

  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [result, setResult] = useState<{ applied: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The draft starts as what is actually in effect, so an untouched field saves the
  // value the operator can see rather than an empty one.
  useEffect(() => {
    if (settings.data) setDraft({ ...settings.data.settings })
  }, [settings.data])

  if (!clientId) return <NeedsClient />

  const sources = settings.data?.sources ?? {}

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = portalRowId
        ? await api.savePortalOverride(portalRowId, draft)
        : await api.saveClientSettings(clientId, draft)
      setResult({ applied: response.applied })
      settings.reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap="4">
      {error ? (
        <Box borderWidth="1px" borderColor="red.400" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="red.500">
            {error}
          </Text>
        </Box>
      ) : null}

      {result ? (
        <Box borderWidth="1px" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm">
            {/* An out-of-range value is now a refusal, not a silent drop: the save
                throws and the error banner above names the field. So this only ever
                reports what was actually written. */}
            Saved {result.applied.length} setting(s).
          </Text>
        </Box>
      ) : null}

      <Panel
        title="Layer being edited"
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={busy} label="Save settings">
            <HStack gap="1">
              <Save size={14} />
              <Text>{portalRowId ? 'Save portal override' : 'Save client settings'}</Text>
            </HStack>
          </Button>
        }
      >
        <Stack p="4" gap="2">
          <HStack gap="2">
            <Text fontSize="xs" color="fg.muted">
              Editing
            </Text>
            <PlainSelect
              value={portalRowId}
              onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                setPortalRowId(event.target.value)
                setResult(null)
              }}
              aria-label="Layer to edit"
              borderWidth="1px"
              borderRadius="md"
              px="2"
              py="1"
              fontSize="sm"
              bg="bg.canvas"
            >
              <option value="">Client layer</option>
              {(portals.data?.portals ?? []).map((portal) => (
                <option key={portal.id} value={portal.id}>
                  Portal override — {portal.label}
                </option>
              ))}
            </PlainSelect>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            Precedence is portal override, then client, then org default, then the built-in
            value. The “from” column below shows which layer each effective value came from.
          </Text>
        </Stack>
      </Panel>

      <Panel title="Effective settings">
        <AsyncState
          loading={settings.loading}
          error={settings.error}
          empty={false}
          emptyMessage=""
        >
          <Table headers={['Setting', 'Effective value', 'From', 'New value']}>
            {FIELDS.map((field) => {
              const effective = settings.data?.settings[field.key]
              const layer = sources[field.key] ?? 'default'
              const value = draft[field.key]

              return (
                <Box as="tr" key={field.key}>
                  <Cell>
                    <Stack gap="0">
                      <Text>{field.label}</Text>
                      {field.hint ? (
                        <Text fontSize="xs" color="fg.muted">
                          {field.hint}
                        </Text>
                      ) : null}
                    </Stack>
                  </Cell>
                  <Cell muted>
                    {effective === null || effective === undefined ? '—' : String(effective)}
                  </Cell>
                  <Cell>
                    <Text
                      fontSize="xs"
                      // A value inherited from a broader layer reads differently from
                      // one set here, so the two are visually distinct.
                      color={layer === 'default' || layer === 'org' ? 'fg.muted' : 'accent.fg'}
                    >
                      {LAYER_LABEL[layer]}
                    </Text>
                  </Cell>
                  <Cell>
                    {field.kind === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={value === true}
                        aria-label={field.label}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, [field.key]: event.target.checked }))
                        }
                      />
                    ) : (
                      <PlainInput
                        type="number"
                        value={value === null || value === undefined ? '' : String(value)}
                        aria-label={field.label}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                          const raw = event.target.value
                          setDraft((current) => ({
                            // Empty means "no cap" for the nullable budgets, so it is
                            // sent as null rather than dropped — dropping it would
                            // leave the old cap in place.
                            ...current,
                            [field.key]: raw === '' ? null : Number(raw),
                          }))
                        }}
                        borderWidth="1px"
                        borderRadius="md"
                        px="2"
                        py="1"
                        fontSize="sm"
                        bg="bg.canvas"
                        w="120px"
                      />
                    )}
                  </Cell>
                </Box>
              )
            })}
          </Table>
        </AsyncState>
      </Panel>
    </Stack>
  )
}
