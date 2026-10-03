// Fila de exportações persistente: forma do item gravado em export-queue.json e a validação defensiva (pura).
// O arquivo guarda só o que ainda não terminou (pendente/rodando), na ordem da fila, cada item com o pedido
// completo (instantâneo do Project em forma de disco + configurações + pasta/nome de saída) para rodar de novo.

export const EXPORT_QUEUE_FILE_VERSION = 1
export const EXPORT_QUEUE_MAX_ITEMS = 200

export type PersistedKind = 'video' | 'gif' | 'audio'

export interface PersistedQueueItem {
  kind: PersistedKind
  /** "<arquivo> · <preset> · <duração>". */
  label: string
  durationUs: number
  privacy: string[]
  projectId: string
  createdAt: number
  /** Pedido do executor (EditorExportRequest/GifExportRequest/AudioExportRequest) com o `project` em forma de disco. */
  request: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Caminho absoluto (unidade `C:\` / `C:/`, UNC ou raiz POSIX), sem segmento `..` e sem NUL. */
export function isSafeOutputDir(dir: unknown): dir is string {
  if (!isStr(dir) || dir.includes('\0')) return false
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(dir)) return false
  return !dir.split(/[\\/]/).includes('..')
}

/** Nome simples de arquivo: sem separador, sem NUL, nem "." / "..". */
export function isSafeFileName(name: unknown): name is string {
  return isStr(name) && name.trim() !== '' && !/[\\/\0]/.test(name) && name.trim() !== '.' && name.trim() !== '..'
}

/** Valida um item (cópia só com os campos conhecidos); inválido → null. */
export function sanitizeItem(raw: unknown): PersistedQueueItem | null {
  if (!isObj(raw)) return null
  const { kind, label, durationUs, privacy, projectId, createdAt, request } = raw
  if (kind !== 'video' && kind !== 'gif' && kind !== 'audio') return null
  if (!isStr(label) || !isNum(durationUs) || !isStr(projectId) || !projectId || !isNum(createdAt)) return null
  if (!Array.isArray(privacy) || !privacy.every(isStr)) return null
  if (!isObj(request)) return null
  if (!isObj(request.project) || !isStr(request.project.id)) return null
  if (!isSafeOutputDir(request.outputDir) || !isSafeFileName(request.fileName)) return null
  if (!isNum(request.fromUs) || !isNum(request.toUs)) return null
  return { kind, label, durationUs, privacy: [...privacy], projectId, createdAt, request }
}

export function sanitizeItems(raw: unknown): PersistedQueueItem[] {
  if (!Array.isArray(raw)) return []
  const out: PersistedQueueItem[] = []
  for (const r of raw.slice(0, EXPORT_QUEUE_MAX_ITEMS)) {
    const it = sanitizeItem(r)
    if (it) out.push(it)
  }
  return out
}

export function serializeQueueFile(items: readonly PersistedQueueItem[]): string {
  return JSON.stringify({ version: EXPORT_QUEUE_FILE_VERSION, items })
}

export type ParsedQueueFile = { ok: true; items: PersistedQueueItem[]; dropped: number } | { ok: false; reason: string }

/** Texto do arquivo → itens. Nunca lança: JSON inválido, envelope errado ou versão desconhecida → { ok: false }. */
export function parseQueueFile(text: string): ParsedQueueFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'JSON inválido' }
  }
  if (!isObj(json)) return { ok: false, reason: 'formato inesperado' }
  if (json.version !== EXPORT_QUEUE_FILE_VERSION) return { ok: false, reason: `versão desconhecida: ${String(json.version)}` }
  if (!Array.isArray(json.items)) return { ok: false, reason: 'lista de itens ausente' }
  const items = sanitizeItems(json.items)
  return { ok: true, items, dropped: json.items.length - items.length }
}
