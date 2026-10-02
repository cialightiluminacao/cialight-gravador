import { createEffectItem, createMediaItem, defaultVisual } from '@shared/editor/factory'
import type { Asset, EffectItem, Item, MediaItem, Project, ShapeItem, TextItem, TextStyle, Track } from '@shared/editor/project'
import { resolveFrame, type TextLayer } from '@shared/editor/resolve'
import { frameToUs } from '@shared/editor/time'
import { paritySample } from '@shared/testing/transitionOracle'
import { boundsOf, type Rgb, type TextReport, type TitleShot } from '@shared/testing/textReport'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { arrowGeometry, strokePx } from '../engine/text/shapeRaster'
import { cssFont, measureTextBox } from '../engine/text/textRaster'
import { downsampleFactor, effectBlurRadiusPx, layerBlurRect } from '../engine/compositor/effectsMath'
import { runEditorExport } from '../export/editorExport'

// Texto e formas (F5 Task 4) no motor real (CIALIGHT_TEST=editor-render). Projeto p-editor-text-test (criado pelo
// main): imagens 1920×1080 cinza 128 (a_tx_gray), listras verticais pretas/brancas de 2 px (a_tx_stripes, detalhe
// para ver desfoque) e vermelho (a_tx_red). As cenas são montadas aqui em memória: título com fundo e alinhamentos,
// contorno, sombra, quebra por largura, formas e holofote, desfoque de camada, efeito `track` na faixa do texto,
// crossfade mídia → texto e paridade com a exportação (o main lê o quadro com o ffmpeg).

export const TEXT_PROJECT_ID = 'p-editor-text-test'
const W = 1920
const H = 1080
const FPS = 30
const S = 1_000_000
const AT = 1 * S
const BLUE: Rgb = [0x20, 0x50, 0xff]
export const TEXT_PARITY_FRAME = 15
const TEXT_PARITY_TO_US = 1 * S

const vtrack = (id: string, items: Item[]): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items })

function textItem(id: string, text: string, style: Partial<TextStyle>, extra: Partial<TextItem> = {}): TextItem {
  return {
    id, type: 'text', startUs: 0, durationUs: 4 * S, text, visual: defaultVisual(),
    style: { font: 'Manrope Variable', size: { value: 110 }, weight: 800, color: '#ffffff', align: 'center', lineHeight: 1.2, ...style },
    ...extra
  }
}

function shapeItem(id: string, over: Partial<ShapeItem>, x = 0.5, y = 0.5): ShapeItem {
  const v = defaultVisual()
  v.transform = { ...v.transform, x: { value: x }, y: { value: y } }
  return { id, type: 'shape', startUs: 0, durationUs: 4 * S, shape: 'rect', fill: 'none', stroke: 'none', strokeWidth: 0, visual: v, box: { w: 0.3, h: 0.2 }, ...over }
}

const bg = (a: Asset, durationUs = 4 * S): MediaItem => ({ ...createMediaItem(a, 0, 'video'), id: `bg_${a.id}`, durationUs })

function scene(base: Project, tracks: Track[]): Project {
  return { ...base, tracks }
}

const rgbAt = (d: Uint8Array, x: number, y: number): Rgb => {
  const i = (Math.round(y) * W + Math.round(x)) * 4
  return [d[i], d[i + 1], d[i + 2]]
}
const near = (c: Rgb, r: number, g: number, b: number, tol: number): boolean => Math.abs(c[0] - r) <= tol && Math.abs(c[1] - g) <= tol && Math.abs(c[2] - b) <= tol

