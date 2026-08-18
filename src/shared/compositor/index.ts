// Compositor: PiP + traços, TS puro (sem DOM além do contexto 2D).
// Usado por preview ao vivo, player de revisão e exportação (Worker) → paridade garantida.
export { pipRectAt, pipPixelRect, clampPip, PIP_EASE_MS, PIP_MIN_SIZE } from './pipMath'
export type { PipRect, PipPixelRect } from './pipMath'
export { visibleStrokesAt, STROKE_FADE_MS } from './strokes'
export type { VisibleStroke } from './strokes'
export {
  drawFrame,
  drawStrokes,
  coverCrop,
  REFERENCE_WIDTH,
  PIP_SHADOW_COLOR,
  PIP_BORDER_COLOR,
  ARROW_HEAD_LENGTH_FACTOR,
  ARROW_HEAD_ANGLE_RAD
} from './drawFrame'
export type { FrameSources, DrawFrameOptions, Canvas2DLike, ImageSourceLike } from './drawFrame'
