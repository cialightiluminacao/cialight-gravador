import { FILE_HOST_MEDIA, FILE_HOST_PROJECT, FILE_PROTOCOL } from '@shared/ipc'
import type { Project } from '@shared/editor/project'
import { isAudioProcessKey, isSourceFingerprint, sourceFingerprint } from '@shared/editor/audioProcess'

// URLs de mídia por asset para o render worker (protocolo cialight-file://media/<projectId>/<assetId>?v=…).
// `original` é a melhor fonte em qualidade cheia (intermediário, se houver, senão o original);
// `proxy` só no preview. O worker usa proxy quando `useProxy` e existe; senão `original`.
// `audio`: versões de áudio pré-processadas prontas (redução de ruído/normalização), por chave — arquivos só de
// áudio em generated/ (?v=audio&k=<chave>&f=<impressão da fonte>), lidos pelo audio worker no preview e na exportação.
// `speech`: silêncios brutos da análise de fala (cache/<id>.speech.json, cialight-file://project/…) que o audio worker lê
// para o ducking; ?f=<impressão da fonte> faz o worker reler quando a mídia é relocalizada e reanalisada.
// Assets ausentes ficam sem URL (o compositor desenha o placeholder "mídia indisponível").

export type MediaUrls = Record<string, { original: string; proxy?: string; audio?: Record<string, string>; speech?: string }>

/** Caminho relativo seguro dentro de cache/ (o arquivo vem do project.json). */
const safeCacheRel = (rel: string): boolean => /^cache\/[^/\\]+\.json$/.test(rel) && !rel.includes('..')

export function mediaUrlsFor(project: Project, mode: 'preview' | 'export'): MediaUrls {
  const out: MediaUrls = {}
  for (const a of project.assets) {
    if (a.status === 'missing') continue
    const base = `${FILE_PROTOCOL}://${FILE_HOST_MEDIA}/${encodeURIComponent(project.id)}/${encodeURIComponent(a.id)}`
    const keys = Object.entries(a.processedAudio ?? {}).filter(([k, fp]) => isAudioProcessKey(k) && isSourceFingerprint(fp))
    out[a.id] = {
      original: `${base}?v=${a.intermediate ? 'intermediate' : 'original'}`,
      ...(mode === 'preview' && a.proxy ? { proxy: `${base}?v=proxy` } : {}),
      ...(keys.length ? { audio: Object.fromEntries(keys.map(([k, fp]) => [k, `${base}?v=audio&k=${encodeURIComponent(k)}&f=${fp}`])) } : {}),
      ...(a.speech && safeCacheRel(a.speech) ? { speech: speechUrl(project.id, a.speech, a.source.type === 'file' ? sourceFingerprint(a.source.size, a.source.mtimeMs) : null) } : {})
    }
  }
  return out
}

function speechUrl(projectId: string, rel: string, fingerprint: string | null): string {
  const path = rel.split('/').map(encodeURIComponent).join('/')
  return `${FILE_PROTOCOL}://${FILE_HOST_PROJECT}/${encodeURIComponent(projectId)}/${path}${fingerprint ? `?f=${fingerprint}` : ''}`
}
