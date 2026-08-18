// Composição de um frame: tela + PiP da webcam + traços. TS puro — usa somente a API
// do contexto 2D (funciona com CanvasRenderingContext2D e OffscreenCanvasRenderingContext2D
// dentro de Worker). Os tipos são estruturais para compilar sem a lib DOM (processo main).
import type { PipKeyframe, Session, StrokePoint } from '../types'
import { clampPip, pipPixelRect, pipRectAt, type PipPixelRect } from './pipMath'
import { visibleStrokesAt } from './strokes'

/**
 * Qualquer fonte aceita por drawImage (HTMLVideoElement, VideoFrame, ImageBitmap, canvas…).
 * As dimensões, quando necessárias (modo cover), são lidas de videoWidth/displayWidth/width.
 */
export type ImageSourceLike = object

/** Subconjunto do contexto 2D usado pelo compositor (compatível com Canvas e OffscreenCanvas). */
export interface Canvas2DLike {
  save(): void
  restore(): void
  drawImage(image: ImageSourceLike, dx: number, dy: number, dw: number, dh: number): void
  drawImage(
    image: ImageSourceLike,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void
  beginPath(): void
  closePath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  roundRect?(x: number, y: number, w: number, h: number, radii?: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  clip(): void
  fill(): void
  stroke(): void
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  fillStyle: string | object
  strokeStyle: string | object
  lineWidth: number
  lineCap: string
  lineJoin: string
  globalAlpha: number
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
}

export interface FrameSources {
  screen: ImageSourceLike
  cam?: ImageSourceLike | null
  camMirrored?: boolean
}

export interface DrawFrameOptions {
  includeWebcam: boolean
  includeAnnotations: boolean
  autoFadeMs: number | null
  pipOverride?: PipKeyframe[] | null
}

/** Largura de referência para escalar espessuras/sombras (traço de width 6 = 6 px em 1080p). */
export const REFERENCE_WIDTH = 1920
export const PIP_SHADOW_COLOR = 'rgba(0,0,0,0.35)'
export const PIP_BORDER_COLOR = 'rgba(255,255,255,0.85)'
export const ARROW_HEAD_LENGTH_FACTOR = 4
export const ARROW_HEAD_ANGLE_RAD = (28 * Math.PI) / 180

/** Dimensões da fonte (VideoFrame: displayWidth; <video>: videoWidth; bitmap/canvas: width). */
function sourceSize(src: ImageSourceLike): { w: number; h: number } | null {
  const s = src as Record<string, unknown>
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = s[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    }
    return null
  }
  const w = pick('videoWidth', 'displayWidth', 'width')
  const h = pick('videoHeight', 'displayHeight', 'height')
  return w && h ? { w, h } : null
}

/** Recorte da fonte para preencher o destino sem distorção (object-fit: cover), centralizado. */
export function coverCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): { sx: number; sy: number; sw: number; sh: number } {
  const srcAspect = srcW / srcH
  const dstAspect = dstW / dstH
  if (srcAspect > dstAspect) {
    const sw = srcH * dstAspect
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }
  }
  const sh = srcW / dstAspect
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh }
}

/** Traça o caminho da PiP (círculo via arc; rounded via roundRect ou arcTo manual). */
function pipPath(ctx: Canvas2DLike, px: PipPixelRect, circle: boolean): void {
  ctx.beginPath()
  if (circle) {
    ctx.arc(px.x + px.w / 2, px.y + px.h / 2, px.radius, 0, Math.PI * 2)
    ctx.closePath()
    return
  }
  const r = Math.max(0, Math.min(px.radius, px.w / 2, px.h / 2))
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(px.x, px.y, px.w, px.h, r)
    return
  }
  const { x, y, w, h } = px
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawPip(ctx: Canvas2DLike, W: number, H: number, cam: ImageSourceLike, mirrored: boolean, px: PipPixelRect, circle: boolean): void {
  const s = W / REFERENCE_WIDTH

  // 1) Sombra: preenche o caminho com sombra ativa (a imagem cobre o preenchimento em seguida).
  ctx.save()
  ctx.shadowColor = PIP_SHADOW_COLOR
  ctx.shadowBlur = 16 * s
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 4 * s
  ctx.fillStyle = '#000'
  pipPath(ctx, px, circle)
  ctx.fill()
  ctx.restore()

  // 2) Webcam recortada pelo caminho, em modo cover, com espelho opcional.
  ctx.save()
  pipPath(ctx, px, circle)
  ctx.clip()
  if (mirrored) {
    // Reflete horizontalmente em torno do centro da PiP: x' = 2x + w − x
    ctx.translate(px.x * 2 + px.w, 0)
    ctx.scale(-1, 1)
  }
  const size = sourceSize(cam)
  if (size) {
    const c = coverCrop(size.w, size.h, px.w, px.h)
    ctx.drawImage(cam, c.sx, c.sy, c.sw, c.sh, px.x, px.y, px.w, px.h)
  } else {
    ctx.drawImage(cam, px.x, px.y, px.w, px.h)
  }
  ctx.restore()

  // 3) Borda.
  ctx.save()
  pipPath(ctx, px, circle)
  ctx.lineWidth = 2 * s
  ctx.strokeStyle = PIP_BORDER_COLOR
  ctx.stroke()
  ctx.restore()
}

