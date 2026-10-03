import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Info, LoaderCircle, ShieldAlert, X } from 'lucide-react'
import { SENSITIVE_KIND_LABELS, type SensitiveKind } from '@shared/editor/sensitive'
import { Button } from '@/components/ui/Button'
import { Progress, Segmented } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { useSensitiveScan } from '../state/sensitiveScan'
import { cancelSensitiveScan, closeSensitiveDialog, resetSensitiveReview, focusSensitiveRow, hideSensitiveRows, startSensitiveScan } from './sensitiveFlow'
import { THUMB_H, THUMB_W } from './sensitiveThumbs'
import { ALL_KINDS, checkedRows, formatSpan, kindCounts, MAX_CUSTOM_WORDS, parseCustomWords, PHASE_LABELS, planScan, ROW_PAGE, SCAN_DISCLAIMER, visibleRows, type ReviewRow } from './sensitiveReview'

// "Procurar dados sensíveis" (G3): 1) opções (tipos, palavras personalizadas, estilo), 2) busca com progresso e
// "Cancelar", 3) revisão — uma linha por ocorrência (miniatura, tipo, texto mascarado, trecho na linha do tempo,
// "não confirmado"), marcada por padrão; passar o ponteiro/foco leva o playhead até ela e desenha o contorno no
// visualizador; "Esconder…" cria os efeitos num passo de desfazer. Modal (foco preso; Esc cancela a busca ou fecha),
// sem fundo escuro, à direita (sobre o inspetor) para o visualizador continuar à vista. Nada é criado sem um clique em
// "Esconder…"; fechar apaga termos e resultados da memória.

const st = (): ReturnType<typeof useSensitiveScan.getState> => useSensitiveScan.getState()

function panelTop(): number {
  const b = document.querySelector('[data-editor-topbar]')?.getBoundingClientRect().bottom
  return Math.round((b ?? 88) + 8)
}

function Disclaimer(): React.JSX.Element {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted" data-sensitive-disclaimer="">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{SCAN_DISCLAIMER}</span>
    </p>
  )
}

function StyleChoice(): React.JSX.Element {
  const style = useSensitiveScan((s) => s.style)
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] font-medium text-fg-2">
        Como esconder
      </span>
      <Segmented
        size="sm"
        ariaLabel="Como esconder"
        value={style}
        onValueChange={(v) => st().patch({ style: v })}
        options={[
          { value: 'blur', label: 'Desfoque', title: 'Desfoca o texto (preset “Esconder texto”)' },
          { value: 'solid', label: 'Tarja', title: 'Cobre com uma tarja preta (irreversível na exportação)' }
        ]}
      />
    </div>
  )
}

