import { useEffect } from 'react'
import { toast } from 'sonner'
import type { SourcesList } from '@shared/ipc'
import { useAppStore } from '@/app/store'

// Lista monitores/janelas; atualiza a cada `intervalMs` enquanto ativo.
// Uma listagem por vez: se já houver uma em voo, quem chamar recebe a mesma
// promessa (o auto-refresh nunca acumula pedidos). Depois do await o estado é
// relido: a seleção feita pelo usuário durante a listagem prevalece.

let inFlight: Promise<void> | null = null
let listFailed = false

/** Lista as fontes; se a captura falhar, avisa uma vez e mantém a lista anterior. */
async function listSources(): Promise<SourcesList | null> {
  try {
    const list = await window.api.sources.list()
    listFailed = false
    return list
  } catch (e) {
    if (!listFailed) {
      listFailed = true
      toast.error(`Não foi possível listar monitores e janelas: ${e instanceof Error ? e.message : String(e)}`)
    }
    return null
  }
}

async function runRefresh(): Promise<void> {
  const st = useAppStore.getState()
  st.setSourcesLoading(true)
  try {
    const list = await listSources()
    if (!list) return
    // estado atual (a seleção pode ter mudado enquanto a listagem rodava)
    const now = useAppStore.getState()
    now.setSources(list)
    const cur = now.selectedSource
    const all = [...list.screens, ...list.windows]
    const stillThere = cur ? all.find((s) => s.id === cur.id) : null
    if (cur && stillThere) {
      // mesma fonte, com nome/miniatura novos
      if (stillThere.name !== cur.name || stillThere.thumbnailDataUrl !== cur.thumbnailDataUrl) now.setSelectedSource(stillThere)
    } else {
      // seleção vazia ou a fonte sumiu: última usada ou o monitor principal
      const last = now.settings.lastSource
      const byLast = last ? (all.find((s) => s.id === last.id) ?? (last.kind === 'window' ? list.windows.find((w) => w.name === last.name) : null)) : null
      const primary = list.screens.find((s) => list.displays.find((d) => d.id === s.displayId)?.isPrimary) ?? list.screens[0] ?? null
      now.setSelectedSource(byLast ?? primary)
    }
  } finally {
    useAppStore.getState().setSourcesLoading(false)
  }
}

export function refreshSources(): Promise<void> {
  if (!inFlight) {
    inFlight = runRefresh().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

export function useSources(active: boolean, intervalMs = 2000): void {
  useEffect(() => {
    if (!active) return
    void refreshSources()
    const t = setInterval(() => void refreshSources(), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
}
