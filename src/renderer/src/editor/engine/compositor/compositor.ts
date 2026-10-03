// Compositor WebGL2 (roda no render worker): desenha as camadas de resolveFrame, do fundo ao topo,
// no canvas inteiro (= quadro do projeto na resolução do canvas). Mesmo código no preview e na exportação.
// F1: mídia (vídeo/imagem) e anotações. F2: efeitos de privacidade (effects.ts) — com efeito no quadro, as
// camadas vão para um FBO de acumulação que o efeito lê. F4: desfoque por camada (preset de animação 'blur') — a
// camada é desenhada isolada no FBO auxiliar, desfocada pelo blur dos efeitos e composta. Texto/forma/transições
// chegam depois (ignorados).
import * as twgl from 'twgl.js'
import { effectBound, type AnnotationsLayer, type EffectLayer, type Layer, type MediaLayer } from '@shared/editor/resolve'
import { parseColor } from './color'
import { EffectPass } from './effects'
import { createGl, createTexture, sourceSize, uploadTexture } from './gl'
import { TEXTURE_IDLE_FRAMES, TextureCache, type TextureCacheStats } from './textureCache'
import { applyMat3, layerMatrix, type Mat3, type Rotation } from './matrix'
import { layerBlurRect } from './effectsMath'
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
// Desfoque da camada (MediaLayer.blur) em pixels de um quadro de 1080 de altura: escala com a altura de saída, como
// os tamanhos dos efeitos (effectsMath) — mesma aparência no preview e em qualquer resolução de exportação.
const BLUR_REFERENCE_HEIGHT = 1080
// raio abaixo disso (px de saída): sem desfoque visível, a camada vai direto (sem o FBO auxiliar)
const MIN_LAYER_BLUR_PX = 0.5
// 'rounded' sem raio definido: 6 % do menor lado (paridade com a PiP v1).
const DEFAULT_ROUNDED = 0.06
const SELECTION_COLOR: [number, number, number, number] = [0.32, 0.6, 1, 1]

// quadros seguidos sem efeito até liberar os FBOs do passe de efeitos (~4 s a 30 fps): o mesmo prazo das texturas
const IDLE_RELEASE_FRAMES = TEXTURE_IDLE_FRAMES

const SHAPE_CODE = { rect: 0, rounded: 1, circle: 2 } as const

/** Memória do compositor (QA/testes): texturas das camadas (cache LRU) e FBOs/texturas do passe de efeitos. */
export interface CompositorMemStats extends TextureCacheStats {
  effectBytes: number
}

/** Estado de um quadro compartilhado pelo desenho das camadas. */
interface LayerCtx {
  sources: Map<string, TexImageSource | VideoFrame | null>
  extra: DrawExtra | undefined
  W: number
  H: number
  /** px do canvas por px do quadro de referência (1920 de largura). */
  px: number
  boxes: Map<string, Mat3>
}

export class Compositor {
  private readonly gl: WebGL2RenderingContext
  private readonly media: twgl.ProgramInfo
  private readonly solid: twgl.ProgramInfo
  private readonly quad: twgl.BufferInfo
  private readonly loop: twgl.BufferInfo
  private readonly textures: TextureCache<WebGLTexture>
  private readonly effects: EffectPass
  private readonly px1 = new Uint8Array(4)
  private framesWithoutFx = 0

  constructor(private readonly canvas: OffscreenCanvas) {
    const gl = createGl(canvas)
    this.gl = gl
    this.media = twgl.createProgramInfo(gl, [VS_QUAD, FS_MEDIA])
    this.solid = twgl.createProgramInfo(gl, [VS_QUAD, FS_SOLID])
    this.quad = twgl.createBufferInfoFromArrays(gl, { a_pos: { numComponents: 2, data: [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1] } })
    this.loop = twgl.createBufferInfoFromArrays(gl, { a_pos: { numComponents: 2, data: [0, 0, 1, 0, 1, 1, 0, 1] } })
    this.effects = new EffectPass(gl, this.quad)
    this.textures = new TextureCache<WebGLTexture>({
      create: () => createTexture(gl),
      upload: (tex, src, sub) => uploadTexture(gl, tex, src as TexImageSource, sub),
      delete: (tex) => gl.deleteTexture(tex)
    })
  }

