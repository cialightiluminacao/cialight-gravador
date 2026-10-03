// Compositor WebGL2 (roda no render worker): desenha as camadas de resolveFrame, do fundo ao topo,
// no canvas inteiro (= quadro do projeto na resolução do canvas). Mesmo código no preview e na exportação.
// F1: mídia (vídeo/imagem) e anotações. F2: efeitos de privacidade (effects.ts) — com efeito no quadro, as
// camadas vão para um FBO de acumulação que o efeito lê. F4: desfoque por camada (preset de animação 'blur') — a
// camada é desenhada isolada no FBO auxiliar, desfocada pelo blur dos efeitos e composta. F5: transições — A e B
// desenhados cada um no seu FBO (sub-pilha com os próprios efeitos) e misturados pelo shader da transição
// (shadersTransitions.ts). Texto e formas (F5 Task 4): rasterizados em Canvas 2D (text/textRaster.ts,
// text/shapeRaster.ts) na escala da saída, num cache LRU de texturas (RasterCache), desenhados como quad (escala e
// rotação do transform no quad); holofote = passe que escurece o acumulado fora da forma (EffectPass.dimOutside).
import * as twgl from 'twgl.js'
import { effectBound, type AnnotationsLayer, type EffectLayer, type Layer, type MediaLayer, type ShapeLayer, type TextLayer, type TransitionLayer } from '@shared/editor/resolve'
import type { FontRequest } from '../text/fontRequests'
import { RasterCache } from '../text/rasterCache'
import { rasterizeShape, shapeCacheKey, shapeVisible, spotlightRegion } from '../text/shapeRaster'
import { cssFont, rasterizeText, textCacheKey } from '../text/textRaster'
import { parseColor } from './color'
import { EffectPass } from './effects'
import { createGl, createTexture, sourceSize, uploadTexture } from './gl'
import { TEXTURE_IDLE_FRAMES, TextureCache, type TextureCacheStats } from './textureCache'
import { anchoredMatrix, applyMat3, layerMatrix, type Mat3, type Rotation } from './matrix'
import { layerBlurRect } from './effectsMath'
import { FS_MEDIA, FS_SOLID, VS_FULL, VS_QUAD } from './shaders'
import { FS_TRANSITION, TRANSITION_MODES, transitionBlurPx } from './shadersTransitions'

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
// borda suave do holofote (px de saída), para dentro da forma
const SPOTLIGHT_FEATHER_PX = 2

/** Memória do compositor (QA/testes): texturas das camadas (cache LRU), do texto/forma (RasterCache) e FBOs/texturas do passe de efeitos. */
export interface CompositorMemStats extends TextureCacheStats {
  effectBytes: number
  /** Texturas de texto/forma rasterizados (cache próprio: ≤ 64 entradas, ≤ 64 MiB; fora do orçamento das camadas). */
  rasterBytes: number
  rasterCount: number
}
/** Texto/forma rasterizado e enviado: textura e quad (px de saída) com o centro da caixa em `anchor`. */
interface RasterEntry { tex: WebGLTexture; w: number; h: number; anchor: { x: number; y: number }; box: { w: number; h: number } }
interface RasterOut { canvas: OffscreenCanvas; w: number; h: number; anchor: { x: number; y: number }; box: { w: number; h: number } }

/** Estado de um quadro compartilhado pelo desenho das camadas. */
interface LayerCtx {
  sources: Map<string, TexImageSource | VideoFrame | null>
  extra: DrawExtra | undefined
  W: number
  H: number
  /** px do canvas por px do quadro de referência (1920 de largura). */
  px: number
  /** Caixa de cada camada desenhada (contorno de seleção; área do desfoque quando não há `areas`). */
  boxes: Map<string, Mat3>
  /** Quad inteiro de texto/forma (com a margem de contorno/sombra): área do desfoque da camada. */
  areas: Map<string, Mat3>
}

