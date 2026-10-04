// Modelos ggml do whisper.cpp (legendas automáticas, G2): catálogo pinado, estado e download sob demanda.
// A rede só é usada dentro de downloadModel (chamado por ação explícita do usuário).
//
// Pasta: CIALIGHT_WHISPER_MODELS_DIR (testes; relativo ao diretório atual) ou userData/models/whisper. userData do app
// = %APPDATA%\cialight-gravador (nome do package.json; o mesmo do settings.json e dos logs — conferido no
// test:transcribe sem gravar nada lá).
//
// "Presente" = arquivo com o tamanho exato + carimbo `<arquivo>.ok` contendo o sha256, gravado só depois de um
// download verificado (não recalcula o hash de 466 MB a cada consulta). O download grava em `<arquivo>.part` com
// sha256 incremental, confere tamanho e hash, renomeia (renameSyncRetry) e só então grava o carimbo.
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { renameSyncRetry } from '../fs/renameRetry'
import type { WhisperModelId, WhisperModelStatus } from '@shared/ipc'

export interface WhisperModelSpec { id: WhisperModelId; label: string; file: string; sizeBytes: number; sha256: string; urls: string[] }

const MIRROR = 'https://github.com/cialightiluminacao/cialight-gravador/releases/download/deps-whisper-v1.9.4'
const UPSTREAM = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1'
const urlsOf = (file: string): string[] => [`${MIRROR}/${file}`, `${UPSTREAM}/${file}`]

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelSpec> = {
  base: { id: 'base', label: 'Base', file: 'ggml-base.bin', sizeBytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', urls: urlsOf('ggml-base.bin') },
  small: { id: 'small', label: 'Preciso', file: 'ggml-small.bin', sizeBytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', urls: urlsOf('ggml-small.bin') }
}

/** Folga além do tamanho do modelo exigida antes de baixar. */
export const DOWNLOAD_HEADROOM_BYTES = 100 * 1048576
const PROGRESS_MIN_MS = 100 // no máximo 10 eventos/s
/** Sem nenhum byte por este tempo (inclusive antes da resposta), a URL atual é abandonada e a próxima é tentada. */
export const DOWNLOAD_STALL_MS = 30_000

/** .part em gravação agora (limpeza síncrona ao sair do app). */
const activeParts = new Set<string>()

/**
 * Saída do app no meio de um download (will-quit não espera promessas): apaga já, de forma síncrona, os .part em
 * gravação (caminhos explícitos). Devolve os caminhos tratados.
 */
export function cleanupDownloadPartsSync(): string[] {
  const out = [...activeParts]
  for (const p of out) removeQuiet(p)
  return out
}

export function whisperModelsDir(): string {
  const env = process.env.CIALIGHT_WHISPER_MODELS_DIR
  return env ? resolve(env) : join(app.getPath('userData'), 'models', 'whisper')
}

export function isWhisperModelId(id: unknown): id is WhisperModelId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(WHISPER_MODELS, id)
}

type Catalog = Partial<Record<WhisperModelId, WhisperModelSpec>>

function isPresent(dir: string, m: WhisperModelSpec): boolean {
  const file = join(dir, m.file)
  try {
    if (statSync(file).size !== m.sizeBytes) return false
    return readFileSync(`${file}.ok`, 'utf8').trim() === m.sha256
  } catch {
    return false
  }
}

export function modelStatus(dir = whisperModelsDir(), catalog: Catalog = WHISPER_MODELS): WhisperModelStatus[] {
  return Object.values(catalog).map((m) => ({ id: m.id, label: m.label, sizeBytes: m.sizeBytes, present: isPresent(dir, m) }))
}

/** Caminho do modelo baixado e verificado, ou null. */
export function modelFileIfPresent(id: WhisperModelId, dir = whisperModelsDir()): string | null {
  const m = WHISPER_MODELS[id]
  return m && isPresent(dir, m) ? join(dir, m.file) : null
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelado')
    this.name = 'DownloadCancelledError'
  }
}

export interface DownloadProgress { receivedBytes: number; totalBytes: number }
export interface DownloadDeps {
  dir?: string
  catalog?: Catalog
  fetch?: typeof fetch
  freeBytes?: (dir: string) => Promise<number>
  now?: () => number
  /** Inatividade máxima por URL (padrão DOWNLOAD_STALL_MS). */
  stallMs?: number
}

const fmtMB = (b: number): string => `${Math.ceil(b / 1048576).toLocaleString('pt-BR')} MB`

