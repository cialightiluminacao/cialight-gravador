import { createEffectItem, createMediaItem } from '@shared/editor/factory'
import { attachEffects } from '@shared/editor/followTransform'
import type { Asset, EffectItem, MediaItem, Project, Track, TransitionKind } from '@shared/editor/project'
import { resolveFrame } from '@shared/editor/resolve'
import { frameToUs } from '@shared/editor/time'
import {
  SAMPLE_GRID,
  TRANSITION_KINDS,
  boundaryDist,
  paritySample,
  transitionPixel,
  type Rgb,
  type TransitionBench,
  type TransitionKindReport,
  type TransitionPrivacyRun,
  type TransitionReport,
  type TransitionShot
} from '@shared/testing/transitionOracle'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'
import { rendererName } from './effectsHarness'

// Transições (F5 Task 3) no motor real (CIALIGHT_TEST=editor-render). Projeto p-editor-transition-test (criado pelo
// main): A = vermelho puro, B = azul puro, e as mesmas cores com um quadrado BRANCO 400×300 em (760, 390) — 2 s cada,
// 1920×1080@30. As cenas são montadas aqui em memória: A [0, 2 s) → B [2 s, 4 s) na faixa t_v, transição de 1 s
// (janela [1,5 s, 2,5 s)). Medidas: cor do modelo (transitionOracle) por tipo nos instantes lineares 0,25/0,5/0,75 e
// cor pura antes/depois da janela; privacidade (tarja vinculada a A ou ancorada em B: nenhum branco em nenhum quadro da
// janela); efeito `track` sobre a faixa em transição; desfoque real no 'blur'; paridade com a exportação (o main lê os
// quadros com o ffmpeg) e desempenho (testBench).

export const TRANSITION_PROJECT_ID = 'p-editor-transition-test'
const W = 1920
const H = 1080
const FPS = 30
const S = 1_000_000
const CUT = 2 * S
const D = 1 * S
const WIN_START = CUT - D / 2
/** Primeiro e último quadro (30 fps) da janela [1,5 s, 2,5 s). */
const WIN_FRAMES = { first: Math.round((WIN_START * FPS) / S), last: Math.round(((WIN_START + D) * FPS) / S) - 1 }
const LINEAR = [0.25, 0.5, 0.75]
/** Quadrado branco das fontes "com quadrado" (px) e a tarja que o cobre (+20 px de cada lado). */
const BOX = { x: 760, y: 390, w: 400, h: 300 }
const TARJA = { x: (BOX.x + BOX.w / 2) / W, y: (BOX.y + BOX.h / 2) / H, w: (BOX.w + 40) / W, h: (BOX.h + 40) / H }
/** Pontos a menos disso (fração do quadro) de uma borda entre cores ficam fora da comparação (cortina: 0,5 % suave). */
const EDGE_MARGIN = 0.012
/** Quadros da timeline comparados com a exportação ([1 s, 3 s) exportado): ~ linear 0,25/0,5/0,75. */
export const PARITY_FRAMES = [53, 60, 67]
export const PARITY_FROM_US = 1 * S
const PARITY_TO_US = 3 * S

type Assets = { red: Asset; blue: Asset; redBox: Asset; blueBox: Asset }

function assetsOf(p: Project): Assets {
  const by = (id: string): Asset => {
    const a = p.assets.find((x) => x.id === id)
    if (!a) throw new Error(`asset ${id} ausente no projeto de transições`)
    return a
  }
  return { red: by('a_tr_red'), blue: by('a_tr_blue'), redBox: by('a_tr_redbox'), blueBox: by('a_tr_bluebox') }
}

const vtrack = (id: string, items: Track['items']): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items })

interface SceneOpts { a: Asset; b: Asset; fx?: EffectItem[]; linkA?: boolean }

