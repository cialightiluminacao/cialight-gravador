import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CursorRecorder, writeCursorTrack, type CursorRecorderDeps } from './cursorRecorder'
import { ButtonEdges } from './buttonEdges'
import { parseCursorTrack, type CursorButton, type CursorTrackV1 } from '@shared/cursor'
import { SessionStore } from '../session/sessionStore'
import { DEFAULT_PIP } from '@shared/defaults'
import type { RecordingConfig } from '@shared/types'

// Relógio, ponto, quadro e cliques injetados; o timer é manual (tick() chamado pelo teste).
function harness(over: Partial<CursorRecorderDeps> = {}) {
  const env = {
    wall: 1000,
    point: { x: 960, y: 540 } as { x: number; y: number } | null,
    frame: { x: 0, y: 0, width: 1920, height: 1080 } as { x: number; y: number; width: number; height: number } | null,
    pending: [] as CursorButton[],
    timers: 0
  }
  const deps: CursorRecorderDeps = {
    now: () => env.wall,
    readPoint: () => env.point,
    readFrame: () => env.frame,
    pollClicks: () => env.pending.splice(0),
    setInterval: () => {
      env.timers++
      return env.timers
    },
    clearInterval: () => {
      env.timers--
    },
    ...over
  }
  const rec = new CursorRecorder(deps, { width: 1920, height: 1080 })
  const step = (ms: number, p?: { x: number; y: number }): void => {
    env.wall += ms
    if (p) env.point = p
    rec.tick()
  }
  return { env, rec, step }
}

