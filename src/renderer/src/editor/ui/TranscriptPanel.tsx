import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Search } from 'lucide-react'
import { toast } from 'sonner'
import type { TextItem } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { ipcErrorMessage } from '@/lib/ipcError'
import { buildTranscript, seekUsForOffset, transcriptText, type TranscriptCue, type TranscriptRow } from './transcriptView'

// Visão "Transcrição" da aba Legendas: as legendas ativas como texto corrido com horários, busca (sem diferenciar
// maiúsculas/acentos) com os trechos destacados, clique numa palavra leva o playhead ao instante dela e "Copiar
// transcrição". Derivada da faixa de legendas atual (nada novo no projeto).

export function TranscriptView({ items, onSeek }: { items: TextItem[]; onSeek: (us: number, itemId: string) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const searching = !!deferred.trim()
  const cues = useMemo<TranscriptCue[]>(() => items.filter((i) => i.enabled !== false).map((i) => ({ id: i.id, startUs: i.startUs, durationUs: i.durationUs, text: i.text })), [items])
  const { rows, matches } = useMemo(() => buildTranscript(cues, deferred), [cues, deferred])
  const byId = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues])
  const listRef = useRef<HTMLDivElement>(null)

  // a 1ª ocorrência entra na área visível
  useEffect(() => {
    if (!deferred.trim()) return
    listRef.current?.querySelector('mark')?.scrollIntoView({ block: 'nearest' })
  }, [deferred, rows])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(transcriptText(cues))
      toast.success('Transcrição copiada')
    } catch (e) {
      toast.error('Não foi possível copiar a transcrição', { description: ipcErrorMessage(e) })
    }
  }

  // um ouvinte só para todas as palavras (1 000 legendas = milhares de palavras)
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const w = (e.target as HTMLElement).closest<HTMLElement>('[data-transcript-word]')
    const row = w?.closest<HTMLElement>('[data-transcript-row]')
    const cue = row ? byId.get(row.dataset.transcriptRow ?? '') : undefined
    if (!w || !cue) return
    onSeek(seekUsForOffset(cue, Number(w.dataset.offset)), cue.id)
  }

  return (
    <div className="flex flex-col gap-2" data-transcript-view="">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          aria-label="Buscar na transcrição"
          placeholder="Buscar na transcrição…"
          value={query}
          spellCheck={false}
          data-transcript-search=""
          className="h-7 w-full rounded-md border border-border bg-bg-2 pl-7 pr-2 text-[11.5px] text-fg outline-none focus:border-accent/60"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-1.5">
        <p className="min-w-0 text-[10.5px] text-muted" role="status" data-transcript-count={searching ? matches : undefined}>
          {searching ? (matches === 0 ? 'Nenhuma ocorrência' : matches === 1 ? '1 ocorrência' : `${matches} ocorrências`) : null}
        </p>
        <Button variant="secondary" size="sm" className="h-7 shrink-0 px-2 text-[11px]" disabled={!cues.length} onClick={() => void copy()} data-transcript-copy="">
          <Copy className="h-3.5 w-3.5" /> Copiar transcrição
        </Button>
      </div>
      <div ref={listRef} className="flex flex-col gap-1.5 text-[11.5px] leading-relaxed" aria-label="Transcrição" role="list" onClick={onClick}>
        {rows.map((r) => (
          <Row key={r.cue.id} row={r} onSeek={onSeek} />
        ))}
      </div>
    </div>
  )
}

const Row = memo(function Row({ row, onSeek }: { row: TranscriptRow; onSeek: (us: number, itemId: string) => void }): React.JSX.Element {
  return (
    <div role="listitem" data-transcript-row={row.cue.id} className="flex gap-2">
      <button
        type="button"
        aria-label={`Ir para ${row.time}`}
        data-transcript-time=""
        className="h-fit shrink-0 rounded px-1 font-mono text-[10px] tabular-nums text-muted hover:bg-white/5 hover:text-fg"
        onClick={(e) => {
          e.stopPropagation()
          onSeek(row.cue.startUs, row.cue.id)
        }}
      >
        {row.time}
      </button>
      <p className="min-w-0 flex-1 text-fg-2">
        {row.tokens.map((t) =>
          t.word ? (
            <span key={t.offset} data-transcript-word="" data-offset={t.offset} className="cursor-pointer rounded-sm hover:bg-white/10 hover:text-fg">
              {t.pieces.map((p, k) => (p.hl ? <mark key={k} data-transcript-match="" className="rounded-sm bg-accent/40 text-fg">{p.text}</mark> : p.text))}
            </span>
          ) : (
            t.pieces.map((p, k) => (p.hl ? <mark key={`${t.offset}-${k}`} data-transcript-match="" className="bg-accent/40 text-fg">{' '}</mark> : ' '))
          )
        )}
      </p>
    </div>
  )
})
