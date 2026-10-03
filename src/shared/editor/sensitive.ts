// Detecção pura de dados sensíveis em texto de OCR (G3 "Procurar dados sensíveis").
// Entrada: linhas/palavras do OCR com caixas normalizadas 0–1; saída: detecções com caixa.
// Sem DOM/Electron/Node. NUNCA registrar (console.log) valores detectados: é um recurso de privacidade.
// Falso negativo é o erro caro; tipos validados (CPF/CNPJ/cartão) só passam com dígito verificador.

export type SensitiveKind =
  | 'cpf'
  | 'cnpj'
  | 'email'
  | 'phone'
  | 'card'
  | 'cep'
  | 'plate'
  | 'pix'
  | 'ip'
  | 'token'
  | 'labeled'
  | 'custom'

/** Caixa topo-esquerda + tamanho, normalizada 0–1 à imagem do OCR. */
export interface OcrBox {
  x: number
  y: number
  w: number
  h: number
}
export interface OcrWord {
  text: string
  box: OcrBox
}
/** Palavras em ordem de leitura; a caixa da linha é a união das caixas das palavras. */
export interface OcrLine {
  words: OcrWord[]
}
export interface Detection {
  kind: SensitiveKind
  /** Valor canônico normalizado (ex.: só dígitos no CPF). Usado só em memória, p/ agrupar dados iguais entre quadros. */
  value: string
  /** Texto de exibição mascarado (nunca o valor completo). */
  masked: string
  /** União das caixas de TODAS as palavras que contribuíram com algum caractere. */
  box: OcrBox
  /** validated = checksum/estrutura verificada; pattern = só regex. */
  confidence: 'validated' | 'pattern'
}
export interface DetectOpts {
  kinds?: readonly SensitiveKind[]
  customTerms?: readonly string[]
}

export const SENSITIVE_KIND_LABELS: Record<SensitiveKind, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  phone: 'Telefone',
  card: 'Cartão',
  cep: 'CEP',
  plate: 'Placa',
  pix: 'Chave PIX',
  ip: 'IP',
  token: 'Token/chave de API',
  labeled: 'Campo rotulado',
  custom: 'Termo personalizado'
}

// ───────────────────────── validadores ─────────────────────────

function allSame(d: string): boolean {
  for (let i = 1; i < d.length; i++) if (d[i] !== d[0]) return false
  return true
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

/** CPF: 11 dígitos, dois dígitos verificadores, rejeita todos iguais. */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || allSame(digits)) return false
  for (let t = 9; t <= 10; t++) {
    let sum = 0
    for (let i = 0; i < t; i++) sum += (digits.charCodeAt(i) - 48) * (t + 1 - i)
    const dv = ((sum * 10) % 11) % 10
    if (dv !== digits.charCodeAt(t) - 48) return false
  }
  return true
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]

/** CNPJ: 14 dígitos, dois dígitos verificadores, rejeita todos iguais. */
export function isValidCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || allSame(digits)) return false
  for (let t = 12; t <= 13; t++) {
    const w = t === 12 ? CNPJ_W1 : CNPJ_W2
    let sum = 0
    for (let i = 0; i < t; i++) sum += (digits.charCodeAt(i) - 48) * w[i]!
    const r = sum % 11
    const dv = r < 2 ? 0 : 11 - r
    if (dv !== digits.charCodeAt(t) - 48) return false
  }
  return true
}

