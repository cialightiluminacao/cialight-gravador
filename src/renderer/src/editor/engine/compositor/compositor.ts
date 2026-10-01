// Compositor WebGL2 (roda no render worker): desenha as camadas de resolveFrame, do fundo ao topo,
// no canvas inteiro (= quadro do projeto na resolução do canvas). Mesmo código no preview e na exportação.
// F1: mídia (vídeo/imagem) e anotações. Texto/forma/efeitos/transições chegam em F2/F5 (ignorados).
import * as twgl from 'twgl.js'
import type { AnnotationsLayer, Layer, MediaLayer } from '@shared/editor/resolve'
import { parseColor } from './color'
import { createGl, createTexture, sourceSize, uploadTexture } from './gl'
import { layerMatrix, type Mat3, type Rotation } from './matrix'
import { FS_MEDIA, FS_SOLID, VS_QUAD } from './shaders'

/** Geometria da fonte: dimensões antes da rotação e rotação horária a aplicar. */
export interface SourceMeta { w: number; h: number; rotation: Rotation }

export interface DrawExtra {
  annotations?: (layer: AnnotationsLayer) => OffscreenCanvas | null
  selectionOutline?: { itemId: string }[]
  /** Por itemId; sem entrada: dimensões da própria fonte, rotação 0 (placeholder: canvas inteiro). */
  meta?: Map<string, SourceMeta>
}

// Larguras de borda e raios do modelo estão em pixels de um quadro de 1920 de largura (como os traços v1).
const REFERENCE_WIDTH = 1920
// 'rounded' sem raio definido: 6 % do menor lado (paridade com a PiP v1).
const DEFAULT_ROUNDED = 0.06
const SELECTION_COLOR: [number, number, number, number] = [0.32, 0.6, 1, 1]

const SHAPE_CODE = { rect: 0, rounded: 1, circle: 2 } as const

interface TexEntry { tex: WebGLTexture; src: unknown }

export class Compositor {
  private readonly gl: WebGL2RenderingContext
  private readonly media: twgl.ProgramInfo
  private readonly solid: twgl.ProgramInfo
  private readonly quad: twgl.BufferInfo
  private readonly loop: twgl.BufferInfo
  private readonly textures = new Map<string, TexEntry>()

  constructor(private readonly canvas: OffscreenCanvas) {
    const gl = createGl(canvas)
    this.gl = gl
    this.media = twgl.createProgramInfo(gl, [VS_QUAD, FS_MEDIA])
    this.solid = twgl.createProgramInfo(gl, [VS_QUAD, FS_SOLID])
    this.quad = twgl.createBufferInfoFromArrays(gl, { a_pos: { numComponents: 2, data: [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1] } })
    this.loop = twgl.createBufferInfoFromArrays(gl, { a_pos: { numComponents: 2, data: [0, 0, 1, 0, 1, 1, 0, 1] } })
  }

  resize(w: number, h: number): void {
    this.canvas.width = Math.max(1, Math.round(w))
    this.canvas.height = Math.max(1, Math.round(h))
  }

