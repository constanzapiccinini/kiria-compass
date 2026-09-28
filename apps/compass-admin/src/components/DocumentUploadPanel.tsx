/**
 * Upload PDFs for the selected client (§9.4).
 *
 * Deliberately shows the client's name in the button, not just "Upload". This screen
 * has a client picker in the header, and an operator who uploads a confidential PDF
 * to the wrong client cannot undo it from here — the document is stored, queued and
 * costing money before anyone notices. Naming the target is the cheapest guard
 * available.
 *
 * Outcomes are listed per file and stay on screen until the next upload. Unlike the
 * client app's receipt, these are NOT auto-cleared: an operator uploading a batch of
 * twenty needs to see which three were duplicates after they have looked away.
 */

import { useRef, useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { Upload } from 'lucide-react'
import { type UploadOutcome } from '@/lib/client'
import { Panel } from '@/components/primitives'

export interface DocumentUploadPanelProps {
  /**
   * Where these files are going, in words the operator recognises — a portal name
   * or a library name.
   *
   * Named rather than left generic because an operator who uploads a confidential
   * PDF to the wrong destination cannot undo it from here: the document is stored,
   * queued and costing money before anyone notices. Naming the target is the
   * cheapest guard available, and it matters more now that there are two kinds of
   * destination.
   */
  destination: string
  /**
   * The upload call itself, injected rather than chosen here.
   *
   * This panel is used for a portal upload and for a library upload, which are the
   * same contract against different routes. Passing the call in keeps one panel
   * instead of two that drift.
   */
  upload: (files: File[]) => Promise<{ results: UploadOutcome[] }>
  /** Called after any upload that queued at least one document, to refresh the table. */
  onUploaded: () => void
}

/** Colour per outcome. `duplicate` is not a failure, so it is not red. */
function tone(status: UploadOutcome['status']): string {
  if (status === 'queued') return 'ok.fg'
  if (status === 'duplicate') return 'warn.fg'
  return 'red.600'
}

export function DocumentUploadPanel({
  destination,
  upload: uploadFiles,
  onUploaded,
}: DocumentUploadPanelProps): React.ReactElement {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<UploadOutcome[]>([])
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async (files: File[]): Promise<void> => {
    // Filter on MIME type OR extension: some browsers report an empty type for a
    // dragged file, and rejecting those would look like a broken drop zone. The
    // backend checks the actual %PDF header regardless, which is the real gate.
    const pdfs = files.filter(
      (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    )
    if (pdfs.length === 0) {
      setError('Only PDF files can be uploaded.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const response = await uploadFiles(pdfs)
      setOutcomes(response.results)
      if (response.results.some((result) => result.status === 'queued')) onUploaded()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={`Upload PDFs to ${destination}`}>
      <Stack p="4" gap="3">
        <Box
          role="button"
          tabIndex={0}
          aria-label={`Upload PDFs to ${destination}`}
          aria-busy={busy}
          borderWidth="1px"
          borderStyle="dashed"
          borderColor={dragging ? 'accent.solid' : 'border.default'}
          bg={dragging ? 'accent.subtle' : 'bg.canvas'}
          borderRadius="card"
          px="4"
          py="6"
          textAlign="center"
          cursor={busy ? 'progress' : 'pointer'}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(event) => {
            if (busy) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              inputRef.current?.click()
            }
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            if (busy) return
            void upload(Array.from(event.dataTransfer.files))
          }}
          _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid' }}
        >
          <Stack align="center" gap="1">
            <Upload size={20} />
            <Text fontSize="sm" fontWeight="medium">
              {busy ? 'Uploading…' : 'Drop PDFs here or click to browse'}
            </Text>
            <Text fontSize="xs" color="fg.muted">
              Up to 100 MB each. Scanned PDFs need OCR, which is not configured in this
              deployment.
            </Text>
          </Stack>

          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              // Reset first, so selecting the same file twice in a row still fires a
              // change event — otherwise a retry after a failure silently does nothing.
              event.target.value = ''
              if (files.length > 0) void upload(files)
            }}
          />
        </Box>

        {error ? (
          <Text fontSize="sm" color="red.500">
            {error}
          </Text>
        ) : null}

        {outcomes.length > 0 ? (
          <Stack gap="1">
            {outcomes.map((outcome) => (
              <HStack key={`${outcome.name}-${outcome.status}`} gap="2" fontSize="xs">
                <Text fontWeight="medium" color={tone(outcome.status)}>
                  {outcome.status}
                </Text>
                <Text>{outcome.name}</Text>
                {outcome.message ? (
                  <Text color="fg.muted">— {outcome.message}</Text>
                ) : null}
              </HStack>
            ))}
            <Text fontSize="xs" color="fg.muted">
              Queued documents are parsed and indexed by the pipeline; the table below
              shows their status as it advances.
            </Text>
          </Stack>
        ) : null}
      </Stack>
    </Panel>
  )
}
