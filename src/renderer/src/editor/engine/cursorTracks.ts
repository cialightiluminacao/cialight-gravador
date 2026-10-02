// Trilhas do cursor (F6) no editor: lidas do main por IPC (cursor.readCursorTrack, <sessão>/cursor.json) uma vez
// por gravação e compartilhadas por quem precisa (auto-zoom, realce de cliques, cursor ampliado). Sem trilha
// (gravação antiga, modo janela sem o módulo nativo, arquivo apagado) é o caso normal: null, sem aviso.
import { useEffect, useState } from 'react'
import type { CursorTrackV1 } from '@shared/cursor'
import type { Asset } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'

/** Gravação cuja trilha o asset usa: só o asset da TELA de uma gravação com `cursor`; senão null. */
export function cursorSessionOf(asset: Asset | undefined | null): string | null {
  return asset?.cursor && asset.source.type === 'session' && asset.source.stream === 'screen' ? asset.source.sessionId : null
}

/** Cache por gravação. Leituras simultâneas compartilham a mesma promessa; null/falha não ficam (tenta de novo depois). */
export class CursorTrackCache {
  private readonly loaded = new Map<string, CursorTrackV1>()
  private readonly pending = new Map<string, Promise<CursorTrackV1 | null>>()

  constructor(private readonly read: (sessionId: string) => Promise<CursorTrackV1 | null>) {}

  /** Trilha já carregada (síncrono); undefined = ainda não carregada (ou sem trilha). */
  peek(sessionId: string): CursorTrackV1 | undefined {
    return this.loaded.get(sessionId)
  }

  /** Trilha da gravação; nunca rejeita (falha do IPC = null). */
  load(sessionId: string): Promise<CursorTrackV1 | null> {
    const hit = this.loaded.get(sessionId)
    if (hit) return Promise.resolve(hit)
    let p = this.pending.get(sessionId)
    if (!p) {
      p = this.read(sessionId)
        .catch(() => null)
        .then((t) => {
          this.pending.delete(sessionId)
          if (t) this.loaded.set(sessionId, t)
          return t
        })
      this.pending.set(sessionId, p)
    }
    return p
  }
}

/** Cache do app (uma leitura por gravação enquanto o editor estiver aberto). */
export const cursorTracks = new CursorTrackCache((sessionId) => window.api.cursor.readCursorTrack(sessionId))

/**
 * Trilha do cursor do asset (pelo id, no projeto aberto) ou null — sem trilha, ainda carregando ou asset que não é
 * a tela de uma gravação com cursor.json. Carregada uma vez e compartilhada (cursorTracks).
 */
export function useCursorTrack(assetId: string | null | undefined): CursorTrackV1 | null {
  const sessionId = useEditorStore((s) => (assetId ? cursorSessionOf(s.project?.assets.find((a) => a.id === assetId)) : null))
  const [state, setState] = useState<{ sessionId: string; track: CursorTrackV1 | null } | null>(null)
  useEffect(() => {
    if (!sessionId || cursorTracks.peek(sessionId)) return
    let alive = true
    void cursorTracks.load(sessionId).then((track) => {
      if (alive) setState({ sessionId, track })
    })
    return () => {
      alive = false
    }
  }, [sessionId])
  if (!sessionId) return null
  return cursorTracks.peek(sessionId) ?? (state?.sessionId === sessionId ? state.track : null)
}
