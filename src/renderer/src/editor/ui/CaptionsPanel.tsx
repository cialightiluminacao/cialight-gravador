import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Captions, FileDown, FileUp, Plus, Trash2, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { addCaption, captionCues, deleteItems, importCaptions, isCaptionsTrack, setCaptionPosition, setCaptionStyle, setCaptionTimes, updateItem } from '@shared/editor/ops'
import { TEXT_PRESETS } from '@shared/editor/factory'
import type { Project, TextItem, TextStyle, Track } from '@shared/editor/project'
import { formatCueTime, parseSrt, serializeSrt, type Cue } from '@shared/editor/srt'
import { fileNameFromTitle } from '@shared/filenames'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Select, Toggle } from '@/components/ui/primitives'
import { ipcErrorMessage } from '@/lib/ipcError'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { seekTo } from './editorActions'
import { ColorInput, FieldRow, PanelSection } from './Inspector/common'
import { NumberField } from './Inspector/NumberField'
import { buildFontOptions, joinColor, splitColor } from './Inspector/textStyleEdit'
import { planTextEdit } from './viewer/textEdit'
import { nextCaptionAt, planTimeEdit, warningsSummary } from './captionsEdit'

// Aba "Legendas" da biblioteca: a lista das legendas (início/fim em mm:ss,mmm e texto editáveis; clicar numa linha leva
// o playhead ao início dela), "Nova legenda no playhead", Enter no texto da última cria a próxima e foca nela,
// importar/exportar SRT e o estilo comum (fonte, tamanho, cor, fundo, posição vertical) — um passo de desfazer por
// gesto (NumberField/ColorInput abrem uma transação; seletores e interruptores são um passo).

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const NO_ITEMS: TextItem[] = []

/** Faixa de legendas e as legendas (textos) dela, em ordem. */
function captionsOf(p: Project | null): { track: Track | null; items: TextItem[] } {
  const track = p?.tracks.find(isCaptionsTrack) ?? null
  return { track, items: track ? (track.items.filter((i) => i.type === 'text') as TextItem[]) : NO_ITEMS }
}

interface PendingImport { cues: Cue[]; warnings: string[]; name: string }

