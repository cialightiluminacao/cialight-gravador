import { useId, useRef } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { X } from 'lucide-react'
import { getAnim, findItem, setKeyEase } from '@shared/editor/ops'
import type { Ease } from '@shared/editor/project'
import { formatTimecodeUs } from '@shared/editor/time'
import { Note } from '@/components/ui/SettingRow'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { useCurveEditor, type CurveTarget } from '../../state/keyframeLanes'
import { EASE_COLOR, easeKind, PATH_LABEL } from '../timeline/laneMath'
import { CURVE_PRESETS, curveGraph, curvePath, handlesOf, presetOf, viewRange, withHandle, type Bez } from './curveMath'

// Editor de curvas (popover): a curva (ease) do trecho que começa no keyframe escolhido — ◇ do inspetor
// com o botão direito ou losango de uma linha de keyframes na linha do tempo. Gráfico 0–1 (tempo × progresso)
// com as duas alças da bezier arrastáveis (x preso a [0,1], y livre em −1..2: overshoot) e os presets.
// Preset = um passo de desfazer; arrastar uma alça = uma transação (um passo ao soltar; Esc/fechar cancela).
// Teclado: as alças recebem foco; setas movem 0,01 (Shift: 0,1) numa transação fechada ao soltar a tecla ou
// sair da alça. Faixa bloqueada: só leitura.

const W = 248
const H = 176
const PAD = 14

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
/**
 * Transação aberta por este editor (arraste/setas numa alça). Só é marcada quando não havia outra aberta: fechar o
 * popover cancela só a dele, nunca a de outro gesto (ex.: campo do inspetor no meio da edição).
 */
let handleTx = false

/** Abre a transação da alça; true = é deste editor. */
function beginHandleTx(): boolean {
  if (handleTx) return true
  const own = !st().txBase
  st().begin()
  handleTx = own
  return own
}

/** Fecha a transação da alça (commit ou cancela); nada se não for deste editor. */
function endHandleTx(commit: boolean): void {
  if (!handleTx) return
  handleTx = false
  if (commit) st().commitTx()
  else st().cancelTx()
}