  resize(w: number, h: number): void {
    this.canvas.width = Math.max(1, Math.round(w))
    this.canvas.height = Math.max(1, Math.round(h))
  }

  draw(layers: Layer[], sources: Map<string, TexImageSource | VideoFrame | null>, background: string, extra?: DrawExtra): void {
    const gl = this.gl
    const W = this.canvas.width
    const H = this.canvas.height
    // Com efeito no quadro, as camadas vão para o FBO de acumulação (o efeito precisa ler o que está abaixo)
    // e o resultado é copiado ao canvas no fim; sem efeito, direto no canvas (caminho da F1, sem custo extra).
    const blurOf = (l: Layer): number => (l.kind === 'media' && l.blur ? (l.blur * H) / BLUR_REFERENCE_HEIGHT : 0)
    const hasFx = layers.some((l) => l.kind === 'effect' || blurOf(l) >= MIN_LAYER_BLUR_PX)
    // FBOs de efeito liberados depois de IDLE_RELEASE_FRAMES quadros seguidos sem efeito (realocados no próximo)
    this.framesWithoutFx = hasFx ? 0 : this.framesWithoutFx + 1
    if (this.framesWithoutFx === IDLE_RELEASE_FRAMES) this.effects.release()
    const fx = hasFx ? { accum: this.effects.accum(W, H) } : null
    this.textures.beginFrame()
    this.bindTarget(fx?.accum ?? null)
    const [r, g, b] = parseColor(background)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const ctx: LayerCtx = { sources, extra, W, H, px: W / REFERENCE_WIDTH, boxes: new Map<string, Mat3>() }
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      if (layer.kind === 'effect') {
        // escopo `track` sem a camada da faixa logo abaixo (lacuna, outro efeito…): nada a afetar
        if (fx && layer.scope === 'below') this.applyEffect(fx.accum, layer, W, H)
        continue
      }
      // efeitos de escopo `track` desta faixa (resolveFrame os põe logo depois dela, pelo targetTrackId) e o desfoque
      // da própria camada: ela é desenhada isolada no FBO auxiliar, desfocada, recebe os efeitos e só então é composta
      // sobre o acumulado (o efeito de privacidade age sobre a camada já desfocada)
      let last = i
      while (fx && layers[last + 1]?.kind === 'effect' && (layers[last + 1] as EffectLayer).scope === 'track' && effectBound(layers, last + 1)) last++
      const blur = blurOf(layer)
      if (fx && (last > i || blur >= MIN_LAYER_BLUR_PX)) {
        const aux = this.effects.aux(W, H)
        this.bindTarget(aux)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        this.drawLayer(layer, ctx)
        const box = blur >= MIN_LAYER_BLUR_PX && layer.kind === 'media' ? ctx.boxes.get(layer.itemId) : undefined
        if (box) {
          // só a caixa da camada + o alcance do blur (cantos do quad local em px GL, origem embaixo)
          const pts = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([a, b]): [number, number] => {
            const [x, y] = applyMat3(box, a, b)
            return [((x + 1) / 2) * W, ((y + 1) / 2) * H]
          })
          this.effects.blurLayer(aux, blur, W, H, layerBlurRect(pts, blur, W, H))
          this.bindTarget(aux)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        }
        for (let j = i + 1; j <= last; j++) this.applyEffect(aux, layers[j] as EffectLayer, W, H)
        this.bindTarget(fx.accum)
        this.effects.composite(aux)
        i = last
        continue
      }
      this.drawLayer(layer, ctx)
    }

    if (fx) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fx.accum.framebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      this.bindTarget(null)
    }

    for (const sel of extra?.selectionOutline ?? []) {
      const mat = ctx.boxes.get(sel.itemId)
      if (!mat) continue
      this.drawQuad(this.solid, mat, { u_checker: 0, u_color: SELECTION_COLOR, u_opacity: 1, u_mask: 0, u_size: [1, 1], u_shape: 0, u_radius: 0 }, this.loop, gl.LINE_LOOP)
    }

    // texturas fora deste quadro: ficam no cache até o orçamento/ociosidade (textureCache.ts)
    this.textures.endFrame()
  }

  /** Memória em uso (QA/testes): texturas das camadas e do passe de efeitos. */
  memoryStats(): CompositorMemStats {
    return { ...this.textures.stats(), effectBytes: this.effects.bytes() }
  }

  /** Testes: orçamento das texturas das camadas (null = o padrão, 512 MiB). */
  setTextureBudget(bytes: number | null): void {
    this.textures.setBudget(bytes)
  }

  /** Espera a GPU terminar o quadro (leitura 1×1 síncrona); só para medições. */
  finish(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px1)
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

  /** Libera texturas, FBOs, programas e buffers (o contexto em si some com o worker). */
  dispose(): void {
    const gl = this.gl
    this.textures.clear()
    gl.deleteProgram(this.media.program)
    gl.deleteProgram(this.solid.program)
    this.effects.dispose()
    for (const b of [this.quad, this.loop]) {
      for (const a of Object.values(b.attribs ?? {})) if (a.buffer) gl.deleteBuffer(a.buffer)
      if (b.indices) gl.deleteBuffer(b.indices)
    }
  }

  // ---- internos ----

  /** Desenha uma camada de mídia/anotações no framebuffer ligado (texto e forma: F2+/F5, ignorados). */
  private drawLayer(layer: Layer, ctx: LayerCtx): void {
    const { W, H, px, sources, extra } = ctx
    switch (layer.kind) {
      case 'media': {
        const src = sources.get(layer.itemId) ?? null
        const meta = extra?.meta?.get(layer.itemId) ?? (src ? { ...sourceSize(src), rotation: 0 as const } : { w: W, h: H, rotation: 0 as const })
        const geom = layerMatrix(layer, meta, { w: W, h: H })
        ctx.boxes.set(layer.itemId, geom.mat)
        const shape = shapeUniforms(layer, geom.size, px)
        if (src) {
          const tex = this.bindSource(`m:${layer.itemId}`, src)
          const adj = layer.adjust
          this.drawQuad(this.media, geom.mat, {
            u_tex: tex,
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
        const tex = this.bindSource(`a:${layer.itemId}`, cv)
        const geom = layerMatrix({ rect: { cx: 0.5, cy: 0.5, scale: 1, rotation: 0 }, fit: 'fill', crop: { l: 0, t: 0, r: 0, b: 0 } }, { w: W, h: H, rotation: 0 }, { w: W, h: H })
        this.drawQuad(this.media, geom.mat, {
          u_tex: tex, u_uv: geom.uv, u_rot: 0, u_mirror: 0, u_opacity: 1, u_adjust: [0, 0, 0], u_border: 0, u_borderColor: [0, 0, 0, 0],
          u_size: geom.size, u_shape: 0, u_radius: 0
        })
        break
      }
      default:
        break // texto, forma e transições: F2+/F5
    }
  }

  /** Efeito sobre o alvo; devolve o estado de desenho das camadas (alvo ligado, blend premultiplicado). */
  private applyEffect(target: twgl.FramebufferInfo, layer: EffectLayer, W: number, H: number): void {
    const gl = this.gl
    this.effects.applyEffect(target, layer, W, H)
    this.bindTarget(target)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  /** Textura por chave (cache LRU); ImageBitmap igual ao último enviado não é re-enviado (imagens estáticas). */
  private bindSource(key: string, src: TexImageSource | VideoFrame): WebGLTexture {
    const { w, h } = sourceSize(src)
    return this.textures.use(key, src, w, h, src instanceof ImageBitmap)
  }

  /** Liga o alvo das camadas (null = canvas) com o viewport do tamanho dele. */
  private bindTarget(target: twgl.FramebufferInfo | null): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null)
    gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height)
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