function drawArrowHead(ctx: Canvas2DLike, from: { x: number; y: number }, to: { x: number; y: number }, lineWidth: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const L = ARROW_HEAD_LENGTH_FACTOR * lineWidth
  const a1 = angle - ARROW_HEAD_ANGLE_RAD
  const a2 = angle + ARROW_HEAD_ANGLE_RAD
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - L * Math.cos(a1), to.y - L * Math.sin(a1))
  ctx.lineTo(to.x - L * Math.cos(a2), to.y - L * Math.sin(a2))
  ctx.closePath()
  ctx.fill()
}

function drawStrokes(
  ctx: Canvas2DLike,
  W: number,
  H: number,
  session: Pick<Session, 'strokes' | 'clearEvents'>,
  tMs: number,
  autoFadeMs: number | null
): void {
  const scale = W / REFERENCE_WIDTH
  const toPx = (p: StrokePoint): { x: number; y: number } => ({ x: p.x * W, y: p.y * H })

  for (const v of visibleStrokesAt(session.strokes, session.clearEvents, tMs, autoFadeMs)) {
    const lw = v.stroke.width * scale
    const pts = v.points.map(toPx)
    const first = pts[0]
    const last = pts[pts.length - 1]

    ctx.save()
    ctx.globalAlpha = v.alpha
    ctx.strokeStyle = v.stroke.color
    ctx.fillStyle = v.stroke.color
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Seta: encurta a haste para que a ponta arredondada fique escondida sob a cabeça.
    let shaftEnd = last
    const isArrow = v.stroke.tool === 'arrow' && pts.length >= 2
    const dx = last.x - first.x
    const dy = last.y - first.y
    const len = Math.hypot(dx, dy)
    if (isArrow && len > 0) {
      const back = Math.min(len, ARROW_HEAD_LENGTH_FACTOR * lw * 0.6)
      shaftEnd = { x: last.x - (dx / len) * back, y: last.y - (dy / len) * back }
    }

    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    if (pts.length === 1) {
      // Ponto único: lineTo no mesmo lugar + lineCap round desenha um "pingo".
      ctx.lineTo(first.x, first.y)
    } else if (v.stroke.tool === 'pen') {
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    } else {
      ctx.lineTo(shaftEnd.x, shaftEnd.y)
    }
    ctx.stroke()

    if (isArrow && len > 0) drawArrowHead(ctx, first, last, lw)
    ctx.restore()
  }
}

/**
 * Desenha um frame completo em `ctx` (W×H):
 * 1) tela em (0,0,W,H); 2) PiP da webcam (clip circular/arredondado, cover, sombra, borda);
 * 3) traços visíveis (largura relativa a W/1920, cap/join round, seta com cabeça triangular).
 * `opts.pipOverride` substitui `session.pip` quando informado (lista vazia → sem PiP).
 */
export function drawFrame(
  ctx: Canvas2DLike,
  W: number,
  H: number,
  src: FrameSources,
  session: Pick<Session, 'pip' | 'strokes' | 'clearEvents'>,
  tMs: number,
  opts: DrawFrameOptions
): void {
  ctx.drawImage(src.screen, 0, 0, W, H)

  if (opts.includeWebcam && src.cam) {
    const keyframes = opts.pipOverride ?? session.pip
    const rect = pipRectAt(keyframes, tMs)
    if (rect && rect.visible) {
      const clamped = clampPip(rect)
      const px = pipPixelRect(clamped, W, H)
      if (px.w > 0 && px.h > 0) drawPip(ctx, W, H, src.cam, src.camMirrored === true, px, clamped.shape === 'circle')
    }
  }

  if (opts.includeAnnotations) drawStrokes(ctx, W, H, session, tMs, opts.autoFadeMs)
}