/** Luhn para cartões (13–19 dígitos). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

// ───────────────────────── máscaras ─────────────────────────

const BULLETS = '••••••'

function stars(n: number): string {
  return '*'.repeat(Math.max(0, n))
}

function rawMask(kind: SensitiveKind, v: string): string {
  switch (kind) {
    case 'cpf':
      return /^\d{11}$/.test(v) ? `***.${v.slice(3, 6)}.***-**` : '***'
    case 'cnpj':
      return /^\d{14}$/.test(v) ? `**.***.${v.slice(5, 8)}/${v.slice(8, 12)}-**` : '***'
    case 'card': {
      const d = digitsOnly(v)
      return d.length >= 13 ? `**** **** **** ${d.slice(-4)}` : '***'
    }
    case 'email': {
      const at = v.lastIndexOf('@')
      if (at < 1) return '***'
      const local = v.slice(0, at)
      const dom = v.slice(at + 1)
      const dot = dom.indexOf('.')
      const rest = dot >= 0 ? dom.slice(dot) : ''
      return `${local[0]}***@${dom[0] ?? ''}***${rest}`
    }
    case 'phone': {
      const d = digitsOnly(v)
      if (d.length < 10) return '***'
      return `(${d.slice(0, 2)}) ${stars(d.length - 6)}-${d.slice(-4)}`
    }
    case 'cep': {
      const d = digitsOnly(v)
      return d.length === 8 ? `*****-${d.slice(5)}` : '***'
    }
    case 'plate': {
      const p = v.replace(/-/g, '').toUpperCase()
      return p.length >= 6 ? `****${p.slice(-3)}` : '***'
    }
    case 'pix':
      return v.length >= 4 ? `xxxxxxxx-…-…-…-${v.slice(-4)}` : '***'
    case 'ip': {
      const parts = v.split('.')
      return parts.length === 4 ? `***.***.***.${parts[3]}` : '***'
    }
    case 'token':
      return v.length > 4 ? `${v.slice(0, 4)}…` : '…'
    case 'labeled': {
      const i = v.search(/[:=]/)
      return i > 0 ? `${v.slice(0, i)}${v[i]} ${BULLETS}` : BULLETS
    }
    case 'custom':
      return v.length > 0 ? `${v[0]}***` : '***'
  }
}

/** Texto de exibição mascarado; nunca devolve o valor completo. */
export function maskSensitive(kind: SensitiveKind, value: string): string {
  const m = rawMask(kind, value)
  // Salvaguarda: valores curtíssimos/estranhos nunca podem aparecer inteiros na máscara.
  if (value.length > 0 && m.includes(value)) return BULLETS
  return m
}

// ───────────────────────── texto por passada ─────────────────────────

interface Pass {
  /** Texto original (palavras unidas por espaço único ou coladas). */
  t: string
  /** Dobrado: minúsculo e sem acento, 1 char por char (índices idênticos a t). */
  f: string
  /** Mapeado p/ dígitos nos tokens "numéricos" (O→0, l→1…), mesmo comprimento. */
  m: string
  /** Índice da palavra de cada char; -1 = separador inserido. */
  wordOf: Int32Array
  /** Índice "colado" (só chars de palavras) de cada char; -1 em separadores. */
  glued: Int32Array
  /** Variante do mapeado em que '|' vira '\' (barra do CNPJ lida como '|'); null se não há '|'. */
  mAlt: string | null
  /** Texto e início (em t) de cada palavra. */
  words: readonly string[]
  wordStart: readonly number[]
  /** Número da passada (1 = espaço único; 2 = vãos pequenos colados). */
  n: 1 | 2
}

function foldChar(ch: string): string {
  const c = ch.charCodeAt(0)
  if (c < 128) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch
  const d = ch.normalize('NFD')[0] ?? ch
  return (d.toLowerCase()[0] ?? d)
}

function fold(t: string): string {
  let out = ''
  for (let i = 0; i < t.length; i++) out += foldChar(t[i]!)
  return out
}

const CONFUSABLE: Record<string, string> = {
  O: '0', o: '0', D: '0', Q: '0',
  l: '1', I: '1', i: '1', '|': '1', '!': '1',
  S: '5', s: '5',
  B: '8',
  Z: '2'
}
const SEP_CHARS = ' .-–—/()'

function isTokChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 124 || c === 33
}

/**
 * Mapeia confusões de OCR para dígitos APENAS em tokens inteiramente "numéricos"
 * (dígitos + confundíveis) que tenham um dígito real, ou que fiquem a ≤ 2 separadores
 * de um token numérico com dígito real. Serve só p/ casar/validar; checksum nunca é relaxado.
 */
