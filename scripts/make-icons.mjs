// Gera os ícones do app sem dependências externas (encoder PNG mínimo + ICO com PNGs embutidos).
// Saídas: build/icon.png (512), build/icon.ico (16..256), build/tray.png, build/tray-rec.png,
// build/tray-pause.png (32) e resources/icons/*.png para a UI.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- PNG ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- desenho com supersampling ----------
function render(size, draw) {
  const ss = 4
  const S = size * ss
  const acc = new Float32Array(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const c = draw((x + 0.5) / S, (y + 0.5) / S) // retorna [r,g,b,a] 0..1
      const i = (y * S + x) * 4
      acc[i] = c[0] * c[3]
      acc[i + 1] = c[1] * c[3]
      acc[i + 2] = c[2] * c[3]
      acc[i + 3] = c[3]
    }
  }
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * S + (x * ss + dx)) * 4
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; a += acc[i + 3]
        }
      }
      const n = ss * ss
      a /= n
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round((r / n / a) * 255)
        out[o + 1] = Math.round((g / n / a) * 255)
        out[o + 2] = Math.round((b / n / a) * 255)
      }
      out[o + 3] = Math.round(a * 255)
    }
  }
  return out
}

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]
const BG = hex('#171a21')
const CORAL = hex('#ff4d4f')
const WHITE = [1, 1, 1]
const AMBER = hex('#f5b301')

function roundedSquare(u, v, r) {
  const x = Math.abs(u - 0.5), y = Math.abs(v - 0.5)
  const half = 0.5
  const qx = Math.max(x - (half - r), 0), qy = Math.max(y - (half - r), 0)
  return Math.hypot(qx, qy) <= r
}
const inCircle = (u, v, cx, cy, r) => Math.hypot(u - cx, v - cy) <= r

// Ícone do app: quadrado arredondado escuro, anel branco e ponto coral (record).
function appIcon(u, v) {
  if (!roundedSquare(u, v, 0.22)) return [0, 0, 0, 0]
  const d = Math.hypot(u - 0.5, v - 0.5)
  if (d <= 0.2) return [...CORAL, 1]
  if (d >= 0.27 && d <= 0.31) return [...WHITE, 0.92]
  return [...BG, 1]
}
// Bandeja: círculo (cinza claro ocioso; coral gravando; âmbar pausado), fundo transparente.
const trayIcon = (color) => (u, v) => {
  const d = Math.hypot(u - 0.5, v - 0.5)
  if (d <= 0.32) return [...color, 1]
  if (d >= 0.38 && d <= 0.46) return [...color, 0.85]
  return [0, 0, 0, 0]
}

mkdirSync(join(root, 'build'), { recursive: true })
mkdirSync(join(root, 'resources', 'icons'), { recursive: true })

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = sizes.map((s) => ({ s, png: encodePng(s, s, render(s, appIcon)) }))
writeFileSync(join(root, 'build', 'icon.png'), encodePng(512, 512, render(512, appIcon)))
writeFileSync(join(root, 'resources', 'icons', 'app-256.png'), pngs.find((p) => p.s === 256).png)

// ICO com entradas PNG (suportado desde o Vista)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(pngs.length, 4)
let offset = 6 + 16 * pngs.length
const entries = []
const datas = []
for (const { s, png } of pngs) {
  const e = Buffer.alloc(16)
  e[0] = s === 256 ? 0 : s
  e[1] = s === 256 ? 0 : s
  e[2] = 0
  e[3] = 0
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += png.length
  entries.push(e)
  datas.push(png)
}
writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, ...entries, ...datas]))

for (const [name, color] of [['tray', hex('#d9dce3')], ['tray-rec', CORAL], ['tray-pause', AMBER]]) {
  writeFileSync(join(root, 'build', `${name}.png`), encodePng(32, 32, render(32, trayIcon(color))))
  writeFileSync(join(root, 'build', `${name}@2x.png`), encodePng(64, 64, render(64, trayIcon(color))))
  writeFileSync(join(root, 'resources', 'icons', `${name}.png`), encodePng(32, 32, render(32, trayIcon(color))))
}
console.log('ícones gerados em build/ e resources/icons/')
