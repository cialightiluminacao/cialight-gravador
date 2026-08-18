import { describe, expect, it } from 'vitest'
import { findDuplicateHotkeys, HOTKEY_BLACKLIST, hotkeyProblems, normalizeAccelerator } from './hotkeys'

describe('normalizeAccelerator', () => {
  it('normaliza modificadores e tecla', () => {
    expect(normalizeAccelerator('Ctrl+Shift+F9')).toBe('CommandOrControl+Shift+F9')
    expect(normalizeAccelerator('ctrl+shift+f9')).toBe('CommandOrControl+Shift+F9')
    expect(normalizeAccelerator('control+a')).toBe('CommandOrControl+A')
    expect(normalizeAccelerator('CmdOrCtrl+B')).toBe('CommandOrControl+B')
    expect(normalizeAccelerator('CommandOrControl+C')).toBe('CommandOrControl+C')
  })
  it('aceita sinônimos de Super', () => {
    expect(normalizeAccelerator('win+g')).toBe('Super+G')
    expect(normalizeAccelerator('meta+g')).toBe('Super+G')
    expect(normalizeAccelerator('super+g')).toBe('Super+G')
  })
  it('ordem canônica: CommandOrControl+Alt+Shift+Super+Tecla', () => {
    expect(normalizeAccelerator('shift+alt+super+ctrl+x')).toBe('CommandOrControl+Alt+Shift+Super+X')
    expect(normalizeAccelerator('Shift+Alt+P')).toBe('Alt+Shift+P')
  })
  it('tolera espaços e maiúsculas variadas', () => {
    expect(normalizeAccelerator('  CTRL + shift + f9 ')).toBe('CommandOrControl+Shift+F9')
  })
  it('teclas nomeadas do Electron', () => {
    expect(normalizeAccelerator('ctrl+space')).toBe('CommandOrControl+Space')
    expect(normalizeAccelerator('ctrl+enter')).toBe('CommandOrControl+Return')
    expect(normalizeAccelerator('ctrl+return')).toBe('CommandOrControl+Return')
    expect(normalizeAccelerator('ctrl+esc')).toBe('CommandOrControl+Escape')
    expect(normalizeAccelerator('ctrl+pageup')).toBe('CommandOrControl+PageUp')
    expect(normalizeAccelerator('alt+printscreen')).toBe('Alt+PrintScreen')
    expect(normalizeAccelerator('ctrl+num5')).toBe('CommandOrControl+num5')
    expect(normalizeAccelerator('ctrl+plus')).toBe('CommandOrControl+Plus')
    expect(normalizeAccelerator('ctrl+-')).toBe('CommandOrControl+-')
    expect(normalizeAccelerator('ctrl+minus')).toBe('CommandOrControl+-')
    expect(normalizeAccelerator('ctrl+F24')).toBe('CommandOrControl+F24')
    expect(normalizeAccelerator('ctrl+0')).toBe('CommandOrControl+0')
  })
  it('F-keys aceitam sem modificador; demais exigem ≥ 1', () => {
    expect(normalizeAccelerator('F5')).toBe('F5')
    expect(normalizeAccelerator('f13')).toBe('F13')
    expect(normalizeAccelerator('A')).toBeNull()
    expect(normalizeAccelerator('Space')).toBeNull()
    expect(normalizeAccelerator('PrintScreen')).toBe('PrintScreen')
  })
  it('inválidos → null', () => {
    expect(normalizeAccelerator('')).toBeNull()
    expect(normalizeAccelerator('   ')).toBeNull()
    expect(normalizeAccelerator('ctrl+')).toBeNull()
    expect(normalizeAccelerator('ctrl+shift')).toBeNull()
    expect(normalizeAccelerator('ctrl+F25')).toBeNull()
    expect(normalizeAccelerator('ctrl+F0')).toBeNull()
    expect(normalizeAccelerator('ctrl+banana')).toBeNull()
    expect(normalizeAccelerator('ctrl+a+b')).toBeNull()
    expect(normalizeAccelerator('ctrl+ctrl+a')).toBeNull()
    expect(normalizeAccelerator('ctrl+num10')).toBeNull()
  })
})