function Setup(): React.JSX.Element {
  const kinds = useSensitiveScan((s) => s.kinds)
  const wordsText = useSensitiveScan((s) => s.wordsText)
  const parsed = useMemo(() => parseCustomWords(wordsText), [wordsText])
  const toggle = (k: SensitiveKind, on: boolean): void => st().patch({ kinds: on ? ALL_KINDS.filter((x) => x === k || kinds.includes(x)) : kinds.filter((x) => x !== k) })
  return (
    <div className="mt-4 space-y-4">
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 flex w-full items-center justify-between text-[12px] font-medium text-fg-2">
          <span>Procurar</span>
          <button type="button" className="text-[11px] font-normal text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => st().patch({ kinds: kinds.length === ALL_KINDS.length ? [] : [...ALL_KINDS] })}>
            {kinds.length === ALL_KINDS.length ? 'Desmarcar todos' : 'Marcar todos'}
          </button>
        </legend>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl border border-border bg-bg-2 px-3 py-2">
          {ALL_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-[12px] text-fg" data-sensitive-kind={k}>
              <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={kinds.includes(k)} onChange={(e) => toggle(k, e.target.checked)} />
              <span className="truncate">{SENSITIVE_KIND_LABELS[k]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1.5">
        <label htmlFor="sensitive-words" className="flex items-baseline justify-between text-[12px] font-medium text-fg-2">
          <span>Palavras personalizadas</span>
          <span className={cn('font-mono text-[10.5px] tabular-nums', parsed.dropped || parsed.tooLong ? 'text-warn' : 'text-muted')}>
            {parsed.words.length} de {MAX_CUSTOM_WORDS}
          </span>
        </label>
        <textarea
          id="sensitive-words"
          data-sensitive-words=""
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={wordsText}
          onChange={(e) => st().patch({ wordsText: e.target.value })}
          aria-describedby="sensitive-words-hint"
          placeholder="Uma por linha ou separadas por vírgula"
          className="w-full resize-none rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-[12px] leading-snug text-fg outline-none focus:border-accent/60"
        />
        <p id="sensitive-words-hint" className="text-[11px] text-muted">
          Nomes, empresas ou termos a esconder. Não ficam salvos.
          {parsed.dropped || parsed.tooLong ? <span className="text-warn"> Até 50 termos com até 100 caracteres: {parsed.dropped + parsed.tooLong} ficarão de fora.</span> : null}
        </p>
      </div>
      <StyleChoice />
      <Disclaimer />
    </div>
  )
}

function Scanning(): React.JSX.Element {
  const pr = useSensitiveScan((s) => s.progress)
  const pct = pr && pr.total > 0 ? (100 * pr.done) / pr.total : 0
  return (
    <div className="mt-5 space-y-2.5" aria-live="polite" data-sensitive-progress="">
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-2 font-medium text-fg">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent" /> {pr ? PHASE_LABELS[pr.phase] : 'Preparando…'}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted">{pr && pr.total > 0 ? `${pr.done} de ${pr.total}` : ''}</span>
      </div>
      <Progress value={pct} />
      {pr ? (
        <p className="text-[11px] text-muted">
          Arquivo {pr.file} de {pr.files}
          {pr.ranges > 1 ? ` · trecho ${pr.range} de ${pr.ranges}` : ''}
        </p>
      ) : null}
      <Disclaimer />
    </div>
  )
}

const Row = memo(function Row({ row, checked, failed, thumb, fps, onFocus }: { row: ReviewRow; checked: boolean; failed: boolean; thumb: string | undefined; fps: number; onFocus: (r: ReviewRow) => void }): React.JSX.Element {
  const label = SENSITIVE_KIND_LABELS[row.kind]
  const toggle = (on: boolean): void => {
    const u = new Set(st().unchecked)
    if (on) u.delete(row.id)
    else u.add(row.id)
    st().patch({ unchecked: u })
  }
  return (
    <li
      data-sensitive-row={row.id}
      data-kind={row.kind}
      className="group flex items-center gap-2 rounded-lg border border-transparent px-1.5 py-1.5 hover:border-border hover:bg-white/4 focus-within:border-border focus-within:bg-white/4"
      onPointerEnter={() => onFocus(row)}
      onFocus={() => onFocus(row)}
    >
      <input type="checkbox" className="h-3.5 w-3.5 shrink-0 accent-accent" checked={checked} onChange={(e) => toggle(e.target.checked)} aria-label={`Incluir ${label} ${row.occ.masked} em “Esconder selecionados”`} />
      <div className="shrink-0 overflow-hidden rounded border border-border bg-black" style={{ width: THUMB_W / 2, height: THUMB_H / 2 }}>
        {thumb ? <img src={thumb} alt="" width={THUMB_W / 2} height={THUMB_H / 2} className="h-full w-full object-cover" draggable={false} /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-fg-2">{label}</span>
          {row.occ.confidence === 'pattern' ? <span className="rounded-full border border-warn/30 bg-warn/15 px-1.5 text-[9.5px] font-semibold text-warn" title="O formato bate, mas o dígito verificador não foi conferido">não confirmado</span> : null}
          {failed ? (
            <span data-sensitive-not-hidden="" className="rounded-full border border-danger/30 bg-danger/15 px-1.5 text-[9.5px] font-semibold text-danger" title="A faixa do clipe está bloqueada: desbloqueie e clique em Esconder de novo">
              não escondido
            </span>
          ) : null}
        </div>
        <div className="truncate font-mono text-[11.5px] text-fg" data-sensitive-masked="">
          {row.occ.masked}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-muted">
          {formatSpan(row.fromUs, row.toUs, fps)}
          {row.clips > 1 ? ` · ${row.clips} clipes` : ''}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <Button size="sm" variant="secondary" className="h-6 rounded-md px-2 text-[11px]" onClick={() => hideSensitiveRows([row])} aria-label={`Esconder ${label} ${row.occ.masked}`}>
          Esconder
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 rounded-md px-2 text-[11px]"
          onClick={() => {
            st().patch({ ignored: new Set(st().ignored).add(row.id), hover: null })
          }}
          aria-label={`Ignorar ${label} ${row.occ.masked}`}
        >
          Ignorar
        </Button>
      </div>
    </li>
  )
})

function Review({ playback }: { playback: PlaybackController | null }): React.JSX.Element {
  const rows = useSensitiveScan((s) => s.rows)
  const ignored = useSensitiveScan((s) => s.ignored)
  const filter = useSensitiveScan((s) => s.filter)
  const unchecked = useSensitiveScan((s) => s.unchecked)
  const thumbs = useSensitiveScan((s) => s.thumbs)
  const fps = useEditorStore((s) => s.project?.canvas.fps ?? 30)
  const [limit, setLimit] = useState(ROW_PAGE)
  const live = useMemo(() => visibleRows(rows, null, ignored), [rows, ignored])
  const counts = useMemo(() => kindCounts(live), [live])
  const shown = useMemo(() => visibleRows(rows, filter, ignored), [rows, filter, ignored])
  const selected = useMemo(() => checkedRows(shown, unchecked), [shown, unchecked])
  const allChecked = useMemo(() => checkedRows(live, unchecked).length, [live, unchecked])
  const notHidden = useSensitiveScan((s) => s.notHidden)
  const onFocus = useMemo(() => (r: ReviewRow) => focusSensitiveRow(r, playback), [playback])
  const toggleFilter = (k: SensitiveKind): void => {
    const f = new Set(filter)
    if (f.has(k)) f.delete(k)
    else f.add(k)
    st().patch({ filter: f })
  }
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar por tipo">
        {counts.map((c) => (
          <button
            key={c.kind}
            type="button"
            aria-pressed={filter.has(c.kind)}
            data-sensitive-filter={c.kind}
            onClick={() => toggleFilter(c.kind)}
            className={cn('h-6 rounded-full border px-2 text-[11px] font-medium', filter.has(c.kind) ? 'border-accent/50 bg-accent/15 text-fg' : 'border-border text-fg-2 hover:bg-white/5')}
          >
            {c.label} <span className="font-mono tabular-nums text-muted">{c.n}</span>
          </button>
        ))}
      </div>
      <ul className="-mx-1.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5" aria-label="Dados encontrados" data-sensitive-list="" onPointerLeave={() => focusSensitiveRow(null, playback)}>
        {shown.slice(0, limit).map((r) => (
          <Row key={r.id} row={r} checked={!unchecked.has(r.id)} failed={notHidden.has(r.id)} thumb={thumbs[r.id]} fps={fps} onFocus={onFocus} />
        ))}
      </ul>
      {shown.length > limit ? (
        <button type="button" className="self-center text-[11px] text-fg-2 underline-offset-2 hover:underline" onClick={() => setLimit((l) => l + ROW_PAGE)}>
          Mostrar mais ({shown.length - limit})
        </button>
      ) : null}
      <StyleChoice />
      <Disclaimer />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={resetSensitiveReview}>
          Nova busca
        </Button>
        <Button size="sm" variant="secondary" disabled={selected.length === 0} title={filter.size ? 'Só as marcadas entre as do filtro de tipo' : undefined} onClick={() => hideSensitiveRows(selected)} data-sensitive-hide-selected="">
          Esconder selecionados ({filter.size ? `${selected.length} de ${allChecked} marcados` : selected.length})
        </Button>
        <Button size="sm" variant="primary" disabled={live.length === 0} onClick={() => hideSensitiveRows(live)} data-sensitive-hide-all="">
          Esconder todos
        </Button>
      </div>
    </div>
  )
}

export function SensitiveDialog({ playback }: { playback: PlaybackController | null }): React.JSX.Element | null {
  const open = useSensitiveScan((s) => s.open)
  const step = useSensitiveScan((s) => s.step)
  const clipId = useSensitiveScan((s) => s.clipId)
  const focusTick = useSensitiveScan((s) => s.focusTick)
  const found = useSensitiveScan((s) => s.rows.reduce((n, r) => n + (s.ignored.has(r.id) ? 0 : 1), 0))
  const project = useEditorStore((s) => s.project)
  const contentRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(96)
  useEffect(() => {
    if (!open) return
    setTop(panelTop())
    const onResize = (): void => setTop(panelTop())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])
  // 2ª entrada com o diálogo aberto: traz o foco para ele
  useEffect(() => {
    if (focusTick) contentRef.current?.focus()
  }, [focusTick])
  const plan = useMemo(() => (open && project ? planScan(project, clipId) : null), [open, project, clipId])
  if (!project) return null
  const clipName = clipId ? project.tracks.flatMap((t) => t.items).find((i) => i.id === clipId)?.name : null
  const files = plan?.jobs.length ?? 0
  const scope = clipId ? `Só no clipe${clipName ? ` “${clipName}”` : ''}; os efeitos entram só nele.` : `Em todos os clipes de vídeo ativos (${files === 1 ? '1 arquivo' : `${files} arquivos`}).`
  const skippedNote = plan?.unsupported ? ` ${plan.unsupported === 1 ? '1 clipe fica' : `${plan.unsupported} clipes ficam`} de fora (imagem, mídia ausente ou gerada: a busca lê só vídeos).` : ''
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) closeSensitiveDialog()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={contentRef}
          data-sensitive-dialog=""
          onEscapeKeyDown={(e) => {
            // Esc na busca: cancela (volta às opções); senão fecha
            if (st().step === 'scanning') {
              e.preventDefault()
              cancelSensitiveScan()
            }
          }}
          onInteractOutside={(e) => e.preventDefault()}
          style={{ top, maxHeight: `calc(100vh - ${top + 12}px)` }}
          className={cn('fixed right-3 z-50 flex w-[min(440px,94vw)] flex-col rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl animate-in fade-in-0 zoom-in-95 focus:outline-none', step === 'review' ? 'h-[calc(100vh-120px)]' : 'overflow-y-auto')}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
                <ShieldAlert className="h-4 w-4 text-accent" /> Procurar dados sensíveis
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-[12px] leading-relaxed text-muted">
                {step === 'review' ? `${found === 1 ? '1 encontrado' : `${found} encontrados`}. Confira cada um e escolha o que esconder.` : `Lê o texto dos quadros (no computador, sem internet) e lista CPF, e-mails, telefones, cartões e outros dados. ${scope}${skippedNote}`}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg" aria-label="Fechar">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          {step === 'setup' ? <Setup /> : step === 'scanning' ? <Scanning /> : <Review playback={playback} />}
          {step !== 'review' ? (
            <div className="mt-5 flex justify-end gap-2">
              {step === 'scanning' ? (
                <Button size="sm" variant="secondary" onClick={() => cancelSensitiveScan()}>
                  Cancelar
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={closeSensitiveDialog}>
                    Fechar
                  </Button>
                  <Button size="sm" variant="primary" disabled={!files} onClick={() => void startSensitiveScan()} data-sensitive-start="">
                    Procurar
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
