import { randomUUID } from 'crypto'
import { extname, isAbsolute } from 'path'
import { SENSITIVE_KIND_LABELS, type SensitiveKind } from '@shared/editor/sensitive'
import type { ScanError, ScanProgress, ScanResult } from '@shared/editor/sensitiveScan'
import type { ScanRequest, ScanRunOpts } from './scan'

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
  return { ok: true, req: { filePath, fromUs: Math.round(fromUs), toUs: Math.round(toUs), ...(kinds ? { kinds } : {}), ...(customTerms ? { customTerms } : {}) } }
}

export interface ScanSink {
  progress: (p: ScanProgress & { scanId: string }) => void
  done: (d: { scanId: string; result: ScanResult }) => void
}

export type ScanRunner = (req: ScanRequest, opts: ScanRunOpts) => Promise<ScanResult>

export class SensitiveScans {
  private current: { scanId: string; ac: AbortController } | null = null

  constructor(private readonly run: ScanRunner, private readonly isFile: (p: string) => boolean) {}

  get running(): string | null {
    return this.current?.scanId ?? null
  }

  /** Começa uma varredura; erro imediato (busy/invalid) volta aqui e NÃO gera `done`. */
  start(raw: unknown, sink: ScanSink): { scanId: string; error?: ScanError } {
    if (this.current) return { scanId: '', error: { code: 'busy', message: SCAN_BUSY_MESSAGE } }
    const v = validateScanRequest(raw, this.isFile)
    if (!v.ok) return { scanId: '', error: v.error }
    const scanId = randomUUID()
    const ac = new AbortController()
    this.current = { scanId, ac }
    void this.run(v.req, { signal: ac.signal, onProgress: (p) => sink.progress({ scanId, ...p }) })
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