export class Compositor {
  private readonly gl: WebGL2RenderingContext
  private readonly media: twgl.ProgramInfo
  private readonly solid: twgl.ProgramInfo
  private readonly transition: twgl.ProgramInfo
  private readonly quad: twgl.BufferInfo
  private readonly loop: twgl.BufferInfo
  private readonly textures: TextureCache<WebGLTexture>
  private readonly effects: EffectPass
  private readonly px1 = new Uint8Array(4)
  private framesWithoutFx = 0
  // texto/forma: texturas por chave de rasterização (LRU; a expulsa tem a textura apagada)
  private readonly rasters: RasterCache<RasterEntry>
  // texturas de rasterizações com fonte ainda não carregada (fora do cache; apagadas no fim do quadro)
  private readonly transient: WebGLTexture[] = []
  private pending: FontRequest[] = []

  constructor(private readonly canvas: OffscreenCanvas) {
    const gl = createGl(canvas)
    this.gl = gl
    this.media = twgl.createProgramInfo(gl, [VS_QUAD, FS_MEDIA])
    this.solid = twgl.createProgramInfo(gl, [VS_QUAD, FS_SOLID])
    this.transition = twgl.createProgramInfo(gl, [VS_FULL, FS_TRANSITION])
    this.quad = twgl.createBufferInfoFromArrays(gl, { a_pos: { numComponents: 2, data: [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1] } })
    this.loop = twgl.createBufferInfoFromArrays(gl, { a_pos: { numComponents: 2, data: [0, 0, 1, 0, 1, 1, 0, 1] } })
    this.effects = new EffectPass(gl, this.quad)
    this.textures = new TextureCache<WebGLTexture>({
      create: () => createTexture(gl),
      upload: (tex, src, sub) => uploadTexture(gl, tex, src as TexImageSource, sub),
      delete: (tex) => gl.deleteTexture(tex)
    })
    this.rasters = new RasterCache<RasterEntry>({ onEvict: (e) => gl.deleteTexture(e.tex) })
  }

  /**
   * Fontes que o último draw desenhou com a reserva (ainda não carregadas): o worker as carrega e redesenha o quadro.
   * Vazio = o quadro saiu com as fontes certas.
   */
  get pendingFonts(): readonly FontRequest[] {
    return this.pending
  }

  resize(w: number, h: number): void {
    this.canvas.width = Math.max(1, Math.round(w))
    this.canvas.height = Math.max(1, Math.round(h))
  }