function mapDigits(t: string): string {
  const n = t.length
  const starts: number[] = []
  const ends: number[] = []
  const numLike: boolean[] = []
  const hasDigit: boolean[] = []
  let i = 0
  while (i < n) {
    if (!isTokChar(t.charCodeAt(i))) {
      i++
      continue
    }
    const s = i
    let nl = true
    let hd = false
    while (i < n && isTokChar(t.charCodeAt(i))) {
      const ch = t[i]!
      const c = t.charCodeAt(i)
      if (c >= 48 && c <= 57) hd = true
      else if (!(ch in CONFUSABLE)) nl = false
      i++
    }
    // '|' ou '!' sozinhos entre separadores (ex.: barra do CNPJ lida como '|') não viram '1'
    if (i - s === 1 && (t[s] === '|' || t[s] === '!')) nl = false
    starts.push(s)
    ends.push(i)
    numLike.push(nl)
    hasDigit.push(hd)
  }
  const near = (a: number, b: number): boolean => {
    // a = fim do token anterior, b = início do próximo; gap ≤ 2 só com separadores
    if (b - a > 2) return false
    for (let k = a; k < b; k++) if (!SEP_CHARS.includes(t[k]!)) return false
    return true
  }
  // propaga: token só-confundível vira "numérico" se vizinho (≤ 2 separadores) já é; duas varreduras cobrem cadeias
  const mapped = hasDigit.slice()
  const toMap: boolean[] = new Array<boolean>(starts.length).fill(false)
  for (let pass = 0; pass < 2; pass++) {
    const order = pass === 0 ? [...starts.keys()] : [...starts.keys()].reverse()
    for (const k of order) {
      if (!numLike[k] || mapped[k]) continue
      const prevOk = k > 0 && mapped[k - 1] && near(ends[k - 1]!, starts[k]!)
      const nextOk = k + 1 < starts.length && mapped[k + 1] && near(ends[k]!, starts[k + 1]!)
      if (prevOk || nextOk) {
        mapped[k] = true
        toMap[k] = true
      }
    }
  }
  let out: string[] | null = null
  for (let k = 0; k < starts.length; k++) {
    if (!toMap[k]) continue
    out ??= t.split('')
    for (let p = starts[k]!; p < ends[k]!; p++) out[p] = CONFUSABLE[t[p]!]!
  }
  // tokens com dígito real mas também confundíveis ("l23", "O9")
  for (let k = 0; k < starts.length; k++) {
    if (!numLike[k] || !hasDigit[k]) continue
    for (let p = starts[k]!; p < ends[k]!; p++) {
      const r = CONFUSABLE[t[p]!]
      if (r !== undefined) {
        out ??= t.split('')
        out[p] = r
      }
    }
  }
  return out ? out.join('') : t
}

function buildPass(texts: readonly string[], join: readonly boolean[], n: 1 | 2): Pass {
  // join[i] = true => sem separador entre a palavra i e i+1
  let t = ''
  const wo: number[] = []
  const wordStart: number[] = []
  for (let i = 0; i < texts.length; i++) {
    if (i > 0 && !join[i - 1]) {
      t += ' '
      wo.push(-1)
    }
    const w = texts[i]!
    wordStart.push(t.length)
    t += w
    for (let k = 0; k < w.length; k++) wo.push(i)
  }
  const wordOf = Int32Array.from(wo)
  const glued = new Int32Array(wordOf.length)
  let g = 0
  for (let i = 0; i < wordOf.length; i++) glued[i] = wordOf[i]! < 0 ? -1 : g++
  return { t, f: fold(t), m: mapDigits(t), mAlt: t.includes('|') ? mapDigits(t.replace(/\|/g, '\\')) : null, wordOf, glued, words: texts, wordStart, n }
}

// ───────────────────────── candidatos ─────────────────────────

interface Cand {
  kind: SensitiveKind
  value: string
  conf: 'validated' | 'pattern'
  gs: number // início colado
  ge: number // fim colado (exclusivo)
  wa: number // primeira palavra
  wb: number // última palavra
  pass: 1 | 2 // 2 = só a passada de palavras coladas achou (nunca suprime tipo diferente achado na 1)
}

function emit(out: Cand[], p: Pass, kind: SensitiveKind, value: string, conf: Cand['conf'], s: number, e: number): void {
  while (s < e && p.wordOf[s]! < 0) s++
  while (e > s && p.wordOf[e - 1]! < 0) e--
  if (s >= e) return
  out.push({ kind, value, conf, gs: p.glued[s]!, ge: p.glued[e - 1]! + 1, wa: p.wordOf[s]!, wb: p.wordOf[e - 1]!, pass: p.n })
}

