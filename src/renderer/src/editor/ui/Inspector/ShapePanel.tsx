import { Segmented, Toggle } from '@/components/ui/primitives'
import { DEFAULT_SHAPE_BOX } from '@shared/editor/project'
import type { ShapeItem } from '@shared/editor/project'
import { AnimPanel } from './AnimPanel'
import { NumberField } from './NumberField'
import { TransformSection } from './TransformSection'
import { ColorInput, FieldRow, PanelSection, editItem, editItemTransient } from './common'
import { joinColor, splitColor } from './textStyleEdit'

// Inspetor da forma: tipo, preenchimento, contorno, cantos (só retângulo), caixa e holofote (retângulo/elipse).
// `fill`/`stroke` são cor ou 'none'. Campos = uma transação por gesto; interruptores = um passo.

const KIND_OPTIONS: { value: ShapeItem['shape']; label: string }[] = [
  { value: 'rect', label: 'Retângulo' },
  { value: 'ellipse', label: 'Elipse' },
  { value: 'arrow', label: 'Seta' }
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

export function ShapePanel({ item, locked }: { item: ShapeItem; locked: boolean }): React.JSX.Element {
  const id = item.id
  const edit = (fn: (d: ShapeItem) => void): void => editItem<ShapeItem>(id, fn)
  const editT = (fn: (d: ShapeItem) => void): void => editItemTransient<ShapeItem>(id, fn)
  const box = item.box ?? DEFAULT_SHAPE_BOX
  const fill = splitColor(item.fill)
  const stroke = splitColor(item.stroke)
  const hasFill = item.fill !== 'none'
  const hasStroke = item.stroke !== 'none'
  const canSpot = item.shape !== 'arrow'

  return (
    <>
      <PanelSection title="Forma">
        <Segmented
          size="sm"
          className="flex w-full [&>*]:flex-1"
          value={item.shape}
          options={KIND_OPTIONS.map((o) => ({ ...o, disabled: locked }))}
          onValueChange={(shape) => edit((d) => { d.shape = shape; if (shape !== 'rect') delete d.cornerRadius; if (shape === 'arrow') delete d.spotlight })}
        />
        <NumberField label="Largura" value={box.w * 100} min={1} max={400} precision={1} step={0.5} unit="%" disabled={locked} onChange={(n) => editT((d) => { d.box = { w: n / 100, h: (d.box ?? DEFAULT_SHAPE_BOX).h } })} title="Largura da caixa, em % da largura do quadro" />
        <NumberField label="Altura" value={box.h * 100} min={1} max={400} precision={1} step={0.5} unit="%" disabled={locked} onChange={(n) => editT((d) => { d.box = { w: (d.box ?? DEFAULT_SHAPE_BOX).w, h: n / 100 } })} title="Altura da caixa, em % da altura do quadro" />
        {item.shape === 'rect' ? (
          <NumberField label="Cantos" value={(item.cornerRadius ?? 0) * 100} min={0} max={50} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => editT((d) => { if (n > 0) d.cornerRadius = n / 100; else delete d.cornerRadius })} title="Arredondamento dos cantos, em % do menor lado da caixa" />
        ) : null}
      </PanelSection>

      <PanelSection title="Preenchimento e contorno">
        <Row label="Preenchimento" on={hasFill} disabled={locked} onChange={(on) => edit((d) => { d.fill = on ? '#ffffff' : 'none' })}>
          <FieldRow label="Cor">
            <span className="font-mono text-[10.5px] uppercase text-muted">{item.fill}</span>
            <ColorInput label="Cor do preenchimento" disabled={locked} value={fill.hex} onChange={(hex) => editT((d) => { d.fill = joinColor(hex, fill.alpha) })} />
          </FieldRow>
          <NumberField label="Opacidade" value={fill.alpha * 100} min={0} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => editT((d) => { d.fill = joinColor(fill.hex, n / 100) })} />
        </Row>
        <Row label="Contorno" on={hasStroke} disabled={locked} onChange={(on) => edit((d) => { if (on) { d.stroke = '#ffffff'; if (d.strokeWidth <= 0) d.strokeWidth = 8 } else d.stroke = 'none' })}>
          <FieldRow label="Cor">
            <span className="font-mono text-[10.5px] uppercase text-muted">{item.stroke}</span>
            <ColorInput label="Cor do contorno" disabled={locked} value={stroke.hex} onChange={(hex) => editT((d) => { d.stroke = joinColor(hex, stroke.alpha) })} />
          </FieldRow>
          <NumberField label="Largura" value={item.strokeWidth} min={0} max={200} precision={1} step={0.5} unit="px" disabled={locked} onChange={(n) => editT((d) => { d.strokeWidth = n })} title="Em pixels num quadro de 1080 px de lado menor" />
        </Row>
      </PanelSection>

      {canSpot ? (
        <PanelSection title="Holofote">
          <Row label="Holofote" on={!!item.spotlight} disabled={locked} onChange={(on) => edit((d) => { if (on) d.spotlight = { dim: 0.6 }; else delete d.spotlight })}>
            <NumberField label="Intensidade" value={(item.spotlight?.dim ?? 0.6) * 100} min={0} max={100} precision={0} step={1} unit="%" disabled={locked} onChange={(n) => editT((d) => { d.spotlight = { dim: n / 100 } })} title="Quanto escurece tudo fora da forma" />
          </Row>
          <p className="text-[10.5px] leading-snug text-muted">Escurece todo o quadro fora da forma; dentro dela a imagem fica intacta.</p>
        </PanelSection>
      ) : null}

      <TransformSection item={item} locked={locked} />
      <AnimPanel item={item} disabled={locked} />
    </>
  )
}
