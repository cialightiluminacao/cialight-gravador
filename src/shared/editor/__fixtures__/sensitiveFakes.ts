// Geradores determinísticos de dados FALSOS porém válidos (checksum/estrutura) para testes de
// detecção de dados sensíveis e vídeos sintéticos (G3). PRNG com semente: mesma semente, mesmo dado.
// Nada aqui é dado real; não usar em produção.

/** PRNG mulberry32: devolve função () => [0,1). */
export function rng(seed: number): () => number {
  let a = (seed * 2654435761 + 1013904223) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function digits(r: () => number, n: number): number[] {
  return Array.from({ length: n }, () => Math.floor(r() * 10))
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!
}

function sameAll(ds: readonly number[]): boolean {
  return ds.every((d) => d === ds[0])
}

/** Troca o último dígito (+1 mod 10): produz documento com checksum inválido. */
export function breakLastDigit(s: string): string {
  const i = s.search(/\d(?!.*\d)/)
  const d = (Number(s[i]) + 1) % 10
  return s.slice(0, i) + String(d) + s.slice(i + 1)
}

/** CPF válido (11 dígitos, sem formatação). */
export function fakeCpf(seed: number): string {
  const r = rng(seed)
  let base = digits(r, 9)
  while (sameAll(base)) base = digits(r, 9)
  for (let t = 9; t <= 10; t++) {
    let sum = 0
    for (let i = 0; i < t; i++) sum += base[i]! * (t + 1 - i)
    base.push(((sum * 10) % 11) % 10)
  }
  return base.join('')
}
export function formatCpf(d: string): string {
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

/** CNPJ válido (14 dígitos, sem formatação). */
export function fakeCnpj(seed: number): string {
  const r = rng(seed + 7919)
  let base = digits(r, 12)
  while (sameAll(base)) base = digits(r, 12)
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  for (const w of [w1, w2]) {
    let sum = 0
    for (let i = 0; i < w.length; i++) sum += base[i]! * w[i]!
    const m = sum % 11
    base.push(m < 2 ? 0 : 11 - m)
  }
  return base.join('')
}
export function formatCnpj(d: string): string {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'elo' | 'diners'

/** Cartão com Luhn válido (só dígitos). */
export function fakeCard(seed: number, brand: CardBrand = 'visa'): string {
  const r = rng(seed + 104729)
  let prefix: string
  let len: number
  switch (brand) {
    case 'visa': prefix = '4'; len = 16; break
    case 'mastercard': prefix = String(51 + Math.floor(r() * 5)); len = 16; break
    case 'amex': prefix = pick(r, ['34', '37']); len = 15; break
    case 'elo': prefix = pick(r, ['636368', '504175', '509']); len = 16; break
    case 'diners': prefix = '36'; len = 14; break
  }
  const body = prefix.split('').map(Number)
  while (body.length < len - 1) body.push(Math.floor(r() * 10))
  let sum = 0
  let dbl = true
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body[i]!
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  body.push((10 - (sum % 10)) % 10)
  return body.join('')
}
/** Agrupa: Amex 4-6-5, Diners 4-6-4, demais 4-4-4-4. */
export function formatCard(d: string, sep = ' '): string {
  if (d.length === 15) return [d.slice(0, 4), d.slice(4, 10), d.slice(10)].join(sep)
  if (d.length === 14) return [d.slice(0, 4), d.slice(4, 10), d.slice(10)].join(sep)
  return (d.match(/.{1,4}/g) ?? [d]).join(sep)
}

const FIRST = ['joao', 'maria', 'ana', 'pedro', 'lucas', 'carla', 'bruno', 'paula', 'rafael', 'julia']
const LAST = ['silva', 'souza', 'lima', 'costa', 'ramos', 'alves', 'rocha', 'melo', 'dias', 'nunes']
const DOMAINS = ['exemplo.com', 'teste.com.br', 'mail.example.org', 'empresa.net.br', 'fake-dominio.io']

export function fakeEmail(seed: number): string {
  const r = rng(seed + 31)
  const f = pick(r, FIRST)
  const l = pick(r, LAST)
  const local = pick(r, [`${f}.${l}`, `${f}_${l}`, `${f}-${l}`, `${f}+${Math.floor(r() * 99)}`, `${f}${l}${Math.floor(r() * 999)}`])
  return `${local}@${pick(r, DOMAINS)}`
}

const DDDS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46,
  47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87,
  88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99]

export type PhoneStyle = 'paren' | 'space' | 'bare' | 'intl' | 'landlineParen' | 'landlineSpace'

/** Telefone BR fictício; devolve texto formatado conforme o estilo. */
export function fakePhone(seed: number, style: PhoneStyle = 'paren'): string {
  const r = rng(seed + 17)
  const ddd = pick(r, DDDS)
  const mob = `9${digits(r, 4).join('')}`
  const mob4 = digits(r, 4).join('')
  const land = `${2 + Math.floor(r() * 4)}${digits(r, 3).join('')}`
  const land4 = digits(r, 4).join('')
  switch (style) {
    case 'paren': return `(${ddd}) ${mob}-${mob4}`
    case 'space': return `${ddd} ${mob}-${mob4}`
    case 'bare': return `${ddd}${mob}${mob4}`
    case 'intl': return `+55 ${ddd} ${mob}-${mob4}`
    case 'landlineParen': return `(${ddd}) ${land}-${land4}`
    case 'landlineSpace': return `${ddd} ${land}-${land4}`
  }
}

/** CEP com hífen (00000-000). */
export function fakeCep(seed: number): string {
  const r = rng(seed + 53)
  return `${digits(r, 5).join('')}-${digits(r, 3).join('')}`
}

const A_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function letters(r: () => number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += A_Z[Math.floor(r() * 26)]
  return s
}

export type PlateStyle = 'old' | 'oldHyphen' | 'mercosul'
export function fakePlate(seed: number, style: PlateStyle = 'mercosul'): string {
  const r = rng(seed + 211)
  const l = letters(r, 3)
  const n4 = digits(r, 4).join('')
  switch (style) {
    case 'old': return `${l}${n4}`
    case 'oldHyphen': return `${l}-${n4}`
    case 'mercosul': return `${l}${digits(r, 1)[0]}${letters(r, 1)}${digits(r, 2).join('')}`
  }
}

/** UUID v4 minúsculo (formato 8-4-4-4-12). */
export function fakeUuid(seed: number): string {
  const r = rng(seed + 977)
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(r() * 4)).toString(16)}${hex(3)}-${hex(12)}`
}

/** IPv4 fictício (1.x.x.x–254.x.x.x, sem octetos zerados na ponta). */
export function fakeIpv4(seed: number): string {
  const r = rng(seed + 4001)
  return [1 + Math.floor(r() * 223), Math.floor(r() * 256), Math.floor(r() * 256), 1 + Math.floor(r() * 254)].join('.')
}

function alnum(r: () => number, n: number, set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'): string {
  let s = ''
  for (let i = 0; i < n; i++) s += set[Math.floor(r() * set.length)]
  return s
}

export type TokenStyle = 'sk' | 'skProj' | 'skAnt' | 'ghp' | 'gho' | 'ghu' | 'ghs' | 'ghr' | 'githubPat' | 'slack' | 'aws' | 'jwt' | 'google'
export const TOKEN_STYLES: readonly TokenStyle[] = ['sk', 'skProj', 'skAnt', 'ghp', 'gho', 'ghu', 'ghs', 'ghr', 'githubPat', 'slack', 'aws', 'jwt', 'google']

/** Um token falso do estilo pedido (formato realista, conteúdo aleatório). */
export function fakeToken(seed: number, style: TokenStyle): string {
  const r = rng(seed + 6007)
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  switch (style) {
    case 'sk': return `sk-${alnum(r, 32)}`
    case 'skProj': return `sk-proj-${alnum(r, 40, `${B}_-`)}`
    case 'skAnt': return `sk-ant-api03-${alnum(r, 40, `${B}_-`)}`
    case 'ghp': return `ghp_${alnum(r, 36)}`
    case 'gho': return `gho_${alnum(r, 36)}`
    case 'ghu': return `ghu_${alnum(r, 36)}`
    case 'ghs': return `ghs_${alnum(r, 36)}`
    case 'ghr': return `ghr_${alnum(r, 36)}`
    case 'githubPat': return `github_pat_${alnum(r, 22, `${B}_`)}_${alnum(r, 40, `${B}_`)}`
    case 'slack': return `xox${pick(r, ['b', 'a', 'p', 'r', 's'])}-${digits(r, 12).join('')}-${digits(r, 12).join('')}-${alnum(r, 24)}`
    case 'aws': return `AKIA${alnum(r, 16, U)}`
    case 'jwt': return `eyJ${alnum(r, 20, `${B}_-`)}.${alnum(r, 40, `${B}_-`)}.${alnum(r, 43, `${B}_-`)}`
    case 'google': return `AIza${alnum(r, 35, `${B}_-`)}`
  }
}

/** Um token de cada estilo (para a semente dada). */
export function fakeTokens(seed: number): string[] {
  return TOKEN_STYLES.map((s, i) => fakeToken(seed * 31 + i, s))
}

/**
 * Corpus FIXO de 200 linhas SEM dado sensível (prosa, datas, horas, dinheiro, versões, ISBN,
 * números de pedido, textos de interface). Nenhuma deve gerar detecção.
 */
function buildNegativeCorpus(): string[] {
  const out: string[] = [
    'O arquivo foi exportado com sucesso para a pasta de vídeos.',
    'Clique em Gravar para iniciar a captura da tela inteira.',
    'Selecione a janela que deseja compartilhar e pressione Enter.',
    'Bem-vindo ao editor: arraste os clipes para a linha do tempo.',
    'Use a tesoura para dividir o clipe na posição do cursor.',
    'Aprovado pela equipe de qualidade na revisão semanal.',
    'Please approve the pull request before the end of the day.',
    'The quick brown fox jumps over the lazy dog.',
    'Reunião de alinhamento com o time de produto e design.',
    'Obrigado pela atenção e até a próxima aula.',
    'Neste vídeo vamos configurar o ambiente de desenvolvimento.',
    'Abra o terminal e execute o comando de instalação.',
    'Pressione Ctrl+Z para desfazer a última alteração.',
    'Lista de tarefas: revisar texto, ajustar áudio, exportar.',
    'Ajuste o brilho e o contraste do vídeo no painel lateral.',
    'Nenhum projeto recente. Crie um novo projeto para começar.',
    'A exportação pode levar alguns minutos dependendo da duração.',
    'Qualidade alta recomendada para vídeos com muito texto na tela.',
    'Escolha o formato de saída: horizontal, vertical ou quadrado.',
    'Dica: segure Shift para arrastar sem encaixar nas bordas.',
    'Legenda gerada automaticamente a partir da narração.',
    'Importar música de fundo e ajustar o volume automaticamente.',
    'Capítulos adicionados a partir dos marcadores da linha do tempo.',
    'Sua gravação foi salva e está pronta para revisão.',
    'Cuidado: esta ação não pode ser desfeita depois de confirmada.',
    'Selecione o microfone usado na narração e teste o nível.',
    'Zoom automático segue o cursor durante os cliques.',
    'Recortar o início e o fim para remover pausas longas.',
    'Texto alternativo para acessibilidade da imagem.',
    'Fim do tutorial. Deixe um comentário com suas dúvidas.'
  ]
  // datas e horas
  const dias = ['12/03/2024', '05/11/2025', '31/12/2023', '01/01/2026', '28/02/2024', '15/08/2022', '09/09/2021', '30/06/2025']
  const horas = ['14:35', '08:00:12', '23:59', '00:12:34', '10:05:59.250', '07:45', '18:20:03', '12:00']
  for (let i = 0; i < 24; i++) out.push(`Reunião em ${dias[i % dias.length]} às ${horas[(i * 3 + 1) % horas.length]} no auditório.`)
  // dinheiro
  const val = ['R$ 1.234.567,89', 'R$ 12.345,67', 'R$ 99,90', 'R$ 1.000,00', 'R$ 250.000,50', 'US$ 4,321.10', 'R$ 7.654.321,00', 'R$ 45,00']
  for (let i = 0; i < 24; i++) out.push(`Valor do orçamento: ${val[i % val.length]} com desconto de ${5 + (i % 7)}%.`)
  // versões
  const ver = ['v10.0.19045', 'versão 2.14.7', '1.2.3.400', 'Node 20.11.1', 'build 4.0.1.5678', 'v3.9.12', '2.0.0-beta.4', 'Windows 10.0.22631', '1.2.3.999', 'Electron 31.7.7']
  for (let i = 0; i < 20; i++) out.push(`Versão instalada: ${ver[i % ver.length]} (canal estável).`)
  // ISBN e códigos
  const isbn = ['978-3-16-148410-0', '978-85-7522-111-5', '0-306-40615-2', '978-0-13-110362-7', 'ISBN 85-359-0277-5']
  for (let i = 0; i < 15; i++) out.push(`Livro de referência ${isbn[i % isbn.length]} edição ${1 + (i % 5)}.`)
  // números de pedido/protocolo curtos ou fora de padrão
  const ped = ['Pedido #48213', 'Protocolo 2024/000123', 'Nota 000123456 série 1', 'Pedido nº 7781', 'OS 2024/0045', 'Lote 20240312', 'Item 12 de 48', 'Fatura 556']
  for (let i = 0; i < 24; i++) out.push(`${ped[i % ped.length]} aguardando aprovação do setor ${1 + (i % 9)}.`)
  // textos de interface
  const ui = ['Gravando… 00:12:34', 'Tela 1920x1080 a 60 fps', 'Bitrate 8000 kbps', 'Volume 75% Brilho 80%', 'Zoom 150%', 'Taxa 48000 Hz estéreo',
    'Tamanho 245,7 MB de 1,2 GB', 'Faixa 3 de 12', 'Quadro 1452 de 9000', 'Duração 01:02:03', 'Resolução 3840x2160', 'Escala 125%']
  for (let i = 0; i < 24; i++) out.push(`${ui[i % ui.length]} | camada ${1 + (i % 6)}`)
  // código
  const code = ['const total = items.length * 2;', 'for (let i = 0; i < 100; i++) {', 'return a + b - c;', 'width: 480px; height: 270px;',
    'let x = 0.75 * 1920;', 'if (ratio > 1.777) scale(1.25);', 'import { ref } from "vue";', 'const ms = 1500 + 250;']
  for (let i = 0; i < 16; i++) out.push(code[i % code.length]!)
  // tabelas/planilhas: linhas de células de 3–4 dígitos (fonte comum de falsos positivos)
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  const tr = rng(2024)
  for (let i = 0; i < 20; i++) {
    // células alternando 3 e 4 dígitos: quatro células seguidas de 4 dígitos com Luhn válido são
    // indistinguíveis de um cartão (limite conhecido, ver relatório), então não entram no corpus
    const cells = Array.from({ length: 8 }, (_, k) => String(k % 2 === i % 2 ? 100 + Math.floor(tr() * 900) : 1000 + Math.floor(tr() * 9000)))
    out.push(`${meses[i % 12]} ${1 + i} ${cells.join(' ')}`)
  }
  out.push('Jan 15 2300 4100 3200 1100 900 450 1200', 'Qtd 41 11 11 11 21 31 11')
  // completa até 200 com variações de prosa numerada
  let k = 0
  while (out.length < 200) {
    out.push(`Passo ${k + 1}: revise o clipe ${k + 3} e confirme a duração de ${k + 2} segundos.`)
    k++
  }
  return out.slice(0, 200)
}

export const NEGATIVE_CORPUS: readonly string[] = buildNegativeCorpus()
