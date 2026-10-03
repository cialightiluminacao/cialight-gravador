import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject } from '@shared/editor/factory'
import type { EffectItem, Project } from '@shared/editor/project'
import { stillNotice, stillPrivacyWarnings } from './stillNotice'

const S = 1_000_000
function withFx(fx: EffectItem): Project {
  const p = createEmptyProject('t')
  p.tracks[0].items = [fx]
  return p
}
const result = { path: 'C:/saida/t - 00m03s.png', width: 1920, height: 1080, warnings: [] as string[] }

describe('quadro PNG direto (Ctrl+Shift+E): avisos de privacidade do instante', () => {
  it('sem aviso → sucesso simples com o tamanho', () => {
    const p = withFx(createEffectItem('blur', 0, 10 * S))
    expect(stillNotice(p, result, stillPrivacyWarnings(p, 3 * S))).toEqual({ kind: 'success', title: 'Quadro exportado: t - 00m03s.png', description: 'PNG 1920×1080', reviewItemId: null })
  })
  it('blur fraco no instante → aviso (nunca sucesso simples), com o texto do diálogo e "Revisar" no efeito', () => {
    const fx = { ...createEffectItem('blur', 0, 10 * S), strength: { value: 20 } }
    const p = withFx(fx)
    const n = stillNotice(p, result, stillPrivacyWarnings(p, 3 * S))
    expect(n.kind).toBe('warning')
    expect(n.title).toBe('Quadro exportado com aviso de privacidade: t - 00m03s.png')
    expect(n.description).toBe('Blur em 00:03 — Blur fraco pode ser revertido; use intensidade ≥ 50 ou Tarja')
    expect(n.reviewItemId).toBe(fx.id)
  })
  it('efeito desativado só no instante do quadro conta; fora dele, não', () => {
    const fx = { ...createEffectItem('pixelate', 2 * S, 2 * S), enabled: false }
    const p = withFx(fx)
    expect(stillNotice(p, result, stillPrivacyWarnings(p, 3 * S)).kind).toBe('warning')
    expect(stillNotice(p, result, stillPrivacyWarnings(p, 5 * S)).kind).toBe('success')
    expect(stillNotice(p, result, stillPrivacyWarnings(p, S)).kind).toBe('success')
  })
  it('avisos do render (anotações) entram junto dos de privacidade', () => {
    const fx = { ...createEffectItem('blur', 0, 10 * S), enabled: false }
    const p = withFx(fx)
    const n = stillNotice(p, { ...result, warnings: ['As anotações não puderam ser lidas e ficaram de fora.'] }, stillPrivacyWarnings(p, 0))
    expect(n.kind).toBe('warning')
    expect(n.description).toContain('Efeito de privacidade desativado neste trecho')
    expect(n.description).toContain('As anotações não puderam ser lidas')
  })
})