async function defaultFreeBytes(dir: string): Promise<number> {
  const st = await fsp.statfs(dir)
  return st.bavail * st.bsize
}

function removeQuiet(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // arquivo preso (antivírus): fica para a próxima tentativa, que o sobrescreve
  }
}

/** Uma URL, com cão de guarda de inatividade: sem bytes por stallMs → aborta só esta URL (o chamador tenta a próxima). */
async function fetchTo(url: string, part: string, m: WhisperModelSpec, onProgress: (p: DownloadProgress) => void, signal: AbortSignal | undefined, deps: DownloadDeps): Promise<void> {
  const stallMs = deps.stallMs ?? DOWNLOAD_STALL_MS
  const urlCtl = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      urlCtl.abort()
    }, stallMs)
  }
  try {
    arm()
    await fetchBody(url, part, m, onProgress, signal ? AbortSignal.any([signal, urlCtl.signal]) : urlCtl.signal, deps, arm)
  } catch (e) {
    if (stalled && !signal?.aborted) throw new Error(`sem dados por ${Math.round(stallMs / 1000)} s`)
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchBody(url: string, part: string, m: WhisperModelSpec, onProgress: (p: DownloadProgress) => void, signal: AbortSignal, deps: DownloadDeps, onBytes: () => void): Promise<void> {
  const res = await (deps.fetch ?? fetch)(url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  onBytes()
  const now = deps.now ?? Date.now
  const hash = createHash('sha256')
  const fh = await fsp.open(part, 'w')
  let received = 0
  let lastEmit = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onBytes()
      received += value.byteLength
      if (received > m.sizeBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`arquivo maior que o esperado (${m.sizeBytes} bytes)`)
      }
      hash.update(value)
      await fh.write(value)
      const t = now()
      if (t - lastEmit >= PROGRESS_MIN_MS) {
        lastEmit = t
        onProgress({ receivedBytes: received, totalBytes: m.sizeBytes })
      }
    }
  } finally {
    await fh.close()
  }
  if (received !== m.sizeBytes) throw new Error(`tamanho divergente (esperado ${m.sizeBytes}, recebido ${received} bytes)`)
  const got = hash.digest('hex')
  if (got !== m.sha256) throw new Error(`sha256 divergente (esperado ${m.sha256}, obtido ${got})`)
  onProgress({ receivedBytes: received, totalBytes: m.sizeBytes })
}

/**
 * Baixa o modelo (espelho, depois upstream) para a pasta dos modelos. Erros em pt-BR; cancelamento →
 * DownloadCancelledError ("Download cancelado"). Nunca deixa `.part` para trás (caminho explícito).
 */
export async function downloadModel(id: WhisperModelId, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal, deps: DownloadDeps = {}): Promise<void> {
  const m = (deps.catalog ?? WHISPER_MODELS)[id]
  if (!m) throw new Error(`Modelo de transcrição desconhecido: ${String(id)}`)
  if (signal?.aborted) throw new DownloadCancelledError()
  const dir = deps.dir ?? whisperModelsDir()
  mkdirSync(dir, { recursive: true })
  const need = m.sizeBytes + DOWNLOAD_HEADROOM_BYTES
  const free = await (deps.freeBytes ?? defaultFreeBytes)(dir)
  if (free < need) throw new Error(`Espaço insuficiente para baixar o modelo “${m.label}”: são necessários ${fmtMB(need)} livres em ${dir}.`)

  const final = join(dir, m.file)
  const part = `${final}.part`
  const stamp = `${final}.ok`
  // carimbo antigo sai antes: um download interrompido nunca deixa o modelo como "presente"
  removeQuiet(stamp)
  const errors: string[] = []
  for (const url of m.urls) {
    if (signal?.aborted) {
      removeQuiet(part)
      throw new DownloadCancelledError()
    }
    activeParts.add(part)
    try {
      await fetchTo(url, part, m, onProgress, signal, deps)
      renameSyncRetry(part, final)
      const tmpStamp = `${stamp}.part`
      writeFileSync(tmpStamp, m.sha256)
      renameSyncRetry(tmpStamp, stamp)
      return
    } catch (e) {
      removeQuiet(part)
      if (signal?.aborted) throw new DownloadCancelledError()
      errors.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      activeParts.delete(part)
    }
  }
  if (existsSync(part)) removeQuiet(part)
  throw new Error(`Não foi possível baixar o modelo: ${errors.join('; ')}`)
}