/** A [0, 2 s) → B [2 s, 4 s) com a transição `kind` de 1 s; efeitos numa faixa acima. */
function scene(base: Project, kind: TransitionKind, o: SceneOpts): Project {
  const A: MediaItem = { ...createMediaItem(o.a, 0, 'video'), id: 'i_a', durationUs: CUT, inUs: 0, ...(o.linkA ? { linkId: 'l_a' } : {}) }
  const B: MediaItem = { ...createMediaItem(o.b, CUT, 'video'), id: 'i_b', durationUs: CUT, inUs: 0, transitionIn: { kind, durationUs: D } }
  const tracks = [vtrack('t_v', [A, B])]
  if (o.fx?.length) tracks.push(vtrack('t_fx', o.fx))
  return { ...base, tracks }
}

/** Tarja preta sólida (feather 0) sobre o quadrado branco, em [startUs, startUs + dur). */
function tarja(id: string, startUs: number, durationUs: number, over: Partial<EffectItem> = {}): EffectItem {
  return { ...createEffectItem('solid', startUs, durationUs, TARJA), id, color: '#000000', ...over }
}

async function frame(client: RenderClient, tUs: number): Promise<Uint8Array> {
  const r = await client.requestFrame(tUs, false)
  if (r.t !== 'rendered') throw new Error(`quadro em ${tUs}: ${JSON.stringify(r)}`)
  return client.readPixels(0, 0, W, H)
}

const rgbAt = (d: Uint8Array, x: number, y: number): Rgb => {
  const i = (y * W + x) * 4
  return [d[i], d[i + 1], d[i + 2]]
}

/** Progresso (suavizado e linear) da transição da faixa t_v em tUs (null fora da janela). */
function progressAt(p: Project, tUs: number): { p: number; linear: number } | null {
  const t = resolveFrame(p, tUs).find((l) => l.kind === 'transition')
  return t?.kind === 'transition' ? { p: t.progress, linear: t.linear } : null
}

/** Compara a grade 10×10 do quadro com `want(u, v)`; pontos perto de borda (boundaryDist) ficam de fora. */
function shot(d: Uint8Array, tUs: number, linear: number, p: number, want: (u: number, v: number) => Rgb, skip: (u: number, v: number) => boolean): TransitionShot {
  let n = 0
  let maxErr = 0
  let worst: TransitionShot['worst'] = null
  for (const [u, v] of SAMPLE_GRID) {
    if (skip(u, v)) continue
    const got = rgbAt(d, Math.floor(u * W), Math.floor(v * H))
    const w = want(u, v).map((c) => Math.round(c)) as Rgb
    const err = Math.max(...got.map((c, i) => Math.abs(c - w[i])))
    n++
    if (err > maxErr || !worst) {
      maxErr = err
      worst = { u, v, got, want: w }
    }
  }
  return { tUs, linear, p: Math.round(p * 1e4) / 1e4, n, maxErr, worst }
}

const whiteCount = (d: Uint8Array): number => {
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++
  return n
}

function benchStats(xs: number[]): TransitionBench {
  const s = [...xs].sort((a, b) => a - b)
  const r = (v: number): number => Math.round(v * 100) / 100
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0
  return { mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), median: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? 0), n: s.length }
}