// DDDs válidos (ANATEL): 11–19, 21,22,24,27,28, 31–35,37,38, 41–49, 51,53–55, 61–69, 71,73–75,77,79, 81–89, 91–99
const DDD = '(?:1[1-9]|2[12478]|3[1-578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])'
// "9" pode vir separado ("9 8765-4321"). Só números COM parênteses aceitam espaço entre as
// metades ("(41) 3456 7890"); sem parênteses exige hífen/colado, senão linhas de tabela
// ("41 3456 7890") viram telefone. Exceção: celular (assinante começando em 9) aceita espaço
// simples entre as metades ("11 98765 4321"). Decisão: fixo com espaço ("11 3456 7890") NÃO é
// detectado (parecido demais com linha de tabela).
const PH_NUM_P = '(?:9\\s?\\d{4}|[2-5]\\d{3})[\\s-]{0,2}\\d{4}'
const PH_NUM = '(?:9\\s?\\d{4}(?:\\s?[-–]\\s?|\\s)?|[2-5]\\d{3}(?:\\s?[-–]\\s?)?)\\d{4}'
// Telefone: com parênteses OU número "solto" com fronteira estrita; DDD + (9XXXX|[2-5]XXX) + 4 dígitos
const RE_PHONE = new RegExp(
  `(?:(?<!\\d)(?:\\+?55[\\s-]?)?\\(0?${DDD}\\)[\\s-]{0,2}${PH_NUM_P}` +
    `|(?<![A-Za-z0-9])(?<!\\d[.,\\-/])(?:\\+?55[\\s-]?)?0?${DDD}[\\s-]{0,2}${PH_NUM})(?!\\d|[.,]\\d)`,
  'g'
)
const NB = '(?<!\\d)(?<!\\d[.,\\-/])' // fronteira p/ tipos validados (checksum protege contra ruído)
const END = '(?!\\d|[.,]\\d)'
// ',' é leitura errada comum de '.'; '\' e '|' de '/' no CNPJ (o checksum continua protegendo)
const RE_CPF = new RegExp(`${NB}\\d{3}[.,\\s]{0,2}\\d{3}[.,\\s]{0,2}\\d{3}[-–—.,\\s]{0,3}\\d{2}${END}`, 'g')
const RE_CNPJ = new RegExp(`${NB}\\d{2}[.,\\s]{0,2}\\d{3}[.,\\s]{0,2}\\d{3}[/\\\\|\\s]{0,2}\\d{4}[-–—.,\\s]{0,3}\\d{2}${END}`, 'g')
// Cartão: agrupamentos regulares 4-4-4-4[-3], 4-4-4-N (13–15 dígitos), Amex 4-6-5, Diners 4-6-4, ou
// corrido de 13–19 dígitos. O 1º dígito deve ser 2–6 (marcas BR: Visa 4, Master 2/5, Amex 3, Elo
// 4/5/6, Hipercard 6, Diners 3); PANs começando em 7/8/9 (e 0/1) NÃO casam de propósito (menos ruído).
const RE_CARD = new RegExp(
  `${NB}(?:\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{4}(?:[ -]\\d{3})?|\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{1,3}|\\d{4}[ -]\\d{6}[ -]\\d{5}|\\d{4}[ -]\\d{6}[ -]\\d{4}|\\d{13,19})${END}`,
  'g'
)
const RE_CEP = /(?:(?<=(?<![A-Za-z])cep[\s:.\-]{0,3})\d{5}-?\d{3}|(?<![A-Za-z0-9])(?<!\d[.,\-/])\d{5}-\d{3})(?!\d|[.,]\d)/gi
const RE_IP = /(?<![A-Za-z0-9.])(?<!\d[,\-/])(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9]|\.\d)/g
const RE_EMAIL =
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g
const RE_EMAIL_FULL = new RegExp(`^${RE_EMAIL.source}$`)
const PLATE_DENY: ReadonlySet<string> = new Set(['CVE', 'ISO', 'NFE', 'WIN', 'RFC', 'PCI', 'SKU'])
const RE_PLATE = /(?<![A-Za-z0-9])(?:[A-Za-z]{3}-?\d{4}|[A-Za-z]{3}\d[A-Za-z]\d{2})(?![A-Za-z0-9])/g
const H = '[0-9a-fA-F]'
const RE_PIX = new RegExp(`(?<![0-9A-Za-z])${H}{8}-${H}{4}-${H}{4}-${H}{4}-${H}{12}(?![0-9A-Za-z])`, 'g')
const RE_TOKEN = new RegExp(
  [
    '(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}',
    '(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}',
    '(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}',
    '(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{10,}',
    '(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}',
    '(?<![A-Za-z0-9_-])eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+',
    '(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}'
  ].join('|'),
  'g'
)
const RE_LABEL =
  /(?<![a-z0-9])(chave pix|senha|password|passwd|pwd|token|conta|agencia|chave|secret|pin|cvv|codigo de seguranca|api[ _-]?key)[ \t]*([:=])/g

