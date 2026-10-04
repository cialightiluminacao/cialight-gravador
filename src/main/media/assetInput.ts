// Arquivo de entrada e streams de um asset (regra única da ingestão, da análise de fala e da transcrição).
import type { Asset } from '@shared/editor/project'
import type { IngestInput } from './ingest'

export interface AssetInputDeps {
  /** Caminho absoluto de um arquivo da pasta do projeto (ProjectStore.filePath). */
  projectFile: (projectId: string, rel: string) => string
  /** Caminho absoluto de um arquivo da pasta da gravação (SessionStore.filePath). */
  sessionFile: (sessionId: string, name: string) => string
  /** Índice por tipo das faixas do rec.mp4 da gravação (session.tracks), se conhecido. */
  sessionTracks: (sessionId: string) => Partial<Record<string, number>> | undefined
}

export function resolveAssetInput(deps: AssetInputDeps, projectId: string, a: Asset): IngestInput {
  switch (a.source.type) {
    case 'file':
      return { path: a.source.path }
    case 'generated':
      return { path: deps.projectFile(projectId, a.source.file) }
    case 'session': {
      // rec.mp4 multi-faixa: índice por tipo vem de session.tracks; gravação do app dispensa proxy
      const idx = deps.sessionTracks(a.source.sessionId)?.[a.source.stream] ?? 0
      const isVideo = a.source.stream === 'screen' || a.source.stream === 'webcam'
      return { path: deps.sessionFile(a.source.sessionId, 'rec.mp4'), analyzeOnly: true, ...(isVideo ? { videoMap: `0:v:${idx}` } : { audioMap: `0:a:${idx}` }) }
    }
  }
}
