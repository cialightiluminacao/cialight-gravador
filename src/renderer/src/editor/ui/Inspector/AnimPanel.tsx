import { useState } from 'react'
import { Ban } from 'lucide-react'
import type { AnimPreset, Ease, Item, PresetAnim, VisualProps } from '@shared/editor/project'
import { presetMoves } from '@shared/editor/contentPose'
import { cn } from '@/lib/cn'
import { Segmented, Select, Tip } from '@/components/ui/primitives'
import { warnLinkedEffects } from '../viewer/ZoomTool'
import { NumberField } from './NumberField'
import { FieldRow, PanelSection, editItem, editItemTransient } from './common'
import { DEFAULT_ANIM_US, EASE_OPTIONS, PRESET_CARDS, THUMB_CYCLE_S, clampAnimUs, easeOptionId, maxAnimUs, sideAnim, thumbKeyframes, type AnimSide } from './animThumbs'

// Animações de entrada/saída de qualquer item visual (mídia; texto e forma na F5): grade de cartões com a prévia em
// miniatura (CSS, gerada pela conta do resolve), duração e curva. Entrada e saída separadas; "Combinação" grava a
// mesma animação nos dois lados.

type VisualItem = Item & { visual: VisualProps }

const SIDES: { value: AnimSide; label: string; title: string }[] = [
  { value: 'in', label: 'Entrada', title: 'Como o item aparece' },
  { value: 'out', label: 'Saída', title: 'Como o item some' },
  { value: 'both', label: 'Combinação', title: 'A mesma animação na entrada e na saída' }
]

/** Grava a animação do lado (null = nenhuma); na combinação, nos dois. */
function setSide(d: VisualItem, side: AnimSide, a: PresetAnim | null): void {
  for (const k of side === 'both' ? (['animIn', 'animOut'] as const) : side === 'in' ? (['animIn'] as const) : (['animOut'] as const)) {
    if (a) d.visual[k] = { ...a }
    else delete d.visual[k]
  }
}

const sec = (us: number): number => Math.round(us / 10_000) / 100

/** Folha de estilo das miniaturas do lado: uma animação por preset (com a curva escolhida, se houver). */
function thumbStyles(side: AnimSide, ease: Ease | undefined): string {
  const rules = PRESET_CARDS.map((c) => thumbKeyframes(`anim-thumb-${side}-${c.preset}`, c.preset, side, ease)).join('\n')
  return `${rules}
[data-anim-card]:hover [data-anim-thumb], [data-anim-card][aria-pressed="true"] [data-anim-thumb] { animation-duration: ${THUMB_CYCLE_S}s; animation-iteration-count: infinite; animation-timing-function: linear; }
@media (prefers-reduced-motion: reduce) { [data-anim-card] [data-anim-thumb] { animation: none !important; } }`
}

export function AnimPanel({ item, disabled }: { item: VisualItem; disabled?: boolean }): React.JSX.Element {
  const [side, setSideTab] = useState<AnimSide>('in')
  const id = item.id
  const v = item.visual
  // combinação com entrada e saída diferentes: nenhum cartão selecionado
  const shown = sideAnim(v, side)
  const none = side === 'both' ? !v.animIn && !v.animOut : !shown
  const pick = (preset: AnimPreset | null): void => {
    editItem<VisualItem>(id, (d) => {
      if (!preset) {
        setSide(d, side, null)
        return
      }
      const base = sideAnim(d.visual, side) ?? (side === 'out' ? d.visual.animOut : d.visual.animIn)
      const durationUs = clampAnimUs(base?.durationUs ?? DEFAULT_ANIM_US, d.durationUs, side)
      setSide(d, side, { preset, durationUs, ...(base?.ease !== undefined ? { ease: base.ease } : {}) })
    })
    // movimento num clipe com efeito de privacidade sem âncora por cima: a mesma oferta do zoom (ancorar ao clipe)
    if (preset && item.type === 'media' && presetMoves(preset)) warnLinkedEffects(id, 'a animação')
  }
  const easeId = shown ? easeOptionId(shown.ease) : 'default'
  const easeOptions = [...EASE_OPTIONS.map((o) => ({ value: o.id, label: o.label })), ...(easeId === 'custom' ? [{ value: 'custom', label: 'Personalizada' }] : [])]

  return (
    <PanelSection title="Animação">
      <style>{thumbStyles(side, shown?.ease)}</style>
      <Segmented size="sm" className="flex w-full [&>*]:flex-1" value={side} options={SIDES} onValueChange={setSideTab} />
      <div className="grid grid-cols-4 gap-1.5 pt-1" role="group" aria-label={`Animação de ${SIDES.find((s) => s.value === side)!.label.toLowerCase()}`} data-anim-grid={side}>
        <Tip content="Sem animação">
          <button type="button" data-anim-card="none" aria-pressed={none} aria-label="Nenhuma" disabled={disabled} onClick={() => pick(null)} className={cardClass(none)}>
            <span className="flex h-[30px] w-full items-center justify-center rounded-[5px] bg-bg-2 text-muted-2">
              <Ban className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">Nenhuma</span>
          </button>
        </Tip>
        {PRESET_CARDS.map((c) => {
          const on = shown?.preset === c.preset
          return (
            <Tip key={c.preset} content={c.title}>
              <button type="button" data-anim-card={c.preset} aria-pressed={on} aria-label={c.label} disabled={disabled} onClick={() => pick(c.preset)} className={cardClass(on)}>
                <span className="relative block h-[30px] w-full overflow-hidden rounded-[5px] bg-bg-2">
                  <span data-anim-thumb className="absolute inset-0 rounded-[5px] bg-gradient-to-br from-accent-2/80 to-info/70" style={{ animationName: `anim-thumb-${side}-${c.preset}` }} />
                </span>
                <span className="truncate">{c.label}</span>
              </button>
            </Tip>
          )
        })}
      </div>
      {shown ? (
        <>
          <NumberField
            label="Duração"
            value={sec(shown.durationUs)}
            min={sec(clampAnimUs(0, item.durationUs, side))}
            max={sec(maxAnimUs(item.durationUs, side))}
            precision={2}
            step={0.01}
            unit="s"
            disabled={disabled}
            onChange={(n) => editItemTransient<VisualItem>(id, (d) => {
              const a = sideAnim(d.visual, side)
              if (a) setSide(d, side, { ...a, durationUs: clampAnimUs(Math.round(n * 1e6), d.durationUs, side) })
            })}
          />
          <FieldRow label="Curva">
            <Select
              triggerClassName="h-7 rounded-md px-2 text-[11px]"
              value={easeId}
              options={easeOptions}
              disabled={disabled}
              onValueChange={(o) => {
                const opt = EASE_OPTIONS.find((x) => x.id === o)
                if (!opt) return
                editItem<VisualItem>(id, (d) => {
                  const a = sideAnim(d.visual, side)
                  if (!a) return
                  const { ease: _old, ...rest } = a
                  setSide(d, side, opt.ease === null ? rest : { ...rest, ease: opt.ease })
                })
              }}
            />
          </FieldRow>
        </>
      ) : side === 'both' && (v.animIn || v.animOut) ? (
        <p className="text-[10.5px] leading-relaxed text-muted">Entrada e saída diferentes. Escolha uma animação para usar a mesma nos dois lados.</p>
      ) : null}
    </PanelSection>
  )
}

function cardClass(on: boolean): string {
  return cn(
    'flex min-w-0 flex-col items-stretch gap-1 rounded-md border p-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    on ? 'border-accent/70 bg-accent/10 text-fg' : 'border-border-strong bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg'
  )
}