function detectDigitKinds(p: Pass, out: Cand[]): void {
  const m = p.m
  for (const x of m.matchAll(RE_CPF)) {
    const d = digitsOnly(x[0])
    if (isValidCpf(d)) emit(out, p, 'cpf', d, 'validated', x.index, x.index + x[0].length)
  }
  for (const mm of p.mAlt ? [m, p.mAlt] : [m]) {
    for (const x of mm.matchAll(RE_CNPJ)) {
      const d = digitsOnly(x[0])
      if (isValidCnpj(d)) emit(out, p, 'cnpj', d, 'validated', x.index, x.index + x[0].length)
    }
  }
  for (const x of m.matchAll(RE_CARD)) {
    const d = digitsOnly(x[0])
    if (luhnValid(d) && !allSame(d) && d[0]! >= '2' && d[0]! <= '6') emit(out, p, 'card', d, 'validated', x.index, x.index + x[0].length)
  }
  for (const x of m.matchAll(RE_PHONE)) {
    let d = digitsOnly(x[0])
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
    if ((d.length === 11 || d.length === 12) && d[0] === '0') d = d.slice(1)
    if (d.length !== 10 && d.length !== 11) continue
    // 10 dígitos soltos (sem formatação nem +55) são comuns demais (códigos, IDs): não reportar
    if (/^\d+$/.test(x[0]) && x[0].length <= 11 && d.length === 10) continue
    emit(out, p, 'phone', d, 'pattern', x.index, x.index + x[0].length)
  }
  for (const x of m.matchAll(RE_CEP)) emit(out, p, 'cep', digitsOnly(x[0]), 'pattern', x.index, x.index + x[0].length)
  for (const x of m.matchAll(RE_IP)) {
    const parts = x[0].split('.')
    if (parts.every((o) => Number(o) <= 255)) {
      emit(out, p, 'ip', parts.map(Number).join('.'), 'pattern', x.index, x.index + x[0].length)
    }
  }
}

