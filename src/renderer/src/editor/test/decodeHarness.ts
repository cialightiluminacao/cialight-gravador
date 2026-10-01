import { decodableTracks } from '../ui/mediaImport'

// Teste de integração da ingestão (CIALIGHT_TEST=ingest), rota index.html#decode-test/<json>: decide
// `decodable` (vídeo/áudio) com o WebCodecs real desta máquina para cada URL e devolve ao main.

declare global {
  interface Window {
    __captureTestSend?: (r: unknown) => void
  }
}

export async function runDecodeHarness(params: { items: { name: string; url: string; kind: 'video' | 'audio' }[] }): Promise<void> {
  const results: Record<string, { video: boolean; audio: boolean }> = {}
  const errors: string[] = []
  for (const it of params.items) {
    try {
      results[it.name] = await decodableTracks(it.url, it.kind)
    } catch (e) {
      errors.push(`${it.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  window.__captureTestSend?.({ ok: errors.length === 0, results, errors })
}