  draw(layers: Layer[], sources: Map<string, TexImageSource | VideoFrame | null>, background: string, extra?: DrawExtra): void {
    const gl = this.gl
    const W = this.canvas.width
    const H = this.canvas.height
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, W, H)
    const [r, g, b] = parseColor(background)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const used = new Set<string>()
    const boxes = new Map<string, Mat3>()
    const px = W / REFERENCE_WIDTH
    for (const layer of layers) {
      switch (layer.kind) {
        case 'media': {
          const src = sources.get(layer.itemId) ?? null
          const meta = extra?.meta?.get(layer.itemId) ?? (src ? { ...sourceSize(src), rotation: 0 as const } : { w: W, h: H, rotation: 0 as const })
          const geom = layerMatrix(layer, meta, { w: W, h: H })
          boxes.set(layer.itemId, geom.mat)
          const shape = shapeUniforms(layer, geom.size, px)
          if (src) {
            const key = `m:${layer.itemId}`
            this.bindSource(key, src)
            used.add(key)
            const adj = layer.adjust
            this.drawQuad(this.media, geom.mat, {
              u_tex: this.textures.get(key)!.tex,
              u_uv: geom.uv,
              u_rot: meta.rotation / 90,
              u_mirror: layer.mirror ? 1 : 0,
              u_opacity: layer.opacity,
              u_adjust: adj ? [adj.brightness, adj.contrast, adj.saturation] : [0, 0, 0],
              u_border: layer.border ? layer.border.width * px : 0,
              u_borderColor: layer.border ? parseColor(layer.border.color) : [0, 0, 0, 0],
              ...shape
            })
          } else {
            this.drawQuad(this.solid, geom.mat, { u_checker: 1, u_color: [0, 0, 0, 1], u_opacity: layer.opacity, u_mask: 1, ...shape })
          }
          break
        }
        case 'annotations': {
          const cv = extra?.annotations?.(layer)
          if (!cv) break
          const key = `a:${layer.itemId}`
          this.bindSource(key, cv)
          used.add(key)
          const geom = layerMatrix({ rect: { cx: 0.5, cy: 0.5, scale: 1, rotation: 0 }, fit: 'fill', crop: { l: 0, t: 0, r: 0, b: 0 } }, { w: W, h: H, rotation: 0 }, { w: W, h: H })
          this.drawQuad(this.media, geom.mat, {
            u_tex: this.textures.get(key)!.tex, u_uv: geom.uv, u_rot: 0, u_mirror: 0, u_opacity: 1, u_adjust: [0, 0, 0], u_border: 0, u_borderColor: [0, 0, 0, 0],
            u_size: geom.size, u_shape: 0, u_radius: 0
          })
          break
        }
        default:
          break // texto, forma, efeitos e transições: F2/F5
      }
    }

    for (const sel of extra?.selectionOutline ?? []) {
      const mat = boxes.get(sel.itemId)
      if (!mat) continue
      this.drawQuad(this.solid, mat, { u_checker: 0, u_color: SELECTION_COLOR, u_opacity: 1, u_mask: 0, u_size: [1, 1], u_shape: 0, u_radius: 0 }, this.loop, gl.LINE_LOOP)
    }

    for (const [key, t] of this.textures) {
      if (used.has(key)) continue
      gl.deleteTexture(t.tex)
      this.textures.delete(key)
    }
  }

  /** Pixels do quadro atual em coordenadas do canvas (origem em cima à esquerda); RGBA linha a linha de cima para baixo. */
  readPixels(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl
    const raw = new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(x, this.canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const out = new Uint8Array(raw.length)
    const row = w * 4
    for (let i = 0; i < h; i++) out.set(raw.subarray((h - 1 - i) * row, (h - i) * row), i * row)
    return out
  }

  /** Libera texturas, programas e buffers (o contexto em si some com o worker). */
  dispose(): void {
    const gl = this.gl
    for (const t of this.textures.values()) gl.deleteTexture(t.tex)
    this.textures.clear()
    gl.deleteProgram(this.media.program)
    gl.deleteProgram(this.solid.program)
    for (const b of [this.quad, this.loop]) {
      for (const a of Object.values(b.attribs ?? {})) if (a.buffer) gl.deleteBuffer(a.buffer)
      if (b.indices) gl.deleteBuffer(b.indices)
    }
  }

  // ---- internos ----

  /** Textura por chave; ImageBitmap igual à última enviada não é re-enviada (imagens estáticas). */
  private bindSource(key: string, src: TexImageSource | VideoFrame): void {
    let t = this.textures.get(key)
    if (!t) {
      t = { tex: createTexture(this.gl), src: null }
      this.textures.set(key, t)
    }
    if (src instanceof ImageBitmap && t.src === src) return
    uploadTexture(this.gl, t.tex, src)
    t.src = src instanceof ImageBitmap ? src : null
  }

  private drawQuad(prog: twgl.ProgramInfo, mat: Mat3, uniforms: Record<string, unknown>, buf = this.quad, mode: number = this.gl.TRIANGLES): void {
    const gl = this.gl
    gl.useProgram(prog.program)
    twgl.setBuffersAndAttributes(gl, prog, buf)
    twgl.setUniforms(prog, { u_mat: mat, ...uniforms })
    twgl.drawBufferInfo(gl, buf, mode)
  }
}

function shapeUniforms(layer: MediaLayer, size: [number, number], px: number): { u_size: [number, number]; u_shape: number; u_radius: number } {
  const radius = layer.shape === 'rounded' ? (layer.radius > 0 ? layer.radius * px : DEFAULT_ROUNDED * Math.min(size[0], size[1])) : 0
  return { u_size: size, u_shape: SHAPE_CODE[layer.shape], u_radius: radius }
}
