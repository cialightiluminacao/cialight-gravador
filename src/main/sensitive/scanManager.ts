import { randomUUID } from 'crypto'
import { extname, isAbsolute } from 'path'
import { SENSITIVE_KIND_LABELS, type SensitiveKind } from '@shared/editor/sensitive'
import type { ScanError, ScanProgress, ScanResult } from '@shared/editor/sensitiveScan'
import type { ScanRequest, ScanRunOpts } from './scan'
import { parseFfprobe } from '../media/probe'

// Uma varredura de dados sensíveis por vez (a segunda recebe 'busy'), pedidos validados aqui (vêm do renderer pelo IPC).
// Os termos personalizados vivem só na memória desta varredura (nunca em log nem em disco).

export const MEDIA_VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'ts']
export const MAX_CUSTOM_TERMS = 50
export const MAX_CUSTOM_TERM_LEN = 100

export const SCAN_BUSY_MESSAGE = 'Já há uma busca de dados sensíveis em andamento. Aguarde ou cancele a atual.'
const invalid = (detail: string): ScanError => ({ code: 'invalid', message: `Pedido de busca de dados sensíveis inválido: ${detail}.` })

const KINDS = new Set(Object.keys(SENSITIVE_KIND_LABELS))

/** Valida o pedido do renderer (formas, números finitos, arquivo de vídeo existente, limites dos termos). */
export function validateScanRequest(raw: unknown, isFile: (p: string) => boolean): { ok: true; req: ScanRequest } | { ok: false; error: ScanError } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: invalid('formato') }
  const r = raw as Record<string, unknown>
  const filePath = r.filePath
  if (typeof filePath !== 'string' || !filePath || !isAbsolute(filePath)) return { ok: false, error: invalid('caminho do arquivo') }
  if (!MEDIA_VIDEO_EXT.includes(extname(filePath).slice(1).toLowerCase())) return { ok: false, error: invalid('o arquivo não é um vídeo') }
  if (!isFile(filePath)) return { ok: false, error: invalid('o arquivo não existe') }
  const fromUs = r.fromUs, toUs = r.toUs
  if (typeof fromUs !== 'number' || typeof toUs !== 'number' || !Number.isFinite(fromUs) || !Number.isFinite(toUs) || fromUs < 0 || toUs <= fromUs) return { ok: false, error: invalid('trecho') }
  let kinds: SensitiveKind[] | undefined
  if (r.kinds !== undefined) {
    if (!Array.isArray(r.kinds) || r.kinds.length > KINDS.size || !r.kinds.every((k) => typeof k === 'string' && KINDS.has(k))) return { ok: false, error: invalid('tipos') }
    kinds = [...new Set(r.kinds as SensitiveKind[])]
  }
  let customTerms: string[] | undefined
  if (r.customTerms !== undefined) {
    const t = r.customTerms
    if (!Array.isArray(t) || t.length > MAX_CUSTOM_TERMS || !t.every((x) => typeof x === 'string' && x.length <= MAX_CUSTOM_TERM_LEN)) {
      return { ok: false, error: invalid(`termos personalizados (até ${MAX_CUSTOM_TERMS}, com até ${MAX_CUSTOM_TERM_LEN} caracteres)`) }
    }
    customTerms = [...(t as string[])]
  }
  const vsi = r.videoStreamIndex
  if (vsi !== undefined && (typeof vsi !== 'number' || !Number.isInteger(vsi) || vsi < 0 || vsi > 63)) return { ok: false, error: invalid('faixa de vídeo') }
  return {
    ok: true,
    req: { filePath, fromUs: Math.round(fromUs), toUs: Math.round(toUs), ...(kinds ? { kinds } : {}), ...(customTerms ? { customTerms } : {}), ...(vsi !== undefined ? { videoStreamIndex: vsi } : {}) }
  }
}

export const SCAN_INTERMEDIATE_MESSAGE = 'Não foi possível achar a cópia convertida deste vídeo (a que o editor mostra) para procurar dados sensíveis. Aguarde a conversão terminar ou reimporte o vídeo.'

/** Caminho do intermediário do asset no projeto (null = não há). */
export type IntermediateResolver = (projectId: string, assetId: string) => string | null

/**
 * Fonte da varredura = o arquivo que o editor DECODIFICA (mediaUrls: o intermediário, se houver, senão o original).
 * O intermediário é transcodificado sem -copyts (tempo = pts do original − start_time do arquivo, e CFR quando VFR) e
 * só leva a faixa 0:v:0: varrer o original rotularia os quadros S (start_time, milhares de segundos num .ts de TV)
 * adiantados em relação ao que o editor mostra. Com `intermediate`, o arquivo vira o intermediário do projeto (faixa
 * v:0); sem ele resolvido, RECUSA (nunca varre o original no lugar, em silêncio).
 */
export function resolveScanSource(raw: unknown, resolveIntermediate?: IntermediateResolver): { ok: true; raw: unknown } | { ok: false; error: ScanError } {
  if (!raw || typeof raw !== 'object' || !('intermediate' in raw) || (raw as { intermediate?: unknown }).intermediate === undefined) return { ok: true, raw }
  const { intermediate, ...rest } = raw as Record<string, unknown>
  const refuse = { ok: false as const, error: { code: 'invalid' as const, message: SCAN_INTERMEDIATE_MESSAGE } }
  const ref = intermediate as { projectId?: unknown; assetId?: unknown } | null
  if (!ref || typeof ref !== 'object' || typeof ref.projectId !== 'string' || typeof ref.assetId !== 'string' || !ref.projectId || !ref.assetId || !resolveIntermediate) return refuse
  let path: string | null
  try {
    path = resolveIntermediate(ref.projectId, ref.assetId)
  } catch {
    path = null
  }
  if (!path) return refuse
  return { ok: true, raw: { ...rest, filePath: path, videoStreamIndex: 0 } }
}

