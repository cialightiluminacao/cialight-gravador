// Proporções do quadro do projeto (seletor da barra superior e "Novo projeto"). Puras.
import type { Project } from '@shared/editor/project'

export type AspectId = '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | 'original'

export const ASPECTS: { id: AspectId; label: string; hint?: string; ratio?: [number, number] }[] = [
  { id: '16:9', label: '16:9 · Paisagem', hint: 'YouTube', ratio: [16, 9] },
  { id: '9:16', label: '9:16 · Vertical', hint: 'Reels, Shorts', ratio: [9, 16] },
  { id: '1:1', label: '1:1 · Quadrado', ratio: [1, 1] },
  { id: '4:5', label: '4:5 · Retrato', hint: 'Feed', ratio: [4, 5] },
  { id: '4:3', label: '4:3 · Clássico', ratio: [4, 3] },
  { id: 'original', label: 'Original da 1ª mídia' }
]

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Tamanho exibido da primeira mídia visual importada (rotação aplicada); null se não houver. */
export function firstMediaSize(p: Project): { width: number; height: number } | null {
  const a = p.assets.find((x) => x.kind !== 'audio' && x.video && x.video.width > 0 && x.video.height > 0)
  if (!a?.video) return null
  const turned = a.video.rotation === 90 || a.video.rotation === 270
  return turned ? { width: a.video.height, height: a.video.width } : { width: a.video.width, height: a.video.height }
}

/** Dimensões do quadro na proporção pedida, mantendo o lado menor atual (1080 continua 1080). */
export function canvasForAspect(p: Project, id: AspectId): { width: number; height: number } {
  if (id === 'original') {
    const m = firstMediaSize(p)
    if (m) return { width: even(m.width), height: even(m.height) }
    return { width: p.canvas.width, height: p.canvas.height }
  }
  const [rw, rh] = ASPECTS.find((a) => a.id === id)!.ratio!
  const short = Math.min(p.canvas.width, p.canvas.height)
  return rw >= rh ? { width: even((short * rw) / rh), height: even(short) } : { width: even(short), height: even((short * rh) / rw) }
}

/** Proporção atual: padrão (±0,5 %), igual à 1ª mídia, ou personalizada. */
export function aspectIdOf(p: Project): AspectId | 'custom' {
  const r = p.canvas.width / p.canvas.height
  for (const a of ASPECTS) if (a.ratio && Math.abs(r / (a.ratio[0] / a.ratio[1]) - 1) < 0.005) return a.id
  const m = firstMediaSize(p)
  if (m && Math.abs(r / (m.width / m.height) - 1) < 0.005) return 'original'
  return 'custom'
}