describe('CursorRecorder', () => {
  it('amostra com tMs de mídia inteiro e normaliza ao quadro', () => {
    const { rec, step } = harness()
    rec.begin()
    step(16.4, { x: 480, y: 270 })
    step(16.4, { x: 1920, y: 1080 })
    const t = rec.stop()
    expect(t.version).toBe(1)
    expect(t.width).toBe(1920)
    expect(t.height).toBe(1080)
    expect(t.samples).toEqual([
      { tMs: 0, x: 0.5, y: 0.5 },
      { tMs: 16, x: 0.25, y: 0.25 },
      { tMs: 33, x: 1, y: 1 }
    ])
    expect(parseCursorTrack(t)).toEqual(t)
  })

  it('pontos repetidos: guarda o primeiro e o último de cada trecho parado', () => {
    const { rec, step } = harness()
    rec.begin() // (960,540) em 0
    step(16) // igual
    step(16) // igual
    step(16, { x: 100, y: 100 }) // muda em 48
    step(16) // igual
    step(16, { x: 200, y: 100 }) // muda em 80
    step(16) // igual (fica como último do trecho parado na parada)
    const t = rec.stop()
    expect(t.samples.map((s) => s.tMs)).toEqual([0, 32, 48, 64, 80, 96])
    expect(t.samples[1]).toEqual({ tMs: 32, x: 0.5, y: 0.5 })
  })

  it('cursor parado a gravação toda: primeira e última amostras preservam a duração', () => {
    const { rec, step } = harness()
    rec.begin()
    for (let i = 0; i < 100; i++) step(16)
    const t = rec.stop()
    expect(t.samples).toEqual([
      { tMs: 0, x: 0.5, y: 0.5 },
      { tMs: 1600, x: 0.5, y: 0.5 }
    ])
  })

  it('tMs estritamente crescente mesmo com ticks no mesmo ms', () => {
    const { rec, step } = harness()
    rec.begin()
    step(0.2, { x: 1, y: 1 })
    step(0.2, { x: 2, y: 2 })
    step(1, { x: 3, y: 3 })
    step(0.4, { x: 4, y: 4 })
    const t = rec.stop()
    for (let i = 1; i < t.samples.length; i++) expect(t.samples[i].tMs).toBeGreaterThan(t.samples[i - 1].tMs)
    for (const s of t.samples) expect(Number.isInteger(s.tMs)).toBe(true)
  })

  it('pausa: sem amostras nem cliques durante a pausa e o tempo de mídia continua de onde parou', () => {
    const { env, rec, step } = harness()
    rec.begin()
    step(100, { x: 100, y: 100 }) // t=100
    rec.pause() // pausa em 100 (parede 1100)
    expect(env.timers).toBe(0) // timer parado durante a pausa
    env.wall += 2000
    env.point = { x: 1500, y: 900 }
    rec.tick() // tick atrasado: ignorado
    env.pending.push('left')
    rec.addClick('right', { x: 10, y: 10 })
    rec.resume() // retoma (parede 3100): cliques pendentes durante a pausa são descartados
    expect(env.timers).toBe(1)
    step(50, { x: 200, y: 200 }) // t=150
    const t = rec.stop()
    expect(t.samples.map((s) => s.tMs)).toEqual([0, 100, 150])
    expect(t.samples.some((s) => s.x === 1500 / 1920)).toBe(false)
    expect(t.clicks).toEqual([])
  })

  it('cliques: carimbados com o tempo de mídia, normalizados; fora do quadro descartados', () => {
    const { env, rec, step } = harness()
    rec.begin()
    step(40, { x: 192, y: 108 })
    env.pending.push('left') // fonte nativa: pressionado desde a última leitura → ponto atual
    step(10)
    rec.addClick('middle', { x: 1920 * 0.75, y: 1080 * 0.25 }) // injetado com ponto próprio, em t=50
    rec.addClick('right', { x: -5, y: 10 }) // fora do quadro → descartado
    rec.addClick('left', { x: 2000, y: 10 }) // fora do quadro → descartado
    const t = rec.stop()
    expect(t.clicks).toEqual([
      { tMs: 50, x: 0.1, y: 0.1, button: 'left' },
      { tMs: 50, x: 0.75, y: 0.25, button: 'middle' }
    ])
  })

  it('modo janela: o quadro amostrado se move e cada ponto usa os limites do instante', () => {
    const { env, rec, step } = harness()
    env.frame = { x: 100, y: 100, width: 800, height: 600 }
    env.point = { x: 500, y: 400 }
    rec.begin() // centro da janela
    env.frame = { x: 300, y: 100, width: 800, height: 600 } // janela arrastada 200 px
    step(16, { x: 700, y: 400 }) // ainda no centro
    env.frame = { x: 300, y: 100, width: 400, height: 300 } // janela redimensionada
    step(16, { x: 300, y: 100 }) // canto superior esquerdo
    rec.addClick('left', { x: 1000, y: 100 }) // fora da janela (mesmo dentro da tela) → descartado
    rec.addClick('left', { x: 500, y: 250 }) // centro
    const t = rec.stop()
    expect(t.samples).toEqual([
      { tMs: 0, x: 0.5, y: 0.5 },
      { tMs: 16, x: 0.5, y: 0.5 },
      { tMs: 32, x: 0, y: 0 }
    ])
    expect(t.clicks).toEqual([{ tMs: 32, x: 0.5, y: 0.5, button: 'left' }])
  })

  it('sem ponto ou sem quadro no instante: pula a amostra', () => {
    const { env, rec, step } = harness()
    rec.begin()
    env.frame = null
    step(16, { x: 1, y: 1 })
    env.frame = { x: 0, y: 0, width: 1920, height: 1080 }
    env.point = null
    step(16)
    env.point = { x: 0, y: 0 }
    step(16)
    expect(rec.stop().samples.map((s) => s.tMs)).toEqual([0, 48])
  })

  it('fonte de cliques que lança não derruba a amostragem (falha isolada)', () => {
    let calls = 0
    const { rec, step } = harness({
      pollClicks: () => {
        calls++
        throw new Error('nativo caiu')
      }
    })
    rec.begin()
    step(16, { x: 1, y: 1 })
    step(16, { x: 2, y: 2 })
    const t = rec.stop()
    expect(t.samples.length).toBe(3)
    expect(calls).toBe(1) // depois da primeira falha a fonte de cliques é desligada
  })

  it('erro ao ler o ponto dentro do timer não escapa (o main não pode cair); avisa uma vez', () => {
    let timerFn: (() => void) | null = null
    const errors: unknown[] = []
    let fail = false
    const { env, rec } = harness({
      readPoint: () => {
        if (fail) throw new Error('getCursorScreenPoint falhou')
        return env.point
      },
      setInterval: (fn) => {
        timerFn = fn
        return 1
      },
      onTickError: (e) => errors.push(e)
    })
    rec.begin()
    fail = true
    expect(() => timerFn!()).not.toThrow()
    expect(() => timerFn!()).not.toThrow()
    expect(errors.length).toBe(1)
    fail = false
    env.wall += 16
    env.point = { x: 5, y: 5 }
    timerFn!()
    expect(rec.stop().samples.length).toBe(2)
  })

  it('stop é idempotente e para o timer', () => {
    const { env, rec, step } = harness()
    rec.begin()
    step(16, { x: 3, y: 3 })
    const a = rec.stop()
    expect(env.timers).toBe(0)
    const b = rec.stop()
    expect(b).toEqual(a)
    rec.tick()
    expect(rec.stop().samples.length).toBe(a.samples.length)
  })
})