/** Popover único da tela do editor; abre pelo useCurveEditor. */
export function CurveEditor(): React.JSX.Element {
  const target = useCurveEditor((s) => s.target)
  const titleId = useId()
  const close = (): void => {
    endHandleTx(false)
    useCurveEditor.getState().close()
  }
  return (
    <Popover.Root open={!!target} onOpenChange={(o) => !o && close()}>
      <Popover.Anchor asChild>
        <span aria-hidden className="pointer-events-none fixed h-0 w-0" style={{ left: target?.x ?? 0, top: target?.y ?? 0 }} />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          data-curve-editor=""
          aria-labelledby={titleId}
          side="left"
          align="center"
          sideOffset={10}
          collisionPadding={8}
          className="z-50 w-[276px] rounded-xl border border-border-strong bg-surface-3 p-3 shadow-2xl animate-in fade-in-0 zoom-in-95"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {target ? <CurveBody target={target} titleId={titleId} onClose={close} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function CurveBody({ target, titleId, onClose }: { target: CurveTarget; titleId: string; onClose: () => void }): React.JSX.Element {
  const project = useEditorStore((s) => s.project)
  const svgRef = useRef<SVGSVGElement>(null)
  /** Faixa vertical presa durante o arraste (a vista não foge do ponteiro). */
  const dragRange = useRef<{ lo: number; hi: number } | null>(null)
  const f = project ? findItem(project, target.itemId) : null
  const anim = f ? getAnim(f.item, target.path) : null
  const keys = anim?.keys ?? []
  const ki = keys.findIndex((k) => Math.abs(k.tUs - target.tUs) <= 1)
  if (!f || !project || ki < 0) {
    return (
      <div className="flex items-center justify-between gap-2 text-[12px] text-muted">
        <span id={titleId}>Este keyframe não existe mais.</span>
        <CloseButton onClose={onClose} />
      </div>
    )
  }
  const key = keys[ki]
  const next = keys[ki + 1]
  const locked = f.track.locked
  const ease = key.ease
  const handles = handlesOf(ease)
  const range = dragRange.current ?? viewRange(handles)
  const g = curveGraph(W, H, range, PAD)
  const fps = project.canvas.fps
  const absUs = f.item.startUs + key.tUs
  const preset = presetOf(ease)
  const color = EASE_COLOR[easeKind(ease)]

  const setEase = (e: Ease, transient = false): void => {
    if (transient) {
      const base = st().txBase
      if (!base) return
      st().apply(() => setKeyEase(base, target.itemId, target.path, absUs, e), { transient: true })
    } else st().apply((p) => setKeyEase(p, target.itemId, target.path, absUs, e))
  }

  const onHandleDown = (which: 1 | 2) => (e: React.PointerEvent<SVGCircleElement>): void => {
    if (locked || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRange.current = range
    const start = handles
    const own = beginHandleTx()
    // ouvintes na janela (como os gestos da linha do tempo): o arraste continua fora do gráfico
    const move = (ev: PointerEvent): void => {
      const r = svgRef.current?.getBoundingClientRect()
      if (!r || !dragRange.current) return
      const p = curveGraph(W, H, dragRange.current, PAD).fromPx(ev.clientX - r.left, ev.clientY - r.top)
      setEase({ bezier: withHandle(start, which, p.x, p.y) }, true)
    }
    const end = (ev: Event): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      dragRange.current = null
      // fechado no meio do arraste: já cancelado; transação de outro gesto: quem abriu fecha
      if (own) endHandleTx(ev.type === 'pointerup')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  /** Setas: move a alça 0,01 (Shift 0,1) a partir da curva atual, na transação da alça. */
  const onHandleKey = (which: 1 | 2) => (e: React.KeyboardEvent<SVGCircleElement>): void => {
    const d = e.shiftKey ? 0.1 : 0.01
    const step = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key]
    if (!step || locked) return
    e.preventDefault()
    e.stopPropagation()
    beginHandleTx()
    const cur = st().project
    const it = cur ? findItem(cur, target.itemId)?.item : undefined
    const k = it ? getAnim(it, target.path)?.keys?.find((x) => Math.abs(x.tUs - target.tUs) <= 1) : undefined
    if (!k) return
    const b = handlesOf(k.ease)
    const i = which === 1 ? 0 : 2
    setEase({ bezier: withHandle(b, which, b[i] + step[0], b[i + 1] + step[1]) }, true)
  }
  const onHandleKeyUp = (e: React.KeyboardEvent<SVGCircleElement>): void => {
    if (e.key.startsWith('Arrow')) endHandleTx(true)
  }

  const p0 = g.toPx(0, 0), p1 = g.toPx(1, 1)
  const h1 = g.toPx(handles[0], handles[1]), h2 = g.toPx(handles[2], handles[3])
  const y0 = g.toPx(0, 0).y, yTop = g.toPx(0, 1).y
  const fmt = (n: number): string => n.toFixed(2).replace('.', ',')

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div id={titleId} className="text-[12px] font-semibold text-fg">Curva — {PATH_LABEL[target.path]}</div>
          <div className="font-mono text-[10px] text-muted">
            {next ? `${formatTimecodeUs(absUs, fps)} → ${formatTimecodeUs(f.item.startUs + next.tUs, fps)}` : `a partir de ${formatTimecodeUs(absUs, fps)}`}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <svg ref={svgRef} data-curve-graph="" width={W} height={H} className="block rounded-lg border border-border bg-bg-2 touch-none select-none">
        {/* área 0..1 (início → fim do trecho; valor do key → valor do próximo) */}
        <rect x={p0.x} y={yTop} width={p1.x - p0.x} height={y0 - yTop} fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
        <line x1={p0.x} y1={p0.y} x2={h1.x} y2={h1.y} stroke="rgba(255,255,255,0.45)" />
        <line x1={p1.x} y1={p1.y} x2={h2.x} y2={h2.y} stroke="rgba(255,255,255,0.45)" />
        <path data-curve-path="" d={curvePath(ease, g)} fill="none" stroke={color} strokeWidth={2} />
        <circle cx={p0.x} cy={p0.y} r={3} fill="#fff" />
        <circle cx={p1.x} cy={p1.y} r={3} fill="#fff" />
        {([1, 2] as const).map((which) => {
          const h = which === 1 ? h1 : h2
          return (
            <circle
              key={which}
              data-curve-handle={which}
              role="button"
              tabIndex={locked ? -1 : 0}
              aria-roledescription="alça da curva"
              aria-disabled={locked || undefined}
              aria-label={`${which === 1 ? 'Alça de saída do keyframe' : 'Alça de chegada no próximo keyframe'}: tempo ${fmt(handles[which === 1 ? 0 : 2])}, valor ${fmt(handles[which === 1 ? 1 : 3])}${locked ? '' : ' — setas ajustam (Shift: passo maior)'}`}
              cx={h.x}
              cy={h.y}
              r={6}
              className={cn('outline-none focus-visible:[stroke-width:3.5] focus-visible:[stroke:var(--accent)]', locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing')}
              fill={color}
              stroke="#fff"
              strokeWidth={1.5}
              onPointerDown={onHandleDown(which)}
              onKeyDown={onHandleKey(which)}
              onKeyUp={onHandleKeyUp}
              onBlur={() => endHandleTx(true)}
            />
          )
        })}
      </svg>
      <div className={cn('text-[10px] text-muted', typeof ease === 'object' && 'font-mono')} data-curve-values="">
        {typeof ease === 'object' ? `bezier(${(ease.bezier as Bez).map(fmt).join('; ')})` : 'Arraste as alças para uma curva personalizada'}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {CURVE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            data-curve-preset={p.id}
            aria-pressed={preset === p.id}
            disabled={locked}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md border px-1.5 text-left text-[10.5px] leading-tight disabled:opacity-40',
              preset === p.id ? 'border-accent bg-accent/15 text-fg' : 'border-border text-muted hover:bg-white/5 hover:text-fg'
            )}
            onClick={() => setEase(typeof p.ease === 'object' ? { bezier: [...p.ease.bezier] } : p.ease)}
          >
            <span className="h-2 w-2 shrink-0 rotate-45" style={{ background: EASE_COLOR[easeKind(p.ease)] }} />
            {p.label}
          </button>
        ))}
      </div>
      {locked ? <Note tone="warn">Faixa bloqueada: desbloqueie para mudar a curva.</Note> : null}
      {!next && !locked ? <Note tone="neutral">Último keyframe: a curva vale quando houver outro keyframe depois dele.</Note> : null}
    </div>
  )
}

function CloseButton({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <button type="button" aria-label="Fechar editor de curvas" className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-white/5 hover:text-fg" onClick={onClose}>
      <X className="h-3.5 w-3.5" />
    </button>
  )
}
