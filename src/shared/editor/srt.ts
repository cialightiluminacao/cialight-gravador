import type { Us } from './project'

// SRT (SubRip) puro: leitura tolerante (BOM, quebras \r\n/\r/\n, índices ausentes/repetidos, ms com vírgula ou
// ponto, tags de estilo) e escrita canônica (índices 1..n, HH:MM:SS,mmm, \r\n). Tempos em µs inteiros.

export interface Cue { startUs: Us; endUs: Us; text: string }

/** Linha de tempo: `H:MM:SS,mmm --> H:MM:SS,mmm` (horas 1–3 dígitos, ms com , ou ., 1–3 dígitos; resto ignorado). */
const TIMING = /^\s*(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?(?:\s.*)?$/
const INDEX = /^\s*\d+\s*$/
/** Tags HTML do SRT (<i>, <b>, <u>, <font …>, fechamentos) e blocos de estilo ASS ({\an8}, {\i1}…). */
const TAGS = /<\/?(?:i|b|u|s|font)\b[^>]*>|\{\\[^}]*\}/gi

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function timeUs(h: string, m: string, s: string, frac: string | undefined): Us | null {
  const mm = Number(m), ss = Number(s)
  if (mm > 59 || ss > 59) return null
  // fração com menos de 3 dígitos vale como decimal ("1,5" = 1 s e 500 ms)
  const msPart = frac ? Number(frac.padEnd(3, '0')) : 0
  return ((Number(h) * 60 + mm) * 60 + ss) * 1_000_000 + msPart * 1000
}

