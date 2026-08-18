import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, Info, Monitor, RefreshCw, Search, X } from 'lucide-react'
import type { CaptureSource, DisplayInfo } from '@shared/types'
import type { SourcesList } from '@shared/ipc'
import { cn } from '@/lib/cn'
import { EmptyState, Tabs, TabsContent, TabsList, TabsTrigger, Tip } from '@/components/ui/primitives'
import { SourceCard } from './SourceCard'

// Coluna esquerda do Preparar: escolha da fonte (monitores | janelas), busca por
// título, atualização manual (a automática vem de useSources no PrepareScreen).

export interface SourcePickerProps {
  sources: SourcesList | null
  loading: boolean
  selected: CaptureSource | null
  onSelect: (s: CaptureSource) => void
  /** Atualização manual; a promessa resolve quando a listagem termina. */
  onRefresh: () => Promise<void>
}

type Tab = 'screens' | 'windows'

function displayFor(displays: DisplayInfo[], s: CaptureSource): DisplayInfo | undefined {
  return s.displayId ? displays.find((d) => d.id === s.displayId) : undefined
}

/** Resolução física do monitor (a mesma do chip "Nativa" no palco) e a escala do Windows. */
function screenSubtitle(d: DisplayInfo | undefined): string | undefined {
  if (!d) return undefined
  const w = Math.round(d.bounds.width * d.scaleFactor)
  const h = Math.round(d.bounds.height * d.scaleFactor)
  const scale = d.scaleFactor !== 1 ? ` (${Math.round(d.scaleFactor * 100)}%)` : ''
  return `${w}×${h}${scale}`
}

function SkeletonCards({ count }: { count: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-surface-2/40 p-1.5">
          <div className="aspect-video w-full animate-pulse rounded-lg bg-white/5" />
          <div className="mx-1 mt-1.5 h-3 w-2/3 animate-pulse rounded bg-white/5" />
        </div>
      ))}
    </div>
  )
}

export function SourcePicker({ sources, loading, selected, onSelect, onRefresh }: SourcePickerProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(() => (selected?.kind === 'window' ? 'windows' : 'screens'))
  const [query, setQuery] = useState('')
  // o ícone só gira na atualização manual (a automática, a cada 2 s, seria ruído)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const refresh = (): void => {
    if (manualRefreshing) return
    setManualRefreshing(true)
    void onRefresh().finally(() => {
      if (mountedRef.current) setManualRefreshing(false)
    })
  }
  // acompanha a aba da fonte selecionada (ex.: última fonte restaurada era uma janela)
  const selectedKind = selected?.kind
  useEffect(() => {
    if (selectedKind) setTab(selectedKind === 'window' ? 'windows' : 'screens')
  }, [selectedKind])

  const displays = sources?.displays ?? []
  const screens = sources?.screens ?? []
  const windows = sources?.windows ?? []
  const filteredWindows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('pt-BR')
    if (!q) return windows
    return windows.filter((w) => w.name.toLocaleLowerCase('pt-BR').includes(q))
  }, [windows, query])

  return (
    <aside className="card flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1.5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">O que gravar</h2>
        <Tip content="Atualizar lista de monitores e janelas (a lista também se renova sozinha)">
          <button
            type="button"
            onClick={refresh}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-muted transition-colors hover:bg-white/5 hover:text-fg"
            aria-label="Atualizar fontes"
            aria-busy={loading || undefined}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', manualRefreshing && 'animate-spin')} />
            Atualizar
          </button>
        </Tip>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex min-h-0 flex-1 flex-col">
        <div className="px-3">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="screens" className="flex items-center justify-center gap-1.5">
              <Monitor className="h-3.5 w-3.5" />
              Monitores
              <span className="font-mono tnum text-[10px] text-muted-2">{screens.length}</span>
            </TabsTrigger>
            <TabsTrigger value="windows" className="flex items-center justify-center gap-1.5">
              <AppWindow className="h-3.5 w-3.5" />
              Janelas
              <span className="font-mono tnum text-[10px] text-muted-2">{windows.length}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="screens" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2.5 focus:outline-none">
          {!sources ? (
            <SkeletonCards count={2} />
          ) : screens.length === 0 ? (
            <EmptyState icon={<Monitor className="h-6 w-6" />} title="Nenhum monitor detectado" description="Verifique a conexão do monitor e clique em Atualizar." />
          ) : (
            <div className="flex flex-col gap-2">
              {screens.map((s, i) => {
                const d = displayFor(displays, s)
                return (
                  <SourceCard
                    key={s.id}
                    source={s}
                    selected={selected?.id === s.id}
                    primary={d?.isPrimary ?? false}
                    title={d ? `Monitor ${d.index + 1}` : `Monitor ${i + 1}`}
                    subtitle={screenSubtitle(d)}
                    onSelect={onSelect}
                  />
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="windows" className="flex min-h-0 flex-1 flex-col focus:outline-none">
          <div className="flex items-center gap-1.5 px-3 pt-2.5">
            <label className="relative flex min-w-0 flex-1 items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar janela pelo título…"
                spellCheck={false}
                className="h-8 w-full rounded-lg border border-border-strong bg-surface-2 pl-8 pr-7 text-xs text-fg placeholder:text-muted-2 focus:border-accent/50 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
                aria-label="Buscar janela"
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-muted hover:text-fg" aria-label="Limpar busca">
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </label>
            <Tip content="Para gravar só uma aba, arraste-a para uma janela própria e selecione essa janela" side="right">
              <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-white/5 hover:text-fg" aria-label="Dica: gravar só uma aba do navegador">
                <Info className="h-4 w-4" />
              </button>
            </Tip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2.5">
            {!sources ? (
              <SkeletonCards count={3} />
            ) : filteredWindows.length === 0 ? (
              <EmptyState
                icon={<AppWindow className="h-6 w-6" />}
                title={query ? 'Nenhuma janela com esse título' : 'Nenhuma janela aberta'}
                description={query ? 'Tente outra palavra ou limpe a busca.' : 'Abra o programa que deseja gravar e clique em Atualizar.'}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {filteredWindows.map((w) => (
                  <SourceCard key={w.id} source={w} selected={selected?.id === w.id} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  )
}