describe('writeCursorTrack', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cl-cursor-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const track: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples: [{ tMs: 0, x: 0.5, y: 0.5 }], clicks: [] }

  it('escreve atomicamente (tmp + rename) ao lado do session.json', () => {
    writeFileSync(join(dir, 'session.json'), '{}')
    writeFileSync(join(dir, 'cursor.json'), 'velho')
    expect(writeCursorTrack(dir, track)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'))).toEqual(track)
    expect(readdirSync(dir).sort()).toEqual(['cursor.json', 'session.json'])
  })

  it('pasta sem session.json (gravação descartada/apagada): não escreve nem recria a pasta', () => {
    expect(writeCursorTrack(dir, track)).toBe(false)
    expect(existsSync(join(dir, 'cursor.json'))).toBe(false)
    const gone = join(dir, 'apagada')
    expect(writeCursorTrack(gone, track)).toBe(false)
    expect(existsSync(gone)).toBe(false)
  })
})

describe('cursor.json e a limpeza das sessões', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('apagar/descartar a sessão leva o cursor.json junto e nunca deixa pasta órfã', async () => {
    root = mkdtempSync(join(tmpdir(), 'cl-cursor-sess-'))
    const store = new SessionStore({ rawRoot: () => root, trash: async (p) => rmSync(p, { recursive: true, force: true }) })
    const extra = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, video: { width: 1920, height: 1080, fps: 30, codec: '', bitrate: 0 } }
    const config: RecordingConfig = { source: { kind: 'screen', id: 'screen:0:0', name: 'M', displayId: '1' }, quality: '1080p', fps: 30, countdownSec: 0, webcam: null, mic: null, systemAudio: false, pipInitial: DEFAULT_PIP }
    store.create(config, 's1', extra)
    const track: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples: [{ tMs: 0, x: 0.5, y: 0.5 }], clicks: [] }
    expect(writeCursorTrack(store.dirOf('s1'), track)).toBe(true)
    expect(store.list().map((s) => s.id)).toEqual(['s1'])
    await store.delete('s1')
    expect(existsSync(store.dirOf('s1'))).toBe(false)
    // parada atrasada depois do descarte: não recria a pasta só com o cursor.json
    expect(writeCursorTrack(store.dirOf('s1'), track)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })
})

describe('ButtonEdges (GetAsyncKeyState)', () => {
  const DOWN = 0x8000 | 0
  const PRESSED_SINCE = 0x0001
  const up = { left: 0, right: 0, middle: 0 }

  it('borda de descida vira um clique; segurar não repete', () => {
    const e = new ButtonEdges()
    expect(e.update(up, false)).toEqual([])
    expect(e.update({ ...up, left: DOWN | PRESSED_SINCE }, false)).toEqual(['left'])
    expect(e.update({ ...up, left: DOWN }, false)).toEqual([])
    expect(e.update(up, false)).toEqual([])
  })

  it('clique mais curto que o tick: só o bit "pressionado desde a última leitura" o revela', () => {
    const e = new ButtonEdges()
    e.update(up, false)
    expect(e.update({ ...up, right: PRESSED_SINCE }, false)).toEqual(['right'])
  })

  it('valor negativo do short (bit alto) conta como pressionado', () => {
    const e = new ButtonEdges()
    e.update(up, false)
    expect(e.update({ ...up, middle: -32768 }, false)).toEqual(['middle'])
  })

  it('botões trocados (canhoto): físico esquerdo = lógico direito', () => {
    const e = new ButtonEdges()
    e.update(up, true)
    expect(e.update({ ...up, left: DOWN }, true)).toEqual(['right'])
  })
})
