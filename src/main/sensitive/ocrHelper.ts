import { spawn, type ChildProcess } from 'child_process'
import type { HelperLine, ScanErrorReason } from '@shared/editor/sensitiveScan'

// Cliente do helper de OCR (resources/ocr/ocr-winrt.ps1; protocolo no topo dele e no spike §6). Um processo por
// varredura. PRIVACIDADE: o texto reconhecido só existe em memória aqui; o stderr do helper é DESCARTADO (poderia
// ecoar texto) e nada daqui vai para log. Encerramento: `{"cmd":"quit"}` e, se não sair em 2 s, kill do PID INICIADO
// aqui (nunca por nome de imagem: o app instalado do usuário roda processos com os mesmos nomes).

/**
 * Erro 'ocrUnavailable': mensagem pt-BR (nunca texto cru do sistema), `reason` para a UI escolher a dica e `detail`
 * técnico (só diagnóstico em memória, sem texto da tela).
 */
export class OcrUnavailableError extends Error {
  readonly code = 'ocrUnavailable' as const
  constructor(message: string, readonly reason: ScanErrorReason, readonly detail?: string) {
    super(message)
  }
}

export const OCR_UNAVAILABLE_MESSAGE = 'O reconhecimento de texto do Windows não está disponível neste computador.'
export const OCR_STOPPED_MESSAGE = 'O reconhecimento de texto do Windows parou de responder.'

/** O helper diz que falta idioma de OCR (mensagens do ocr-winrt.ps1: "idioma de OCR não instalado" / "nenhum idioma de OCR"). */
const isLanguageError = (e: string): boolean => /idioma de OCR/i.test(e)

/**
 * powershell.exe pelo caminho absoluto do sistema: pelo nome, o libuv procura também na pasta atual e no PATH (um
 * powershell.exe plantado ali receberia os quadros da tela). Sem SystemRoot (não deveria acontecer no Windows), o nome.
 */
