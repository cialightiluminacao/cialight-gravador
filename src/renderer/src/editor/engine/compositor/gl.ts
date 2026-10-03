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
// Quadro I420 em memória de CPU (decoder em software; opt-in do chamador por DrawExtra.cpuFrames): em vez do
// texImage2D(VideoFrame) (~10 ms/quadro 1080p), os planos copiados por copyTo sobem como texturas R8 e uma passada de
// render-to-texture (FS_YUV) escreve na textura RGBA8 da camada. R4: só I420 (yuv.ts).

/**
 * Recursos extras da entrada de camada no TextureCache: texturas de plano (contadas em textureBytes) e o buffer de CPU
 * reaproveitado (memória do JS, fora do orçamento de texturas; vive o mesmo tempo que a entrada).
 */
export interface YuvPlanes {
  buf: Uint8Array | null
  tex: WebGLTexture[]
  /** Tamanho alocado de cada textura de plano (realoca só quando muda). */
  dims: { w: number; h: number }[]
}

/**
 * Planos de um quadro já copiados para a CPU (Compositor.prepareCpuFrames), à espera do upload no draw. `frame` só
 * identifica a fonte (o draw confere que é o mesmo VideoFrame do mapa de fontes); nada o retém depois do draw.
 */
export class StagedYuv {
  constructor(
    readonly frame: VideoFrame,
    readonly format: YuvFormat,
    /** Dimensões do visibleRect (= plano Y = textura RGBA da camada: prepareCpuFrames exige exibido = visível). */
    readonly w: number,
    readonly h: number,
    readonly buf: Uint8Array,
    readonly layout: readonly PlaneLayout[],
    readonly color: YuvColor
  ) {}
}

/**
 * Envia um plano R8 de `buf` com o stride/offset do PlaneLayout; aloca a textura só quando o tamanho muda. Layout que
 * não cabe no buffer lança (o chamador cai no caminho antigo) em vez de virar um erro GL silencioso.
 */
function uploadPlane(gl: WebGL2RenderingContext, tex: WebGLTexture, dims: { w: number; h: number } | undefined, spec: PlaneSpec, buf: Uint8Array, layout: PlaneLayout): boolean {
  if (layout.stride < spec.width || layout.offset + layout.stride * (spec.height - 1) + spec.width > buf.byteLength) throw new Error('layout do plano fora do buffer')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const realloc = !dims || dims.w !== spec.width || dims.h !== spec.height
  if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, spec.width, spec.height, 0, gl.RED, gl.UNSIGNED_BYTE, null)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.stride)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, spec.width, spec.height, gl.RED, gl.UNSIGNED_BYTE, buf, layout.offset)
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
   * Sobe os planos Y/U/V de `st` e converte para `target` (RGBA8 w×h; `sub` = já tem esse tamanho). Os planos/buffer
   * ficam em `slot.extra` (reaproveitados no próximo quadro). Deixa o framebuffer padrão ligado e o blend desligado.
   */
  convert(target: WebGLTexture, sub: boolean, st: StagedYuv, slot: TexSlot<YuvPlanes>): void {
    const gl = this.gl
    const planes = planeSpecs(st.format, st.w, st.h)
    const ex = (slot.extra ??= { buf: null, tex: [], dims: [] })
    ex.buf = st.buf
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    try {
      let changed = false
      for (let i = 0; i < planes.length; i++) {
        // createTexture: LINEAR — o croma é interpolado, como o Chromium faz com o I420 de CPU (paridade medida)
        ex.tex[i] ??= createTexture(gl)
        if (uploadPlane(gl, ex.tex[i], ex.dims[i], planes[i], st.buf, st.layout[i])) {
          ex.dims[i] = { w: planes[i].width, h: planes[i].height }
          changed = true
        }
      }
      if (changed) slot.extraBytes = ex.dims.reduce((s, d) => s + d.w * d.h, 0)
    } finally {
      // os outros uploads dependem do padrão
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }
    gl.bindTexture(gl.TEXTURE_2D, target)
    if (!sub) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, st.w, st.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
    gl.viewport(0, 0, st.w, st.h)
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    const { m, off } = yuvCoeffs(st.color)
    const [y, u, v] = ex.tex
    gl.useProgram(this.prog.program)
    twgl.setBuffersAndAttributes(gl, this.prog, this.quad)
    twgl.setUniforms(this.prog, {
      u_y: y, u_u: u, u_v: v, u_m: m, u_off: off, u_dst: [st.w, st.h],
      // dimensão ímpar: o plano de croma tem ceil(w/2) amostras para w/2 de largura útil
      u_cscale: [st.w / 2 / planes[1].width, st.h / 2 / planes[1].height]
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
