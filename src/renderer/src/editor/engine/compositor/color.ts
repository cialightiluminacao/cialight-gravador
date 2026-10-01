// Cor CSS simples (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba()) → RGBA 0–1 para uniforms/clearColor.
export type Rgba = [number, number, number, number]

export function parseColor(css: string): Rgba {
  const s = css.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1]
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s)
  if (fn) {
    const p = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (p.length >= 3 && p.every((v) => Number.isFinite(v))) {
      const c = (v: number): number => Math.min(1, Math.max(0, v / 255))
      return [c(p[0]), c(p[1]), c(p[2]), p.length > 3 ? Math.min(1, Math.max(0, p[3])) : 1]
    }
  }
  return [0, 0, 0, 1]
}
