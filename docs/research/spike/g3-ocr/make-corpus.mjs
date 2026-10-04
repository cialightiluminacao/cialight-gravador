// Spike G3 — gera o corpus SINTÉTICO de "telas" 1920×1080 com dados sensíveis falsos.
// Uso: node docs/research/spike/g3-ocr/make-corpus.mjs
// Saída (git-ignored): test-out/g3-ocr/corpus/{png,h264}/*.png + truth.json
//  - png/  : render GDI (ClearType) direto, sem perdas
//  - h264/ : mesmo quadro após ida-e-volta libx264 yuv420p crf 23 (pessimista vs. a gravação de 12 Mb/s)
// Verdade: string + retângulo de layout (GDI) + retângulo de tinta (pixels medidos).
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const FFMPEG = join(ROOT, 'resources/ffmpeg/ffmpeg.exe')
const OUT = join(ROOT, 'test-out/g3-ocr/corpus')
mkdirSync(join(OUT, 'png'), { recursive: true })
mkdirSync(join(OUT, 'h264'), { recursive: true })

// PRNG determinístico (corpus reprodutível)
let seed = 20261003
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const digits = (n) => Array.from({ length: n }, () => ri(0, 9)).join('')
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const B64U = ALNUM + '-_'
const str = (n, set = ALNUM) => Array.from({ length: n }, () => set[ri(0, set.length - 1)]).join('')

function cpf() {
  const d = Array.from({ length: 9 }, () => ri(0, 9))
  for (const len of [9, 10]) {
    let s = 0
    for (let i = 0; i < len; i++) s += d[i] * (len + 1 - i)
    const r = (s * 10) % 11
    d.push(r === 10 ? 0 : r)
  }
  return d.join('')
}
function cnpj() {
  const d = [...Array.from({ length: 8 }, () => ri(0, 9)), 0, 0, 0, 1]
  for (const w of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const s = w.reduce((a, wi, i) => a + wi * d[i], 0)
    const r = s % 11
    d.push(r < 2 ? 0 : 11 - r)
  }
  const x = d.join('')
  return `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}`
}
function card() {
  const d = [pick([4, 5]), ...Array.from({ length: 14 }, () => ri(0, 9))]
  let s = 0
  for (let i = 0; i < 15; i++) {
    let v = d[14 - i]
    if (i % 2 === 0) { v *= 2; if (v > 9) v -= 9 }
    s += v
  }
  d.push((10 - (s % 10)) % 10)
  const x = d.join('')
  const sep = rnd() < 0.7 ? ' ' : '-'
  return [0, 4, 8, 12].map((i) => x.slice(i, i + 4)).join(sep)
}
const NOMES = ['joao', 'maria', 'ana', 'pedro', 'lucas', 'beatriz', 'carla', 'rafael', 'fernanda', 'gustavo']
const SOBRE = ['silva', 'souza', 'oliveira', 'santos', 'pereira', 'costa', 'almeida', 'ferreira']
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const GEN = {
  cpf_fmt: () => { const c = cpf(); return { label: 'CPF do cliente:', value: `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` } },
  cpf_raw: () => ({ label: 'Documento', value: cpf() }),
  cnpj: () => ({ label: 'CNPJ da empresa:', value: cnpj() }),
  card: () => ({ label: 'Cartão de crédito', value: card() }),
  email: () => ({ label: 'Enviar para', value: `${pick(NOMES)}.${pick(SOBRE)}${ri(1, 99)}@exemplo.com.br` }),
  phone: () => ({ label: 'Telefone:', value: `(${ri(11, 99)}) 9${digits(4)}-${digits(4)}` }),
  cep: () => ({ label: 'CEP', value: `${digits(5)}-${digits(3)}` }),
  plate_new: () => ({ label: 'Placa do veículo', value: `${str(3, L)}${ri(0, 9)}${str(1, L)}${digits(2)}` }),
  plate_old: () => ({ label: 'Placa antiga', value: `${str(3, L)}-${digits(4)}` }),
  uuid: () => {
    const h = '0123456789abcdef'
    const x = str(32, h).split('')
    x[12] = '4'; x[16] = h[8 + ri(0, 3)]
    const s = x.join('')
    return { label: 'Chave PIX', value: `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` }
  },
  ipv4: () => ({ label: 'Servidor em', value: `${ri(10, 223)}.${ri(0, 255)}.${ri(0, 255)}.${ri(1, 254)}` }),
  sk: () => ({ label: 'OPENAI_API_KEY=', value: `sk-${str(32)}` }),
  ghp: () => ({ label: 'token', value: `ghp_${str(36)}` }),
  jwt: () => ({ label: 'Authorization: Bearer', value: `eyJhbGciOiJIUzI1NiJ9.eyJ${str(28, B64U)}.${str(30, B64U)}` }),
  senha: () => ({ label: 'Senha:', value: `${str(4)}${pick(['@', '#', '!', '$', '&'])}${str(5)}` })
}
const CATS = Object.keys(GEN)
const SUFFIX = ['', '', 'confirmado', '(atualizado hoje)', '— ver detalhes', 'ok']
const NORMAL = [
  'Resumo do pedido número 4521 aprovado pelo financeiro',
  'Clique em Salvar para concluir a alteração do cadastro',
  'Última sincronização há 3 minutos com o servidor principal',
  'Relatório mensal de vendas por região e categoria',
  'Configurações avançadas de notificações e privacidade',
  'O arquivo foi exportado com sucesso para a pasta Documentos',
  'Atenção: revise os campos obrigatórios antes de enviar'
]

