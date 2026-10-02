// Passe de efeitos de privacidade do compositor (blur gaussiano, pixelização, tarja sólida), WebGL2.
// Opera sobre um alvo W×H (o FBO de acumulação ou o auxiliar de uma camada isolada): copia a área afetada
// (caixa da região + margem do kernel/bloco) para um snapshot, processa só essa área (scissor) e reescreve
// o alvo com a máscara da região (retângulo/elipse rotacionado, borda suave, invertida = quadro inteiro).
// Blur: redução 2/4/8× alinhada ao quadro → gaussiano H e V (σ = raio/2) → ampliação bilinear na composição.
// Pixelização: média exata de cada bloco (passes H e V de caixa, uma textura com um texel por bloco).
// Tamanhos por effectsMath (proporcionais à altura de saída): mesma aparência no preview e na exportação.
// Recursos por tamanho de alvo, reaproveitados entre quadros; liberados ao mudar o tamanho e no dispose.
import * as twgl from 'twgl.js'
import type { EffectLayer } from '@shared/editor/resolve'
import { parseColor } from './color'
import { downsampleFactor, effectBlurRadiusPx, effectPixelBlockPx, gaussianWeights, featherPx, pixelCellQ, regionScissor, type PxRect } from './effectsMath'
import { BLUR_MAX_TAPS, FS_APPLY, FS_BLUR, FS_COPY, FS_DOWN, FS_PIXH, FS_PIXV, VS_FULL } from './shaders'

const MODE = { blur: 0, pixelate: 1, solid: 2 } as const
// raio do blur abaixo disso (px de saída): sem efeito visível, o passe não roda
const MIN_BLUR_PX = 0.5

interface Sized {
  w: number
  h: number
  /** Acumulado das camadas (destino do quadro antes de ir ao canvas). */
  accum: twgl.FramebufferInfo
  /** Camada isolada (efeito de escopo `track`), transparente; criado só quando usado. */
  aux: twgl.FramebufferInfo | null
  /** Cópia do que está abaixo do efeito (só a área afetada é atualizada). */
  snapshot: WebGLTexture
  /** Pares ping-pong do blur por fator de redução (tamanho ⌈W/ds⌉×⌈H/ds⌉). */
  blur: Map<number, [twgl.FramebufferInfo, twgl.FramebufferInfo]>
  /** Pixelização: médias por linha (blocos × H) e por bloco (blocos × blocos); bloco ≥ 2 px. Criado no primeiro uso. */
  pix: [twgl.FramebufferInfo, twgl.FramebufferInfo] | null
}

export class EffectPass {
  private readonly copy: twgl.ProgramInfo
  private readonly down: twgl.ProgramInfo
  private readonly blurProg: twgl.ProgramInfo
  private readonly apply: twgl.ProgramInfo
  private readonly pixH: twgl.ProgramInfo
  private readonly pixV: twgl.ProgramInfo
  private sized: Sized | null = null
  private readonly weights = new Float32Array(BLUR_MAX_TAPS + 1)

  constructor(private readonly gl: WebGL2RenderingContext, private readonly quad: twgl.BufferInfo) {
    this.copy = twgl.createProgramInfo(gl, [VS_FULL, FS_COPY])
    this.down = twgl.createProgramInfo(gl, [VS_FULL, FS_DOWN])
    this.blurProg = twgl.createProgramInfo(gl, [VS_FULL, FS_BLUR])
    this.apply = twgl.createProgramInfo(gl, [VS_FULL, FS_APPLY])
    this.pixH = twgl.createProgramInfo(gl, [VS_FULL, FS_PIXH])
    this.pixV = twgl.createProgramInfo(gl, [VS_FULL, FS_PIXV])
  }

  /** FBO de acumulação W×H (recriado só quando o tamanho muda). */
  accum(W: number, H: number): twgl.FramebufferInfo {
    return this.ensure(W, H).accum
  }