  draw(layers: Layer[], sources: Map<string, TexImageSource | VideoFrame | null>, background: string, extra?: DrawExtra): void {
    const gl = this.gl
    const W = this.canvas.width
    const H = this.canvas.height
    // Com efeito ou transição no quadro, as camadas vão para o FBO de acumulação (o efeito precisa ler o que está
    // abaixo; a transição usa FBOs do mesmo pool) e o resultado é copiado ao canvas no fim; sem nada disso, direto no
    // canvas (caminho da F1, sem custo extra).
    const hasFx = layers.some((l) => l.kind === 'effect' || l.kind === 'transition' || this.blurOf(l, H) >= MIN_LAYER_BLUR_PX || hasSpotlight(l))
    // FBOs de efeito liberados depois de IDLE_RELEASE_FRAMES quadros seguidos sem efeito (realocados no próximo)
    this.framesWithoutFx = hasFx ? 0 : this.framesWithoutFx + 1
    if (this.framesWithoutFx === IDLE_RELEASE_FRAMES) this.effects.release()
    const accum = hasFx ? this.effects.accum(W, H) : null
    this.textures.beginFrame()
    this.bindTarget(accum)
    const [r, g, b] = parseColor(background)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    this.pending = []
    const ctx: LayerCtx = { sources, extra, W, H, px: W / REFERENCE_WIDTH, boxes: new Map<string, Mat3>(), areas: new Map<string, Mat3>() }
    this.drawStack(layers, accum, ctx, 'aux')

    if (accum) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, accum.framebuffer)
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
    // rasterizações com fonte ainda não carregada valem só para este quadro
    for (const t of this.transient.splice(0)) gl.deleteTexture(t)
  }

  /** Memória em uso (QA/testes): texturas das camadas, do texto/forma e do passe de efeitos. */
  memoryStats(): CompositorMemStats {
    return { ...this.textures.stats(), effectBytes: this.effects.bytes(), rasterBytes: this.rasters.bytes, rasterCount: this.rasters.size }
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
    this.rasters.clear()
    for (const t of this.transient.splice(0)) gl.deleteTexture(t)
    gl.deleteProgram(this.media.program)
    gl.deleteProgram(this.solid.program)
    gl.deleteProgram(this.transition.program)
    this.effects.dispose()
    for (const b of [this.quad, this.loop]) {
      for (const a of Object.values(b.attribs ?? {})) if (a.buffer) gl.deleteBuffer(a.buffer)
      if (b.indices) gl.deleteBuffer(b.indices)
    }
  }

  // ---- internos ----

  /** Raio (px de saída) do desfoque próprio da camada (preset de animação 'blur'): mídia, texto e forma. */
  private blurOf(l: Layer, H: number): number {
    return (l.kind === 'media' || l.kind === 'text' || l.kind === 'shape') && l.blur ? (l.blur * H) / BLUR_REFERENCE_HEIGHT : 0
  }

  /**
   * Desenha uma pilha de camadas, do fundo ao topo, sobre `target` (já ligado, blend premultiplicado). target null =
   * canvas direto (só quando o quadro não tem efeito, transição nem desfoque). `auxName`: FBO do pool para a camada
   * isolada — a pilha principal usa 'aux'; as sub-pilhas de uma transição usam outro (a própria transição pode estar
   * isolada no 'aux' quando um efeito `track` age sobre ela).
   */
  private drawStack(layers: Layer[], target: twgl.FramebufferInfo | null, ctx: LayerCtx, auxName: string): void {
    const gl = this.gl
    const { W, H } = ctx
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      if (layer.kind === 'effect') {
        // escopo `track` sem a camada da faixa logo abaixo (lacuna, outro efeito…): nada a afetar
        if (target && layer.scope === 'below') this.applyEffect(target, layer, W, H)
        continue
      }
      // holofote: escurece o que já está no alvo fora da forma (antes de desenhar a própria forma, que fica por cima)
      if (target && layer.kind === 'shape') this.spotlight(layer, target, W, H)
      // efeitos de escopo `track` desta faixa (resolveFrame os põe logo depois dela, pelo targetTrackId) e o desfoque
      // da própria camada: ela é desenhada isolada no FBO auxiliar, desfocada, recebe os efeitos e só então é composta
      // sobre o alvo (o efeito age sobre a camada já desfocada; numa transição, sobre a mistura de A e B)
      let last = i
      while (target && layers[last + 1]?.kind === 'effect' && (layers[last + 1] as EffectLayer).scope === 'track' && effectBound(layers, last + 1)) last++
      const blur = this.blurOf(layer, H)
      if (target && (last > i || blur >= MIN_LAYER_BLUR_PX)) {
        const aux = this.effects.fbo(auxName, W, H)
        this.bindTarget(aux)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        this.drawOne(layer, aux, ctx)
        const box = blur >= MIN_LAYER_BLUR_PX && layer.kind !== 'transition' ? (ctx.areas.get(layer.itemId) ?? ctx.boxes.get(layer.itemId)) : undefined
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
        // tarja sobre texto/forma isolado: opaca na região toda (senão só recolore as letras, que seguem legíveis)
        const opaque = layer.kind === 'text' || layer.kind === 'shape'
        for (let j = i + 1; j <= last; j++) this.applyEffect(aux, layers[j] as EffectLayer, W, H, opaque)
        this.bindTarget(target)
        this.effects.composite(aux)
        i = last
        continue
      }
      this.drawOne(layer, target, ctx)
    }
  }

  /** Uma camada sobre `target` (ligado). A transição precisa de alvo FBO (draw garante: transição → acumulação). */
  private drawOne(layer: Layer, target: twgl.FramebufferInfo | null, ctx: LayerCtx): void {
    if (layer.kind === 'transition') {
      if (target) this.drawTransition(layer, target, ctx)
      return
    }
    this.drawLayer(layer, ctx)
  }

  /**
   * Transição: `from` no FBO 'transA' e `to` no 'transB' (transparentes, W×H), cada sub-pilha com a própria acumulação
   * — os efeitos dentro dela (os que cobrem A/B, avaliados nos instantes congelados) agem só sobre o conteúdo dela —;
   * depois o shader mistura A e B sobre `target` (premultiplicado; no 'blur', mistura num FBO e compõe o desfoque dela).
   * Deixa `target` ligado com o blend premultiplicado.
   */
  private drawTransition(t: TransitionLayer, target: twgl.FramebufferInfo, ctx: LayerCtx): void {
    const gl = this.gl
    const { W, H } = ctx
    const a = this.effects.fbo('transA', W, H)
    const b = this.effects.fbo('transB', W, H)
    for (const [fbo, sub] of [[a, t.from], [b, t.to]] as const) {
      this.bindTarget(fbo)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      this.drawStack(sub, fbo, ctx, 'transAux')
    }
    // 'blur': o desfoque é linear, então desfocar A e B e misturar = misturar e desfocar uma vez só (metade do custo):
    // a mistura vai para 'transMix' e o desfoque dela é composto sobre o alvo
    const radius = t.transition === 'blur' ? transitionBlurPx(t.progress, H) : 0
    const mixFbo = radius >= MIN_LAYER_BLUR_PX ? this.effects.fbo('transMix', W, H) : null
    this.bindTarget(mixFbo ?? target)
    if (mixFbo) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    const m = TRANSITION_MODES[t.transition]
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.transition.program)
    twgl.setBuffersAndAttributes(gl, this.transition, this.quad)
    twgl.setUniforms(this.transition, {
      u_a: a.attachments[0] as WebGLTexture,
      u_b: b.attachments[0] as WebGLTexture,
      u_frame: [W, H],
      u_mode: m.mode,
      u_p: t.progress,
      u_dir: m.dir,
      u_color: m.color
    })
    twgl.drawBufferInfo(gl, this.quad)
    if (mixFbo) {
      this.effects.blurOnto(mixFbo, target, radius, W, H)
      this.bindTarget(target)
    }
  }

  /** Desenha uma camada de mídia/anotações/texto/forma no framebuffer ligado. */
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
      case 'text':
      case 'shape':
        this.drawRaster(layer, ctx)
        break
      default:
        break // transição: drawOne → drawTransition; efeito: drawStack
    }
  }

  /**
   * Texto/forma: rasterização do cache (ou nova: Canvas 2D → textura) desenhada como quad w×h com o centro da caixa
   * no centro do transform; registra a caixa (seleção, escopo `track`) e o quad inteiro (área do desfoque da camada).
   */
  private drawRaster(layer: TextLayer | ShapeLayer, ctx: LayerCtx): void {
    const { W, H } = ctx
    const frame = { W, H }
    let e: RasterEntry | null
    if (layer.kind === 'text') {
      if (!layer.text) return
      e = this.raster(textCacheKey(layer, frame), () => {
        const r = rasterizeText(layer, frame)
        return { r, pending: r.pending ? { font: cssFont(layer.style, 16), text: layer.text } : null }
      })
    } else {
      if (!shapeVisible(layer.item)) return
      e = this.raster(shapeCacheKey(layer.item, frame), () => ({ r: rasterizeShape(layer.item, frame), pending: null }))
    }
    if (!e) return
    const canvas = { w: W, h: H }
    const rect = pixelAligned(layer.rect, e.anchor, W, H)
    const mat = anchoredMatrix(rect, e.w, e.h, e.anchor, canvas)
    ctx.areas.set(layer.itemId, mat)
    ctx.boxes.set(layer.itemId, anchoredMatrix(rect, e.box.w, e.box.h, { x: e.box.w / 2, y: e.box.h / 2 }, canvas))
    this.drawQuad(this.media, mat, {
      u_tex: e.tex, u_uv: [0, 0, 1, 1], u_rot: 0, u_mirror: 0, u_opacity: layer.opacity, u_adjust: [0, 0, 0], u_border: 0, u_borderColor: [0, 0, 0, 0],
      u_size: [e.w * layer.rect.scale, e.h * layer.rect.scale], u_shape: 0, u_radius: 0
    })
  }

  /**
   * Entrada do cache de rasterização; sem ela, rasteriza e envia a textura (o canvas é liberado). Fonte ainda não
   * carregada: a textura vale só para este quadro (fora do cache) e a fonte entra em pendingFonts.
   */
  private raster(key: string, make: () => { r: RasterOut; pending: FontRequest | null }): RasterEntry | null {
    const hit = this.rasters.get(key)
    if (hit) return hit
    const { r, pending } = make()
    if (!(r.w > 0 && r.h > 0)) return null
    const tex = createTexture(this.gl)
    uploadTexture(this.gl, tex, r.canvas)
    const entry: RasterEntry = { tex, w: r.w, h: r.h, anchor: r.anchor, box: r.box }
    const bytes = r.canvas.width * r.canvas.height * 4
    r.canvas.width = 0
    r.canvas.height = 0
    if (pending) {
      this.transient.push(tex)
      this.pending.push(pending)
    } else this.rasters.set(key, entry, bytes)
    return entry
  }

  /** Holofote da forma (se tiver): escurece o alvo fora dela com preto·dim·opacidade; religa o alvo com o blend. */
  private spotlight(layer: ShapeLayer, target: twgl.FramebufferInfo, W: number, H: number): void {
    const r = spotlightRegion(layer, { W, H })
    if (!r) return
    const gl = this.gl
    this.effects.dimOutside(target, r, r.dim * layer.opacity, SPOTLIGHT_FEATHER_PX, W, H, r.cornerPx)
    this.bindTarget(target)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  /** Efeito sobre o alvo; devolve o estado de desenho das camadas (alvo ligado, blend premultiplicado). */
  private applyEffect(target: twgl.FramebufferInfo, layer: EffectLayer, W: number, H: number, opaque = false): void {
    const gl = this.gl
    this.effects.applyEffect(target, layer, W, H, opaque)
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

const hasSpotlight = (l: Layer): boolean => l.kind === 'shape' && !!spotlightRegion(l)

/**
 * Texto/forma parado em escala 1 sem rotação: desloca o centro (< ½ px) para o canto do quad cair num pixel inteiro —
 * 1 texel = 1 pixel, sem reamostragem bilinear (letras nítidas). Com escala/rotação o quad é reamostrado de qualquer jeito.
 */
function pixelAligned(rect: TextLayer['rect'], anchor: { x: number; y: number }, W: number, H: number): TextLayer['rect'] {
  if (rect.scale !== 1 || rect.rotation % 360 !== 0) return rect
  const x0 = rect.cx * W - anchor.x
  const y0 = rect.cy * H - anchor.y
  return { ...rect, cx: rect.cx + (Math.round(x0) - x0) / W, cy: rect.cy + (Math.round(y0) - y0) / H }
}

function shapeUniforms(layer: MediaLayer, size: [number, number], px: number): { u_size: [number, number]; u_shape: number; u_radius: number } {
  const radius = layer.shape === 'rounded' ? (layer.radius > 0 ? layer.radius * px : DEFAULT_ROUNDED * Math.min(size[0], size[1])) : 0
  return { u_size: size, u_shape: SHAPE_CODE[layer.shape], u_radius: radius }
}
