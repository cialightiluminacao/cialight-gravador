// Lógica pura da edição direta do texto no visualizador.

/** O que fazer ao confirmar: nada (igual), recusar (vazio) ou gravar. Fim de linha normalizado para \n. */
export function planTextEdit(before: string, typed: string): { kind: 'same' } | { kind: 'empty' } | { kind: 'change'; text: string } {
  const text = typed.replace(/\r\n?/g, '\n')
  if (text === before) return { kind: 'same' }
  if (text.trim() === '') return { kind: 'empty' }
  return { kind: 'change', text }
}

/** Luminância relativa (0–1) de #rgb, #rrggbb ou #rrggbbaa; cores que não são hexadecimais valem 1 (claras). */
export function luminance(color: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())
  if (!m) return 1
  let h = m[1]
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = ch.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** Fundo da caixa de edição: escuro para texto claro e claro para texto escuro (esconde o texto desenhado por baixo). */
export const editBackdrop = (textColor: string): string => (luminance(textColor) > 0.35 ? '#0d1017f2' : '#f1f3f8f2')

/** Caixa de edição: a do texto, com um mínimo para dar o que digitar (px de tela). */
export function editBox(box: { cx: number; cy: number; w: number; h: number }, k: number, min = { w: 160, h: 48 }): { left: number; top: number; width: number; height: number } {
  const width = Math.max(min.w, box.w * k)
  const height = Math.max(min.h, box.h * k)
  return { left: box.cx * k - width / 2, top: box.cy * k - height / 2, width, height }
}
