import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import * as SliderPrimitive from '@radix-ui/react-slider'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatAcceleratorLabel } from '@shared/hotkeys'

// Primitivas visuais do app (Radix + Tailwind). Mantidas num arquivo só para
// facilitar consistência; cada componente é pequeno e sem estado global.

/* ---------- Toggle (switch) ---------- */
export function Toggle({ checked, onCheckedChange, disabled, className, size = 'md', ...rest }: SwitchPrimitive.SwitchProps & { size?: 'sm' | 'md' }): React.JSX.Element {
  const w = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11'
  const t = size === 'sm' ? 'h-4 w-4 data-[state=checked]:translate-x-4' : 'h-5 w-5 data-[state=checked]:translate-x-5'
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-surface-3 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
        w,
        className
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb className={cn('block translate-x-0.5 rounded-full bg-fg shadow transition-transform', t)} />
    </SwitchPrimitive.Root>
  )
}

/* ---------- Tooltip ---------- */
export const TooltipProvider = TooltipPrimitive.Provider
export function Tip({ content, children, side = 'top', shortcut }: { content: React.ReactNode; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right'; shortcut?: string | null }): React.JSX.Element {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-2 rounded-lg border border-border-strong bg-surface-3 px-2.5 py-1.5 text-xs text-fg shadow-xl animate-in fade-in-0 zoom-in-95"
        >
          <span>{content}</span>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/* ---------- Kbd ---------- */
export function Kbd({ children, className }: { children: string; className?: string }): React.JSX.Element {
  const label = children.includes('+') ? formatAcceleratorLabel(children) : children
  return (
    <kbd className={cn('font-mono inline-flex h-5 items-center rounded-md border border-border-strong bg-bg-2 px-1.5 text-[10px] font-medium tracking-wide text-fg-2', className)}>
      {label}
    </kbd>
  )
}

/* ---------- Progress ---------- */
export function Progress({ value, className, tone = 'accent' }: { value: number; className?: string; tone?: 'accent' | 'ok' | 'info' }): React.JSX.Element {
  const bar = tone === 'ok' ? 'bg-ok' : tone === 'info' ? 'bg-info' : 'bg-accent'
  return (
    <ProgressPrimitive.Root value={value} className={cn('relative h-2 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      <ProgressPrimitive.Indicator className={cn('h-full rounded-full transition-[width] duration-200', bar)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </ProgressPrimitive.Root>
  )
}

/* ---------- Slider ---------- */
export function Slider({ className, ...props }: SliderPrimitive.SliderProps): React.JSX.Element {
  return (
    <SliderPrimitive.Root className={cn('relative flex h-5 w-full touch-none select-none items-center', className)} {...props}>
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-3">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      {(props.value ?? props.defaultValue ?? [0]).map((_, i) => (
        <SliderPrimitive.Thumb key={i} className="block h-4 w-4 rounded-full border-2 border-accent bg-fg shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" />
      ))}
    </SliderPrimitive.Root>
  )
}

/* ---------- Segmented (toggle group single) ---------- */
export function Segmented<T extends string>({ value, onValueChange, options, className, size = 'md' }: { value: T; onValueChange: (v: T) => void; options: { value: T; label: React.ReactNode; disabled?: boolean; title?: string }[]; className?: string; size?: 'sm' | 'md' }): React.JSX.Element {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as T)
      }}
      className={cn('inline-flex items-center rounded-xl border border-border bg-bg-2 p-1', className)}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          title={o.title}
          className={cn(
            'rounded-lg font-medium text-muted transition-colors hover:text-fg data-[state=on]:bg-surface-3 data-[state=on]:text-fg data-[state=on]:shadow disabled:opacity-40',
            size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm'
          )}
        >
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

