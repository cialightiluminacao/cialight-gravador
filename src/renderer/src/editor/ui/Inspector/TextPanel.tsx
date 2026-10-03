import { useEffect, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { toast } from 'sonner'
import { patchTextStyle } from '@shared/editor/factory'
import { setAnimValue } from '@shared/editor/ops'
import { DEFAULT_TEXT_SHADOW, type TextItem, type TextStyle } from '@shared/editor/project'
import { Select, Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { planTextEdit } from '../viewer/textEdit'
import { AnimPanel } from './AnimPanel'
import { KeyframeButton } from './KeyframeButton'
import { NumberField } from './NumberField'
import { TransformSection } from './TransformSection'
import { ColorInput, FieldRow, PanelSection, animAt, editItem, editItemTransient, localUs } from './common'
import { buildFontOptions, joinColor, loadSystemFonts, splitColor, weightOptions } from './textStyleEdit'

// Inspetor do texto: conteúdo, fonte, tamanho (animável), peso, itálico, cor, fundo, contorno, sombra, alinhamento,
// altura da linha, largura máxima e contagem. Campos/sliders = uma transação por gesto (NumberField); interruptores e
// seletores = um passo cada. `shadow` fica coerente com `shadowStyle` pelo patchTextStyle (factory).

const ALIGN: { value: TextStyle['align']; label: string; icon: React.ReactNode }[] = [
  { value: 'left', label: 'Alinhar à esquerda', icon: <AlignLeft className="h-3.5 w-3.5" /> },
  { value: 'center', label: 'Centralizar', icon: <AlignCenter className="h-3.5 w-3.5" /> },
  { value: 'right', label: 'Alinhar à direita', icon: <AlignRight className="h-3.5 w-3.5" /> }
]

function Row({ label, on, onChange, disabled, children }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <div className="flex min-h-7 items-center justify-between gap-2 text-[11px]">
        <span className="text-muted">{label}</span>
        <Toggle size="sm" checked={on} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
      </div>
      {on ? children : null}
    </>
  )
}

export function TextPanel({ item, locked }: { item: TextItem; locked: boolean }): React.JSX.Element {
  const playheadUs = usePausedPlayhead()
  const local = localUs(item, playheadUs)
  const tUs = item.startUs + local
  const id = item.id
  const s = item.style
  const apply = useEditorStore((x) => x.apply)
  const style = (patch: Partial<TextStyle>): void => editItem<TextItem>(id, (d) => { d.style = patchTextStyle(d.style, patch) })
  const styleT = (patch: Partial<TextStyle>): void => editItemTransient<TextItem>(id, (d) => { d.style = patchTextStyle(d.style, patch) })

  // fontes do sistema (queryLocalFonts): sem a API ou sem permissão fica só a lista curada, sem erro
  const [system, setSystem] = useState<string[]>([])
  const canQuery = typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
  useEffect(() => {
    let live = true
    void loadSystemFonts().then((f) => live && setSystem(f))
    return () => {
      live = false
    }
  }, [])
  const loadFonts = (): void => {
    void loadSystemFonts().then((f) => {
      setSystem(f)
      if (f.length === 0) toast('Não foi possível ler as fontes instaladas: a lista padrão continua disponível.')
    })
  }

  const commitContent = (typed: string): void => {
    const plan = planTextEdit(item.text, typed)
    if (plan.kind === 'empty') toast('O texto não pode ficar vazio: o anterior foi mantido.')
    else if (plan.kind === 'change') editItem<TextItem>(id, (d) => { d.text = plan.text })
  }

  const bg = splitColor(s.background)
  const stroke = s.stroke
  const sh = s.shadowStyle ?? DEFAULT_TEXT_SHADOW
  const shColor = splitColor(sh.color)
  const setShadow = (patch: Partial<typeof sh>): void => styleT({ shadowStyle: { ...sh, ...patch } })

  return (
    <>
      <PanelSection title="Texto">
        {item.counter ? (
          <p className="text-[10.5px] leading-snug text-muted">Este texto é uma contagem: o número exibido vai de “De” até “Até” ao longo do item.</p>
        ) : (
          <textarea
            key={item.text}
            aria-label="Conteúdo do texto"
            defaultValue={item.text}
            disabled={locked}
            rows={3}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-border bg-bg-2 px-2 py-1.5 text-[12px] leading-snug text-fg outline-none focus:border-accent/60 disabled:opacity-40"
            onBlur={(e) => commitContent(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                e.currentTarget.value = item.text
                e.currentTarget.blur()
              }
            }}
          />
        )}
        {item.counter ? (
          <div className="grid grid-cols-2 gap-x-3">
            <NumberField compact label="De" value={item.counter.from} step={1} min={-9999} max={9999} disabled={locked} onChange={(n) => editItemTransient<TextItem>(id, (d) => { if (d.counter) d.counter.from = Math.round(n) })} />
            <NumberField compact label="Até" value={item.counter.to} step={1} min={-9999} max={9999} disabled={locked} onChange={(n) => editItemTransient<TextItem>(id, (d) => { if (d.counter) d.counter.to = Math.round(n) })} />
          </div>
        ) : null}
      </PanelSection>

      <PanelSection title="Fonte">
        <FieldRow label="Fonte">
          <Select triggerClassName="h-7 rounded-md px-2 text-[11px]" value={s.font} options={buildFontOptions(s.font, system)} disabled={locked} onValueChange={(font) => style({ font })} />
        </FieldRow>
        {canQuery && system.length === 0 ? (
          <button type="button" disabled={locked} className="h-6 w-full rounded-md border border-border bg-bg-2 text-[10.5px] font-medium text-fg-2 hover:border-border-strong hover:text-fg disabled:opacity-40" onClick={loadFonts}>
            Carregar fontes do sistema
          </button>
        ) : null}
        <NumberField label="Tamanho" value={animAt(s.size, local)} min={1} max={1000} precision={0} step={1} unit="px" disabled={locked} onChange={(n) => apply((p) => setAnimValue(p, id, 'text.size', tUs, n), { transient: true })} title="Em pixels num quadro de 1080 px de lado menor" trailing={<KeyframeButton item={item} path="text.size" label="Tamanho" disabled={locked} />} />
        <FieldRow label="Peso">
          <Select triggerClassName="h-7 rounded-md px-2 text-[11px]" value={String(s.weight)} options={weightOptions(s.weight)} disabled={locked} onValueChange={(v) => style({ weight: Number(v) })} />
        </FieldRow>
        <FieldRow label="Itálico">
          <Toggle size="sm" checked={!!s.italic} disabled={locked} onCheckedChange={(on) => style({ italic: on ? true : undefined })} aria-label="Itálico" />
        </FieldRow>
        <FieldRow label="Alinhamento">
          <div className="flex gap-1" role="group" aria-label="Alinhamento do texto">
            {ALIGN.map((a) => (
              <button
                key={a.value}
                type="button"
                disabled={locked}
                aria-label={a.label}
                title={a.label}
                aria-pressed={s.align === a.value}
                onClick={() => style({ align: a.value })}
                className="flex h-7 w-8 items-center justify-center rounded-md border border-border-strong bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg disabled:opacity-40 aria-pressed:border-accent aria-pressed:bg-accent/20 aria-pressed:text-fg"
              >
                {a.icon}
              </button>
            ))}
          </div>
        </FieldRow>
        <NumberField label="Altura da linha" value={s.lineHeight} min={0.5} max={3} precision={2} step={0.05} disabled={locked} onChange={(n) => styleT({ lineHeight: n })} />
        <Row label="Quebra automática" on={s.maxWidth !== undefined} disabled={locked} onChange={(on) => style({ maxWidth: on ? 0.9 : undefined })}>
          <NumberField label="Largura máx." value={(s.maxWidth ?? 0.9) * 100} min={5} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => styleT({ maxWidth: n / 100 })} title="Largura máxima da linha, em % da largura do quadro" />
        </Row>
      </PanelSection>

      <PanelSection title="Cor">
        <FieldRow label="Cor do texto">
          <span className="font-mono text-[10.5px] uppercase text-muted">{s.color}</span>
          <ColorInput label="Cor do texto" disabled={locked} value={splitColor(s.color).hex} onChange={(hex) => styleT({ color: joinColor(hex, splitColor(s.color).alpha) })} />
        </FieldRow>
        <Row label="Fundo" on={!!s.background} disabled={locked} onChange={(on) => style({ background: on ? '#000000b3' : undefined })}>
          <FieldRow label="Cor do fundo">
            <ColorInput label="Cor do fundo" disabled={locked} value={bg.hex} onChange={(hex) => styleT({ background: joinColor(hex, bg.alpha) })} />
          </FieldRow>
          <NumberField label="Opacidade" value={bg.alpha * 100} min={0} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => styleT({ background: joinColor(bg.hex, n / 100) })} title="Opacidade do fundo" />
          <NumberField label="Espaçamento" value={(s.padding ?? 0.3) * 100} min={0} max={300} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => styleT({ padding: n / 100 })} title="Margem entre o texto e a borda do fundo, em % do tamanho da fonte" />
          <NumberField label="Cantos" value={(s.backgroundRadius ?? 0) * 100} min={0} max={200} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => styleT({ backgroundRadius: n / 100 })} title="Arredondamento dos cantos do fundo, em % do tamanho da fonte" />
        </Row>
      </PanelSection>

      <PanelSection title="Contorno e sombra">
        <Row label="Contorno" on={!!stroke} disabled={locked} onChange={(on) => style({ stroke: on ? { width: 4, color: '#000000' } : undefined })}>
          <NumberField label="Largura" value={stroke?.width ?? 4} min={0.5} max={60} precision={1} step={0.5} unit="px" disabled={locked} onChange={(n) => styleT({ stroke: { width: n, color: stroke?.color ?? '#000000' } })} />
          <FieldRow label="Cor do contorno">
            <ColorInput label="Cor do contorno" disabled={locked} value={splitColor(stroke?.color).hex} onChange={(hex) => styleT({ stroke: { width: stroke?.width ?? 4, color: hex } })} />
          </FieldRow>
        </Row>
        <Row label="Sombra" on={!!s.shadow} disabled={locked} onChange={(on) => style({ shadow: on })}>
          <FieldRow label="Cor da sombra">
            <ColorInput label="Cor da sombra" disabled={locked} value={shColor.hex} onChange={(hex) => setShadow({ color: joinColor(hex, shColor.alpha) })} />
          </FieldRow>
          <NumberField label="Opacidade" value={shColor.alpha * 100} min={0} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => setShadow({ color: joinColor(shColor.hex, n / 100) })} />
          <NumberField label="Desfoque" value={sh.blur * 100} min={0} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => setShadow({ blur: n / 100 })} title="Em % do tamanho da fonte" />
          <div className="grid grid-cols-2 gap-x-3">
            <NumberField compact label="Desl. X" value={sh.dx * 100} min={-100} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => setShadow({ dx: n / 100 })} title="Deslocamento horizontal, em % do tamanho da fonte" />
            <NumberField compact label="Desl. Y" value={sh.dy * 100} min={-100} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => setShadow({ dy: n / 100 })} title="Deslocamento vertical, em % do tamanho da fonte" />
          </div>
        </Row>
      </PanelSection>

      <TransformSection item={item} locked={locked} />
      <AnimPanel item={item} disabled={locked} />
    </>
  )
}
