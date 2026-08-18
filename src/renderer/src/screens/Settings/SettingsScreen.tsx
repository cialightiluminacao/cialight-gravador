import { useEffect, useState } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { Cable, CheckCircle2, Info, Keyboard, PenLine, SlidersHorizontal, Wrench, type LucideIcon } from 'lucide-react'
import { useAppStore } from '@/app/store'
import { Tabs, TabsContent } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import { useDisplayedHotkeyStatus } from './hotkeyStatusView'
import { SETTINGS_TABS, SETTINGS_TAB_LABELS, getInitialSettingsTab, installSettingsDeepLink, rememberSettingsTab, type SettingsTab } from './settingsTabs'
import { GeneralTab } from './GeneralTab'
import { DevicesTab } from './DevicesTab'
import { HotkeysTab } from './HotkeysTab'
import { AnnotationsTab } from './AnnotationsTab'
import { AdvancedTab } from './AdvancedTab'
import { UpdateTab } from './UpdateTab'

// Tela Configurações: cabeçalho, abas verticais à esquerda e cartões à direita.
// Cada mudança persiste na hora (settings:set) com preview otimista no store.

installSettingsDeepLink()

const TAB_ICONS: Record<SettingsTab, LucideIcon> = {
  geral: SlidersHorizontal,
  dispositivos: Cable,
  atalhos: Keyboard,
  anotacoes: PenLine,
  avancado: Wrench,
  atualizacao: Info
}

const TAB_HINTS: Record<SettingsTab, string> = {
  geral: 'Qualidade, pastas, PiP',
  dispositivos: 'Câmera, microfone, áudio',
  atalhos: 'Teclas globais',
  anotacoes: 'Cor, espessura, teclas',
  avancado: 'Proteção, encoder, logs',
  atualizacao: 'Versão, novidades, licenças'
}

const TAB_CONTENT: Record<SettingsTab, () => React.JSX.Element> = {
  geral: GeneralTab,
  dispositivos: DevicesTab,
  atalhos: HotkeysTab,
  anotacoes: AnnotationsTab,
  avancado: AdvancedTab,
  atualizacao: UpdateTab
}

export function SettingsScreen(): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(getInitialSettingsTab)
  const settingsLoaded = useAppStore((s) => s.settingsLoaded)
  const updateState = useAppStore((s) => s.updateStatus?.state)
  const hotkeyStatus = useDisplayedHotkeyStatus()
  const hotkeyIssues = hotkeyStatus.filter((h) => h.accelerator && !h.registered).length
  useEffect(() => rememberSettingsTab(tab), [tab])

  const dot = (t: SettingsTab): 'accent' | 'warn' | null => {
    if (t === 'atualizacao' && (updateState === 'available' || updateState === 'downloaded')) return 'accent'
    if (t === 'atalhos' && hotkeyIssues > 0) return 'warn'
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-end justify-between px-7 pb-4 pt-5">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Configurações</h1>
          <p className="mt-0.5 text-sm text-muted">Tudo aqui é salvo automaticamente e vale para as próximas gravações.</p>
        </div>
        <div className={cn('flex items-center gap-1.5 text-xs transition-opacity', settingsLoaded ? 'text-muted' : 'text-muted-2')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', settingsLoaded ? 'text-ok' : 'text-muted-2')} />
          {settingsLoaded ? 'Salvo automaticamente' : 'Carregando…'}
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)} orientation="vertical" className="flex min-h-0 flex-1 gap-6 px-7 pb-6">
        <TabsPrimitive.List aria-label="Seções das configurações" className="flex w-[228px] shrink-0 flex-col gap-1">
          {SETTINGS_TABS.map((t, i) => {
            const Icon = TAB_ICONS[t]
            const mark = dot(t)
            return (
              <TabsPrimitive.Trigger
                key={t}
                value={t}
                className={cn(
                  'group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2 text-left transition-colors rise-in',
                  `rise-in-${Math.min(4, i)}`,
                  'text-muted hover:bg-white/[0.04] hover:text-fg data-[state=active]:border-border-strong data-[state=active]:bg-surface-2 data-[state=active]:text-fg data-[state=active]:shadow'
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-muted transition-colors group-hover:text-fg-2 group-data-[state=active]:bg-accent/15 group-data-[state=active]:text-accent-2">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold leading-tight">{SETTINGS_TAB_LABELS[t]}</span>
                  <span className="block truncate text-[11px] leading-tight text-muted-2 group-data-[state=active]:text-muted">{TAB_HINTS[t]}</span>
                </span>
                {mark ? <span className={cn('h-2 w-2 shrink-0 rounded-full', mark === 'accent' ? 'bg-accent' : 'bg-warn')} aria-label={mark === 'accent' ? 'Atualização disponível' : 'Atalhos com problema'} /> : null}
              </TabsPrimitive.Trigger>
            )
          })}
        </TabsPrimitive.List>

        <div className="@container min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          {SETTINGS_TABS.map((t) => {
            const Content = TAB_CONTENT[t]
            return (
              <TabsContent key={t} value={t} className="outline-none data-[state=inactive]:hidden">
                {tab === t ? <Content /> : null}
              </TabsContent>
            )
          })}
        </div>
      </Tabs>
    </div>
  )
}