/* ---------- Select ---------- */
export interface SelectOption {
  value: string
  label: string
  hint?: string
}
export function Select({ value, onValueChange, options, placeholder = 'Selecionar…', disabled, className, triggerClassName }: { value: string | null; onValueChange: (v: string) => void; options: SelectOption[]; placeholder?: string; disabled?: boolean; className?: string; triggerClassName?: string }): React.JSX.Element {
  return (
    <SelectPrimitive.Root value={value ?? undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-border-strong bg-surface-2 px-3 text-left text-sm text-fg hover:bg-surface-3 disabled:opacity-40 data-[placeholder]:text-muted',
          triggerClassName,
          className
        )}
      >
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={6} className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border-strong bg-surface-3 shadow-2xl animate-in fade-in-0 zoom-in-95">
          <SelectPrimitive.Viewport className="p-1">
            {options.length === 0 ? <div className="px-3 py-2 text-xs text-muted">Nenhuma opção</div> : null}
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="relative flex cursor-pointer select-none items-center rounded-lg py-2 pl-8 pr-3 text-sm text-fg outline-none data-[highlighted]:bg-white/8 data-[state=checked]:text-accent-2">
                <span className="absolute left-2 inline-flex h-4 w-4 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-4 w-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint ? <span className="ml-auto pl-3 text-xs text-muted">{o.hint}</span> : null}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/* ---------- Dialog ---------- */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export function DialogContent({ title, description, children, className, footer, hideClose }: { title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; className?: string; footer?: React.ReactNode; hideClose?: boolean }): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] animate-in fade-in-0" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border-strong bg-surface p-6 shadow-2xl animate-in fade-in-0 zoom-in-95 focus:outline-none',
          className
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description> : null}
          </div>
          {!hideClose ? (
            <DialogPrimitive.Close className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg" aria-label="Fechar">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          ) : null}
        </div>
        {children ? <div className="mt-4">{children}</div> : null}
        {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/* ---------- Tabs ---------- */
export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content
export function TabsList({ className, ...p }: TabsPrimitive.TabsListProps): React.JSX.Element {
  return <TabsPrimitive.List className={cn('inline-flex items-center gap-1 rounded-xl border border-border bg-bg-2 p-1', className)} {...p} />
}
export function TabsTrigger({ className, ...p }: TabsPrimitive.TabsTriggerProps): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      className={cn('h-8 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-surface-3 data-[state=active]:text-fg data-[state=active]:shadow', className)}
      {...p}
    />
  )
}

/* ---------- Badge ---------- */
export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'info'; className?: string }): React.JSX.Element {
  const tones = {
    neutral: 'bg-white/6 text-fg-2 border-border-strong',
    accent: 'bg-accent/15 text-accent-2 border-accent/30',
    ok: 'bg-ok/15 text-ok border-ok/30',
    warn: 'bg-warn/15 text-warn border-warn/30',
    info: 'bg-info/15 text-info border-info/30'
  }
  return <span className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wide', tones[tone], className)}>{children}</span>
}

/* ---------- Estado vazio ---------- */
export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong p-8 text-center', className)}>
      {icon ? <div className="text-muted">{icon}</div> : null}
      <div className="text-sm font-semibold">{title}</div>
      {description ? <div className="max-w-xs text-xs text-muted">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/* ---------- Medidor de nível ---------- */
export function VuMeter({ level, className, segments = 16, vertical = false }: { level: number; className?: string; segments?: number; vertical?: boolean }): React.JSX.Element {
  const lit = Math.round(Math.max(0, Math.min(1, level)) * segments)
  return (
    <div className={cn('flex gap-[2px]', vertical ? 'flex-col-reverse' : 'flex-row', className)} aria-label={`nível ${Math.round(level * 100)}%`}>
      {Array.from({ length: segments }, (_, i) => {
        const on = i < lit
        const color = i >= segments - 2 ? 'bg-danger' : i >= segments - 5 ? 'bg-warn' : 'bg-ok'
        return <span key={i} className={cn('vu-seg rounded-[2px]', vertical ? 'h-1.5 w-full' : 'h-full w-1.5', on ? color : 'bg-white/8', on ? 'opacity-100' : 'opacity-100')} />
      })}
    </div>
  )
}

/* ---------- Ícone de status pulsante ---------- */
export function RecDot({ active, paused, className }: { active: boolean; paused?: boolean; className?: string }): React.JSX.Element {
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full', paused ? 'bg-warn' : active ? 'bg-accent rec-pulse' : 'bg-muted-2', className)} />
}

/* ---------- Seção com título ---------- */
export function Section({ title, aside, children, className }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={cn('card p-4', className)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}