function detectTextKinds(p: Pass, out: Cand[]): void {
  const t = p.t
  if (t.includes('@')) {
    for (const x of t.matchAll(RE_EMAIL)) {
      let s = x.index
      let e = x.index + x[0].length
      // Palavras coladas só continuam o e-mail quando a quebra é plausível: palavra anterior
      // terminando em . _ - + (ou "@" em palavra própria) e, no domínio, terminando em . ou -.
      const at = t.indexOf('@', s)
      const wAt = p.wordOf[at]!
      const wa = p.wordOf[s]!
      const wb = p.wordOf[e - 1]!
      let lo = wAt
      while (lo > wa && (/[._+-]$/.test(p.words[lo - 1]!) || (lo === wAt && p.words[wAt]!.startsWith('@')))) lo--
      if (lo > wa) s = p.wordStart[lo]!
      let hi = wAt
      while (hi < wb && (/[.-]$/.test(p.words[hi]!) || (hi === wAt && p.words[wAt]!.endsWith('@')) || p.words[hi + 1]!.startsWith('.'))) hi++
      if (hi < wb) e = p.wordStart[hi]! + p.words[hi]!.length
      const txt = t.slice(s, e)
      if (!RE_EMAIL_FULL.test(txt)) continue
      emit(out, p, 'email', txt.toLowerCase(), 'pattern', s, e)
    }
  }
  for (const x of t.matchAll(RE_PLATE)) {
    // Prefixos de 3 letras de códigos comuns (não placas): a lista é um trade-off consciente — uma
    // placa real com esses prefixos deixa de ser achada, em troca de menos ruído em texto técnico.
    if (PLATE_DENY.has(x[0].slice(0, 3).toUpperCase())) continue
    emit(out, p, 'plate', x[0].replace('-', '').toUpperCase(), 'pattern', x.index, x.index + x[0].length)
  }
  if (t.includes('-')) {
    for (const x of t.matchAll(RE_PIX)) {
      emit(out, p, 'pix', x[0].toLowerCase(), 'pattern', x.index, x.index + x[0].length)
    }
  }
  for (const x of t.matchAll(RE_TOKEN)) {
    emit(out, p, 'token', x[0], 'pattern', x.index, x.index + x[0].length)
  }
  // rotulados: o valor vai até o próximo rótulo (ou o fim da linha)
  if (p.f.includes(':') || p.f.includes('=')) {
    const ms = [...p.f.matchAll(RE_LABEL)]
    for (let i = 0; i < ms.length; i++) {
      const x = ms[i]!
      const start = x.index
      const afterSep = start + x[0].length
      let vs = afterSep
      let ve = i + 1 < ms.length ? ms[i + 1]!.index : t.length
      while (vs < ve && p.wordOf[vs]! < 0) vs++
      while (ve > vs && p.wordOf[ve - 1]! < 0) ve--
      const label = t.slice(start, start + x[1]!.length)
      const sep = x[2]!
      if (vs < ve) emit(out, p, 'labeled', `${label}${sep} ${t.slice(vs, ve)}`, 'pattern', vs, ve)
      // valor vazio na linha: cobre o próprio rótulo para o usuário decidir
      else emit(out, p, 'labeled', `${label}${sep}`, 'pattern', start, afterSep)
    }
  }
}

interface CustomTerm {
  value: string
  re: RegExp
}

function compileTerms(terms: readonly string[] | undefined): CustomTerm[] {
  const res: CustomTerm[] = []
  for (const raw of terms ?? []) {
    const folded = fold(raw.trim()).replace(/\s+/g, ' ')
    if (folded.length < 2) continue
    const body = folded
      .split(' ')
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*')
    res.push({ value: folded, re: new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'g') })
  }
  return res
}

function detectCustom(p: Pass, terms: readonly CustomTerm[], out: Cand[]): void {
  for (const term of terms) {
    for (const x of p.f.matchAll(term.re)) {
      emit(out, p, 'custom', term.value, 'pattern', x.index, x.index + x[0].length)
    }
  }
}

// ───────────────────────── resolução ─────────────────────────

const DIGIT_PRIORITY: readonly SensitiveKind[] = ['cpf', 'cnpj', 'card', 'phone', 'ip', 'cep']
/** Tipos estruturais fortes: candidatos "numéricos" contidos neles são ruído (ex.: dígitos dentro de e-mail). */
const STRONG: ReadonlySet<SensitiveKind> = new Set(['email', 'token', 'pix'])
const SUPPRESSIBLE: ReadonlySet<SensitiveKind> = new Set(['cpf', 'cnpj', 'card', 'phone', 'ip', 'cep', 'plate'])

/** a está contido em b; um achado só da passada 2 nunca suprime um achado da passada 1. */
function contained(a: Cand, b: Cand): boolean {
  return a.gs >= b.gs && a.ge <= b.ge && !(b.pass === 2 && a.pass === 1)
}