  /** FBO auxiliar W×H (camada isolada do escopo `track`), alocado no primeiro uso. */
  aux(W: number, H: number): twgl.FramebufferInfo {
    const s = this.ensure(W, H)
    if (!s.aux) s.aux = this.makeFbo(W, H)
    return s.aux
  }

  /** Libera os FBOs/texturas por tamanho (quadros sem efeito); o próximo efeito os realoca. */
  release(): void {
    this.freeSized()
  }

  /** Compõe o alvo `src` (premultiplicado) sobre o framebuffer ligado (blend já configurado pelo chamador). */
  composite(src: twgl.FramebufferInfo): void {
    this.pass(this.copy, { u_tex: src.attachments[0] as WebGLTexture })
  }

  /** Aplica o efeito sobre o conteúdo atual de `target` (W×H). Deixa o blend desligado e o scissor desligado. */
  applyEffect(target: twgl.FramebufferInfo, fx: EffectLayer, W: number, H: number): void {
    const gl = this.gl
    const s = this.ensure(W, H)
    const area: PxRect = fx.invert ? { x: 0, y: 0, w: W, h: H } : regionScissor(fx.region, fx.feather, W, H)
    if (area.w <= 0 || area.h <= 0) return
    const radius = fx.effect === 'blur' ? effectBlurRadiusPx(fx.strength, fx.region, W, H, fx.invert) : 0
    // bloco em 1/256 px (conta inteira exata nos shaders)
    const q = pixelCellQ(effectPixelBlockPx(fx.strength, fx.region, W, H, fx.invert))
    const cell = q / 256
    if (fx.effect === 'blur' && radius < MIN_BLUR_PX) return
    gl.disable(gl.BLEND)
    gl.enable(gl.SCISSOR_TEST)

    let fxTex: WebGLTexture = s.snapshot
    let fxScale: [number, number] = [1 / W, 1 / H]
    if (fx.effect === 'blur') {
      const b = this.blurArea(s, target, area, radius, W, H)
      fxTex = b.tex
      fxScale = b.scale
    } else {
      // pixelização: blocos que cruzam a borda da área usam pixels até um bloco além dela
      const margin = fx.effect === 'pixelate' ? Math.ceil(cell) + 2 : 0
      const copyRect = clampRect({ x: area.x - margin, y: area.y - margin, w: area.w + 2 * margin, h: area.h + 2 * margin }, W, H)
      this.snap(target, s.snapshot, copyRect)
      if (fx.effect === 'pixelate') {
        // blocos (bx, by — by de cima) que tocam a área; centros de pixel pela mesma conta do FS_APPLY
        const blk = (px: number): number => Math.floor(((2 * px + 1) * 128) / q)
        const bx0 = blk(area.x)
        const bx1 = blk(area.x + area.w - 1)
        const by0 = blk(H - area.y - area.h)
        const by1 = blk(H - 1 - area.y)
        const [rows, blocks] = this.pixPair(s)
        twgl.bindFramebufferInfo(gl, rows)
        this.scissor({ x: bx0, y: copyRect.y, w: bx1 - bx0 + 1, h: copyRect.h })
        this.pass(this.pixH, { u_src: s.snapshot, u_q: q })
        twgl.bindFramebufferInfo(gl, blocks)
        this.scissor({ x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 })
        this.pass(this.pixV, { u_tex: rows.attachments[0], u_q: q, u_h: H })
        fxTex = blocks.attachments[0] as WebGLTexture
      }
    }

    const th = (fx.region.rotation * Math.PI) / 180
    twgl.bindFramebufferInfo(gl, target)
    this.scissor(area)
    this.pass(this.apply, {
      u_src: s.snapshot,
      u_fx: fxTex,
      u_fxScale: fxScale,
      u_frame: [W, H],
      u_mode: MODE[fx.effect],
      u_q: q,
      u_color: parseColor(fx.color).slice(0, 3),
      u_center: [fx.region.x * W, fx.region.y * H],
      u_half: [(Math.abs(fx.region.w) * W) / 2, (Math.abs(fx.region.h) * H) / 2],
      u_rot: [Math.cos(th), Math.sin(th)],
      u_shape: fx.region.shape === 'ellipse' ? 1 : 0,
      u_feather: featherPx(fx.region, fx.feather, W, H),
      u_invert: fx.invert ? 1 : 0
    })
    gl.disable(gl.SCISSOR_TEST)
  }