export function powershellPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT
  return root ? `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

export interface OcrHelperOpts {
  /** Caminho do .ps1 (dev: resources/ocr; empacotado: process.resourcesPath/ocr). */
  script: string
  /** Força um idioma (sem alternativa); ausente = en-US → pt-BR → perfil → o 1º disponível. */
  lang?: string
  readyTimeoutMs?: number
  frameTimeoutMs?: number
  /** Testes: outro executável/argumentos no lugar do powershell.exe. */
  command?: string
  args?: string[]
  onSpawn?: (pid: number) => void
}

interface Pending { id: number; resolve: (l: HelperLine[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class OcrHelper {
  private buf = ''
  private pending: Pending | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private exited = false
  private closing = false
  private readonly exitPromise: Promise<void>
  private failure: OcrUnavailableError | null = null
  private closePromise: Promise<void> | null = null
  lang = ''
  maxDim = 10000
  startMs = 0

  private constructor(private readonly child: ChildProcess, private readonly frameTimeoutMs: number) {
    this.exitPromise = new Promise((resolve) => {
      child.on('exit', () => {
        this.exited = true
        resolve()
      })
      child.on('error', () => {
        this.exited = true
        resolve()
      })
    })
    void this.exitPromise.then(() => this.fail(new OcrUnavailableError(OCR_STOPPED_MESSAGE, 'stopped', 'o helper encerrou')))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** Inicia o helper e espera a linha `ready`. Rejeita com OcrUnavailableError (sem idioma, PowerShell bloqueado...). */
  static start(o: OcrHelperOpts): Promise<OcrHelper> {
    const command = o.command ?? powershellPath()
    const args = o.args ?? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', o.script, ...(o.lang ? ['-Lang', o.lang] : [])]
    let child: ChildProcess
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      return Promise.reject(new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE, 'powershell', (e as Error).message))
    }
    if (child.pid !== undefined) o.onSpawn?.(child.pid)
    const h = new OcrHelper(child, o.frameTimeoutMs ?? 15_000)
    child.stdin?.on('error', () => {}) // EPIPE quando o helper já saiu: o 'exit' trata
    return new Promise<OcrHelper>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        h.kill()
        reject(new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE, 'powershell', 'o helper não respondeu na partida'))
      }, o.readyTimeoutMs ?? 20_000)
      const onReady = (line: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        let j: { ready?: boolean; lang?: string; maxDim?: number; startMs?: number; error?: string }
        try {
          j = JSON.parse(line)
        } catch {
          h.kill()
          reject(new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE, 'powershell', 'resposta inválida do helper'))
          return
        }
        if (j.ready !== true) {
          h.kill()
          const err = String(j.error ?? '')
          // falta de idioma: o motivo vem do nosso .ps1 (pt-BR, com a etiqueta pedida); outra falha (WinRT ausente,
          // PowerShell em modo restrito…) traz texto cru do sistema, que fica só no `detail`
          if (isLanguageError(err)) reject(new OcrUnavailableError(`${OCR_UNAVAILABLE_MESSAGE} Motivo: ${err}.`, 'noLanguage', err))
          else reject(new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE, 'powershell', err))
          return
        }
        h.lang = String(j.lang ?? '')
        h.maxDim = Number.isFinite(j.maxDim) && (j.maxDim as number) > 0 ? (j.maxDim as number) : 10000
        h.startMs = Number(j.startMs ?? 0)
        resolve(h)
      }
      let first = true
      child.stdout?.on('data', (d: Buffer) => {
        h.buf += d.toString('utf8')
        let i: number
        while ((i = h.buf.indexOf('\n')) >= 0) {
          const line = h.buf.slice(0, i).replace(/\r$/, '')
          h.buf = h.buf.slice(i + 1)
          if (!line) continue
          if (first) {
            first = false
            onReady(line)
          } else h.onLine(line)
        }
      })
      void h.exitPromise.then(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE, 'powershell', 'o helper encerrou na partida'))
      })
    })
  }

  private onLine(line: string): void {
    const p = this.pending
    let j: { id?: number; ok?: boolean; lines?: HelperLine[]; error?: string }
    try {
      j = JSON.parse(line)
    } catch {
      this.fail(new OcrUnavailableError(OCR_STOPPED_MESSAGE, 'stopped', 'resposta inválida do helper'))
      this.kill()
      return
    }
    if (!p || j.id !== p.id) return // resposta atrasada de um pedido que já expirou
    this.pending = null
    clearTimeout(p.timer)
    if (j.ok === true && Array.isArray(j.lines)) p.resolve(j.lines)
    // erro de um quadro (ex.: cabeçalho inválido): a varredura trata como quadro sem texto lido
    else p.reject(new Error(`ocr: ${String(j.error ?? 'erro')}`))
  }

  private fail(e: OcrUnavailableError): void {
    if (!this.failure) this.failure = e
    const p = this.pending
    if (p) {
      this.pending = null
      clearTimeout(p.timer)
      p.reject(this.closing ? new OcrUnavailableError(OCR_STOPPED_MESSAGE, 'stopped', 'helper fechado') : this.failure)
    }
  }

  /** Reconhece um quadro cinza w×h (px da imagem recebida nas coordenadas da resposta). Um pedido por vez. */
  recognize(data: Uint8Array, w: number, h: number): Promise<HelperLine[]> {
    const run = (): Promise<HelperLine[]> =>
      new Promise<HelperLine[]>((resolve, reject) => {
        if (this.exited || this.closing) return reject(this.failure ?? new OcrUnavailableError(OCR_STOPPED_MESSAGE, 'stopped', 'helper fechado'))
        if (data.byteLength !== w * h) return reject(new Error('ocr: tamanho do quadro não confere'))
        const id = this.nextId++
        const timer = setTimeout(() => {
          // quadro travado: mata o helper (só este PID); a varredura vira 'ocrUnavailable'
          this.fail(new OcrUnavailableError(OCR_STOPPED_MESSAGE, 'stopped', 'tempo esgotado no reconhecimento de um quadro'))
          this.kill()
        }, this.frameTimeoutMs)
        this.pending = { id, resolve, reject, timer }
        const stdin = this.child.stdin
        if (!stdin) return this.fail(new OcrUnavailableError(OCR_STOPPED_MESSAGE, 'stopped', 'sem stdin'))
        stdin.write(`{"id":${id},"w":${w},"h":${h},"fmt":"gray8","len":${data.byteLength}}\n`)
        stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      })
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  /** Mata o processo iniciado aqui (só este PID). */
  kill(): void {
    if (!this.exited && this.child.exitCode === null) {
      try {
        this.child.kill()
      } catch {
        /* já saiu */
      }
    }
  }

  /** `{"cmd":"quit"}`; se não sair em 2 s, kill do PID. Resolve quando o processo saiu. */
  close(graceMs = 2000): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose(graceMs)
    return this.closePromise
  }

  private async doClose(graceMs: number): Promise<void> {
    if (this.exited) return
    this.closing = true
    try {
      this.child.stdin?.write('{"cmd":"quit"}\n')
      this.child.stdin?.end()
    } catch {
      /* pipe já fechado */
    }
    let t: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([this.exitPromise.then(() => false), new Promise<boolean>((r) => (t = setTimeout(() => r(true), graceMs)))])
    if (t) clearTimeout(t)
    if (timedOut) {
      this.kill()
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 1000))])
    }
  }
}