const FONTS = ['Segoe UI', 'Arial', 'Consolas']
const SIZES = [12, 13, 14, 16, 20, 28]
const THEMES = {
  light: { bg: '#F3F3F3', panel: '#FFFFFF', side: '#E6E6E6', title: '#DADADA', text: '#1F1F1F', muted: '#6B6B6B', accent: '#0063B1' },
  dark: { bg: '#1E1E1E', panel: '#252526', side: '#333333', title: '#3C3C3C', text: '#D4D4D4', muted: '#9D9D9D', accent: '#4FC1FF' }
}
const ITEMS_PER_SCREEN = 12
const PANEL = { x: 300, y: 70, w: 1580, h: 980 }

const screens = []
let catIdx = 0
for (const size of SIZES) for (const font of FONTS) for (const theme of Object.keys(THEMES)) {
  const name = `s${size}_${font.replace(/\s/g, '')}_${theme}`
  const th = THEMES[theme]
  const lh = Math.ceil(size * 1.6)
  const lines = []
  const items = []
  let y = PANEL.y + 20
  // alterna linhas normais e linhas com item sensível; com fonte grande algumas linhas normais saem para caber
  const maxLines = Math.floor((PANEL.h - 40) / lh)
  const normalBetween = Math.max(0, Math.min(1, Math.floor((maxLines - ITEMS_PER_SCREEN) / ITEMS_PER_SCREEN)))
  for (let k = 0; k < ITEMS_PER_SCREEN; k++) {
    for (let n = 0; n < normalBetween; n++) {
      lines.push({ x: PANEL.x + 24, y, segs: [{ text: pick(NORMAL), color: th.muted }] })
      y += lh
    }
    const cat = CATS[catIdx++ % CATS.length]
    const g = GEN[cat]()
    const id = `${name}#${k}`
    const valueColor = rnd() < 0.3 ? th.accent : th.text
    const segs = [{ text: g.label, color: th.text }, { text: g.value, color: valueColor, id }]
    const suf = pick(SUFFIX)
    if (suf) segs.push({ text: suf, color: th.muted })
    lines.push({ x: PANEL.x + 24 + ri(0, 200), y, segs })
    items.push({ id, cat, value: g.value, accent: valueColor === th.accent })
    y += lh
  }
  if (y > PANEL.y + PANEL.h) throw new Error(`layout estourou em ${name}`)
  screens.push({ name, font, size, theme, colors: th, panel: PANEL, lines, items })
}

const specPath = join(OUT, 'spec.json')
writeFileSync(specPath, JSON.stringify({ outDir: join(OUT, 'png'), screens }, null, 1))
console.log(`renderizando ${screens.length} telas…`)
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'render-corpus.ps1'), specPath], { stdio: 'inherit' })
const layout = JSON.parse(readFileSync(join(OUT, 'layout.json'), 'utf8').replace(/^﻿/, ''))

// retângulo de tinta: pixels que diferem do fundo do painel dentro do retângulo de layout (+2 px)
const hex2gray = (h) => { const v = parseInt(h.slice(1), 16); return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) }
function grayOf(file) {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 << 20 })
}
const truth = []
for (const s of screens) {
  const png = join(OUT, 'png', `${s.name}.png`)
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', png, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-f', 'h264', join(OUT, 'h264', `${s.name}.264`)])
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', join(OUT, 'h264', `${s.name}.264`), '-frames:v', '1', join(OUT, 'h264', `${s.name}.png`)])
  const g = grayOf(png)
  const bg = hex2gray(s.colors.panel)
  for (const it of s.items) {
    const r = layout[it.id]
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
    for (let y = Math.max(0, r.y - 2); y < Math.min(1080, r.y + r.h + 2); y++)
      for (let x = Math.max(0, r.x - 2); x < Math.min(1920, r.x + r.w + 2); x++)
        if (Math.abs(g[y * 1920 + x] - bg) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    if (x1 < 0) throw new Error(`sem tinta em ${it.id}`)
    truth.push({ ...it, screen: s.name, font: s.font, size: s.size, theme: s.theme, layout: r, ink: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } })
  }
}
writeFileSync(join(OUT, 'truth.json'), JSON.stringify({ screens: screens.map((s) => ({ name: s.name, font: s.font, size: s.size, theme: s.theme })), items: truth }, null, 1))
console.log(`ok: ${screens.length} telas, ${truth.length} strings sensíveis → ${OUT}`)