export interface StreamInfo { video?: { width: number; height: number; rotation?: number }; durationUs: number | null }

/**
 * Dimensões/giro/duração da faixa de vídeo v:N (ruling R23: a webcam do rec.mp4 é v:1, com outro tamanho que a tela).
 * N = 0 usa o probe normal; N > 0 roda `ffprobe -select_streams v:N` (só ela aparece) pelo `run` injetado.
 */
export async function probeVideoStream(file: string, idx: number, deps: { probe: (f: string) => Promise<StreamInfo>; run: (args: string[]) => Promise<string> }): Promise<StreamInfo> {
  if (!idx) return deps.probe(file)
  const out = await deps.run(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', `v:${idx}`, file])
  const json = JSON.parse(out) as { streams?: { codec_type?: string }[] }
  if (!json.streams?.some((s) => s.codec_type === 'video')) throw new Error(`faixa de vídeo v:${idx} inexistente`)
  return parseFfprobe(json, file)
}

export interface ScanSink {
  progress: (p: ScanProgress & { scanId: string }) => void
  done: (d: { scanId: string; result: ScanResult }) => void
}

export type ScanRunner = (req: ScanRequest, opts: ScanRunOpts) => Promise<ScanResult>

export class SensitiveScans {
  private current: { scanId: string; ac: AbortController } | null = null

  constructor(private readonly run: ScanRunner, private readonly isFile: (p: string) => boolean, private readonly resolveIntermediate?: IntermediateResolver) {}

  get running(): string | null {
    return this.current?.scanId ?? null
  }

  /** Começa uma varredura; erro imediato (busy/invalid) volta aqui e NÃO gera `done`. */
  start(raw: unknown, sink: ScanSink): { scanId: string; error?: ScanError } {
    if (this.current) return { scanId: '', error: { code: 'busy', message: SCAN_BUSY_MESSAGE } }
    const src = resolveScanSource(raw, this.resolveIntermediate)
    if (!src.ok) return { scanId: '', error: src.error }
    const v = validateScanRequest(src.raw, this.isFile)
    if (!v.ok) return { scanId: '', error: v.error }
    const scanId = randomUUID()
    const ac = new AbortController()
    this.current = { scanId, ac }
    void this.run(v.req, { scanId, signal: ac.signal, onProgress: (p) => sink.progress({ scanId, ...p }) })
      .catch((): ScanResult => ({ occurrences: [], framesSampled: 0, framesOcr: 0, ms: 0, lang: '', error: { code: 'ffmpeg', message: 'A busca de dados sensíveis falhou.' } }))
      .then((result) => {
        if (this.current?.scanId === scanId) this.current = null
        sink.done({ scanId, result })
      })
    return { scanId }
  }

  /** Cancela a varredura (o `done` chega com `cancelled`). false = não é a que está rodando. */
  cancel(scanId: string): boolean {
    if (!this.current || this.current.scanId !== scanId) return false
    this.current.ac.abort()
    return true
  }

  cancelAll(): void {
    this.current?.ac.abort()
  }
}

/** O que a varredura usa do webContents de quem pediu (injetável: testado com um EventEmitter). */
export interface ScanSender {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * Começa a varredura pedida por uma página: progresso/fim vão para ela, e a varredura (com os processos dela) acaba
 * junto com a página — janela fechada, renderer caído ou página recarregada/navegada (quadro principal, outro
 * documento). Os ouvintes saem quando a varredura termina (nada se acumula a cada busca).
 */
export function startScanForSender(scans: SensitiveScans, wc: ScanSender, raw: unknown, channels: { progress: string; done: string }): { scanId: string; error?: ScanError } {
  const send = (channel: string, payload: unknown): void => {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
  let scanId = ''
  let finished = false
  const cancel = (): void => {
    if (scanId) scans.cancel(scanId)
  }
  const onNavigate = (...args: unknown[]): void => {
    // Electron atual: 1º argumento traz isMainFrame/isSameDocument; forma antiga: (evento, url, isInPlace, isMainFrame)
    const d = args[0] as { isMainFrame?: unknown; isSameDocument?: unknown } | undefined
    const main = typeof d?.isMainFrame === 'boolean' ? d.isMainFrame : args[3] === true
    const same = typeof d?.isSameDocument === 'boolean' ? d.isSameDocument : args[2] === true
    if (main && !same) cancel()
  }
  const unbind = (): void => {
    wc.removeListener('destroyed', cancel)
    wc.removeListener('render-process-gone', cancel)
    wc.removeListener('did-start-navigation', onNavigate)
  }
  const r = scans.start(raw, {
    progress: (p) => send(channels.progress, p),
    done: (d) => {
      finished = true
      unbind()
      send(channels.done, d)
    }
  })
  if (r.error || finished) return r
  scanId = r.scanId
  wc.on('destroyed', cancel)
  wc.on('render-process-gone', cancel)
  wc.on('did-start-navigation', onNavigate)
  return r
}