export function CaptionsPanel({ playback }: { playback: PlaybackController | null }): React.JSX.Element {
  const project = useEditorStore((s) => s.project)
  const selection = useEditorStore((s) => s.selection)
  const { track, items } = captionsOf(project)
  const locked = !!track?.locked
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [importWarnings, setImportWarnings] = useState<{ name: string; list: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  // legenda recém-criada que deve receber o foco quando a linha aparecer
  const focusRef = useRef<string | null>(null)

  const seek = useCallback(
    (us: number): void => {
      if (st().playing) playback?.pause()
      seekTo(playback, us)
    },
    [playback]
  )

  const addAt = useCallback((atUs: number): void => {
    let id: string | null = null
    const ok = st().apply((p) => {
      const r = addCaption(p, atUs, 'Nova legenda')
      id = r.itemId
      return r.project
    })
    if (ok && id) {
      focusRef.current = id
      st().select([id])
    }
  }, [])
  // Enter no texto da última legenda: a próxima nasce no playhead (ou logo depois da última)
  const onEnterLast = useCallback((): void => {
    const list = captionsOf(st().project).items
    addAt(nextCaptionAt(st().playheadUs, list.length ? list[list.length - 1] : null))
  }, [addAt])

  const doImport = (pi: PendingImport, mode: 'replace' | 'append'): void => {
    setPending(null)
    let result: { count: number; warnings: string[] } | null = null
    st().apply((p) => {
      const r = importCaptions(p, pi.cues, { mode })
      result = { count: r.count, warnings: r.warnings }
      return r.project
    })
    if (!result) return
    const { count, warnings } = result as { count: number; warnings: string[] }
    const all = [...pi.warnings, ...warnings]
    setImportWarnings(all.length ? { name: pi.name, list: all } : null)
    const title = `${count === 1 ? '1 legenda importada' : `${count} legendas importadas`} de “${pi.name}”`
    if (all.length) toast.warning(title, { description: <span className="whitespace-pre-line">{warningsSummary(all)}</span>, duration: 10_000 })
    else toast.success(title)
  }

  const importSrt = async (): Promise<void> => {
    setBusy(true)
    try {
      const file = await window.api.captions.openSrt()
      if (!file) return
      const parsed = parseSrt(file.text)
      if (!parsed.cues.length) {
        setImportWarnings(parsed.warnings.length ? { name: file.name, list: parsed.warnings } : null)
        toast.error(`Nenhuma legenda encontrada em “${file.name}”`, { description: <span className="whitespace-pre-line">{warningsSummary(parsed.warnings) || 'O arquivo não parece ser um SRT.'}</span> })
        return
      }
      const pi = { cues: parsed.cues, warnings: parsed.warnings, name: file.name }
      // já há legendas: pergunta substituir/acrescentar
      if (captionsOf(st().project).items.length) setPending(pi)
      else doImport(pi, 'replace')
    } catch (e) {
      toast.error('Não foi possível importar as legendas', { description: ipcErrorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const exportSrt = async (): Promise<void> => {
    const p = st().project
    if (!p) return
    const cues = captionCues(p)
    if (!cues.length) {
      toast('Não há legendas (ativas) para exportar.')
      return
    }
    setBusy(true)
    try {
      const path = await window.api.captions.saveSrt(serializeSrt(cues), `${fileNameFromTitle(p.name) || 'Legendas'}.srt`)
      if (path) toast.success(`${cues.length === 1 ? '1 legenda exportada' : `${cues.length} legendas exportadas`}`, { description: path })
    } catch (e) {
      toast.error('Não foi possível exportar as legendas', { description: ipcErrorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 p-2" data-captions-panel="">
      <div className="flex flex-col gap-1.5">
        <Button variant="primary" size="sm" className="h-8 w-full" disabled={locked || !project} onClick={() => addAt(st().playheadUs)} data-caption-add="">
          <Plus className="h-3.5 w-3.5" /> Nova legenda no playhead
        </Button>
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" disabled={busy || locked} onClick={() => void importSrt()} data-caption-import="">
            <FileUp className="h-3.5 w-3.5" /> Importar SRT…
          </Button>
          <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" disabled={busy || !items.length} onClick={() => void exportSrt()} data-caption-export="">
            <FileDown className="h-3.5 w-3.5" /> Exportar SRT…
          </Button>
        </div>
        {locked ? <p className="text-[10.5px] text-warn">A faixa de legendas está bloqueada: desbloqueie-a para editar.</p> : null}
      </div>

      {importWarnings ? (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-2 py-1.5 text-[10.5px] text-warn" role="status" data-import-warnings="">
          <div className="flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 font-semibold">
              {importWarnings.list.length === 1 ? '1 aviso' : `${importWarnings.list.length} avisos`} ao importar “{importWarnings.name}”
            </span>
            <button type="button" aria-label="Fechar avisos da importação" className="shrink-0 rounded p-0.5 hover:bg-white/10" onClick={() => setImportWarnings(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
          <ul className="mt-1 flex max-h-24 flex-col gap-0.5 overflow-y-auto pl-4">
            {importWarnings.list.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {items.length ? (
        <>
          <ol className="flex flex-col gap-1" aria-label="Legendas" data-captions-list="">
            {items.map((it, i) => (
              <CaptionRow
                key={it.id}
                item={it}
                index={i}
                isLast={i === items.length - 1}
                selected={selection.includes(it.id)}
                locked={locked}
                focusRef={focusRef}
                onSeek={seek}
                onEnterLast={onEnterLast}
              />
            ))}
          </ol>
          <CaptionStyle items={items} locked={locked} />
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-muted">
          <Captions className="h-6 w-6" />
          <span className="text-[11px] leading-relaxed">Nenhuma legenda ainda. Crie uma no playhead ou importe um arquivo SRT.</span>
        </div>
      )}

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent title="Importar legendas" className="w-[min(440px,92vw)]">
          {pending ? (
            <div className="flex flex-col gap-4" data-import-choice="">
              <p className="text-[12.5px] leading-relaxed text-fg-2">
                O projeto já tem {items.length === 1 ? '1 legenda' : `${items.length} legendas`}. O que fazer com {pending.cues.length === 1 ? 'a legenda' : `as ${pending.cues.length} legendas`} de “{pending.name}”?
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setPending(null)}>
                  Cancelar
                </Button>
                <Button variant="secondary" onClick={() => doImport(pending, 'append')} data-import-mode="append">
                  Acrescentar
                </Button>
                <Button variant="primary" onClick={() => doImport(pending, 'replace')} data-import-mode="replace">
                  Substituir
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Campo de tempo (mm:ss,mmm): rascunho local, confirmado no Enter/ao sair; Esc descarta o rascunho. */
function TimeField({ label, valueUs, disabled, onCommit, field }: { label: string; valueUs: number; disabled: boolean; onCommit: (typed: string) => void; field: 'start' | 'end' }): React.JSX.Element {
  const shown = formatCueTime(valueUs)
  const [draft, setDraft] = useState<string | null>(null)
  const discard = useRef(false)
  return (
    <input
      aria-label={label}
      title={label}
      value={draft ?? shown}
      disabled={disabled}
      spellCheck={false}
      data-caption-time={field}
      className="h-6 w-[74px] rounded border border-border bg-bg-2 px-1 font-mono text-[10.5px] tabular-nums text-fg outline-none focus:border-accent/60 disabled:opacity-40"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        // o campo volta a mostrar o modelo: um tempo recusado não fica nele (o aceito chega pelo valueUs)
        const typed = draft
        setDraft(null)
        if (discard.current) discard.current = false
        else if (typed !== null && typed !== shown) onCommit(typed)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          discard.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

const CaptionRow = memo(function CaptionRow({ item, index, isLast, selected, locked, focusRef, onSeek, onEnterLast }: { item: TextItem; index: number; isLast: boolean; selected: boolean; locked: boolean; focusRef: React.RefObject<string | null>; onSeek: (us: number) => void; onEnterLast: () => void }): React.JSX.Element {
  const textRef = useRef<HTMLTextAreaElement>(null)
  // Enter na última: grava o texto e cria a próxima só depois do blur (uma edição por vez)
  const enterRef = useRef(false)
  useEffect(() => {
    if (focusRef.current !== item.id || !textRef.current) return
    focusRef.current = null
    textRef.current.focus()
    textRef.current.select()
    textRef.current.scrollIntoView({ block: 'nearest' })
  })

  const commitTime = (field: 'start' | 'end', typed: string): void => {
    const plan = planTimeEdit(item, field, typed)
    if (plan.kind === 'invalid') toast.error(plan.message)
    else if (plan.kind === 'change') st().apply((p) => setCaptionTimes(p, item.id, plan.startUs, plan.endUs))
  }
  const commitText = (typed: string): void => {
    const plan = planTextEdit(item.text, typed)
    if (plan.kind === 'empty') toast('O texto da legenda não pode ficar vazio: o anterior foi mantido.')
    else if (plan.kind === 'change') st().apply((p) => updateItem<TextItem>(p, item.id, (d) => { d.text = plan.text }))
  }
  const off = item.enabled === false

  return (
    <li
      aria-label={`Legenda ${index + 1}`}
      data-caption-id={item.id}
      className={cn('flex flex-col gap-1 rounded-lg border px-1.5 py-1.5', selected ? 'border-accent/60 bg-accent/10' : 'border-border bg-bg-2/40 hover:border-border-strong', off && 'opacity-50')}
      onClick={() => {
        onSeek(item.startUs)
        if (!selected) st().select([item.id])
      }}
    >
      <div className="flex items-center gap-1">
        <span className="w-5 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted">{index + 1}</span>
        <TimeField label={`Início da legenda ${index + 1}`} field="start" valueUs={item.startUs} disabled={locked} onCommit={(t) => commitTime('start', t)} />
        <span className="text-[10px] text-muted-2">→</span>
        <TimeField label={`Fim da legenda ${index + 1}`} field="end" valueUs={item.startUs + item.durationUs} disabled={locked} onCommit={(t) => commitTime('end', t)} />
        {off ? <span className="text-[9.5px] text-muted">desativada</span> : null}
        <button
          type="button"
          aria-label={`Excluir a legenda ${index + 1}`}
          title="Excluir legenda"
          disabled={locked}
          data-caption-delete=""
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-danger/15 hover:text-danger disabled:opacity-40"
          onClick={(e) => {
            e.stopPropagation()
            st().apply((p) => deleteItems(p, [item.id], { includeLinked: false }))
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        ref={textRef}
        key={item.text}
        aria-label={`Texto da legenda ${index + 1}`}
        defaultValue={item.text}
        disabled={locked}
        rows={Math.min(3, item.text.split('\n').length)}
        spellCheck
        data-caption-text=""
        className="w-full resize-none rounded border border-border bg-bg-2 px-1.5 py-1 text-[11.5px] leading-snug text-fg outline-none focus:border-accent/60 disabled:opacity-40"
        onBlur={(e) => {
          const typed = e.target.value
          // texto recusado (vazio) não fica no campo
          if (typed.trim() === '') e.target.value = item.text
          commitText(typed)
          if (enterRef.current) {
            enterRef.current = false
            onEnterLast()
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          // Enter confirma (Shift+Enter quebra a linha); na última legenda, cria a próxima
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            enterRef.current = isLast
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.currentTarget.value = item.text
            e.currentTarget.blur()
          }
        }}
      />
    </li>
  )
})

/** Estilo comum das legendas (o da primeira; setCaptionStyle aplica a todas). */
function CaptionStyle({ items, locked }: { items: TextItem[]; locked: boolean }): React.JSX.Element {
  const s = items[0].style
  const y = items[0].visual.transform.y.value
  const apply = (patch: Partial<TextStyle>, transient: boolean): void => {
    st().apply((p) => setCaptionStyle(p, patch), transient ? { transient: true } : undefined)
  }
  const bg = splitColor(s.background)
  const color = splitColor(s.color)
  return (
    <PanelSection title="Estilo das legendas">
      <FieldRow label="Fonte">
        <Select triggerClassName="h-7 rounded-md px-2 text-[11px]" value={s.font} options={buildFontOptions(s.font, [])} disabled={locked} onValueChange={(font) => apply({ font }, false)} />
      </FieldRow>
      <NumberField label="Tamanho" value={s.size.value} min={8} max={400} precision={0} step={1} unit="px" disabled={locked} onChange={(n) => apply({ size: { value: n } }, true)} title="Em pixels num quadro de 1080 px de lado menor" />
      <FieldRow label="Cor do texto">
        <span className="font-mono text-[10.5px] uppercase text-muted">{color.hex}</span>
        <ColorInput label="Cor do texto das legendas" disabled={locked} value={color.hex} onChange={(hex) => apply({ color: joinColor(hex, color.alpha) }, true)} />
      </FieldRow>
      <FieldRow label="Fundo">
        <Toggle size="sm" checked={!!s.background} disabled={locked} aria-label="Fundo das legendas" onCheckedChange={(on) => apply({ background: on ? (TEXT_PRESETS.caption.style.background ?? '#000000b3') : undefined }, false)} />
      </FieldRow>
      {s.background ? (
        <>
          <FieldRow label="Cor do fundo">
            <ColorInput label="Cor do fundo das legendas" disabled={locked} value={bg.hex} onChange={(hex) => apply({ background: joinColor(hex, bg.alpha) }, true)} />
          </FieldRow>
          <NumberField label="Opacidade" value={bg.alpha * 100} min={0} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => apply({ background: joinColor(bg.hex, n / 100) }, true)} title="Opacidade do fundo das legendas" />
        </>
      ) : null}
      <NumberField
        label="Posição vertical"
        value={y * 100}
        min={0}
        max={100}
        precision={0}
        step={1}
        unit="%"
        disabled={locked}
        onChange={(n) => st().apply((p) => setCaptionPosition(p, n / 100), { transient: true })}
        title="Centro das legendas, em % da altura do quadro (0 = topo, 100 = base)"
      />
    </PanelSection>
  )
}
