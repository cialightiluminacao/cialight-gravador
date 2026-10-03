// Utilidades WebGL2 do compositor (twgl.js 7, como no spike F0).
import * as twgl from 'twgl.js'
import { FS_YUV, VS_FULL } from './shaders'
import type { TexSlot } from './textureCache'
import { planeSpecs, yuvCoeffs, type PlaneSpec, type YuvColor, type YuvFormat } from './yuv'

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

/**
 * Sobe VideoFrame/ImageBitmap/canvas como textura RGBA8: linha 0 da imagem em t = 0 (sem flip), alpha não
 * pré-multiplicado. `sub`: a textura já tem as dimensões da fonte (envio anterior igual) — texSubImage2D, sem realocar.
 */
export function uploadTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, source: TexImageSource, sub = false): void {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  if (sub) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
}

/** Dimensões em pixels (antes de qualquer rotação) de uma fonte de textura. */
export function sourceSize(src: TexImageSource): { w: number; h: number } {
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return { w: src.displayWidth, h: src.displayHeight }
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight }
  const s = src as { width: number; height: number }
  return { w: s.width, h: s.height }
}

// ---- caminho de upload YUV (G1) ----
// Quadro de vídeo em memória de CPU (decoder em software; opt-in do chamador por DrawExtra.cpuFrames): em vez do
// texImage2D(VideoFrame) (o Chromium converte para RGBA na CPU, 10–15 ms/quadro 1080p), os planos copiados por
// copyTo sobem como texturas R8/RG8 e uma passada de render-to-texture (FS_YUV) escreve na textura RGBA8 da camada.

/** Recursos extras da entrada de camada no TextureCache: texturas de plano e o buffer de CPU reaproveitado. */
export interface YuvPlanes {
  buf: Uint8Array | null
  tex: WebGLTexture[]
  /** Tamanho alocado de cada textura de plano (realoca só quando muda). */
  dims: { w: number; h: number; ch: number }[]
}

/**
 * Planos de um quadro já copiados para a CPU (Compositor.prepareCpuFrames), à espera do upload no draw. `frame` só
 * identifica a fonte (o draw confere que é o mesmo VideoFrame do mapa de fontes); nada o retém depois do draw.
 */
export class StagedYuv {
  constructor(
    readonly frame: VideoFrame,
    readonly format: YuvFormat,
    /** Dimensões do visibleRect (= plano Y). */
    readonly w: number,
    readonly h: number,
    /** Dimensões da textura RGBA da camada (sourceSize: displayWidth × displayHeight). */
    readonly dw: number,
    readonly dh: number,
    readonly buf: Uint8Array,
    readonly layout: readonly PlaneLayout[],
    readonly color: YuvColor
  ) {}
}

/** Envia um plano (R8 ou RG8) de `buf` com o stride/offset do PlaneLayout; aloca a textura só quando o tamanho muda. */
function uploadPlane(gl: WebGL2RenderingContext, tex: WebGLTexture, dims: { w: number; h: number; ch: number } | undefined, spec: PlaneSpec, buf: Uint8Array, layout: PlaneLayout, filter: number): boolean {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  const fmt = spec.channels === 2 ? gl.RG : gl.RED
  const realloc = !dims || dims.w !== spec.width || dims.h !== spec.height || dims.ch !== spec.channels
  if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, spec.channels === 2 ? gl.RG8 : gl.R8, spec.width, spec.height, 0, fmt, gl.UNSIGNED_BYTE, null)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.stride / spec.channels)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, spec.width, spec.height, fmt, gl.UNSIGNED_BYTE, buf, layout.offset)
  return realloc
}

export class YuvConverter {
  private readonly prog: twgl.ProgramInfo
  private readonly fbo: WebGLFramebuffer

  constructor(private readonly gl: WebGL2RenderingContext, private readonly quad: twgl.BufferInfo) {
    this.prog = twgl.createProgramInfo(gl, [VS_FULL, FS_YUV])
    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('falha ao criar o framebuffer da conversão YUV')
    this.fbo = fbo
  }

  /**
   * Sobe os planos de `st` e converte para `target` (RGBA8 dw×dh; `sub` = já tem esse tamanho). Os planos/buffer ficam
   * em `slot.extra` (reaproveitados no próximo quadro). Deixa o framebuffer padrão ligado e o blend desligado.
   */
  convert(target: WebGLTexture, sub: boolean, st: StagedYuv, slot: TexSlot<YuvPlanes>): void {
    const gl = this.gl
    const planes = planeSpecs(st.format, st.w, st.h)
    // croma como o caminho antigo do Chromium (medido no teste de paridade): I420 de CPU é interpolado (LINEAR); NV12 e
    // I420A de CPU vão pela conversão em software (libyuv), que repete a amostra de croma de cada bloco 2×2 (NEAREST)
    const chroma = st.format === 'I420' ? gl.LINEAR : gl.NEAREST
    const ex = (slot.extra ??= { buf: null, tex: [], dims: [] })
    ex.buf = st.buf
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    try {
      let changed = false
      for (let i = 0; i < planes.length; i++) {
        ex.tex[i] ??= createTexture(gl)
        const isChroma = i === 1 || i === 2
        if (uploadPlane(gl, ex.tex[i], ex.dims[i], planes[i], st.buf, st.layout[i], isChroma ? chroma : gl.LINEAR)) {
          ex.dims[i] = { w: planes[i].width, h: planes[i].height, ch: planes[i].channels }
          changed = true
        }
      }
      if (changed) slot.extraBytes = ex.dims.reduce((s, d) => s + d.w * d.h * d.ch, 0)
    } finally {
      // os outros uploads dependem do padrão
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }
    gl.bindTexture(gl.TEXTURE_2D, target)
    if (!sub) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, st.dw, st.dh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
    gl.viewport(0, 0, st.dw, st.dh)
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    const { m, off } = yuvCoeffs(st.color)
    const [y, u, v, a] = ex.tex
    gl.useProgram(this.prog.program)
    twgl.setBuffersAndAttributes(gl, this.prog, this.quad)
    // todo sampler com textura de plano (nunca a do alvo: laço de realimentação), mesmo os que o formato não usa
    twgl.setUniforms(this.prog, {
      u_y: y, u_u: u, u_v: st.format === 'NV12' ? y : v, u_a: st.format === 'I420A' ? a : y,
      u_layout: st.format === 'NV12' ? 1 : 0, u_hasAlpha: st.format === 'I420A' ? 1 : 0,
      u_m: m, u_off: off, u_dst: [st.dw, st.dh]
    })
    twgl.drawBufferInfo(gl, this.quad)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Libera as texturas de plano de uma entrada que saiu do cache. */
  deletePlanes(ex: YuvPlanes): void {
    for (const t of ex.tex) this.gl.deleteTexture(t)
    ex.tex = []
    ex.dims = []
    ex.buf = null
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog.program)
    this.gl.deleteFramebuffer(this.fbo)
  }
}
