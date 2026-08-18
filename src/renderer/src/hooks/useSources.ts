import { useEffect } from 'react'
import { useAppStore } from '@/app/store'

// Lista monitores/janelas; atualiza a cada `intervalMs` enquanto ativo.

export async function refreshSources(): Promise<void> {
  const st = useAppStore.getState()
  st.setSourcesLoading(true)
  try {
    const list = await window.api.sources.list()
    st.setSources(list)
    // mantém a seleção se ainda existir; senão escolhe última usada ou o monitor principal
    const cur = st.selectedSource
    const all = [...list.screens, ...list.windows]
    const stillThere = cur ? all.find((s) => s.id === cur.id) : null
    if (stillThere) {
      if (stillThere.name !== cur!.name || stillThere.thumbnailDataUrl !== cur!.thumbnailDataUrl) st.setSelectedSource(stillThere)
    } else {
      const last = st.settings.lastSource
      const byLast = last ? all.find((s) => s.id === last.id) ?? (last.kind === 'window' ? list.windows.find((w) => w.name === last.name) : null) : null
      const primary = list.screens.find((s) => list.displays.find((d) => d.id === s.displayId)?.isPrimary) ?? list.screens[0] ?? null
      st.setSelectedSource(byLast ?? primary)
    }
  } finally {
    st.setSourcesLoading(false)
  }
}

export function useSources(active: boolean, intervalMs = 2000): void {
  useEffect(() => {
    if (!active) return
    void refreshSources()
    const t = setInterval(() => void refreshSources(), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
}
