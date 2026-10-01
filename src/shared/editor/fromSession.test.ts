import { describe, expect, it } from 'vitest'
import { pipRectAt } from '../compositor/pipMath'
import type { PipKeyframe, Session } from '../types'
import { projectFromSession } from './fromSession'
import type { Asset } from './project'
import { resolveFrame } from './resolve'
import type { MediaLayer } from './resolve'
import { validateProject } from './schema'
import { msToUs } from './time'

const base = {
  version: 1, id: '2026-08-18T14-32-05', createdAt: '2026-08-18T17:32:05.000Z', state: 'recording',
  source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1.640028', bitrate: 12e6 },
  systemAudio: false, tracks: { screen: 0 }, durationMs: 10_000, pauses: [], pip: [], strokes: [], clearEvents: [], markers: [],
  engine: 'webcodecs', files: { rec: 'rec.mp4' }
} as unknown as Session

const stroke = { tMs: 1000 } as unknown as Session['strokes'][number]
// h = w·16/9 em fração do quadro 16:9 → pixels quadrados (aspecto 1:1)
const sq = (w: number): number => w * (1920 / 1080)
const pip: PipKeyframe[] = [
  { tMs: 0, x: 0.75, y: 0.7, w: 0.2, h: sq(0.2), shape: 'circle', visible: true },
  { tMs: 4000, x: 0.05, y: 0.05, w: 0.3, h: sq(0.3), shape: 'circle', visible: true },
  { tMs: 7000, x: 0.5, y: 0.2, w: 0.25, h: sq(0.25), shape: 'circle', visible: false }
]
const full = {
  ...base,
  webcam: { deviceId: 'd', label: 'cam', width: 1280, height: 720, mirrored: true },
  mic: { deviceId: 'm', label: 'mic', echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  systemAudio: true, tracks: { screen: 0, webcam: 1, mic: 0, system: 1 },
  strokes: [stroke, stroke], pip, markers: [{ tMs: 2500 }, { tMs: 5000, label: 'Importante' }]
} as unknown as Session
const opts = { projectId: 'p1', name: 'Gravação', now: '2026-10-01T00:00:00.000Z' }

describe('projectFromSession', () => {
  it('sessão completa → 5 faixas na ordem, válido', () => {
    const p = projectFromSession(full, opts)
    expect(p.tracks.map((t) => t.name)).toEqual(['Tela', 'Webcam', 'Anotações', 'Microfone', 'Sistema'])
    expect(p.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'video', 'audio', 'audio'])
    expect(p.tracks[3].role).toBe('voice')
    expect(p.tracks[4].role).toBe('sfx')
    expect(validateProject(p)).toEqual([])
    expect(p.canvas).toMatchObject({ width: 1920, height: 1080, fps: 30 })
    expect(p.assets.map((a) => a.id)).toEqual(['p1-screen', 'p1-webcam', 'p1-mic', 'p1-system'])
    const link = p.tracks[0].items[0].linkId
    expect(link).toBeTruthy()
    expect(p.tracks[3].items[0].linkId).toBe(link)
    expect(p.tracks[4].items[0].linkId).toBe(link)
    expect(p.tracks[2].items[0]).toMatchObject({ type: 'annotations', sessionId: full.id, inUs: 0, startUs: 0, durationUs: 10_000_000 })
    expect(p.markers.map((m) => [m.label, m.tUs, m.color])).toEqual([['Marcador 1', 2_500_000, '#ff4d4f'], ['Importante', 5_000_000, '#ff4d4f']])
  })

  it('áudio da sessão: audioTrackIndex = índice a:N de session.tracks (rec.mp4 multi-faixa)', () => {
    const p = projectFromSession(full, opts)
    const byId = (id: string): Asset | undefined => p.assets.find((a) => a.id === id)
    expect(byId('p1-mic')?.audioTrackIndex).toBe(0)
    expect(byId('p1-system')?.audioTrackIndex).toBe(1)
    expect(byId('p1-screen')?.audioTrackIndex).toBeUndefined()
    expect(byId('p1-webcam')?.audioTrackIndex).toBeUndefined()
    const swapped = projectFromSession({ ...full, tracks: { screen: 0, system: 0, mic: 1 } } as Session, opts)
    expect(swapped.assets.find((a) => a.id === 'p1-mic')?.audioTrackIndex).toBe(1)
    expect(swapped.assets.find((a) => a.id === 'p1-system')?.audioTrackIndex).toBe(0)
  })

  it('vídeo da sessão: videoTrackIndex = índice v:N (tela 0, webcam session.tracks.webcam); áudio sem', () => {
    const p = projectFromSession(full, opts)
    const byId = (id: string): Asset | undefined => p.assets.find((a) => a.id === id)
    expect(byId('p1-screen')?.videoTrackIndex).toBe(0)
    expect(byId('p1-webcam')?.videoTrackIndex).toBe(1)
    expect(byId('p1-mic')?.videoTrackIndex).toBeUndefined()
    expect(byId('p1-system')?.videoTrackIndex).toBeUndefined()
  })

  it('anotações: autoFadeMs vem da opção (padrão null)', () => {
    expect(projectFromSession(full, opts).tracks[2].items[0]).toMatchObject({ type: 'annotations', autoFadeMs: null })
    expect(projectFromSession(full, { ...opts, annotationsAutoFadeMs: 4000 }).tracks[2].items[0]).toMatchObject({ type: 'annotations', autoFadeMs: 4000 })
  })

  it('webcam: keys em tMs e tMs+150 ms, shape, espelho e fit', () => {
    const p = projectFromSession(full, opts)
    const cam = p.tracks[1].items[0]
    if (cam.type !== 'media' || !cam.visual) throw new Error('esperado item de mídia visual')
    const v = cam.visual
    expect(v.shape).toBe('circle')
    expect(v.mirror).toBe(true)
    expect(v.fit).toBe('contain')
    const xs = v.transform.x.keys!.map((k) => k.tUs)
    expect(xs).toEqual([msToUs(4000), msToUs(4150), msToUs(7000), msToUs(7150)])
    expect(v.transform.opacity.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 1], [msToUs(7000), 0]])
  })

  it('só tela → 1 faixa de vídeo, nenhuma de áudio nem vazia', () => {
    const p = projectFromSession(base, opts)
    expect(p.tracks).toHaveLength(1)
    expect(p.tracks[0].kind).toBe('video')
    expect(p.tracks.every((t) => t.items.length > 0)).toBe(true)
    expect(validateProject(p)).toEqual([])
  })

  it('sem durationMs → lança', () => {
    expect(() => projectFromSession({ ...base, durationMs: undefined }, opts)).toThrow()
  })

  it('paridade com pipRectAt (30 instantes, incluindo bordas das rampas)', () => {
    const p = projectFromSession(full, opts)
    const W = p.canvas.width, H = p.canvas.height
    const asset = p.assets.find((a) => a.id === 'p1-webcam')!
    let seed = 12345
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    const ts = [4000, 4075, 4150, 7000, 7100, ...Array.from({ length: 25 }, () => rnd() * 9999)]
    for (const tMs of ts) {
      const layers = resolveFrame(p, msToUs(tMs))
      const cam = layers.find((l): l is MediaLayer => l.kind === 'media' && l.assetId === asset.id)!
      expect(cam).toBeTruthy()
      // Retângulo na tela: fonte cortada encaixada (contain) no quadro × scale, centrada em cx,cy.
      const cw = asset.video!.width * (1 - cam.crop.l - cam.crop.r)
      const ch = asset.video!.height * (1 - cam.crop.t - cam.crop.b)
      const f = Math.min(W / cw, H / ch)
      const w = (cw * f * cam.rect.scale) / W
      const h = (ch * f * cam.rect.scale) / H
      const exp = pipRectAt(pip, tMs)!
      const got = { x: cam.rect.cx - w / 2, y: cam.rect.cy - h / 2, w, h }
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(got[k] - exp[k])).toBeLessThan(0.005)
      expect(cam.opacity).toBe(exp.visible ? 1 : 0)
    }
  })

  it('PiP com aspecto diferente da fonte → crop centralizado', () => {
    const s = { ...full, pip: [{ tMs: 0, x: 0.1, y: 0.1, w: 0.1, h: sq(0.1), shape: 'rounded', visible: true }] } as Session
    const cam = projectFromSession(s, opts).tracks[1].items[0]
    if (cam.type !== 'media') throw new Error('esperado item de mídia')
    expect(cam.visual!.shape).toBe('rounded')
    // fonte 16:9 → alvo 1:1: corta a largura
    expect(cam.visual!.crop.l).toBeCloseTo((1 - 9 / 16) / 2)
    expect(cam.visual!.crop.t).toBe(0)
  })
})