  /**
   * Desfoque gaussiano de raio `radius` px na área `area` do alvo (W×H, camada isolada e transparente; preset de
   * animação 'blur' — effectsMath.layerBlurRect: a caixa da camada + o alcance do blur): o mesmo caminho do blur dos
   * efeitos (redução, H e V, ampliação bilinear), com máscara 1 na área. Deixa o blend e o scissor desligados.
   */
  blurLayer(target: twgl.FramebufferInfo, radius: number, W: number, H: number, area: PxRect): void {
    if (radius < MIN_BLUR_PX || area.w <= 0 || area.h <= 0) return
    const gl = this.gl
    const s = this.ensure(W, H)
    gl.disable(gl.BLEND)
    gl.enable(gl.SCISSOR_TEST)
    const b = this.blurArea(s, target, area, radius, W, H)
    twgl.bindFramebufferInfo(gl, target)
    this.scissor(area)
    // região = o quadro inteiro + 1 px, sem borda suave: máscara 1 em todo pixel da área (o scissor limita)
    this.pass(this.apply, {
      u_src: s.snapshot, u_fx: b.tex, u_fxScale: b.scale, u_frame: [W, H], u_mode: MODE.blur, u_q: 512, u_color: [0, 0, 0],
      u_center: [W / 2, H / 2], u_half: [W / 2 + 1, H / 2 + 1], u_rot: [1, 0], u_shape: 0, u_feather: 0, u_invert: 0
    })
    gl.disable(gl.SCISSOR_TEST)
  }

  /** Libera programas, FBOs e texturas. */
  dispose(): void {
    const gl = this.gl
    this.freeSized()
    for (const p of [this.copy, this.down, this.blurProg, this.apply, this.pixH, this.pixV]) gl.deleteProgram(p.program)
  }

  // ---- internos ----

  private ensure(W: number, H: number): Sized {
    if (this.sized && this.sized.w === W && this.sized.h === H) return this.sized
    this.freeSized()
    const gl = this.gl
    this.sized = {
      w: W,
      h: H,
      accum: this.makeFbo(W, H),
      aux: null,
      snapshot: twgl.createTexture(gl, { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE, width: W, height: H }),
      blur: new Map(),
      pix: null
    }
    return this.sized
  }

  /**
   * Blur da área `area` do alvo (scissor ligado, blend desligado): copia a área + alcance do kernel para o snapshot,
   * reduz ds× e aplica o gaussiano H e V. Devolve a textura reduzida e a escala para lê-la em px do alvo.
   */
  private blurArea(s: Sized, target: twgl.FramebufferInfo, area: PxRect, radius: number, W: number, H: number): { tex: WebGLTexture; scale: [number, number] } {
    const gl = this.gl
    const ds = downsampleFactor(radius)
    const w = gaussianWeights(radius / ds, BLUR_MAX_TAPS)
    this.weights.fill(0)
    this.weights.set(w)
    const n = w.length - 1
    const [a, b] = this.blurPair(s, ds)
    const dw = a.width
    const dh = a.height
    // área em texels da escala reduzida; cada passe anterior cobre a área do seguinte + o alcance do kernel
    const e = n + 2
    const vRect = grow(toGrid(area, ds), 1, dw, dh)
    const hRect = grow(vRect, e, dw, dh)
    const dRect = grow(vRect, 2 * e, dw, dh)
    const copyRect = clampRect({ x: dRect.x * ds, y: dRect.y * ds, w: dRect.w * ds, h: dRect.h * ds }, W, H)
    this.snap(target, s.snapshot, copyRect)
    twgl.bindFramebufferInfo(gl, a)
    this.scissor(dRect)
    this.pass(this.down, { u_src: s.snapshot, u_srcSize: [W, H], u_ds: ds })
    twgl.bindFramebufferInfo(gl, b)
    this.scissor(hRect)
    this.pass(this.blurProg, { u_tex: a.attachments[0], u_dir: [1, 0], u_n: n, u_w: this.weights })
    twgl.bindFramebufferInfo(gl, a)
    this.scissor(vRect)
    this.pass(this.blurProg, { u_tex: b.attachments[0], u_dir: [0, 1], u_n: n, u_w: this.weights })
    return { tex: a.attachments[0] as WebGLTexture, scale: [1 / (ds * dw), 1 / (ds * dh)] }
  }