/** "00:00:01,500" (canônico do SRT). */
function srtTime(us: Us): string {
  const t = Math.max(0, Math.round(us / 1000))
  const msPart = t % 1000, s = Math.floor(t / 1000) % 60, m = Math.floor(t / 60_000) % 60, h = Math.floor(t / 3_600_000)
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msPart, 3)}`
}

interface RawCue extends Cue { block: number }

/**
 * Lê um SRT. Cues com fim ≤ início ou sem texto são descartadas; sobrepostas têm o fim da anterior cortado no início
 * da seguinte; blocos sem linha de tempo legível são pulados. Cada caso gera um aviso em pt-BR com o número do bloco
 * (posição no arquivo, a partir de 1). Resultado ordenado pelo início.
 */
export function parseSrt(text: string): { cues: Cue[]; warnings: string[] } {
  const warnings: string[] = []
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  // blocos = grupos de linhas não vazias
  const blocks: string[][] = []
  let cur: string[] = []
  for (const l of lines) {
    if (l.trim() === '') {
      if (cur.length) blocks.push(cur)
      cur = []
    } else cur.push(l)
  }
  if (cur.length) blocks.push(cur)

  const raw: RawCue[] = []
  let n = 0
  for (const b of blocks) {
    // um bloco pode conter várias cues coladas (sem linha em branco): corta em cada linha de tempo; o número inteiro
    // logo antes de uma linha de tempo é o índice dela
    const timings = b.map((l, i) => (TIMING.test(l) ? i : -1)).filter((i) => i >= 0)
    if (!timings.length) {
      n++
      warnings.push(`Bloco ${n}: não foi possível ler o tempo — bloco ignorado`)
      continue
    }
    timings.forEach((ti, k) => {
      n++
      // antes da 1ª linha de tempo só cabe o índice: outra coisa (texto solto) é descartada com aviso
      const pre = k === 0 ? b.slice(0, ti) : []
      if (pre.length > 1 || (pre.length === 1 && !INDEX.test(pre[0]))) {
        const junk = pre.filter((l) => !INDEX.test(l)).join(' ').trim()
        warnings.push(`Bloco ${n}: texto antes do tempo ignorado (“${junk.length > 40 ? `${junk.slice(0, 40)}…` : junk}”)`)
      }
      const next = k + 1 < timings.length ? timings[k + 1] : b.length
      const stop = k + 1 < timings.length && next - 1 > ti && INDEX.test(b[next - 1]) ? next - 1 : next
      const m = TIMING.exec(b[ti])!
      const s = timeUs(m[1], m[2], m[3], m[4])
      const e = timeUs(m[5], m[6], m[7], m[8])
      if (s === null || e === null) {
        warnings.push(`Bloco ${n}: tempo inválido — legenda ignorada`)
        return
      }
      const body = b
        .slice(ti + 1, stop)
        .map((l) => l.replace(TAGS, '').trim())
        .filter((l) => l !== '')
        .join('\n')
      if (e <= s) {
        warnings.push(`Bloco ${n}: o fim (${srtTime(e)}) não é depois do início (${srtTime(s)}) — legenda ignorada`)
        return
      }
      if (!body) {
        warnings.push(`Bloco ${n}: legenda sem texto — ignorada`)
        return
      }
      raw.push({ startUs: s, endUs: e, text: body, block: n })
    })
  }

  raw.sort((a, b) => a.startUs - b.startUs || a.block - b.block)
  const out: RawCue[] = []
  for (const c of raw) {
    const prev = out[out.length - 1]
    if (prev && prev.endUs > c.startUs) {
      if (c.startUs <= prev.startUs) {
        // começa junto com a anterior: cortar a anterior a zeraria
        warnings.push(`Bloco ${prev.block}: começa no mesmo instante que o bloco ${c.block} — legenda ignorada`)
        out.pop()
      } else {
        warnings.push(`Bloco ${prev.block}: sobrepõe o bloco ${c.block} — fim ajustado para ${srtTime(c.startUs)}`)
        prev.endUs = c.startUs
      }
    }
    out.push(c)
  }
  return { cues: out.map(({ startUs, endUs, text: t }) => ({ startUs, endUs, text: t })), warnings }
}

/** SRT canônico: índices 1..n, `HH:MM:SS,mmm` (arredondado ao ms), `\r\n`, linha em branco entre blocos. */
export function serializeSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => {
      // linha vazia no meio do texto encerraria o bloco
      const body = c.text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '').join('\r\n')
      return `${i + 1}\r\n${srtTime(c.startUs)} --> ${srtTime(c.endUs)}\r\n${body}\r\n`
    })
    .join('\r\n')
}

/** Tempo da lista de legendas: "mm:ss,mmm" (com horas: "h:mm:ss,mmm"); arredondado ao ms. */
export function formatCueTime(us: Us): string {
  const t = Math.max(0, Math.round(us / 1000))
  const msPart = t % 1000, s = Math.floor(t / 1000) % 60, m = Math.floor(t / 60_000) % 60, h = Math.floor(t / 3_600_000)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)},${pad(msPart, 3)}` : `${pad(m)}:${pad(s)},${pad(msPart, 3)}`
}

/** Lê "ss", "ss,mmm", "mm:ss,mmm" ou "h:mm:ss,mmm" (vírgula ou ponto); inválido → null. */
export function parseCueTime(text: string): Us | null {
  const m = /^\s*(?:(?:(\d{1,3}):)?(\d{1,2}):)?(\d{1,5})(?:[,.](\d{1,3}))?\s*$/.exec(text)
  if (!m) return null
  const h = Number(m[1] ?? 0), mm = Number(m[2] ?? 0), ss = Number(m[3])
  // com minutos, os segundos vão até 59; sozinhos, podem passar (ex.: "90" = 1:30)
  if ((m[2] !== undefined && ss > 59) || mm > 59) return null
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0
  return ((h * 60 + mm) * 60 + ss) * 1_000_000 + frac * 1000
}

/**
 * Cues de um trecho exportado [fromUs, toUs): cortadas nas bordas e deslocadas para o tempo do vídeo exportado (0 =
 * fromUs). As que ficam fora (ou com menos de 1 ms dentro) saem.
 */
export function cuesForRange(cues: readonly Cue[], fromUs: Us, toUs: Us): Cue[] {
  const out: Cue[] = []
  for (const c of cues) {
    const s = Math.max(c.startUs, fromUs), e = Math.min(c.endUs, toUs)
    if (e - s >= 1000) out.push({ startUs: s - fromUs, endUs: e - fromUs, text: c.text })
  }
  return out
}
