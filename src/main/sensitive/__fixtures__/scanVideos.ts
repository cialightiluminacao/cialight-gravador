// Vídeos SINTÉTICOS para os testes reais da varredura de dados sensíveis (scan.ocr.test.ts): telas claras de app
// 1920×1080 a 30 qps (H.264 yuv420p, como as gravações) com linhas de texto normal e valores falsos (sensitiveFakes)
// desenhados pelo drawtext do ffmpeg empacotado em 12/14/16/20 px. A verdade de cada valor é o retângulo de TINTA
// medido em pixels: quadro com tudo − quadro só com os prefixos ("CPF: ", "Senha: "...) no mesmo lugar (y_align=font:
// a posição vertical não depende dos glifos do texto, então o prefixo cai igual nos dois).
// Gera só em test-out/g3-scan/gen (arquivos de texto do drawtext, roteiros de filtro e os vídeos) — nunca no Temp.
import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import {
  fakeCard,
  fakeCep,
  fakeCnpj,
  fakeCpf,
  fakeEmail,
  fakeIpv4,
  fakePhone,
  fakePlate,
  fakeToken,
  fakeUuid,
  formatCard,
  formatCnpj,
  formatCpf,
  NEGATIVE_CORPUS,
  rng
} from '../../../shared/editor/__fixtures__/sensitiveFakes'

export const VW = 1920
export const VH = 1080
export const VFPS = 30
export const SIZES = [12, 14, 16, 20] as const
export type FontName = 'segoe' | 'arial' | 'consolas'
export const FONTS: Record<FontName, string> = { segoe: '/Windows/Fonts/segoeui.ttf', arial: '/Windows/Fonts/arial.ttf', consolas: '/Windows/Fonts/consola.ttf' }
export type ItemKind = 'cpf' | 'cnpj' | 'card' | 'email' | 'phone' | 'cep' | 'plate' | 'pix' | 'ip' | 'sk' | 'ghp' | 'jwt' | 'senha'
export const ITEM_KINDS: readonly ItemKind[] = ['cpf', 'cnpj', 'card', 'email', 'phone', 'cep', 'plate', 'pix', 'ip', 'sk', 'ghp', 'jwt', 'senha']
/** Tipos estruturados (asserção a 14 px Segoe/Arial). */
export const STRUCTURED: ReadonlySet<ItemKind> = new Set(['cpf', 'cnpj', 'card', 'email', 'phone', 'cep', 'plate', 'pix', 'ip'])

const LABELS: Record<ItemKind, string> = {
  cpf: 'CPF: ', cnpj: 'CNPJ: ', card: 'Cartão: ', email: 'E-mail: ', phone: 'Tel.: ', cep: 'CEP: ', plate: 'Placa: ',
  pix: 'Chave PIX: ', ip: 'IP: ', sk: 'API key: ', ghp: 'Token: ', jwt: 'Authorization: Bearer ', senha: 'Senha: '
}

export interface Item {
  id: number
  kind: ItemKind
  size: number
  font: FontName
  prefix: string
  value: string
  x: number
  y: number
  color: string
  /** Retângulo de tinta do VALOR (px do quadro, na posição de t=0 / n=0). */
  ink?: { x: number; y: number; w: number; h: number }
}

function senha(seed: number): string {
  const r = rng(seed + 991)
  const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const sym = '!#$%&*?@'
  let s = ''
  for (let i = 0; i < 9; i++) s += set[Math.floor(r() * set.length)]
  const k = Math.floor(r() * 10)
  return s.slice(0, k) + sym[Math.floor(r() * sym.length)] + s.slice(k)
}

