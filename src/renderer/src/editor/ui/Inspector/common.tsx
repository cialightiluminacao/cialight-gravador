import { evalAnim, setValue } from '@shared/editor/anim'
import { updateItem } from '@shared/editor/ops'
import type { Anim, Item, Us } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'

// Peças comuns dos painéis do inspetor: seções, linhas e helpers de edição do item selecionado.

export function PanelSection({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={cn('border-b border-border px-3 py-3', className)}>
      <div className="mb-2 flex h-5 items-center justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{title}</h3>
        {aside}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

/** Linha rótulo + controle, alinhada com os NumberField. */
export function FieldRow({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex min-h-7 items-center gap-2 text-[11px]', className)}>
      <span className="w-[74px] shrink-0 truncate text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </div>
  )
}

/** Edição dentro de uma transação aberta (NumberField/arrasto): sem entrada de histórico até o commit. */
export function editItemTransient<T extends Item>(itemId: string, recipe: (d: T) => void): void {
  useEditorStore.getState().apply((p) => updateItem<T>(p, itemId, recipe), { transient: true })
}

/** Edição discreta (toggle, seletor, botão): uma entrada de histórico. */
export function editItem<T extends Item>(itemId: string, recipe: (d: T) => void): void {
  useEditorStore.getState().apply((p) => updateItem<T>(p, itemId, recipe))
}

/** Tempo local do playhead dentro do item (limitado à duração). */
export function localUs(item: Item, playheadUs: Us): Us {
  return Math.min(Math.max(0, playheadUs - item.startUs), item.durationUs)
}

export const animAt = (a: Anim<number>, local: Us): number => evalAnim(a, local)
export const withValue = (a: Anim<number>, local: Us, v: number): Anim<number> => setValue(a, local, v)

/** µs ↔ segundos com 2 casas para os campos de fade. */
export const usToSec2 = (us: Us): number => Math.round(us / 10_000) / 100
export const sec2ToUs = (s: number): Us => Math.round(s * 1e6)

/** Seletor de cor: o arrasto no seletor nativo é uma transação só (abre no foco, fecha ao sair). */
export function ColorInput({ value, label, onChange }: { value: string; label: string; onChange: (hex: string) => void }): React.JSX.Element {
  const st = useEditorStore.getState
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      className="h-6 w-10 cursor-pointer rounded border border-border-strong bg-transparent"
      value={value}
      onFocus={() => st().begin()}
      onBlur={() => st().commitTx()}
      onChange={(e) => {
        if (!st().txBase) st().begin()
        onChange(e.target.value)
      }}
    />
  )
}
