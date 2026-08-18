import { BrowserWindow, desktopCapturer, screen } from 'electron'
import type { CaptureSource, DisplayInfo } from '@shared/types'
import type { SourcesList } from '@shared/ipc'
import { log } from '../log'

// Lista monitores e janelas capturáveis. Filtra as janelas do próprio app.
// Issue electron#51910: alguns apps (Razer Synapse etc.) fazem getSources com
// thumbnail falhar → refazemos sem thumbnail.

export function listDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Monitor ${i + 1}${d.id === primary.id ? ' (principal)' : ''} — ${d.size.width}×${d.size.height}`,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    isPrimary: d.id === primary.id,
    index: i
  }))
}

function ownSourceIds(): Set<string> {
  const ids = new Set<string>()
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      ids.add(w.getMediaSourceId())
    } catch {
      /* janela destruída */
    }
  }
  return ids
}

export async function listSources(): Promise<SourcesList> {
  const displays = listDisplays()
  let raw: Electron.DesktopCapturerSource[]
  try {
    raw = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
  } catch (e) {
    log.warn('getSources com thumbnail falhou; tentando sem thumbnail', e)
    raw = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
  }
  const own = ownSourceIds()
  const screens: CaptureSource[] = []
  const windows: CaptureSource[] = []
  for (const s of raw) {
    if (s.id.startsWith('screen:')) {
      const displayId = s.display_id || undefined
      const disp = displayId ? displays.find((d) => d.id === displayId) : undefined
      screens.push({
        id: s.id,
        kind: 'screen',
        name: disp ? disp.label : s.name,
        displayId,
        thumbnailDataUrl: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : undefined
      })
    } else if (s.id.startsWith('window:')) {
      if (own.has(s.id)) continue
      if (!s.name || s.name.trim() === '') continue
      windows.push({
        id: s.id,
        kind: 'window',
        name: s.name,
        thumbnailDataUrl: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : undefined,
        appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined
      })
    }
  }
  // ordena telas pela ordem dos displays (fallback: ordem original)
  screens.sort((a, b) => {
    const ia = displays.findIndex((d) => d.id === a.displayId)
    const ib = displays.findIndex((d) => d.id === b.displayId)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  // Fallback quando display_id vem vazio (issue #52232): casa por ordem
  screens.forEach((s, i) => {
    if (!s.displayId && displays[i]) {
      s.displayId = displays[i].id
      s.name = displays[i].label
    }
  })
  return { displays, screens, windows }
}

/** Miniatura de uma fonte específica (usada pelo preview do Preparar a ~1 fps). */
export async function sourceThumbnail(id: string, width: number, height: number): Promise<string | null> {
  const type = id.startsWith('screen:') ? 'screen' : 'window'
  try {
    const raw = await desktopCapturer.getSources({ types: [type], thumbnailSize: { width, height } })
    const s = raw.find((r) => r.id === id)
    if (!s || s.thumbnail.isEmpty()) return null
    return s.thumbnail.toDataURL()
  } catch (e) {
    log.warn('sourceThumbnail falhou', e)
    return null
  }
}

export function displayForSource(src: { kind: string; displayId?: string }, displays = listDisplays()): DisplayInfo | null {
  if (src.kind === 'screen' && src.displayId) return displays.find((d) => d.id === src.displayId) ?? null
  return null
}

/** Display que contém o ponto do cursor (usado para posicionar overlays em modo janela sem bounds conhecidos). */
export function displayAtCursor(): DisplayInfo {
  const p = screen.getCursorScreenPoint()
  const d = screen.getDisplayNearestPoint(p)
  const all = listDisplays()
  return all.find((x) => x.id === String(d.id)) ?? all[0]
}
