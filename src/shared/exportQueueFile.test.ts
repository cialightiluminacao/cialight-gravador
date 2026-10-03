import { describe, expect, it } from 'vitest'
import { parseQueueFile, sanitizeItem, serializeQueueFile, type PersistedQueueItem } from './exportQueueFile'

const item = (name: string, over: Partial<PersistedQueueItem> = {}): PersistedQueueItem => ({
  kind: 'video',
  label: `${name} · 1080p · 0:10`,
  durationUs: 10_000_000,
  privacy: ['Há 1 desfoque'],
  projectId: 'p_1',
  createdAt: 1_700_000_000_000,
  request: { project: { id: 'p_1', name: 'x' }, width: 1920, height: 1080, fps: 30, fromUs: 0, toUs: 10_000_000, outputDir: 'C:/saida', fileName: name },
  ...over
})

describe('arquivo da fila de exportações', () => {
  it('ida e volta mantém ordem e conteúdo', () => {
    const items = [item('a.mp4'), item('b.gif', { kind: 'gif' }), item('c.mp3', { kind: 'audio' })]
    expect(parseQueueFile(serializeQueueFile(items))).toEqual({ ok: true, items, dropped: 0 })
  })
  it('item inválido sai, os outros ficam (com contagem)', () => {
    const text = JSON.stringify({ version: 1, items: [item('a.mp4'), { kind: 'video' }, null, item('b.mp4', { kind: 'zip' as never })] })
    const r = parseQueueFile(text)
    expect(r.ok && r.items.map((i) => i.request.fileName)).toEqual(['a.mp4'])
    expect(r.ok && r.dropped).toBe(3)
  })
  it('corrompido, versão desconhecida ou formato errado: { ok: false } sem lançar', () => {
    expect(parseQueueFile('{nao é json').ok).toBe(false)
    expect(parseQueueFile('[]').ok).toBe(false)
    expect(parseQueueFile('null').ok).toBe(false)
    expect(parseQueueFile(JSON.stringify({ version: 2, items: [] })).ok).toBe(false)
    expect(parseQueueFile(JSON.stringify({ version: 1 })).ok).toBe(false)
  })
  it('exige pasta, nome, projeto e trecho no pedido', () => {
    expect(sanitizeItem(item('a.mp4', { request: { project: { id: 'p' }, fromUs: 0, toUs: 1, outputDir: '', fileName: 'a' } }))).toBeNull()
    expect(sanitizeItem(item('a.mp4', { request: { project: {}, fromUs: 0, toUs: 1, outputDir: 'C:/x', fileName: 'a' } }))).toBeNull()
  })
})