function resolve(all: Cand[]): Cand[] {
  // 1) mesmo tipo com trechos sobrepostos → um só (o mais longo), com a união de palavras
  const byKind = new Map<SensitiveKind, Cand[]>()
  for (const c of all) {
    const arr = byKind.get(c.kind)
    if (arr) arr.push(c)
    else byKind.set(c.kind, [c])
  }
  const merged: Cand[] = []
  for (const arr of byKind.values()) {
    arr.sort((a, b) => a.gs - b.gs || b.ge - a.ge)
    let cur: Cand | null = null
    let curEnd = -1
    for (const c of arr) {
      if (cur && c.gs < curEnd) {
        if (c.ge - c.gs > cur.ge - cur.gs) {
          cur = { ...c, wa: Math.min(c.wa, cur.wa), wb: Math.max(c.wb, cur.wb), gs: Math.min(c.gs, cur.gs), pass: Math.min(c.pass, cur.pass) as 1 | 2 }
        } else {
          cur.wa = Math.min(cur.wa, c.wa)
          cur.wb = Math.max(cur.wb, c.wb)
          cur.pass = Math.min(cur.pass, c.pass) as 1 | 2
        }
        curEnd = Math.max(curEnd, c.ge)
        cur.ge = Math.max(cur.ge, c.ge)
        merged[merged.length - 1] = cur
      } else {
        cur = { ...c }
        curEnd = c.ge
        merged.push(cur)
      }
    }
  }
  // 2) entre tipos: estruturais fortes e validados vencem os tipos numéricos mais fracos
  const strong = merged.filter((c) => STRONG.has(c.kind))
  const accepted: Cand[] = merged.filter((c) => !SUPPRESSIBLE.has(c.kind))
  const higher: Cand[] = [...strong]
  for (const k of DIGIT_PRIORITY) {
    for (const c of merged) {
      if (c.kind !== k) continue
      if (higher.some((h) => contained(c, h))) continue
      accepted.push(c)
      higher.push(c)
    }
  }
  const plates = merged.filter((c) => c.kind === 'plate')
  for (const c of plates) if (!strong.some((h) => contained(c, h))) accepted.push(c)
  accepted.sort((a, b) => a.gs - b.gs || a.ge - b.ge)
  return accepted
}

function unionBox(words: readonly OcrWord[], a: number, b: number): OcrBox {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = a; i <= b; i++) {
    const bx = words[i]!.box
    if (bx.x < x0) x0 = bx.x
    if (bx.y < y0) y0 = bx.y
    if (bx.x + bx.w > x1) x1 = bx.x + bx.w
    if (bx.y + bx.h > y1) y1 = bx.y + bx.h
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n === 0 ? 0 : n % 2 ? s[(n - 1) >> 1]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

/**
 * Detecta dados sensíveis nas linhas de OCR. Duas passadas por linha: (1) palavras unidas por
 * espaço; (2) palavras com vão pequeno (< 0,6 × altura mediana) coladas sem separador, p/ OCR que
 * quebra "123.456." + "789-00". A caixa de cada detecção é a união de toda palavra que contribuiu.
 */
export function detectSensitive(lines: readonly OcrLine[], opts?: DetectOpts): Detection[] {
  const enabled = opts?.kinds ? new Set<SensitiveKind>(opts.kinds) : null
  const terms = !enabled || enabled.has('custom') ? compileTerms(opts?.customTerms) : []
  const result: Detection[] = []
  for (const line of lines) {
    const words = line.words.filter((w) => w.text.trim().length > 0)
    if (words.length === 0) continue
    const texts = words.map((w) => w.text.trim())
    const cands: Cand[] = []
    const none = new Array<boolean>(Math.max(0, words.length - 1)).fill(false)
    const p1 = buildPass(texts, none, 1)
    detectDigitKinds(p1, cands)
    detectTextKinds(p1, cands)
    detectCustom(p1, terms, cands)
    if (words.length > 1) {
      // limiar no eixo x (x comparado com x): 0,3 × largura mediana de um caractere da linha
      const thr = 0.3 * median(words.map((w, i) => w.box.w / texts[i]!.length))
      const join = none.map((_, i) => {
        const a = words[i]!.box
        const b = words[i + 1]!.box
        return b.x - (a.x + a.w) < thr
      })
      if (join.some(Boolean)) {
        const p2 = buildPass(texts, join, 2)
        detectDigitKinds(p2, cands)
        detectTextKinds(p2, cands)
        detectCustom(p2, terms, cands)
      }
    }
    // filtra por tipo ANTES de resolver: tipo desligado não pode suprimir tipo ligado
    const kept = enabled ? cands.filter((c) => enabled.has(c.kind)) : cands
    for (const c of resolve(kept)) {
      result.push({
        kind: c.kind,
        value: c.value,
        masked: maskSensitive(c.kind, c.value),
        box: unionBox(words, c.wa, c.wb),
        confidence: c.conf
      })
    }
  }
  return result
}