  /** FBOs da pixelização: bloco ≥ 2 px → no máximo ⌈W/2⌉+1 blocos por linha e ⌈H/2⌉+1 por coluna. */
  private pixPair(s: Sized): [twgl.FramebufferInfo, twgl.FramebufferInfo] {
    if (!s.pix) {
      const bw = Math.ceil(s.w / 2) + 1
      s.pix = [this.makeFbo(bw, s.h), this.makeFbo(bw, Math.ceil(s.h / 2) + 1)]
    }
    return s.pix
  }

  private blurPair(s: Sized, ds: number): [twgl.FramebufferInfo, twgl.FramebufferInfo] {
    let pair = s.blur.get(ds)
    if (!pair) {
      const w = Math.ceil(s.w / ds)
      const h = Math.ceil(s.h / ds)
      pair = [this.makeFbo(w, h), this.makeFbo(w, h)]
      s.blur.set(ds, pair)
    }
    return pair
  }

  private makeFbo(w: number, h: number): twgl.FramebufferInfo {
    const gl = this.gl
    return twgl.createFramebufferInfo(gl, [{ internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE }], w, h)
  }

  private freeFbo(f: twgl.FramebufferInfo): void {
    const gl = this.gl
    gl.deleteFramebuffer(f.framebuffer)
    for (const a of f.attachments) gl.deleteTexture(a as WebGLTexture)
  }

  private freeSized(): void {
    const s = this.sized
    if (!s) return
    this.freeFbo(s.accum)
    if (s.aux) this.freeFbo(s.aux)
    this.gl.deleteTexture(s.snapshot)
    for (const [a, b] of [...s.blur.values(), ...(s.pix ? [s.pix] : [])]) {
      this.freeFbo(a)
      this.freeFbo(b)
    }
    this.sized = null
  }

  /** Copia `r` do alvo para a mesma posição do snapshot. */
  private snap(target: twgl.FramebufferInfo, snapshot: WebGLTexture, r: PxRect): void {
    const gl = this.gl
    if (r.w <= 0 || r.h <= 0) return
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
    gl.bindTexture(gl.TEXTURE_2D, snapshot)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.x, r.y, r.w, r.h)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  }

  private scissor(r: PxRect): void {
    this.gl.scissor(r.x, r.y, r.w, r.h)
  }

  private pass(prog: twgl.ProgramInfo, uniforms: Record<string, unknown>): void {
    const gl = this.gl
    gl.useProgram(prog.program)
    twgl.setBuffersAndAttributes(gl, prog, this.quad)
    twgl.setUniforms(prog, uniforms)
    twgl.drawBufferInfo(gl, this.quad)
  }
}

/** Caixa em px → caixa em texels da grade reduzida (ds×), cobrindo-a inteira. */
function toGrid(r: PxRect, ds: number): PxRect {
  const x0 = Math.floor(r.x / ds)
  const y0 = Math.floor(r.y / ds)
  return { x: x0, y: y0, w: Math.ceil((r.x + r.w) / ds) - x0, h: Math.ceil((r.y + r.h) / ds) - y0 }
}

function grow(r: PxRect, by: number, W: number, H: number): PxRect {
  return clampRect({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by }, W, H)
}

function clampRect(r: PxRect, W: number, H: number): PxRect {
  const x0 = Math.max(0, r.x)
  const y0 = Math.max(0, r.y)
  const x1 = Math.min(W, r.x + r.w)
  const y1 = Math.min(H, r.y + r.h)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}