export function fakeValue(kind: ItemKind, seed: number): string {
  switch (kind) {
    case 'cpf': return formatCpf(fakeCpf(seed))
    case 'cnpj': return formatCnpj(fakeCnpj(seed))
    case 'card': return formatCard(fakeCard(seed, 'visa'), ' ')
    case 'email': return fakeEmail(seed)
    case 'phone': return fakePhone(seed, 'paren')
    case 'cep': return fakeCep(seed)
    case 'plate': return fakePlate(seed, seed % 2 ? 'mercosul' : 'oldHyphen')
    case 'pix': return fakeUuid(seed)
    case 'ip': return fakeIpv4(seed)
    case 'sk': return fakeToken(seed, 'sk')
    case 'ghp': return fakeToken(seed, 'ghp')
    case 'jwt': return fakeToken(seed, 'jwt')
    case 'senha': return senha(seed)
  }
}

export interface Screen {
  items: Item[]
  /** Linhas de texto normal (sem dado sensível). */
  normals: { text: string; size: number; font: FontName; x: number; y: number }[]
}

const PANEL_X = 260, PANEL_R = 1880
/** Topo da área de conteúdo (na rolagem, o que passa acima disso fica escondido). */
export const PANEL_Y = 70

/** Uma tela de uma fonte: por tamanho, uma linha normal de cabeçalho e os 13 tipos em fluxo, com linhas normais entre as fileiras. */
export function layoutScreen(font: FontName, seed: number, y0 = PANEL_Y + 10): Screen {
  const items: Item[] = []
  const normals: Screen['normals'] = []
  let y = y0
  let id = seed * 1000
  let nk = seed * 7
  const charW = (size: number): number => size * (font === 'consolas' ? 0.6 : 0.62)
  for (const size of SIZES) {
    const rowH = Math.round(size * 2.1)
    normals.push({ text: NEGATIVE_CORPUS[nk++ % NEGATIVE_CORPUS.length], size, font, x: PANEL_X + 20, y })
    y += rowH
    let x = PANEL_X + 20
    let rowItems = 0
    ITEM_KINDS.forEach((kind, k) => {
      const value = fakeValue(kind, seed * 100 + size * 7 + k)
      const prefix = kind === 'senha' || (k + seed + size) % 3 === 0 ? LABELS[kind] : ''
      const w = (prefix.length + value.length) * charW(size)
      if (x + w > PANEL_R && rowItems > 0) {
        y += rowH
        normals.push({ text: NEGATIVE_CORPUS[nk++ % NEGATIVE_CORPUS.length], size, font, x: PANEL_X + 20, y })
        y += rowH
        x = PANEL_X + 20
        rowItems = 0
      }
      items.push({ id: id++, kind, size, font, prefix, value, x: Math.round(x), y, color: (k + seed) % 10 < 3 ? '0x0067C0' : '0x1F1F1F' })
      x += w + 48
      rowItems++
    })
    y += rowH
  }
  return { items, normals }
}

// ---------------------------------------------------------------- ffmpeg