export async function transitionCheck(outDir: string | null): Promise<TransitionReport> {
  const report: TransitionReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    report.renderer = rendererName()
    const base = await window.api.project.load(TRANSITION_PROJECT_ID)
    const src = assetsOf(base)
    const urls = mediaUrlsFor(base, 'preview')
    const use = (p: Project): void => client.setProject(p, urls, true)

    // cores reais das fontes (decodificadas): o modelo usa estas
    const plain = (kind: TransitionKind): Project => scene(base, kind, { a: src.red, b: src.blue })
    use(plain('crossfade'))
    const A = rgbAt(await frame(client, 1 * S), W / 2, H / 2)
    const B = rgbAt(await frame(client, 3 * S), W / 2, H / 2)
    report.colors = { A, B }

    // 1. os 11 tipos: modelo nos instantes 0,25/0,5/0,75; cor pura no último quadro antes e no primeiro depois da janela
    const kinds: TransitionKindReport[] = []
    for (const kind of TRANSITION_KINDS) {
      const p = plain(kind)
      use(p)
      const none = (): boolean => false
      const beforeUs = frameToUs(WIN_FRAMES.first - 1, FPS)
      const afterUs = WIN_START + D
      const before = shot(await frame(client, beforeUs), beforeUs, 0, 0, () => A, none)
      const after = shot(await frame(client, afterUs), afterUs, 1, 1, () => B, none)
      if (progressAt(p, beforeUs) || progressAt(p, afterUs)) throw new Error(`${kind}: transição fora da janela`)
      const inside: TransitionShot[] = []
      for (const lin of LINEAR) {
        const tUs = WIN_START + Math.round(lin * D)
        const pr = progressAt(p, tUs)
        if (!pr) throw new Error(`${kind}: sem transição em ${tUs}`)
        inside.push(shot(await frame(client, tUs), tUs, pr.linear, pr.p, (u, v) => transitionPixel(kind, pr.p, u, v, A, B), (u, v) => boundaryDist(kind, pr.p, u, v) < EDGE_MARGIN))
      }
      kinds.push({ kind, before, after, inside })
    }
    report.kinds = kinds

    // emenda do deslizar: a coluna onde A e B se encontram é a média das duas, sem deixar ver o fundo (preto) abaixo
    {
      const p = plain('slideL')
      use(p)
      let minSum = Infinity
      for (const lin of LINEAR) {
        const tUs = WIN_START + Math.round(lin * D)
        const pr = progressAt(p, tUs)!
        const d = await frame(client, tUs)
        const edge = Math.round((1 - pr.p) * W)
        for (let x = Math.max(0, edge - 8); x < Math.min(W, edge + 8); x++) minSum = Math.min(minSum, rgbAt(d, x, H / 2).reduce((s0, c) => s0 + c, 0))
      }
      const sum = (c: Rgb): number => c[0] + c[1] + c[2]
      report.slideSeam = { minSum, colorSums: [sum(A), sum(B)] }
    }

    // 2. privacidade: quadrado branco coberto por tarja vinculada a A (termina no corte) ou ancorada em B (começa no
    // corte); TODOS os quadros da janela, sem nenhum branco visível. Controle: sem a tarja o branco aparece.
    const privacy: TransitionPrivacyRun[] = []
    for (const kind of ['slideL', 'zoomIn', 'crossfade', 'blur'] as const) {
      for (const side of ['A', 'B'] as const) {
        const withFx = side === 'A'
          ? scene(base, kind, { a: src.redBox, b: src.blue, linkA: true, fx: [tarja('i_tarja', 0, CUT, { linkId: 'l_a' })] })
          : attachEffects(scene(base, kind, { a: src.red, b: src.blueBox, fx: [tarja('i_tarja', CUT, CUT)] }), 'i_b', ['i_tarja'])
        const control = side === 'A' ? scene(base, kind, { a: src.redBox, b: src.blue }) : scene(base, kind, { a: src.red, b: src.blueBox })
        let whiteMax = 0, whiteFrames = 0, frames = 0
        use(withFx)
        for (let n = WIN_FRAMES.first; n <= WIN_FRAMES.last; n++) {
          const w = whiteCount(await frame(client, frameToUs(n, FPS)))
          frames++
          whiteMax = Math.max(whiteMax, w)
          if (w > 0) whiteFrames++
        }
        let controlWhiteMax = 0
        use(control)
        for (let n = WIN_FRAMES.first; n <= WIN_FRAMES.last; n += 5) controlWhiteMax = Math.max(controlWhiteMax, whiteCount(await frame(client, frameToUs(n, FPS))))
        privacy.push({ kind, side, frames, whiteMax, whiteFrames, controlWhiteMax })
      }
    }
    report.privacy = privacy

    // 3. efeito `track` (tarja #123456 no centro, sem vínculo) sobre a faixa em transição: cobre a composição
    const trackFx: EffectItem = { ...createEffectItem('solid', 0, 2 * CUT, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }), id: 'i_track', color: '#123456', scope: 'track', targetTrackId: 't_v' }
    use(scene(base, 'slideL', { a: src.red, b: src.blue, fx: [trackFx] }))
    const centers: Rgb[] = []
    for (const lin of LINEAR) centers.push(rgbAt(await frame(client, WIN_START + Math.round(lin * D)), W / 2, H / 2))
    report.trackScope = { kind: 'slideL', centers }

    // 4. o 'blur' desfoca de verdade: degrau através da borda esquerda do quadrado branco (linha do meio)
    use(scene(base, 'blur', { a: src.redBox, b: src.blueBox }))
    const step = (d: Uint8Array): number => {
      let m = 0
      const y = BOX.y + BOX.h / 2
      for (let x = BOX.x - 60; x < BOX.x + 60; x++) {
        const s0 = rgbAt(d, x, y).reduce((a, b) => a + b, 0)
        const s1 = rgbAt(d, x + 1, y).reduce((a, b) => a + b, 0)
        m = Math.max(m, Math.abs(s1 - s0))
      }
      return m
    }
    report.blurEdge = { sharp: step(await frame(client, 1 * S)), mid: step(await frame(client, CUT)) }

    // 5. paridade: os mesmos quadros no preview (amostra) e na exportação de [1 s, 3 s) — o main compara
    report.parity = []
    for (const kind of ['crossfade', 'slideL'] as const) {
      const p = plain(kind)
      use(p)
      const frames: { frame: number; preview: number[] }[] = []
      for (const n of PARITY_FRAMES) frames.push({ frame: n, preview: paritySample(await frame(client, frameToUs(n, FPS)), W, H, 4) })
      const run: NonNullable<TransitionReport['parity']>[number] = { kind, fromUs: PARITY_FROM_US, frames }
      if (outDir) {
        try {
          const out = await runEditorExport({ project: p, width: W, height: H, fps: FPS, fromUs: PARITY_FROM_US, toUs: PARITY_TO_US, videoBitrate: 16_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: `transicao-${kind}.mp4` })
          run.exportPath = out.path
        } catch (e) {
          run.exportError = e instanceof Error ? e.message : String(e)
        }
      } else run.exportError = 'sem pasta de saída'
      report.parity.push(run)
    }

    // 6. desempenho em 1080p: reprodução sequencial pela janela inteira (compositor + GPU por quadro), depois de aquecer
    const bench: NonNullable<TransitionReport['bench']> = {}
    for (const kind of ['crossfade', 'blur'] as const) {
      use(plain(kind))
      await client.testBench(WIN_START, 5, FPS)
      const b = await client.testBench(WIN_START, WIN_FRAMES.last - WIN_FRAMES.first + 1, FPS)
      if (b.error) bench.error = b.error
      bench[kind] = benchStats(b.drawMs)
    }
    report.bench = bench

    // mesmo asset em A e B: o slot de decoder de B não muda no fim da janela (assignSlots) — sem engasgo ali
    try {
      const same = scene(base, 'crossfade', { a: src.redBox, b: src.redBox })
      use(same)
      const startN = WIN_FRAMES.last - 9 // 10 quadros antes do fim da janela e 10 depois
      await client.testBench(frameToUs(startN - 5, FPS), 5, FPS)
      const b = await client.testBench(frameToUs(startN, FPS), 20, FPS)
      const ms = b.frameMs
      const boundary = ms[WIN_FRAMES.last + 1 - startN]
      // mediana dos quadros de regime (sem o 1º do bench nem os 3 a partir do fim da janela)
      const others = ms.filter((_, i) => i > 0 && (i < WIN_FRAMES.last + 1 - startN || i > WIN_FRAMES.last + 3 - startN)).sort((x, y) => x - y)
      const r2 = (v: number): number => Math.round(v * 100) / 100
      const i0 = WIN_FRAMES.last + 1 - startN
      report.sameAsset = { boundaryMs: r2(boundary ?? NaN), after3Ms: r2(ms[i0] + ms[i0 + 1] + ms[i0 + 2]), medianMs: r2(others[Math.floor(others.length / 2)] ?? NaN), maxMs: r2(Math.max(...ms)), frameMs: ms.map(r2), ...(b.error ? { error: b.error } : {}) }
    } catch (e) {
      report.sameAsset = { boundaryMs: NaN, after3Ms: NaN, medianMs: NaN, maxMs: NaN, error: e instanceof Error ? e.message : String(e) }
    }
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
