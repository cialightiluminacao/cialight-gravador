// Rasterização de texto (F5) num OffscreenCanvas 2D — o mesmo código no render worker (compositor) e na thread
// principal (measureTextBox para as alças do visualizador). Sem DOM além de OffscreenCanvas/FontFaceSet.
// Unidades (TextStyle): `size` em px num quadro de lado menor 1080 → size·min(W,H)/1080 px na saída W×H; padding,
// raio do fundo e sombra em "em" (fração do tamanho); contorno em px da mesma referência 1080 (largura VISÍVEL: o traço
// tem o dobro e metade fica sob o preenchimento). Rasteriza na escala do quadro de saída; escala/rotação do transform
// são do quad (compositor), não da rasterização — o cache (textCacheKey) só muda com texto, estilo resolvido e W×H.
import { DEFAULT_TEXT_SHADOW, type TextShadow } from '@shared/editor/project'
import type { Rect, ResolvedTextStyle } from '@shared/editor/resolve'

export const TEXT_REFERENCE_SHORT = 1080
/** Padding do fundo (em) quando o estilo tem fundo e não diz o padding. */
export const DEFAULT_BG_PADDING = 0.3
// lado máximo da textura (px): acima disso a rasterização é reduzida e o quad a amplia
const MAX_RASTER_SIDE = 8192

export interface FrameSize { W: number; H: number }
/** O que layoutText usa de um contexto 2D (o teste passa um medidor falso). */
export interface MeasureCtx { font: string; measureText(s: string): { width: number } }
/** Camada mínima para rasterizar/medir (TextLayer serve). */
export interface TextSource { text: string; style: ResolvedTextStyle }

export interface TextLayout {
  /** Fonte CSS usada (a de reserva enquanto a do estilo carrega: ver pending). */
  font: string
  /** A fonte do estilo ainda não carregou: medido e desenhado com sans-serif (redesenhar quando carregar). */
  pending: boolean
  /** Tamanho da fonte em px da saída. */
  fontPx: number
  /** Altura de cada linha (fontPx · lineHeight). */
  lineH: number
  lines: string[]
  widths: number[]
  textW: number
  textH: number
  /** Padding do fundo em px. */
  pad: number
  /** Caixa (texto + padding) em px da saída, antes da escala do transform. */
  boxW: number
  boxH: number
}

export interface TextRaster {
  canvas: OffscreenCanvas
  /** Tamanho do quad em px da saída (pode ser maior que o canvas se a textura foi reduzida). */
  w: number
  h: number
  /** Centro da caixa dentro do quad (px da saída): fica em rect.cx/cy. */
  anchor: { x: number; y: number }
  /** A caixa (texto + padding) em px da saída, antes da escala do transform. */
  box: { w: number; h: number }
  /** A fonte ainda não carregou: desenhado com a reserva (não guardar no cache; redesenhar quando carregar). */
  pending: boolean
}

export const fontPx = (size: number, frame: FrameSize): number => (size * Math.min(frame.W, frame.H)) / TEXT_REFERENCE_SHORT

