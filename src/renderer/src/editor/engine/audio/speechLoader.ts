// Carregamento da fala (sem dependência do worker, testável): lê os speech.json pela URL (cache por URL; falha não
// fica em cache e é avisada uma vez por URL). No audio worker (ducking) monta o plano com a fala sem nunca rejeitar —
// erro ao montar mantém o plano anterior (sem fala) e é avisado; no diálogo "Remover silêncios" (thread principal)
// carrega a fala sem margem nem mescla (SILENCE_SPEECH_OPTS).
import { speechFromFile, type SpeechFile, type SpeechInterval } from '@shared/editor/speech'

type SpeechOpts = Parameters<typeof speechFromFile>[1]

export type FetchJson = (url: string) => Promise<unknown>

/** Formato mínimo do cache/<id>.speech.json (versão 1). */
function isSpeechFile(x: unknown): x is SpeechFile {
  const f = x as SpeechFile | null
  return !!f && f.version === 1 && Array.isArray(f.silences) && typeof f.durationUs === 'number' && f.durationUs > 0 &&
    f.silences.every((s) => typeof s?.fromUs === 'number' && (s.toUs === null || typeof s.toUs === 'number'))
}

export class SpeechLoader {
  private readonly cache = new Map<string, Promise<SpeechInterval[] | null>>()
  private readonly reported = new Set<string>()

  /** onFailed(assetId): speech.json que não carregou (uma vez por URL). opts: margem/mescla (padrão: SPEECH_DEFAULTS). */
  constructor(private readonly fetchJson: FetchJson, private readonly onFailed: (assetId: string) => void, private readonly opts: SpeechOpts = {}) {}

  /** Intervalos de fala por assetId (urls: assetId → URL do speech.json); o que não carregar fica de fora. */
  async load(urls: Record<string, string>): Promise<Record<string, SpeechInterval[]>> {
    const out: Record<string, SpeechInterval[]> = {}
    await Promise.all(
      Object.entries(urls).map(async ([id, url]) => {
        let p = this.cache.get(url)
        if (!p) {
          p = this.fetchJson(url)
            .then((json) => (isSpeechFile(json) ? speechFromFile(json, this.opts) : null))
            .catch(() => null)
          this.cache.set(url, p)
        }
        const iv = await p
        if (iv) {
          out[id] = iv
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
