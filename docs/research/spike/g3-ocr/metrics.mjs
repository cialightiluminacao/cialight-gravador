// Spike G3 — métricas comuns aos motores de OCR (recall de strings, caixas, tempos).
// Entrada de um motor, por tela: { lines: [{ t: 'texto da linha', w: [[palavra, x, y, w, h], ...] }] }
// em pixels da imagem ENVIADA (scale = fator de ampliação aplicado antes do OCR).
import { readFileSync } from 'node:fs'

const CONF = { O: '0', o: '0', D: '0', l: '1', I: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2' }
// normalização leve do brief: sem espaços; O→0, l/I→1, S→5 só DENTRO de sequências de dígitos
const BRIEF_CONF = new Set(['O', 'l', 'I', 'S'])
export function normalize(s) {
  const a = s.replace(/\s+/g, '').split('')
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < a.length; i++) {
      if (!BRIEF_CONF.has(a[i])) continue
      if (/[0-9]/.test(a[i - 1] ?? '') || /[0-9]/.test(a[i + 1] ?? '')) { a[i] = CONF[a[i]]; changed = true }
    }
  }
  return a.join('')
}

// tolerante (diagnóstico p/ o detector): dobra classes de glifos ambíguos em QUALQUER posição e ignora caixa;
// e/ê/@/ø viram 0 junto de dígitos (o zero cortado/pontilhado do Consolas é lido assim).
const FOLD = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', '!': '1', S: '5', B: '8', Z: '2' }
export function lenient(s) {
  const a = s.replace(/[\s_]+/g, '').split('')
  for (let i = 0; i < a.length; i++) if (/[eêé@øØ]/.test(a[i]) && (/[0-9]/.test(a[i - 1] ?? '') || /[0-9]/.test(a[i + 1] ?? ''))) a[i] = '0'
  return a.map((c) => FOLD[c] ?? c).join('').toLowerCase()
}

export const loadTruth = (path) => JSON.parse(readFileSync(path, 'utf8'))

const quant = (arr, q) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}
export const median = (arr) => quant(arr, 0.5)
export { quant }

/** Avalia um quadro: devolve um registro por item de verdade daquela tela. */
export function scoreScreen(items, ocr, scale) {
  const rawText = ocr.lines.map((l) => l.t).join('\n')
  // concatenação das palavras sem separador → normalização preserva o comprimento (só trocas 1:1)
  let cat = ''
  const owner = []
  const words = []
  for (const l of ocr.lines) for (const w of l.w) {
    const idx = words.length
    words.push(w)
    for (let k = 0; k < w[0].length; k++) owner.push(idx)
    cat += w[0]
  }
  const normCat = normalize(cat)
  const lenientCat = lenient(cat)
  return items.map((it) => {
    const raw = rawText.includes(it.value)
    const nt = normalize(it.value)
    const at = normCat.indexOf(nt)
    const rec = { id: it.id, cat: it.cat, size: it.size, font: it.font, theme: it.theme, accent: it.accent, raw, norm: at >= 0 }
    rec.lenient = lenientCat.includes(lenient(it.value))
    // presença: palavras do OCR cobrindo ≥ 90 % da largura da tinta da verdade (independe de ler certo);
    // vãos entre palavras de até 0,8 × corpo da fonte contam como cobertos (espaços não têm caixa)
    {
      const t = it.ink
      const iv = []
      for (const [, x, y, w, h] of words) {
        const X0 = x / scale, X1 = (x + w) / scale, Y0 = y / scale, Y1 = (y + h) / scale
        if (Y1 <= t.y || Y0 >= t.y + t.h || X1 <= t.x || X0 >= t.x + t.w) continue
        iv.push([Math.max(X0, t.x), Math.min(X1, t.x + t.w)])
      }
      iv.sort((p, q) => p[0] - q[0])
      let cov = 0, end = -1e9
      const gap = 0.8 * it.size
      for (const [p, q] of iv) {
        if (q <= end) continue
        cov += p - end <= gap && end > -1e9 ? q - end : q - p
        end = q
      }
      rec.coverage = cov / t.w
      rec.present = rec.coverage >= 0.9
    }
    if (at >= 0) {
      const ws = new Set(owner.slice(at, at + nt.length))
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (const i of ws) {
        const [, x, y, w, h] = words[i]
        x0 = Math.min(x0, x / scale); y0 = Math.min(y0, y / scale)
        x1 = Math.max(x1, (x + w) / scale); y1 = Math.max(y1, (y + h) / scale)
      }
      const t = it.ink
      const tx1 = t.x + t.w, ty1 = t.y + t.h
      const ix = Math.max(0, Math.min(x1, tx1) - Math.max(x0, t.x))
      const iy = Math.max(0, Math.min(y1, ty1) - Math.max(y0, t.y))
      const inter = ix * iy
      rec.iou = inter / ((x1 - x0) * (y1 - y0) + t.w * t.h - inter)
      // margem (px do quadro original) que a caixa do OCR precisa crescer para conter a tinta da verdade
      rec.marginPx = Math.max(0, x0 - t.x, tx1 - x1, y0 - t.y, ty1 - y1)
      rec.marginRel = rec.marginPx / it.size
      rec.box = [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v * 10) / 10)
    }
    return rec
  })
}

/** Agrega registros por chave (ex.: 'size', 'cat', 'font'). */
export function aggregate(recs, key) {
  const groups = new Map()
  for (const r of recs) {
    const k = typeof key === 'function' ? key(r) : r[key]
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const rows = []
  for (const [k, rs] of [...groups].sort((a, b) => (a[0] > b[0] ? 1 : -1))) {
    const found = rs.filter((r) => r.norm)
    rows.push({
      key: k, n: rs.length,
      rawRecall: rs.filter((r) => r.raw).length / rs.length,
      lenientRecall: rs.filter((r) => r.lenient).length / rs.length,
      presence: rs.filter((r) => r.present).length / rs.length,
      normRecall: found.length / rs.length,
      iouMedian: median(found.map((r) => r.iou)),
      iouMin: Math.min(...found.map((r) => r.iou)),
      marginP99Px: quant(found.map((r) => r.marginPx), 0.99),
      marginP99Rel: quant(found.map((r) => r.marginRel), 0.99)
    })
  }
  return rows
}

export const pct = (v) => (Number.isFinite(v) ? (100 * v).toFixed(1) + '%' : '—')
export function printTable(title, rows) {
  console.log(`\n${title}`)
  console.log('chave'.padEnd(22) + 'n'.padStart(5) + 'raw'.padStart(8) + 'norm'.padStart(8) + 'toler'.padStart(8) + 'pres'.padStart(8) + 'IoUmed'.padStart(8) + 'IoUmin'.padStart(8) + 'm99px'.padStart(7) + 'm99/fs'.padStart(8))
  for (const r of rows) {
    console.log(String(r.key).padEnd(22) + String(r.n).padStart(5) + pct(r.rawRecall).padStart(8) + pct(r.normRecall).padStart(8) + pct(r.lenientRecall).padStart(8) + pct(r.presence).padStart(8) +
      (r.iouMedian ?? NaN).toFixed(2).padStart(8) + (Number.isFinite(r.iouMin) ? r.iouMin.toFixed(2) : '—').padStart(8) +
      (Number.isFinite(r.marginP99Px) ? r.marginP99Px.toFixed(1) : '—').padStart(7) + (Number.isFinite(r.marginP99Rel) ? r.marginP99Rel.toFixed(2) : '—').padStart(8))
  }
}
