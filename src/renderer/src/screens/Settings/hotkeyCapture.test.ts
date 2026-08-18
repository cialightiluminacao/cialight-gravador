import { describe, expect, it } from 'vitest'
import { captureFromKey, electronKeyName, type KeyLike } from './hotkeyCapture'

const ev = (partial: Partial<KeyLike>): KeyLike => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial })

describe('electronKeyName', () => {
  it('mapeia letras, dígitos, F-keys e numpad pelo code', () => {
    expect(electronKeyName({ key: 'a', code: 'KeyA' })).toBe('A')
    expect(electronKeyName({ key: '!', code: 'Digit1' })).toBe('1')
    expect(electronKeyName({ key: 'F9', code: 'F9' })).toBe('F9')
    expect(electronKeyName({ key: 'F24', code: 'F24' })).toBe('F24')
    expect(electronKeyName({ key: '5', code: 'Numpad5' })).toBe('num5')
  })
  it('mapeia teclas nomeadas para o vocabulário do Electron', () => {
    expect(electronKeyName({ key: 'ArrowUp', code: 'ArrowUp' })).toBe('Up')
    expect(electronKeyName({ key: ' ', code: 'Space' })).toBe('Space')
    expect(electronKeyName({ key: 'Enter', code: 'NumpadEnter' })).toBe('Enter')
    expect(electronKeyName({ key: 'PrintScreen', code: 'PrintScreen' })).toBe('PrintScreen')
    expect(electronKeyName({ key: 'PageDown', code: 'PageDown' })).toBe('PageDown')
  })
  it('usa o caractere produzido em códigos desconhecidos (layout ABNT2)', () => {
    expect(electronKeyName({ key: 'ç', code: 'Semicolon' })).toBe(';')
    expect(electronKeyName({ key: '+', code: 'IntlRo' })).toBe('Plus')
    expect(electronKeyName({ key: 'Dead', code: 'Quote' })).toBe("'")
    expect(electronKeyName({ key: 'Unidentified', code: '' })).toBeNull()
  })
})

describe('captureFromKey', () => {
  it('fica pendente enquanto só modificadores estão pressionados', () => {
    expect(captureFromKey(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toEqual({ kind: 'pending', modifiers: ['CommandOrControl'] })
    expect(captureFromKey(ev({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'pending', modifiers: ['CommandOrControl', 'Shift'] })
  })
  it('monta e normaliza a combinação completa', () => {
    const r = captureFromKey(ev({ key: 'F9', code: 'F9', ctrlKey: true, shiftKey: true }))
    expect(r).toEqual({ kind: 'done', accelerator: 'CommandOrControl+Shift+F9', raw: 'CommandOrControl+Shift+F9' })
    expect(captureFromKey(ev({ key: 'r', code: 'KeyR', altKey: true, metaKey: true }))).toMatchObject({ kind: 'done', accelerator: 'Alt+Super+R' })
  })
  it('recusa tecla sem modificador que o Electron não aceita', () => {
    expect(captureFromKey(ev({ key: 'a', code: 'KeyA' }))).toMatchObject({ kind: 'done', accelerator: null, raw: 'A' })
    expect(captureFromKey(ev({ key: 'F5', code: 'F5' }))).toMatchObject({ kind: 'done', accelerator: 'F5' })
  })
  it('Backspace/Delete limpam e Escape cancela quando não há modificadores', () => {
    expect(captureFromKey(ev({ key: 'Backspace', code: 'Backspace' }))).toEqual({ kind: 'clear' })
    expect(captureFromKey(ev({ key: 'Delete', code: 'Delete' }))).toEqual({ kind: 'clear' })
    expect(captureFromKey(ev({ key: 'Escape', code: 'Escape' }))).toEqual({ kind: 'cancel' })
    expect(captureFromKey(ev({ key: 'Escape', code: 'Escape', ctrlKey: true, shiftKey: true }))).toMatchObject({ kind: 'done', accelerator: 'CommandOrControl+Shift+Escape' })
  })
})
