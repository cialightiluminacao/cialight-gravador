// Spike F0 — pipeline WebGL2 mínimo (twgl.js 7): VideoFrame → textura → FBO "src";
// efeitos: blur gaussiano separável (com downsample opcional) e pixelização por região;
// composição final no canvas (ou num FBO para leitura/verificação).
import * as twgl from 'twgl.js'

const VS = `#version 300 es
in vec2 position;
out vec2 v_uv;
uniform float u_flipY;
void main() {
  v_uv = vec2(position.x * 0.5 + 0.5, u_flipY > 0.5 ? 0.5 - position.y * 0.5 : position.y * 0.5 + 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`

const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }`

const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_step;
uniform float u_sigma;
uniform int u_radius;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -32; i <= 32; i++) {
    if (abs(i) > u_radius) continue;
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    acc += texture(u_tex, v_uv + float(i) * u_step) * w;
    wsum += w;
  }
  o = acc / wsum;
}`

const FS_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_blur;
uniform vec4 u_blurRect;
uniform vec4 u_pixRect;
uniform vec2 u_size;
uniform float u_cell;
in vec2 v_uv;
out vec4 o;
bool inside(vec2 p, vec4 r) { return p.x >= r.x && p.y >= r.y && p.x <= r.z && p.y <= r.w; }
void main() {
  if (inside(v_uv, u_blurRect)) { o = texture(u_blur, v_uv); return; }
  if (inside(v_uv, u_pixRect)) {
    vec2 c = (floor(v_uv * u_size / u_cell) + 0.5) * u_cell;
    o = texture(u_src, c / u_size);
    return;
  }
  o = texture(u_src, v_uv);
}`

/** Retângulos em UV do FBO (origem embaixo à esquerda, convenção GL): [x0, y0, x1, y1]. */
export const BLUR_RECT: [number, number, number, number] = [0.05, 0.1, 0.45, 0.6]
export const PIX_RECT: [number, number, number, number] = [0.55, 0.1, 0.95, 0.6]
export const OUTSIDE_RECT: [number, number, number, number] = [0.05, 0.7, 0.95, 0.95]

export interface EffectOpts {
  blurDownsample: number
  blurRadius: number
  blurSigma: number
  pixelCell: number
}

export class GlPipeline {
  readonly gl: WebGL2RenderingContext
  private readonly quad: twgl.BufferInfo
  private readonly copyProg: twgl.ProgramInfo
  private readonly blurProg: twgl.ProgramInfo
  private readonly compProg: twgl.ProgramInfo
  private readonly videoTex: WebGLTexture
  readonly fboSrc: twgl.FramebufferInfo
  readonly fboOut: twgl.FramebufferInfo
  private blurFbos = new Map<number, [twgl.FramebufferInfo, twgl.FramebufferInfo]>()
  private readonly px = new Uint8Array(4)

  constructor(
    gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number
  ) {
    this.gl = gl
    this.quad = twgl.createBufferInfoFromArrays(gl, { position: { numComponents: 2, data: [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1] } })
    this.copyProg = twgl.createProgramInfo(gl, [VS, FS_COPY])
    this.blurProg = twgl.createProgramInfo(gl, [VS, FS_BLUR])
    this.compProg = twgl.createProgramInfo(gl, [VS, FS_COMPOSITE])
    this.videoTex = twgl.createTexture(gl, { min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE, width: 1, height: 1 })
    this.fboSrc = this.makeFbo(width, height)
    this.fboOut = this.makeFbo(width, height)
  }

  private makeFbo(w: number, h: number): twgl.FramebufferInfo {
    const gl = this.gl
    return twgl.createFramebufferInfo(gl, [{ internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE }], w, h)
  }

  private tex(fbo: twgl.FramebufferInfo): WebGLTexture {
    return fbo.attachments[0] as WebGLTexture
  }

  private draw(prog: twgl.ProgramInfo, target: twgl.FramebufferInfo | null, uniforms: Record<string, unknown>): void {
    const gl = this.gl
    twgl.bindFramebufferInfo(gl, target)
    gl.useProgram(prog.program)
    twgl.setBuffersAndAttributes(gl, prog, this.quad)
    twgl.setUniforms(prog, uniforms)
    twgl.drawBufferInfo(gl, this.quad)
  }

  /** Sobe o frame (VideoFrame/ImageBitmap/canvas) como textura e copia para fboSrc (corrigindo a orientação). */
  upload(source: TexImageSource): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    this.draw(this.copyProg, this.fboSrc, { u_tex: this.videoTex, u_flipY: 1 })
  }

  /** Só copia o fboSrc para o destino (sem efeitos). */
  present(target: twgl.FramebufferInfo | null): void {
    this.draw(this.copyProg, target, { u_tex: this.tex(this.fboSrc), u_flipY: 0 })
  }

  /** Blur separável (H→V) do fboSrc inteiro (pior caso) e composição com pixelização. */
  effects(o: EffectOpts, target: twgl.FramebufferInfo | null): void {
    const ds = Math.max(1, o.blurDownsample)
    let pair = this.blurFbos.get(ds)
    if (!pair) {
      pair = [this.makeFbo(Math.round(this.width / ds), Math.round(this.height / ds)), this.makeFbo(Math.round(this.width / ds), Math.round(this.height / ds))]
      this.blurFbos.set(ds, pair)
    }
    const [a, b] = pair
    const radius = Math.max(1, Math.round(o.blurRadius / ds))
    const sigma = Math.max(0.5, o.blurSigma / ds)
    this.draw(this.blurProg, a, { u_tex: this.tex(this.fboSrc), u_step: [ds / this.width, 0], u_sigma: sigma, u_radius: radius, u_flipY: 0 })
    this.draw(this.blurProg, b, { u_tex: this.tex(a), u_step: [0, 1 / (this.height / ds)], u_sigma: sigma, u_radius: radius, u_flipY: 0 })
    this.draw(this.compProg, target, {
      u_src: this.tex(this.fboSrc),
      u_blur: this.tex(b),
      u_blurRect: BLUR_RECT,
      u_pixRect: PIX_RECT,
      u_size: [this.width, this.height],
      u_cell: o.pixelCell,
      u_flipY: 0
    })
  }

  /** Força a GPU a terminar (readPixels 1×1 é síncrono). */
  sync(): void {
    const gl = this.gl
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px)
  }

  read(fbo: twgl.FramebufferInfo, rect: [number, number, number, number]): { w: number; h: number; data: Uint8Array } {
    const gl = this.gl
    const x = Math.round(rect[0] * this.width)
    const y = Math.round(rect[1] * this.height)
    const w = Math.round((rect[2] - rect[0]) * this.width)
    const h = Math.round((rect[3] - rect[1]) * this.height)
    const data = new Uint8Array(w * h * 4)
    twgl.bindFramebufferInfo(gl, fbo)
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return { w, h, data }
  }

  rendererInfo(): string {
    const gl = this.gl
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  }
}

/** Energia de alta frequência: média de |ΔL| horizontal+vertical (luma). */
export function hfEnergy(img: { w: number; h: number; data: Uint8Array }): number {
  const { w, h, data } = img
  const L = (i: number): number => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  let s = 0
  let n = 0
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4
      const l = L(i)
      s += Math.abs(l - L(i + 4)) + Math.abs(l - L(i + w * 4))
      n++
    }
  }
  return s / n
}

/** Variância da luma. */
export function lumaVariance(img: { w: number; h: number; data: Uint8Array }): number {
  const { data } = img
  let s = 0
  let s2 = 0
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    s += l
    s2 += l * l
  }
  const m = s / n
  return s2 / n - m * m
}

/** RGBA de baixo para cima (GL) → PNG (bytes). */
export async function toPng(img: { w: number; h: number; data: Uint8Array }): Promise<ArrayBuffer> {
  const { w, h, data } = img
  const flipped = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) flipped.set(data.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.putImageData(new ImageData(flipped, w, h), 0, 0)
  return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()
}

export function stats(xs: number[]): { n: number; mean: number; median: number; p95: number; max: number; min: number } {
  const s = [...xs].sort((a, b) => a - b)
  const r = (v: number): number => Math.round(v * 100) / 100
  return {
    n: s.length,
    mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
    median: r(s[Math.floor(s.length / 2)] ?? 0),
    p95: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0),
    max: r(s[s.length - 1] ?? 0),
    min: r(s[0] ?? 0)
  }
}
