import { memo } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { Kbd } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'

// Menu de contexto (botão direito) sobre o DropdownMenu do Radix, ancorado num gatilho invisível
// posicionado no ponto do clique.

export type MenuEntry =
  | { separator: true }
  | { label: string; icon?: LucideIcon; shortcut?: string; onSelect?: () => void; disabled?: boolean; danger?: boolean; sub?: MenuEntry[] }

const ITEM = 'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-fg outline-none data-[highlighted]:bg-white/8 data-[disabled]:pointer-events-none data-[disabled]:opacity-40'
const PANEL = 'z-50 min-w-[220px] rounded-xl border border-border-strong bg-surface-3 p-1 shadow-2xl animate-in fade-in-0 zoom-in-95'

function Entries({ entries }: { entries: MenuEntry[] }): React.JSX.Element {
  return (
    <>
      {entries.map((e, i) => {
        if ('separator' in e) return <DropdownMenu.Separator key={i} className="my-1 h-px bg-border" />
        const Icon = e.icon
        const body = (
          <>
            {Icon ? <Icon className={cn('h-4 w-4', e.danger ? 'text-danger' : 'text-muted')} /> : <span className="w-4" />}
            <span className="flex-1">{e.label}</span>
            {e.shortcut ? <Kbd className="ml-4">{e.shortcut}</Kbd> : null}
          </>
        )
        if (e.sub) {
          return (
            <DropdownMenu.Sub key={i}>
              <DropdownMenu.SubTrigger className={ITEM} disabled={e.disabled}>
                {body}
                <ChevronRight className="h-3.5 w-3.5 text-muted" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent sideOffset={4} className={cn(PANEL, 'min-w-[140px]')}>
                  <Entries entries={e.sub} />
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )
        }
        return (
          <DropdownMenu.Item key={i} className={cn(ITEM, e.danger && 'text-danger')} disabled={e.disabled} onSelect={() => e.onSelect?.()}>
            {body}
          </DropdownMenu.Item>
        )
      })}
    </>
  )
}

export const ContextMenu = memo(function ContextMenu({ at, entries, onClose }: { at: { x: number; y: number } | null; entries: MenuEntry[]; onClose: () => void }): React.JSX.Element {
  return (
    <DropdownMenu.Root open={!!at} onOpenChange={(o) => !o && onClose()} modal={false}>
      <DropdownMenu.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed h-0 w-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" side="bottom" sideOffset={2} className={PANEL} data-timeline-menu="" onCloseAutoFocus={(e) => e.preventDefault()}>
          <Entries entries={entries} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
})
