import { FILE_HOST_MEDIA, FILE_PROTOCOL } from '@shared/ipc'
import type { Project } from '@shared/editor/project'
import { isAudioProcessKey } from '@shared/editor/audioProcess'

// URLs de mídia por asset para o render worker (protocolo cialight-file://media/<projectId>/<assetId>?v=…).
// `original` é a melhor fonte em qualidade cheia (intermediário, se houver, senão o original);
// `proxy` só no preview. O worker usa proxy quando `useProxy` e existe; senão `original`.
// `audio`: versões de áudio pré-processadas prontas (redução de ruído/normalização), por chave — arquivos só de
// áudio em generated/ (?v=audio&k=<chave>), lidos pelo audio worker no preview e na exportação.
// Assets ausentes ficam sem URL (o compositor desenha o placeholder "mídia indisponível").

export type MediaUrls = Record<string, { original: string; proxy?: string; audio?: Record<string, string> }>

export function mediaUrlsFor(project: Project, mode: 'preview' | 'export'): MediaUrls {
  const out: MediaUrls = {}
  for (const a of project.assets) {
    if (a.status === 'missing') continue
    const base = `${FILE_PROTOCOL}://${FILE_HOST_MEDIA}/${encodeURIComponent(project.id)}/${encodeURIComponent(a.id)}`
    const keys = (a.processedAudio ?? []).filter(isAudioProcessKey)
    out[a.id] = {
      original: `${base}?v=${a.intermediate ? 'intermediate' : 'original'}`,
      ...(mode === 'preview' && a.proxy ? { proxy: `${base}?v=proxy` } : {}),
      ...(keys.length ? { audio: Object.fromEntries(keys.map((k) => [k, `${base}?v=audio&k=${encodeURIComponent(k)}`])) } : {})
    }
  }
  return out
}