export async function textCheck(outDir: string | null): Promise<TextReport> {
  const report: TextReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const base = await window.api.project.load(TEXT_PROJECT_ID)
    const asset = (id: string): Asset => {
      const a = base.assets.find((x) => x.id === id)
      if (!a) throw new Error(`asset ${id} ausente no projeto de texto`)
      return a
    }
    const gray = asset('a_tx_gray'), stripes = asset('a_tx_stripes'), red = asset('a_tx_red')
    const urls = mediaUrlsFor(base, 'preview')
    const use = (p: Project): void => client.setProject(p, urls, true)
    // a mesma fonte na thread principal (CSS do app) para a caixa esperada
    await document.fonts.load(cssFont({ font: 'Manrope Variable', weight: 800 }, 110), 'TESTE F5 OK')

    /** Quadro em tUs depois que o worker tem as fontes (quadro sem `fontsPending`); devolve os pixels e as tentativas. */
    const frame = async (tUs: number): Promise<{ d: Uint8Array; tries: number }> => {
      for (let tries = 1; tries <= 60; tries++) {
        const r = await client.requestFrame(tUs, false)
        if (r.t !== 'rendered') throw new Error(`quadro em ${tUs}: ${JSON.stringify(r)}`)
        if (!r.fontsPending) return { d: await client.readPixels(0, 0, W, H), tries }
        await new Promise((res) => setTimeout(res, 100))
      }
      throw new Error(`fontes não carregaram no worker (quadro em ${tUs})`)
    }
    const expectBox = (p: Project, id: string, tUs = AT) => {
      const l = resolveFrame(p, tUs).find((x): x is TextLayer => x.kind === 'text' && x.itemId === id)
      if (!l) throw new Error(`sem camada de texto ${id}`)
      return measureTextBox(l, { W, H })
    }
    const boxArea = (b: { cx: number; cy: number; w: number; h: number }, grow = 0) => ({ x0: Math.floor(b.cx - b.w / 2 - grow), y0: Math.floor(b.cy - b.h / 2 - grow), x1: Math.ceil(b.cx + b.w / 2 + grow), y1: Math.ceil(b.cy + b.h / 2 + grow) })
    const isWhite = (r: number, g: number, b: number): boolean => r > 200 && g > 200 && b > 200

    // 1. título "TESTE F5" + 2ª linha "T": fundo #2050ff, padding 0,3, nos três alinhamentos (fundo do quadro preto)
    const titles: TitleShot[] = []
    for (const align of ['center', 'left', 'right'] as const) {
      const p = scene(base, [vtrack('t_tx', [textItem('i_title', 'TESTE F5\nT', { background: '#2050ff', padding: 0.3, align })])])
      use(p)
      const { d, tries } = await frame(AT)
      const e = expectBox(p, 'i_title')
      const pad = 0.3 * 110
      // busca bem além da caixa esperada: com outra fonte a caixa real seria outra (e a conferência pega)
      const area = boxArea(e, 80)
      const top = e.cy - e.h / 2
      // 2ª linha: faixa vertical da linha 2 (pad + lineH .. pad + 2·lineH)
      const lineH = 110 * 1.2
      titles.push({
        align, expected: e, pad, fontTries: tries,
        blue: boundsOf(d, W, H, (r, g, b) => near([r, g, b], ...BLUE, 3), area),
        bgPixel: rgbAt(d, e.cx - e.w / 2 + pad / 2, e.cy),
        white: boundsOf(d, W, H, isWhite, area),
        line2: boundsOf(d, W, H, isWhite, { x0: area.x0, y0: Math.round(top + pad + lineH + 4), x1: area.x1, y1: Math.round(top + pad + 2 * lineH - 4) })
      })
    }
    report.titles = titles

    // 2. contorno vermelho (6 px de referência) e sombra preta deslocada (0,1 em, sem desfoque) sobre cinza 128
    {
      const p = scene(base, [vtrack('t_bg', [bg(gray)]), vtrack('t_tx', [textItem('i_st', 'TESTE', { stroke: { width: 6, color: '#ff0000' } })])])
      use(p)
      const { d } = await frame(AT)
      const area = boxArea(expectBox(p, 'i_st'), 30)
      report.stroke = { strokePx: 6, white: boundsOf(d, W, H, isWhite, area), red: boundsOf(d, W, H, (r, g, b) => r > 200 && g < 60 && b < 60, area) }
    }
    {
      const p = scene(base, [vtrack('t_bg', [bg(gray)]), vtrack('t_tx', [textItem('i_sh', 'TESTE', { shadow: true, shadowStyle: { color: '#000000', blur: 0, dx: 0.1, dy: 0.1 } })])])
      use(p)
      const { d } = await frame(AT)
      const area = boxArea(expectBox(p, 'i_sh'), 40)
      report.shadow = { offsetPx: 11, white: boundsOf(d, W, H, isWhite, area), dark: boundsOf(d, W, H, (r, g, b) => r < 40 && g < 40 && b < 40, area) }
    }

    // 3. quebra por largura (maxWidth 0,3): altura da caixa ≈ linhas × size × lineHeight + 2·padding
    {
      const text = 'uma frase bem longa para quebrar em várias linhas'
      const p = scene(base, [vtrack('t_tx', [textItem('i_wrap', text, { size: { value: 60 }, weight: 600, background: '#2050ff', padding: 0.3, maxWidth: 0.3 })])])
      use(p)
      const { d } = await frame(AT)
      const e = expectBox(p, 'i_wrap')
      const lines = Math.round((e.h - 2 * 0.3 * 60) / (60 * 1.2))
      report.wrap = { lines, blue: boundsOf(d, W, H, (r, g, b) => near([r, g, b], ...BLUE, 3)), expectedH: lines * 60 * 1.2 + 2 * 0.3 * 60, maxW: 0.3 * W + 2 * 0.3 * 60 }
    }

    // 4. formas sobre cinza 128: retângulo e elipse verdes (0,192,0), seta magenta, holofote dim 0,6
    {
      const green = '#00c000'
      const p = scene(base, [
        vtrack('t_bg', [bg(gray)]),
        vtrack('t_sh', [
          shapeItem('i_rect', { shape: 'rect', fill: green, box: { w: 0.2, h: 0.2 } }, 0.25, 0.3),
          // mesma faixa não pode sobrepor: as outras formas em faixas próprias
        ]),
        vtrack('t_sh2', [shapeItem('i_ell', { shape: 'ellipse', fill: green, box: { w: 0.2, h: 0.2 } }, 0.75, 0.3)]),
        vtrack('t_sh3', [shapeItem('i_arrow', { shape: 'arrow', fill: '#ff00ff', stroke: '#ff00ff', strokeWidth: 12, box: { w: 0.25, h: 0.1 } }, 0.5, 0.75)])
      ])
      use(p)
      const { d } = await frame(AT)
      const rx = 0.75 * W, ry = 0.3 * H, rw = 0.2 * W, rh = 0.2 * H
      const ax1 = 0.5 * W + 0.125 * W
      const head = arrowGeometry(0.25 * W, 0.1 * H, strokePx({ strokeWidth: 12 }, { W, H }))
      const shapes: NonNullable<TextReport['shapes']> = {
        rectCenter: rgbAt(d, 0.25 * W, 0.3 * H),
        ellipseCenter: rgbAt(d, rx, ry),
        ellipseCorner: rgbAt(d, rx - rw / 2 + 0.05 * rw, ry - rh / 2 + 0.05 * rh),
        arrowTip: rgbAt(d, ax1 - 0.3 * head.headLen, 0.75 * H),
        arrowTail: rgbAt(d, 0.5 * W - 0.125 * W + 10, 0.75 * H),
        spotOutside: [0, 0, 0], spotInside: [0, 0, 0], spotEdgeOutside: [0, 0, 0]
      }
      const ps = scene(base, [vtrack('t_bg', [bg(gray)]), vtrack('t_sh', [shapeItem('i_spot', { shape: 'ellipse', box: { w: 0.3, h: 0.45 }, spotlight: { dim: 0.6 } })])])
      use(ps)
      const s = (await frame(AT)).d
      shapes.spotOutside = rgbAt(s, 100, 100)
      shapes.spotInside = rgbAt(s, W / 2, H / 2)
      // logo fora da borda direita da elipse (meia-largura 288 px): +4 px já é "fora" inteiro (borda suave para dentro)
      shapes.spotEdgeOutside = rgbAt(s, W / 2 + 0.15 * W + 4, H / 2)
      report.shapes = shapes
    }

    // 5. desfoque da camada (animação de entrada 'blur') no título sobre listras: só dentro da caixa (+ alcance)
    {
      const title = (blur: boolean): Project =>
        scene(base, [vtrack('t_bg', [bg(stripes)]), vtrack('t_tx', [textItem('i_bl', 'TESTE F5', {}, blur ? { visual: { ...defaultVisual(), animIn: { preset: 'blur', durationUs: S } } } : {})])])
      const tUs = 300_000
      const pb = title(true)
      const layer = resolveFrame(pb, tUs).find((x): x is TextLayer => x.kind === 'text')!
      const blurPx = layer.blur ?? 0
      use(title(false))
      const sharp = (await frame(tUs)).d
      use(pb)
      const soft = (await frame(tUs)).d
      // área do desfoque = a do compositor (layerBlurRect sobre o quad do texto, com a margem dele) — usa a caixa + 40 px
      const e = expectBox(pb, 'i_bl', tUs)
      const b = boxArea(e, 40)
      const r = layerBlurRect([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], blurPx, W, H)
      const area = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }
      let outsideMaxDiff = 0, insideDiff = 0
      const inner = boxArea(e)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const diff = Math.max(Math.abs(sharp[i] - soft[i]), Math.abs(sharp[i + 1] - soft[i + 1]), Math.abs(sharp[i + 2] - soft[i + 2]))
          if (x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1) outsideMaxDiff = Math.max(outsideMaxDiff, diff)
          else if (x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1) insideDiff += diff
        }
      }
      report.layerBlur = { blurPx, outsideMaxDiff, insideDiff, area }
    }

    // 6. efeito `track` (blur forte, região grande) com alvo na faixa do texto: borra o texto, não as listras abaixo
    {
      // intensidade 3 numa região de 0,8×0,8: raio ≈ 1,25 × 864 × 0,03 = 32 px (alcance bem menor que a região)
      const fx: EffectItem = { ...createEffectItem('blur', 0, 4 * S, { x: 0.5, y: 0.5, w: 0.8, h: 0.8 }), id: 'i_fx', strength: { value: 3 }, feather: 0, scope: 'track', targetTrackId: 't_tx' }
      const radius = effectBlurRadiusPx(3, { w: 0.8, h: 0.8 }, W, H)
      const mk = (withFx: boolean): Project =>
        scene(base, [vtrack('t_bg', [bg(stripes)]), vtrack('t_tx', [textItem('i_tt', 'TESTE F5', {})]), ...(withFx ? [vtrack('t_fx', [fx])] : [])])
      use(mk(false))
      const ref = (await frame(AT)).d
      const pf = mk(true)
      use(pf)
      const got = (await frame(AT)).d
      const e = expectBox(pf, 'i_tt')
      // texto (+ margem da rasterização) + alcance do kernel (3σ = 1,5·r) + a grade reduzida
      const reach = boxArea(e, 40 + Math.ceil(1.5 * radius) + 2 * downsampleFactor(radius))
      const inner = boxArea(e)
      let mediaMaxDiff = 0, textDiff = 0, mediaPixels = 0
      for (let y = Math.round(0.1 * H) + 2; y < Math.round(0.9 * H) - 2; y++) {
        for (let x = Math.round(0.1 * W) + 2; x < Math.round(0.9 * W) - 2; x++) {
          const i = (y * W + x) * 4
          const diff = Math.max(Math.abs(ref[i] - got[i]), Math.abs(ref[i + 1] - got[i + 1]), Math.abs(ref[i + 2] - got[i + 2]))
          if (x < reach.x0 || x >= reach.x1 || y < reach.y0 || y >= reach.y1) {
            mediaMaxDiff = Math.max(mediaMaxDiff, diff)
            mediaPixels++
          } else if (x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1) textDiff += diff
        }
      }
      report.trackScope = { radius, mediaMaxDiff, textDiff, mediaPixels }
    }

    // 7. crossfade A = imagem vermelha [0, 2 s) → B = título com fundo azul [2 s, 4 s), 1 s: meio da janela (2 s)
    {
      const A: MediaItem = { ...createMediaItem(red, 0, 'video'), id: 'i_a', durationUs: 2 * S }
      const B = textItem('i_b', 'TESTE F5', { background: '#2050ff', padding: 0.3 }, { startUs: 2 * S, durationUs: 2 * S, transitionIn: { kind: 'crossfade', durationUs: S } })
      const p = scene(base, [vtrack('t_v', [A, B])])
      use(p)
      const cA = rgbAt((await frame(S)).d, W / 2, H / 2)
      const tr = resolveFrame(p, 2 * S).find((l) => l.kind === 'transition')
      if (tr?.kind !== 'transition') throw new Error('crossfade: sem transição em 2 s')
      const d = (await frame(2 * S)).d
      const e = measureTextBox(tr.to[0] as TextLayer, { W, H })
      const k = tr.progress
      const mix = (a: Rgb, b: Rgb): Rgb => [a[0] * (1 - k) + b[0] * k, a[1] * (1 - k) + b[1] * k, a[2] * (1 - k) + b[2] * k]
      report.crossfade = {
        p: k, A: cA,
        inBox: rgbAt(d, e.cx, e.cy - e.h / 2 + 0.15 * 110), // padding de cima (fundo, sem letra)
        outside: rgbAt(d, 200, 200),
        expectedIn: mix(cA, BLUE),
        expectedOut: mix(cA, [0, 0, 0])
      }
    }

    // 8. paridade preview × exportação do título (quadro 15 de [0, 1 s))
    {
      const p = scene(base, [vtrack('t_tx', [textItem('i_title', 'TESTE F5', { background: '#2050ff', padding: 0.3, shadow: true, shadowStyle: { color: '#000000b3', blur: 0.08, dx: 0.04, dy: 0.04 } })])])
      use(p)
      const preview = paritySample((await frame(frameToUs(TEXT_PARITY_FRAME, FPS))).d, W, H, 4)
      const run: NonNullable<TextReport['parity']> = { frame: TEXT_PARITY_FRAME, fromUs: 0, preview }
      if (outDir) {
        try {
          const out = await runEditorExport({ project: p, width: W, height: H, fps: FPS, fromUs: 0, toUs: TEXT_PARITY_TO_US, videoBitrate: 16_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'texto-titulo.mp4' })
          run.exportPath = out.path
        } catch (e) {
          run.exportError = e instanceof Error ? e.message : String(e)
        }
      } else run.exportError = 'sem pasta de saída'
      report.parity = run
    }
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
