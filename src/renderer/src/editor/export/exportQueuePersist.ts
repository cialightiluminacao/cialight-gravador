// Item da fila <-> item do arquivo export-queue.json (renderer, puro). O Project vai em forma de disco (toDiskProject) e
// volta pelo schema atual (parseProject): projeto que não passa no schema é descartado com aviso, nunca derruba a fila.
import type { Project } from '@shared/editor/project'
import { parseProject, toDiskProject } from '@shared/editor/schema'
import type { PersistedQueueItem } from '@shared/exportQueueFile'
import type { ParkedEntry, QueueJob } from './exportQueue'

/** Campos do pedido que só existem em teste (ou não são JSON): não vão para o arquivo. */
const NOT_PERSISTED = new Set(['cursorTracks', 'simulateHwFailure', 'simulateSoftwareFailure', 'simulateHevcFailure', 'simulateFirstPassOvershoot'])

const persistedCache = new WeakMap<object, PersistedQueueItem>()

/** Entrada da fila → item do arquivo (Project em forma de disco). Cache por job: o instantâneo é imutável. */
export function toPersisted(e: ParkedEntry): PersistedQueueItem {
  const hit = persistedCache.get(e.job)
  if (hit) return hit
  const request: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e.job.request)) if (!NOT_PERSISTED.has(k)) request[k] = v
  request.project = toDiskProject(e.job.request.project)
  const out: PersistedQueueItem = { kind: e.job.kind, label: e.label, durationUs: e.durationUs, privacy: [...e.privacy], projectId: e.job.request.project.id, createdAt: e.createdAt, request }
  persistedCache.set(e.job, out)
  return out
}

/** Item do arquivo → entrada da fila; projeto que não passa no schema atual → null (o item é descartado, com aviso no console). */
export function fromPersisted(p: PersistedQueueItem): ParkedEntry | null {
  try {
    const project: Project = parseProject(p.request.project)
    const request = { ...p.request, project } as unknown as QueueJob['request']
    return { job: { kind: p.kind, request } as QueueJob, label: p.label, durationUs: p.durationUs, privacy: p.privacy, createdAt: p.createdAt }
  } catch (e) {
    console.warn('fila de exportações: item do arquivo ignorado (projeto inválido)', p.label, e)
    return null
  }
}
