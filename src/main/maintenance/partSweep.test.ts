import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isExportPart, isIngestPart, staleParts, sweepStaleParts } from './partSweep'

describe('padrões de .part', () => {
  it('ingestão: <nome>.part-<pid>-<n>.<ext> (proxies, filmstrip, peaks, miniatura)', () => {
    for (const n of ['a_1.part-123-4.mp4', 'a_1.intermediate.part-9-1.m4a', 'a_1.strip.part-1-2.jpg', 'a_1.peaks.part-77-10.bin', 'thumb.part-5-6.jpg']) expect(isIngestPart(n)).toBe(true)
    for (const n of ['a_1.mp4', 'a_1.strip.jpg', 'parte.mp4', 'a.part.mp4']) expect(isIngestPart(n)).toBe(false)
  })
  it('exportação do editor: <nome>.mp4.part', () => {
    expect(isExportPart('Meu vídeo (2).mp4.part')).toBe(true)
    expect(isExportPart('Meu vídeo.mp4')).toBe(false)
    expect(isExportPart('x.part-1-2.mp4')).toBe(false)
  })
  it('exportação do editor em outros formatos (F7): GIF e seus temporários, PNG e áudio', () => {
    for (const n of ['Clipe.gif.part', 'Clipe.gif.ffv1.part', 'Clipe.gif.palette.part', 'Projeto - 00m12s.png.part', 'Trilha.wav.part', 'Trilha.MP3.part', 'Trilha.m4a.part']) expect(isExportPart(n)).toBe(true)
    for (const n of ['Clipe.gif', 'notas.txt.part', 'Clipe.part', 'Trilha.wav']) expect(isExportPart(n)).toBe(false)
  })
  it('áudio temporário da reserva libx264: <nome>.mp4.audio.part (sobra de queda); só com .mp4', () => {
    for (const n of ['Vídeo.mp4.audio.part', 'Meu vídeo (2).MP4.audio.part']) expect(isExportPart(n)).toBe(true)
    for (const n of ['Vídeo.mp4.audio', 'gravacao.audio.part', 'Vídeo.wav.audio.part', 'Vídeo.mp4.audio.part.bak', 'Clipe.mp4.ffv1.part', 'Clipe.png.palette.part', 'Clipe.gif.audio.part', 'Vídeo.mp4.audio.part-1-2']) {
      expect(isExportPart(n)).toBe(false)
    }
  })
})

describe('sweepStaleParts', () => {
  let root: string
  const DAY = 86_400_000
  const now = Date.UTC(2026, 9, 2)
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cl-sweep-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const touch = (path: string, ageMs: number): string => {
    writeFileSync(path, 'x')
    const t = (now - ageMs) / 1000
    utimesSync(path, t, t)
    return path
  }

  it('apaga só .part com mais de 1 dia nas pastas pedidas; o resto fica', async () => {
    const proxies = join(root, 'p1', 'proxies')
    const cache = join(root, 'p1', 'cache')
    const out = join(root, 'Vídeos')
    for (const d of [proxies, cache, out]) mkdirSync(d, { recursive: true })
    const oldProxy = touch(join(proxies, 'a.part-1-1.mp4'), 2 * DAY)
    const newProxy = touch(join(proxies, 'b.part-1-2.mp4'), 60_000) // ingestão em andamento
    const realProxy = touch(join(proxies, 'a.mp4'), 10 * DAY)
    const oldStrip = touch(join(cache, 'a.strip.part-3-4.jpg'), 3 * DAY)
    const oldExport = touch(join(out, 'Vídeo.mp4.part'), 2 * DAY)
    const oldAudio = touch(join(out, 'Vídeo.mp4.audio.part'), 2 * DAY) // reserva libx264 interrompida
    const oldFfv1 = touch(join(out, 'Clipe.gif.ffv1.part'), 2 * DAY)
    const oldPalette = touch(join(out, 'Clipe.gif.palette.part'), 2 * DAY)
    const newAudio = touch(join(out, 'Outro.mp4.audio.part'), 60_000) // exportação em andamento
    const userFile = touch(join(out, 'notas.part'), 9 * DAY) // não é nosso
    const removed = await sweepStaleParts([{ dir: proxies, kind: 'ingest' }, { dir: cache, kind: 'ingest' }, { dir: out, kind: 'export' }, { dir: join(root, 'nao-existe'), kind: 'ingest' }], { now: () => now })
    expect(removed.sort()).toEqual([oldExport, oldAudio, oldFfv1, oldPalette, oldProxy, oldStrip].sort())
    expect([newProxy, realProxy, userFile, newAudio].every(existsSync)).toBe(true)
  })

  it('staleParts lista sem apagar', () => {
    const d = join(root, 'proxies')
    mkdirSync(d)
    const p = touch(join(d, 'a.part-1-1.mp4'), 2 * DAY)
    expect(staleParts({ dir: d, kind: 'ingest' }, now)).toEqual([p])
    expect(existsSync(p)).toBe(true)
  })
})

describe('exportPartsFor (parciais da fila salva)', () => {
  it('só os parciais daquele nome (com ou sem número e extensão digitada); nada de outros arquivos', async () => {
    const { exportPartsFor } = await import('./partSweep')
    const names = ['Aula.mp4.part', 'Aula (2).mp4.part', 'Aula.gif.ffv1.part', 'Aula2.mp4.part', 'Outro.mp4.part', 'Aula.mp4', 'Aula.srt.part', 'Aula.mp4.audio.part']
    expect(exportPartsFor(names, 'Aula.mp4').sort()).toEqual(['Aula (2).mp4.part', 'Aula.gif.ffv1.part', 'Aula.mp4.audio.part', 'Aula.mp4.part'].sort())
    expect(exportPartsFor(names, 'Aula')).toEqual(exportPartsFor(names, 'Aula.mp4'))
    expect(exportPartsFor(names, '')).toEqual([])
  })
})