/** Fonte CSS do canvas: estilo, peso, px e a família entre aspas, sempre com `sans-serif` de reserva. */
export function cssFont(style: Pick<ResolvedTextStyle, 'font' | 'weight' | 'italic'>, px: number): string {
  const family = style.font.replace(/["']/g, '').trim() || 'sans-serif'
  return `${style.italic ? 'italic' : 'normal'} ${style.weight} ${round3(px)}px "${family}", sans-serif`
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000

/**
 * Linhas, larguras e caixa do texto: `\n` explícito; com `maxWidth` (fração de W), quebra automática por palavra —
 * palavra mais larga que a linha é quebrada por caractere. Deixa `ctx.font` com a fonte do texto.
 * Fonte ainda não carregada: mede (e rasterizeText desenha) com a string de reserva `… sans-serif`, SEM a família — o
 * Chromium guarda a fonte resolvida por string no worker, e usar a string da família antes do carregamento deixa a
 * reserva presa nela mesmo depois do `load` (medido no test:editor: o preview seguia com a reserva e `check` já dava
 * pronta; a exportação, que espera as fontes antes do 1º quadro, saía certa).
 */
export function layoutText(text: string, style: ResolvedTextStyle, frame: FrameSize, ctx: MeasureCtx): TextLayout {
  const px = fontPx(style.size, frame)
  const real = cssFont(style, px)
  const pending = !fontReady(real, text)
  const font = pending ? `${style.italic ? 'italic' : 'normal'} ${style.weight} ${round3(px)}px sans-serif` : real
  ctx.font = font
  const measure = (s: string): number => ctx.measureText(s).width
  const max = style.maxWidth && style.maxWidth > 0 ? style.maxWidth * frame.W : Infinity
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (!Number.isFinite(max)) {
      lines.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      const cand = line ? `${line} ${word}` : word
      if (measure(cand) <= max) {
        line = cand
        continue
      }
      if (line) lines.push(line)
      line = ''
      if (measure(word) <= max) {
        line = word
        continue
      }
      // palavra maior que a linha: por caractere (code points — acentos/emoji inteiros)
      for (const ch of word) {
        if (line && measure(line + ch) > max) {
          lines.push(line)
          line = ''
        }
        line += ch
      }
    }
    lines.push(line)
  }
  const widths = lines.map(measure)
  const textW = Math.max(0, ...widths)
  const lineH = px * style.lineHeight
  const textH = lines.length * lineH
  const pad = (style.padding ?? (style.background ? DEFAULT_BG_PADDING : 0)) * px
  return { font, pending, fontPx: px, lineH, lines, widths, textW, textH, pad, boxW: textW + 2 * pad, boxH: textH + 2 * pad }
}

/** x (px dentro da caixa) da âncora do fillText de cada linha, com textAlign = align. */
export function lineX(l: TextLayout, align: ResolvedTextStyle['align']): number {
  return align === 'left' ? l.pad : align === 'right' ? l.boxW - l.pad : l.boxW / 2
}

/** Caixa desenhada (px da saída) com a escala do transform. */
export function textBoxPx(l: TextLayout, scale: number): { w: number; h: number } {
  return { w: l.boxW * scale, h: l.boxH * scale }
}

/** Chave do cache de rasterização: texto, estilo resolvido (tamanho já avaliado) e tamanho do quadro. */
export function textCacheKey(layer: TextSource, frame: FrameSize): string {
  return JSON.stringify(['t', layer.text, layer.style, frame.W, frame.H])
}

/** Sombra efetiva (projeto antigo com só `shadow: true` → DEFAULT_TEXT_SHADOW). */
export function textShadowOf(style: ResolvedTextStyle): TextShadow | null {
  return style.shadowStyle ?? (style.shadow ? DEFAULT_TEXT_SHADOW : null)
}

// ---- fontes ----

/** FontFaceSet do contexto (worker: self.fonts; página: document.fonts); null fora do navegador. */
export function fontSet(): FontFaceSet | null {
  const g = globalThis as { fonts?: FontFaceSet; document?: { fonts?: FontFaceSet } }
  return g.fonts ?? g.document?.fonts ?? null
}

/** A fonte já está pronta para `text`? Família sem FontFace registrada (fonte do sistema) = pronta. */
export function fontReady(font: string, text: string): boolean {
  const set = fontSet()
  if (!set) return true
  try {
    return set.check(font, text || ' ')
  } catch {
    return true
  }
}

// ---- medida e rasterização ----

let measureCtx: OffscreenCanvasRenderingContext2D | null = null
function measurer(): OffscreenCanvasRenderingContext2D {
  if (!measureCtx) {
    const c = new OffscreenCanvas(1, 1).getContext('2d')
    if (!c) throw new Error('Canvas 2D indisponível para medir texto')
    measureCtx = c
  }
  return measureCtx
}

/**
 * Caixa do texto no quadro W×H exatamente como o compositor desenha: centro (px), w×h (px, já com a escala do
 * transform) e rotação (graus, horária). Para as alças do visualizador (Task 5). `pending`: medida com a fonte de
 * reserva (a do estilo ainda carrega) — medir de novo depois de `document.fonts.load`.
 */
export function measureTextBox(layer: TextSource & { rect: Rect }, frame: FrameSize): { cx: number; cy: number; w: number; h: number; rotation: number; pending: boolean } {
  const l = layoutText(layer.text, layer.style, frame, measurer())
  const b = textBoxPx(l, layer.rect.scale)
  return { cx: layer.rect.cx * frame.W, cy: layer.rect.cy * frame.H, w: b.w, h: b.h, rotation: layer.rect.rotation, pending: l.pending }
}

/**
 * Rasteriza o texto: fundo (`background`, padding, `backgroundRadius`), contorno POR BAIXO do preenchimento
 * (strokeText antes de fillText, lineJoin round) e sombra só no texto (no contorno quando há, senão no preenchimento —
 * uma sombra só), linhas alinhadas na caixa. Margem em volta da caixa para contorno, sombra e o que os glifos passam da
 * largura medida. O quad tem `w`×`h` px da saída e a caixa centrada em `anchor`.
 */
export function rasterizeText(layer: TextSource, frame: FrameSize): TextRaster {
  const s = layer.style
  const l = layoutText(layer.text, s, frame, measurer())
  const px = l.fontPx
  const strokePx = s.stroke && s.stroke.width > 0 ? (s.stroke.width * Math.min(frame.W, frame.H)) / TEXT_REFERENCE_SHORT : 0
  const sh = textShadowOf(s)
  const shadowReach = sh ? Math.max(Math.abs(sh.dx), Math.abs(sh.dy)) * px + 2 * sh.blur * px : 0
  const margin = Math.ceil(strokePx + shadowReach + 0.25 * px + 2)
  const w = l.boxW + 2 * margin
  const h = l.boxH + 2 * margin
  const k = Math.min(1, MAX_RASTER_SIDE / w, MAX_RASTER_SIDE / h)
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w * k)), Math.max(1, Math.ceil(h * k)))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D indisponível para o texto')
  ctx.scale(k, k)
  if (s.background) {
    ctx.fillStyle = s.background
    ctx.beginPath()
    ctx.roundRect(margin, margin, l.boxW, l.boxH, Math.min((s.backgroundRadius ?? 0) * px, l.boxW / 2, l.boxH / 2))
    ctx.fill()
  }
  ctx.font = l.font
  ctx.textAlign = s.align
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const x = margin + lineX(l, s.align)
  const setShadow = (on: boolean): void => {
    ctx.shadowColor = on && sh ? sh.color : 'transparent'
    ctx.shadowBlur = on && sh ? sh.blur * px * k : 0
    ctx.shadowOffsetX = on && sh ? sh.dx * px * k : 0
    ctx.shadowOffsetY = on && sh ? sh.dy * px * k : 0
  }
  l.lines.forEach((line, i) => {
    if (!line) return
    const y = margin + l.pad + (i + 0.5) * l.lineH
    if (strokePx > 0) {
      setShadow(true)
      ctx.strokeStyle = s.stroke!.color
      ctx.lineWidth = 2 * strokePx
      ctx.strokeText(line, x, y)
      setShadow(false)
    } else setShadow(true)
    ctx.fillStyle = s.color
    ctx.fillText(line, x, y)
  })
  // quad = o canvas inteiro (1 texel = 1 px da saída quando k = 1): sem reamostrar a rasterização
  return { canvas, w: canvas.width / k, h: canvas.height / k, anchor: { x: margin + l.boxW / 2, y: margin + l.boxH / 2 }, box: { w: l.boxW, h: l.boxH }, pending: l.pending }
}