describe('hotkeyProblems', () => {
  it('Ctrl+Alt+<qualquer> avisa AltGr/ABNT2', () => {
    const p = hotkeyProblems('Ctrl+Alt+X')
    expect(p.some((m) => m.includes('AltGr'))).toBe(true)
    expect(p.some((m) => m.includes('ABNT2'))).toBe(true)
    expect(hotkeyProblems('CommandOrControl+Alt+Shift+F3').some((m) => m.includes('AltGr'))).toBe(true)
  })
  it('atalhos padrão do app não têm avisos', () => {
    expect(hotkeyProblems('CommandOrControl+Shift+F9')).toEqual([])
    expect(hotkeyProblems('CommandOrControl+Shift+F1')).toEqual([])
  })
  it('Xbox Game Bar', () => {
    expect(hotkeyProblems('Super+G')).toEqual(['Reservado pela Xbox Game Bar'])
    expect(hotkeyProblems('win+alt+r')).toContain('Reservado pela Xbox Game Bar')
    expect(hotkeyProblems('Super+Alt+M')).toContain('Reservado pela Xbox Game Bar')
    expect(hotkeyProblems('Super+Alt+PrintScreen')).toContain('Reservado pela Xbox Game Bar')
  })
  it('Ferramenta de Captura do Windows', () => {
    expect(hotkeyProblems('Super+Shift+S')).toContain('Reservado pela Ferramenta de Captura do Windows')
    expect(hotkeyProblems('Super+Shift+R')).toContain('Reservado pela Ferramenta de Captura do Windows')
    expect(hotkeyProblems('PrintScreen')).toContain('Reservado pela Ferramenta de Captura do Windows')
  })
  it('Gerenciador de Tarefas', () => {
    expect(hotkeyProblems('Ctrl+Shift+Esc')).toContain('Reservado pelo Gerenciador de Tarefas')
    expect(hotkeyProblems('CommandOrControl+Shift+Escape')).toContain('Reservado pelo Gerenciador de Tarefas')
  })
  it('Loom', () => {
    for (const a of ['Ctrl+Shift+L', 'Alt+Shift+P', 'Alt+Shift+C', 'Ctrl+Shift+R', 'Ctrl+Shift+D']) {
      expect(hotkeyProblems(a), a).toContain('Usado pelo Loom')
    }
  })
  it('Zight', () => {
    expect(hotkeyProblems('Alt+Shift+6')).toContain('Usado pelo Zight')
    const p = hotkeyProblems('Ctrl+Alt+Shift+I')
    expect(p).toContain('Usado pelo Zight')
    expect(p.some((m) => m.includes('AltGr'))).toBe(true)
  })
  it('F1–F12 puros avisam conflito com app em foco', () => {
    expect(hotkeyProblems('F5')).toEqual(['Tecla de função sozinha pode conflitar com o app em foco'])
    expect(hotkeyProblems('F12')).toHaveLength(1)
    expect(hotkeyProblems('F13')).toEqual([])
  })
  it('acelerador inválido → aviso de inválido', () => {
    expect(hotkeyProblems('banana')).toEqual(['Atalho inválido'])
    expect(hotkeyProblems('')).toEqual(['Atalho inválido'])
  })
  it('HOTKEY_BLACKLIST exportada e normalizada', () => {
    expect(HOTKEY_BLACKLIST.length).toBeGreaterThan(5)
    for (const e of HOTKEY_BLACKLIST) {
      expect(normalizeAccelerator(e.accelerator), e.accelerator).toBe(e.accelerator)
      expect(e.reason.length).toBeGreaterThan(0)
    }
    expect(HOTKEY_BLACKLIST.find((e) => e.accelerator === 'Super+G')?.reason).toBe('Reservado pela Xbox Game Bar')
  })
})

describe('findDuplicateHotkeys', () => {
  it('sem duplicados → []', () => {
    expect(findDuplicateHotkeys({ a: 'Ctrl+Shift+F1', b: 'Ctrl+Shift+F2', c: null })).toEqual([])
  })
  it('detecta pares com o mesmo acelerador normalizado', () => {
    expect(findDuplicateHotkeys({ a: 'ctrl+shift+f1', b: 'CommandOrControl+Shift+F1', c: null, d: 'Alt+X' })).toEqual([['a', 'b']])
  })
  it('três iguais → 3 pares; ignora null e inválidos', () => {
    const r = findDuplicateHotkeys({ a: 'Ctrl+A', b: 'Ctrl+A', c: 'Ctrl+A', d: null, e: null, f: 'inválido', g: 'inválido' })
    expect(r).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c']
    ])
  })
})
