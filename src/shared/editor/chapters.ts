// Capítulos do YouTube a partir dos marcadores do projeto. Puro (sem DOM/Node), µs inteiros.
import type { Marker, Us } from './project'

export interface Chapter { tUs: Us; label: string }
/** warnings em pt-BR; nunca alteram a lista (só avisam). */
export interface ChapterResult { chapters: Chapter[]; text: string; warnings: string[] }

/** O YouTube ignora a lista se algum capítulo tiver menos de 10 s. */
export const MIN_CHAPTER_GAP_US = 10_000_000
const SECOND_US = 1_000_000
const HOUR_US = 3_600 * SECOND_US

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** "00:00", "12:05"; com useHours "1:02:03" (segundos truncados). */
export function formatChapterTime(us: Us, useHours: boolean): string {
  const total = Math.max(0, Math.floor(us / SECOND_US))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return useHours ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(Math.floor(total / 60))}:${pad2(s)}`
}

export function chaptersFromMarkers(markers: readonly Marker[], range: { fromUs: Us; toUs: Us }): ChapterResult {
  const durationUs = Math.max(0, range.toUs - range.fromUs)
  const inRange = markers.filter((m) => m.tUs >= range.fromUs && m.tUs < range.toUs).sort((a, b) => a.tUs - b.tUs)
  if (!inRange.length) return { chapters: [], text: '', warnings: ['Nenhum marcador no intervalo'] }

  const useHours = durationUs >= HOUR_US
  const warnings: string[] = []
  // tempo relativo ao início do intervalo; marcador em [0, 1 s) vale 00:00
  const raw = inRange.map((m) => ({ tUs: m.tUs - range.fromUs < SECOND_US ? 0 : m.tUs - range.fromUs, label: m.label }))
  if (raw[0].tUs !== 0) raw.unshift({ tUs: 0, label: 'Introdução' })

  const kept: { tUs: Us; label: string }[] = []
  const dups: string[] = []
  const clean = (l: string): string => l.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  for (const c of raw) {
    const last = kept[kept.length - 1]
    if (last && Math.floor(last.tUs / SECOND_US) === Math.floor(c.tUs / SECOND_US)) {
      const t = formatChapterTime(last.tUs, useHours)
      dups.push(clean(c.label) ? `${t} "${clean(c.label)}"` : t)
    } else kept.push(c)
  }
  if (dups.length) warnings.push(`Marcadores no mesmo segundo: só o primeiro foi mantido; descartado: ${dups.join(', ')}`)

  const chapters: Chapter[] = kept.map((c, i) => {
    const label = clean(c.label)
    return { tUs: c.tUs, label: label || `Capítulo ${i + 1}` }
  })

  if (chapters.length < 3) warnings.push('O YouTube exige pelo menos 3 capítulos')
  const shortOnes: string[] = []
  chapters.forEach((c, i) => {
    const next = i + 1 < chapters.length ? chapters[i + 1].tUs : durationUs
    if (next - c.tUs < MIN_CHAPTER_GAP_US) shortOnes.push(formatChapterTime(c.tUs, useHours))
  })
  if (shortOnes.length) warnings.push(`Capítulos com menos de 10 s: ${shortOnes.join(', ')}`)

  const text = chapters.map((c) => `${formatChapterTime(c.tUs, useHours)} ${c.label}`).join('\n')
  return { chapters, text, warnings }
}

/** Caminho sugerido para salvar: pasta + nome, com o separador da pasta (aceita barra invertida e normal; sem pasta, só o nome). */
export function joinDefaultPath(folder: string | null, name: string): string {
  const trimmed = (folder ?? '').replace(/[\\/]+$/, '')
  if (!trimmed) return name
  const sep = trimmed.includes('\\') || !trimmed.includes('/') ? '\\' : '/'
  return trimmed + sep + name
}

/** Último componente de um caminho (barra invertida ou normal). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
