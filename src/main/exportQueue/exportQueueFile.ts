import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { parseQueueFile, sanitizeItems, serializeQueueFile, type PersistedQueueItem } from '@shared/exportQueueFile'
import { renameSyncRetry } from '../fs/renameRetry'

// Fila de exportações persistente (main): <userData>/export-queue.json, `{ version: 1, items }`. Só o main escreve
// (gravação atômica tmp + rename); o renderer pede por IPC e nunca informa caminho. Em teste/QA nunca o userData.

/**
 * Arquivo da fila: CIALIGHT_EXPORT_QUEUE_FILE; em teste/QA (CIALIGHT_TEST/CIALIGHT_QA/CIALIGHT_SHOT) NUNCA o userData
 * (o app instalado o compartilha): <CIALIGHT_RAW_DIR>/../export-queue.json (padrão test-out/export-queue.json); senão userData.
 */
export function exportQueueFileFor(env: Record<string, string | undefined>, userData: string, cwd: string = process.cwd()): string {
  if (env.CIALIGHT_EXPORT_QUEUE_FILE) return resolve(cwd, env.CIALIGHT_EXPORT_QUEUE_FILE)
  if (env.CIALIGHT_TEST || env.CIALIGHT_QA || env.CIALIGHT_SHOT) return resolve(cwd, env.CIALIGHT_RAW_DIR || 'test-out/raw', '..', 'export-queue.json')
  return resolve(userData, 'export-queue.json')
}

export interface QueueFileLog {
  warn: (...a: unknown[]) => void
}

export class ExportQueueFile {
  constructor(
    private readonly file: string,
    private readonly log: QueueFileLog = { warn: () => {} }
  ) {}

  get path(): string {
    return this.file
  }

  /** Itens gravados. Ausente → []. Corrompido/versão desconhecida → [] e o arquivo vira `.bad` (nunca lança). */
  load(): PersistedQueueItem[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed = parseQueueFile(readFileSync(this.file, 'utf8'))
      if (parsed.ok) {
        if (parsed.dropped) this.log.warn(`fila de exportações: ${parsed.dropped} item(ns) inválido(s) ignorado(s)`)
        return parsed.items
      }
      this.log.warn(`fila de exportações ilegível (${parsed.reason}); arquivo guardado como .bad`)
      try {
        renameSyncRetry(this.file, `${this.file}.bad`)
      } catch (e) {
        this.log.warn('não foi possível renomear o arquivo da fila', e)
      }
      return []
    } catch (e) {
      this.log.warn('falha ao ler a fila de exportações', e)
      return []
    }
  }

  /** Grava (atômico: tmp + rename). `raw` é revalidado; o que não é item válido sai. Falha → lança (o chamador registra). */
  save(raw: unknown): PersistedQueueItem[] {
    const items = sanitizeItems(raw)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, serializeQueueFile(items), 'utf8')
      renameSyncRetry(tmp, this.file)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // melhor esforço
      }
      throw e
    }
    return items
  }
}