function run(ffmpeg: string, args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg falhou: ${String(stderr).slice(-800)}`))
      else resolve(stdout)
    })
  })
}

/** Fundo claro de app: barra de título, barra lateral com menus, painel branco. */
function chrome(): string[] {
  return [
    'drawbox=x=0:y=0:w=1920:h=40:color=0xE1E1E1:t=fill',
    'drawbox=x=0:y=40:w=230:h=1040:color=0xEBEBEB:t=fill',
    `drawbox=x=${PANEL_X - 10}:y=${PANEL_Y - 10}:w=${PANEL_R - PANEL_X + 30}:h=${VH - PANEL_Y}:color=0xFFFFFF:t=fill`
  ]
}

interface DrawOpts {
  /** y extra por quadro (rolagem): y = y0 - pxPerFrame*n. */
  pxPerFrame?: number
  /** Só desenha nos quadros [n0, n1]. */
  enable?: [number, number]
}

export class Generator {
  private n = 0
  constructor(readonly ffmpeg: string, readonly dir: string) {
    mkdirSync(join(dir, 'txt'), { recursive: true })
  }
  private textFile(text: string): string {
    const p = join(this.dir, 'txt', `${this.n++}.txt`)
    writeFileSync(p, text, 'utf8')
    return relative(this.dir, p).replace(/\\/g, '/')
  }
  private drawtext(text: string, font: FontName, size: number, x: number, y: number, color: string, o: DrawOpts = {}): string {
    const yExpr = o.pxPerFrame ? `${y}-${o.pxPerFrame}*n` : String(y)
    const en = o.enable ? `:enable=between(n\\,${o.enable[0]}\\,${o.enable[1]})` : ''
    return `drawtext=fontfile=${FONTS[font]}:textfile=${this.textFile(text)}:expansion=none:y_align=font:fontsize=${size}:fontcolor=${color}:x=${x}:y=${yExpr}${en}`
  }
  /** Filtro: chrome, linhas normais, itens (prefixo+valor, só prefixo, ou nada) e, na rolagem, o que fica por cima. */
  filter(screens: { s: Screen; dy: number }[], what: 'full' | 'prefix' | 'none', o: { items?: DrawOpts; normals?: DrawOpts; topChrome?: boolean } = {}): string {
    const parts = [...chrome()]
    for (const { s, dy } of screens) {
      for (const l of s.normals) parts.push(this.drawtext(l.text, l.font, l.size, l.x, l.y + dy, '0x3A3A3A', o.normals))
      if (what !== 'none') for (const it of s.items) {
        const text = what === 'full' ? it.prefix + it.value : it.prefix
        if (text) parts.push(this.drawtext(text, it.font, it.size, it.x, it.y + dy, it.color, o.items))
      }
    }
    // rolagem: barra de título e cabeçalho do painel por cima (o conteúdo some embaixo deles)
    if (o.topChrome) parts.push('drawbox=x=0:y=0:w=1920:h=40:color=0xE1E1E1:t=fill', `drawbox=x=230:y=40:w=1690:h=${PANEL_Y - 40}:color=0xF3F3F3:t=fill`)
    return parts.join(',\n')
  }
  private script(name: string, body: string): string {
    const p = join(this.dir, `${name}.filter.txt`)
    writeFileSync(p, `format=rgb24,\n${body}`, 'utf8')
    return p
  }
  /** Um quadro (n=0) em cinza cru, em memória. */
  async still(name: string, body: string): Promise<Uint8Array> {
    const f = this.script(name, `${body},\nformat=gray`)
    const out = await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0xF3F3F3:s=${VW}x${VH}:r=${VFPS}:d=1`, '-/vf', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], this.dir)
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
  /** Vídeo H.264 yuv420p 30 qps (reaproveita se já existe). */
  async video(name: string, body: string, seconds: number): Promise<string> {
    const out = join(this.dir, `${name}.mp4`)
    if (existsSync(out)) return out
    const f = this.script(name, body)
    await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xF3F3F3:s=${VW}x${VH}:r=${VFPS}:d=${seconds}`, '-/vf', f,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '60', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${name}.part.mp4`], this.dir)
    const { renameSync } = await import('fs')
    renameSync(join(this.dir, `${name}.part.mp4`), out)
    return out
  }
}

/** Mede a tinta de cada valor: pixels que diferem (> 24 níveis) entre o quadro completo e o só-prefixos, na célula do item. */
export function measureInk(full: Uint8Array, prefix: Uint8Array, items: Item[]): void {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  for (const it of items) {
    // célula: da linha do item até antes do próximo item na mesma fileira
    const nextX = sorted.filter((o) => o.y === it.y && o.x > it.x).reduce((m, o) => Math.min(m, o.x), VW)
    const y0 = Math.max(0, it.y - Math.round(it.size * 0.5)), y1 = Math.min(VH, it.y + Math.round(it.size * 1.6))
    let x0 = Infinity, x1 = -Infinity, yy0 = Infinity, yy1 = -Infinity
    for (let y = y0; y < y1; y++) for (let x = it.x; x < nextX - 2; x++) {
      const i = y * VW + x
      if (Math.abs(full[i] - prefix[i]) > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < yy0) yy0 = y
        if (y > yy1) yy1 = y
      }
    }
    if (x1 >= x0) it.ink = { x: x0, y: yy0, w: x1 - x0 + 1, h: yy1 - yy0 + 1 }
  }
}
