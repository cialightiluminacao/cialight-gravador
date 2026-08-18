import { describe, expect, it } from 'vitest'
import type { PipKeyframe, Session, Stroke } from '../types'
import { drawFrame, type Canvas2DLike } from './drawFrame'

interface Call {
  name: string
  args: unknown[]
}

/** Contexto 2D falso: grava chamadas de método e atribuições de propriedade (set:<prop>). */
function fakeCtx(withRoundRect = true): { ctx: Canvas2DLike; calls: Call[]; names: () => string[] } {
  const calls: Call[] = []
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
    }
  const target: Record<string, unknown> = {
    save: rec('save'),
    restore: rec('restore'),
    drawImage: rec('drawImage'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    rect: rec('rect'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arcTo: rec('arcTo'),
    clip: rec('clip'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    translate: rec('translate'),
    scale: rec('scale'),
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0
  }
  if (withRoundRect) target.roundRect = rec('roundRect')
  const ctx = new Proxy(target, {
    set(obj, prop, value) {
      calls.push({ name: `set:${String(prop)}`, args: [value] })
      obj[prop as string] = value
      return true
    }
  }) as unknown as Canvas2DLike
  return { ctx, calls, names: () => calls.map((c) => c.name) }
}

const screen = { videoWidth: 1920, videoHeight: 1080 } as unknown as object
const cam = { videoWidth: 1280, videoHeight: 720 } as unknown as object

const pipKf: PipKeyframe = { tMs: 0, x: 0.75, y: 0.6, w: 0.2, h: 0.3, shape: 'circle', visible: true }

const strokeA: Stroke = {
  id: 'a',
  tMs: 100,
  tool: 'pen',
  points: [
    { x: 0.1, y: 0.1, tMs: 100 },
    { x: 0.2, y: 0.2, tMs: 150 }
  ],
  color: '#ff3b30',
  width: 6
}

const arrow: Stroke = {
  id: 'b',
  tMs: 100,
  tool: 'arrow',
  points: [
    { x: 0.1, y: 0.5, tMs: 100 },
    { x: 0.5, y: 0.5, tMs: 200 }
  ],
  color: '#00ff00',
  width: 4
}

const session: Pick<Session, 'pip' | 'strokes' | 'clearEvents'> = { pip: [pipKf], strokes: [strokeA], clearEvents: [] }

const optsAll = { includeWebcam: true, includeAnnotations: true, autoFadeMs: null }

/** Índice da primeira ocorrência de `name` a partir de `from` (-1 se não houver). */
const idxAfter = (names: string[], name: string, from = 0): number => {
  const i = names.slice(from).indexOf(name)
  return i < 0 ? -1 : i + from
}

describe('drawFrame', () => {
  it('desenha a tela em (0,0,W,H) primeiro', () => {
    const { ctx, calls } = fakeCtx()
    drawFrame(ctx, 1920, 1080, { screen, cam }, session, 1000, optsAll)
    const first = calls.find((c) => c.name === 'drawImage')!
    expect(calls.indexOf(first)).toBe(0)
    expect(first.args).toEqual([screen, 0, 0, 1920, 1080])
  })

  it('ordem: tela → PiP (save, clip, drawImage, restore) → traços', () => {
    const { ctx, calls, names } = fakeCtx()
    drawFrame(ctx, 1920, 1080, { screen, cam }, session, 1000, optsAll)
    const n = names()
    const iScreen = 0
    const iSave = idxAfter(n, 'save', iScreen + 1)
    const iClip = idxAfter(n, 'clip', iSave)
    const iCam = idxAfter(n, 'drawImage', iClip)
    const iRestore = idxAfter(n, 'restore', iCam)
    const iStroke = idxAfter(n, 'stroke', iRestore)
    expect(iSave).toBeGreaterThan(iScreen)
    expect(iClip).toBeGreaterThan(iSave)
    expect(iCam).toBeGreaterThan(iClip)
    expect(iRestore).toBeGreaterThan(iCam)
    expect(iStroke).toBeGreaterThan(iRestore)
    // o drawImage da webcam usa a fonte cam
    expect(calls[iCam].args[0]).toBe(cam)
    // círculo → arc; sem roundRect
    expect(n).toContain('arc')
    expect(n).not.toContain('roundRect')
    // save/restore balanceados
    expect(n.filter((x) => x === 'save').length).toBe(n.filter((x) => x === 'restore').length)
  })

  it('PiP círculo: arc centralizado no quadrado com raio = lado/2 e webcam em modo cover (crop horizontal 16:9 → 1:1)', () => {
    const { ctx, calls } = fakeCtx()
    drawFrame(ctx, 1000, 1000, { screen, cam }, session, 1000, optsAll)
    // rect px = (750, 600, 200, 300) → lado 200, centro (850, 750)
    const arc = calls.find((c) => c.name === 'arc')!
    expect(arc.args.slice(0, 3)).toEqual([850, 750, 100])
    const camDraw = calls.filter((c) => c.name === 'drawImage')[1]
    // cover: fonte 1280x720 em destino 200x200 → recorta largura 720, sx = 280
    expect(camDraw.args).toEqual([cam, 280, 0, 720, 720, 750, 650, 200, 200])
  })

  it('cover com fonte mais alta que o destino recorta verticalmente', () => {
    const { ctx, calls } = fakeCtx()
    const tallCam = { displayWidth: 720, displayHeight: 1280 } as unknown as object
    const s = { ...session, pip: [{ ...pipKf, shape: 'rounded' as const, x: 0, y: 0, w: 0.4, h: 0.2 }] }
    drawFrame(ctx, 1000, 1000, { screen, cam: tallCam }, s, 1000, optsAll)
    const camDraw = calls.filter((c) => c.name === 'drawImage')[1]
    // destino 400x200 (2:1); fonte 720x1280 → altura recortada 360, sy = 460
    expect(camDraw.args).toEqual([tallCam, 0, 460, 720, 360, 0, 0, 400, 200])
  })

  it('PiP rounded usa roundRect com raio 6 % do menor lado', () => {
    const { ctx, calls } = fakeCtx()
    const s = { ...session, pip: [{ ...pipKf, shape: 'rounded' as const }] }
    drawFrame(ctx, 1000, 1000, { screen, cam }, s, 1000, optsAll)
    const rr = calls.find((c) => c.name === 'roundRect')!
    expect(rr.args.slice(0, 4)).toEqual([750, 600, 200, 300])
    expect(rr.args[4]).toBeCloseTo(12)
  })

  it('sem ctx.roundRect faz o path manualmente (arcTo)', () => {
    const { ctx, names } = fakeCtx(false)
    const s = { ...session, pip: [{ ...pipKf, shape: 'rounded' as const }] }
    drawFrame(ctx, 1000, 1000, { screen, cam }, s, 1000, optsAll)
    expect(names()).toContain('arcTo')
    expect(names().filter((n) => n === 'drawImage')).toHaveLength(2)
  })

  it('camMirrored aplica translate + scale(-1,1) antes do drawImage da webcam', () => {
    const { ctx, calls, names } = fakeCtx()
    drawFrame(ctx, 1000, 1000, { screen, cam, camMirrored: true }, session, 1000, optsAll)
    const n = names()
    const iScale = n.indexOf('scale')
    const iCam = n.lastIndexOf('drawImage')
    expect(iScale).toBeGreaterThan(-1)
    expect(iScale).toBeLessThan(iCam)
    expect(calls[iScale].args).toEqual([-1, 1])
    const tr = calls[n.indexOf('translate')]
    // translate(2x + w, 0) → espelha em torno do centro do PiP (x=750, w=200)
    expect(tr.args).toEqual([1700, 0])
  })

  it('sem camMirrored não aplica scale', () => {
    const { ctx, names } = fakeCtx()
    drawFrame(ctx, 1000, 1000, { screen, cam }, session, 1000, optsAll)
    expect(names()).not.toContain('scale')
  })

  it('includeWebcam=false não desenha PiP', () => {
    const { ctx, names } = fakeCtx()
    drawFrame(ctx, 1920, 1080, { screen, cam }, session, 1000, { ...optsAll, includeWebcam: false })
    expect(names().filter((n) => n === 'drawImage')).toHaveLength(1)
    expect(names()).not.toContain('clip')
  })

  it('sem fonte de webcam não desenha PiP', () => {
    const { ctx, names } = fakeCtx()
    drawFrame(ctx, 1920, 1080, { screen, cam: null }, session, 1000, optsAll)
    expect(names().filter((n) => n === 'drawImage')).toHaveLength(1)
  })

  it('PiP invisível (visible=false) não é desenhado', () => {
    const { ctx, names } = fakeCtx()
    const s = { ...session, pip: [{ ...pipKf, visible: false }] }
    drawFrame(ctx, 1920, 1080, { screen, cam }, s, 1000, optsAll)
    expect(names().filter((n) => n === 'drawImage')).toHaveLength(1)
  })

  it('pipOverride substitui os keyframes da sessão', () => {
    const { ctx, calls } = fakeCtx()
    const override: PipKeyframe[] = [{ tMs: 0, x: 0, y: 0, w: 0.2, h: 0.2, shape: 'circle', visible: true }]
    drawFrame(ctx, 1000, 1000, { screen, cam }, session, 1000, { ...optsAll, pipOverride: override })
    const arc = calls.find((c) => c.name === 'arc')!
    expect(arc.args.slice(0, 3)).toEqual([100, 100, 100])
  })

  it('pipOverride vazio → sem PiP', () => {
    const { ctx, names } = fakeCtx()
    drawFrame(ctx, 1000, 1000, { screen, cam }, session, 1000, { ...optsAll, pipOverride: [] })
    expect(names().filter((n) => n === 'drawImage')).toHaveLength(1)
  })

  it('traços: largura relativa a W/1920, lineCap/lineJoin round, cor e coordenadas em pixels', () => {
    const { ctx, calls } = fakeCtx()
    drawFrame(ctx, 960, 540, { screen, cam: null }, session, 1000, optsAll)
    const lw = calls.find((c) => c.name === 'set:lineWidth')!
    expect(lw.args[0]).toBeCloseTo(3)
    expect(calls.find((c) => c.name === 'set:lineCap')!.args[0]).toBe('round')
    expect(calls.find((c) => c.name === 'set:lineJoin')!.args[0]).toBe('round')
    expect(calls.find((c) => c.name === 'set:strokeStyle')!.args[0]).toBe('#ff3b30')
    const mv = calls.find((c) => c.name === 'moveTo')!
    expect(mv.args[0]).toBeCloseTo(96)
    expect(mv.args[1]).toBeCloseTo(54)
    const lt = calls.find((c) => c.name === 'lineTo')!
    expect(lt.args[0]).toBeCloseTo(192)
    expect(lt.args[1]).toBeCloseTo(108)
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1)
  })

  it('includeAnnotations=false não desenha traços', () => {
    const { ctx, names } = fakeCtx()
    drawFrame(ctx, 1920, 1080, { screen, cam: null }, session, 1000, { ...optsAll, includeAnnotations: false })
    expect(names()).not.toContain('stroke')
  })

  it('desenho progressivo: em t=120 só o primeiro ponto (ponto único vira um pingo)', () => {
    const { ctx, calls } = fakeCtx()
    drawFrame(ctx, 1920, 1080, { screen, cam: null }, session, 120, optsAll)
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1)
    expect(calls.filter((c) => c.name === 'lineTo')).toHaveLength(1)
  })

  it('seta: linha + cabeça triangular preenchida (comprimento 4×largura, ângulo 28°)', () => {
    const { ctx, calls } = fakeCtx()
    const s = { ...session, strokes: [arrow] }
    drawFrame(ctx, 1920, 1080, { screen, cam: null }, s, 1000, optsAll)
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1)
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(1)
    expect(calls.find((c) => c.name === 'set:fillStyle')!.args[0]).toBe('#00ff00')
    // cabeça: 3 vértices — ponta em (960, 540), base a 16 px atrás com abertura de 28°
    const iFill = calls.findIndex((c) => c.name === 'fill')
    const head = calls
      .slice(0, iFill)
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .slice(-3)
    const tip = head[0].args as number[]
    expect(tip[0]).toBeCloseTo(960)
    expect(tip[1]).toBeCloseTo(540)
    const L = 4 * 4
    const dx = L * Math.cos((28 * Math.PI) / 180)
    const dy = L * Math.sin((28 * Math.PI) / 180)
    const b1 = head[1].args as number[]
    const b2 = head[2].args as number[]
    expect(b1[0]).toBeCloseTo(960 - dx)
    expect(b2[0]).toBeCloseTo(960 - dx)
    expect(Math.abs(b1[1] - 540)).toBeCloseTo(dy)
    expect(Math.abs(b2[1] - 540)).toBeCloseTo(dy)
    expect(Math.sign(b1[1] - 540)).toBe(-Math.sign(b2[1] - 540))
  })

  it('alpha do fade vai para globalAlpha', () => {
    const { ctx, calls } = fakeCtx()
    // autoFade 1000 a partir do último ponto (150): fade de 650 a 1150; em t=900 alpha=0.5
    drawFrame(ctx, 1920, 1080, { screen, cam: null }, session, 900, { ...optsAll, autoFadeMs: 1000 })
    const ga = calls.find((c) => c.name === 'set:globalAlpha')!
    expect(ga.args[0]).toBeCloseTo(0.5)
  })

  it('traços apagados por clear não são desenhados', () => {
    const { ctx, names } = fakeCtx()
    const s = { ...session, clearEvents: [{ tMs: 500 }] }
    drawFrame(ctx, 1920, 1080, { screen, cam: null }, s, 1000, optsAll)
    expect(names()).not.toContain('stroke')
  })
})
