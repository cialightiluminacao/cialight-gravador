import { describe, expect, it } from 'vitest'
import { editBackdrop, editBox, luminance, planTextEdit } from './textEdit'

describe('planTextEdit', () => {
  it('igual = nada; vazio = recusa (o texto antigo fica); senão grava com \\n', () => {
    expect(planTextEdit('Olá', 'Olá')).toEqual({ kind: 'same' })
    expect(planTextEdit('Olá', '   \n ')).toEqual({ kind: 'empty' })
    expect(planTextEdit('Olá', '')).toEqual({ kind: 'empty' })
    expect(planTextEdit('Olá', 'Olá\r\nmundo')).toEqual({ kind: 'change', text: 'Olá\nmundo' })
    expect(planTextEdit('a\nb', 'a\r\nb')).toEqual({ kind: 'same' })
  })
})

describe('caixa de edição', () => {
  it('luminância e fundo contrastante', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1)
    expect(luminance('#000')).toBe(0)
    expect(luminance('#ffffff80')).toBeCloseTo(1)
    expect(luminance('rgb(0,0,0)')).toBe(1) // formato desconhecido: tratado como claro
    expect(editBackdrop('#ffffff')).toMatch(/^#0d1017/)
    expect(editBackdrop('#101010')).toMatch(/^#f1f3f8/)
  })
  it('a caixa da textarea é a do texto na escala da tela, com tamanho mínimo, centrada no mesmo ponto', () => {
    expect(editBox({ cx: 960, cy: 540, w: 800, h: 200 }, 0.5)).toEqual({ left: 280, top: 220, width: 400, height: 100 })
    expect(editBox({ cx: 100, cy: 100, w: 10, h: 10 }, 1)).toEqual({ left: 20, top: 76, width: 160, height: 48 })
  })
})
