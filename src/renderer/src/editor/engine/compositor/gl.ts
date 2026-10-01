// Utilidades WebGL2 do compositor (twgl.js 7, como no spike F0).
import * as twgl from 'twgl.js'

export function createGl(canvas: OffscreenCanvas): WebGL2RenderingContext {
  // preserveDrawingBuffer: o quadro continua legível depois da task (readPixels de teste,
  // VideoSample(canvas) da exportação e reapresentação sem re-render).
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  if (!gl) throw new Error('WebGL2 indisponível no worker')
  return gl
}

export function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  return twgl.createTexture(gl, { min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE, width: 1, height: 1 })
}

/** Sobe VideoFrame/ImageBitmap/canvas como textura RGBA8: linha 0 da imagem em t = 0 (sem flip), alpha não pré-multiplicado. */
export function uploadTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, source: TexImageSource): void {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
}

/** Dimensões em pixels (antes de qualquer rotação) de uma fonte de textura. */
export function sourceSize(src: TexImageSource): { w: number; h: number } {
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return { w: src.displayWidth, h: src.displayHeight }
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight }
  const s = src as { width: number; height: number }
  return { w: s.width, h: s.height }
}
