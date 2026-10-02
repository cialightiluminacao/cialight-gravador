// Carregamento da fala (sem dependência do worker, testável): lê os speech.json pela URL (cache por URL; falha não
// fica em cache e é avisada uma vez por URL). No audio worker (ducking) monta o plano com a fala sem nunca rejeitar —
// erro ao montar mantém o plano anterior (sem fala) e é avisado; o painel "Remover silêncios" (thread principal) lê os
// arquivos (loadFiles: limiar da análise + silêncios) e tira a fala sem margem nem mescla (SILENCE_SPEECH_OPTS).
import { speechFromFile, type SpeechFile, type SpeechInterval } from '@shared/editor/speech'

export type FetchJson = (url: string) => Promise<unknown>

/** Formato mínimo do cache/<id>.speech.json (versão 1). */
function isSpeechFile(x: unknown): x is SpeechFile {
  const f = x as SpeechFile | null
  return !!f && f.version === 1 && Array.isArray(f.silences) && typeof f.durationUs === 'number' && f.durationUs > 0 &&
    f.silences.every((s) => typeof s?.fromUs === 'number' && (s.toUs === null || typeof s.toUs === 'number'))
}

export class SpeechLoader {
  private readonly cache = new Map<string, Promise<SpeechFile | null>>()
  private readonly reported = new Set<string>()
  private readonly intervals = new WeakMap<SpeechFile, SpeechInterval[]>()

  /** onFailed(assetId): speech.json que não carregou (uma vez por URL). */
  constructor(private readonly fetchJson: FetchJson, private readonly onFailed: (assetId: string) => void) {}

  /** speech.json por assetId (urls: assetId → URL); o que não carregar fica de fora (e é avisado uma vez por URL). */
  async loadFiles(urls: Record<string, string>): Promise<Record<string, SpeechFile>> {
    const out: Record<string, SpeechFile> = {}
    await Promise.all(
      Object.entries(urls).map(async ([id, url]) => {
        let p = this.cache.get(url)
        if (!p) {
          p = this.fetchJson(url)
            .then((json) => (isSpeechFile(json) ? json : null))
            .catch(() => null)
          this.cache.set(url, p)
        }
        const file = await p
        if (file) {
          out[id] = file
          return
        }
        if (this.cache.get(url) === p) this.cache.delete(url) // tenta de novo no próximo projeto
        if (!this.reported.has(url)) {
          this.reported.add(url)
          this.onFailed(id)
        }
      })
    )
    return out
  }

  /** Intervalos de fala por assetId com a margem/mescla padrão (SPEECH_DEFAULTS: ducking). */
  async load(urls: Record<string, string>): Promise<Record<string, SpeechInterval[]>> {
    const files = await this.loadFiles(urls)
    const out: Record<string, SpeechInterval[]> = {}
    for (const [id, f] of Object.entries(files)) {
      let iv = this.intervals.get(f)
      if (!iv) this.intervals.set(f, (iv = speechFromFile(f)))
      out[id] = iv
    }
    return out
  }

  /**
   * Carrega a fala e chama `apply` com ela. Nunca rejeita: falha em `apply` (montar o plano) vai para `onError` e o
   * plano em uso (sem fala) continua — os blocos que esperam esta promessa nunca ficam presos.
   */
  plan(urls: Record<string, string>, apply: (speech: Record<string, SpeechInterval[]>) => void, onError: (message: string) => void): Promise<void> {
    return this.load(urls)
      .then(apply)
      .catch((err: unknown) => {
        onError(err instanceof Error ? err.message : String(err))
      })
  }
}
