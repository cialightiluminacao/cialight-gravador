import { describe, expect, it } from 'vitest'
import { CURVE_EDITOR_ACTIONS, isEditableTarget, SHORTCUT_LABELS, shortcutFor, TRANSPORT_ACTIONS, type KeyLike } from './shortcuts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

describe('shortcutFor', () => {
  it('mapa da spec §9', () => {
    expect(shortcutFor(key(' '))).toBe('playPause')
    expect(shortcutFor(key('j'))).toBe('shuttleBack')
    expect(shortcutFor(key('K'))).toBe('pause')
    expect(shortcutFor(key('l'))).toBe('shuttleForward')
    expect(shortcutFor(key('Z', { shiftKey: true }))).toBe('zoomFit')
    expect(shortcutFor(key('z'))).toBe('zoomTool') // Z: ferramenta Zoom do visualizador; Shift+Z continua sendo ajustar a timeline
    expect(shortcutFor(key('z', { altKey: true }))).toBeNull()
    expect(shortcutFor(key('ArrowLeft'))).toBe('prevFrame')
    expect(shortcutFor(key('ArrowRight', { shiftKey: true }))).toBe('fwd1s')
    expect(shortcutFor(key('Home'))).toBe('home')
    expect(shortcutFor(key('End'))).toBe('end')
    expect(shortcutFor(key('s'))).toBe('split')
    expect(shortcutFor(key('b', { ctrlKey: true }))).toBe('split')
    expect(shortcutFor(key('b'))).toBe('drawRegion')
    expect(shortcutFor(key('B', { shiftKey: true }))).toBe('drawRegion')
    expect(shortcutFor(key('q'))).toBe('rippleTrimStart')
    expect(shortcutFor(key('w'))).toBe('rippleTrimEnd')
    expect(shortcutFor(key('Delete'))).toBe('delete')
    expect(shortcutFor(key('Delete', { shiftKey: true }))).toBe('rippleDelete')
    expect(shortcutFor(key('c', { ctrlKey: true }))).toBe('copy')
    expect(shortcutFor(key('v', { ctrlKey: true }))).toBe('paste')
    expect(shortcutFor(key('d', { ctrlKey: true }))).toBe('duplicate')
    expect(shortcutFor(key('z', { ctrlKey: true }))).toBe('undo')
    expect(shortcutFor(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(shortcutFor(key('y', { ctrlKey: true }))).toBe('redo')
    expect(shortcutFor(key('i'))).toBe('markIn')
    expect(shortcutFor(key('o'))).toBe('markOut')
    expect(shortcutFor(key('X', { ctrlKey: true, shiftKey: true }))).toBe('deleteRange')
    expect(shortcutFor(key('m'))).toBe('marker')
    expect(shortcutFor(key('+'))).toBe('zoomIn')
    expect(shortcutFor(key('-'))).toBe('zoomOut')
    expect(shortcutFor(key('s', { ctrlKey: true }))).toBe('save')
    expect(shortcutFor(key('n'))).toBe('toggleSnap')
  })

  it('keyframes e ativar/desativar (K é pausa → keyframe é Alt+K)', () => {
    expect(shortcutFor(key('k', { altKey: true }))).toBe('toggleKeyframe')
    expect(shortcutFor(key('K', { altKey: true, code: 'KeyK' }))).toBe('toggleKeyframe')
    expect(shortcutFor(key('k'))).toBe('pause')
    expect(shortcutFor(key('k', { altKey: true, ctrlKey: true }))).toBeNull()
    expect(shortcutFor(key('['))).toBe('prevKeyframe')
    expect(shortcutFor(key(']'))).toBe('nextKeyframe')
    expect(shortcutFor(key('E', { shiftKey: true }))).toBe('toggleEnabled')
    expect(shortcutFor(key('e'))).toBeNull()
    expect(shortcutFor(key('E', { shiftKey: true, altKey: true }))).toBe('toggleEnabledUnlinked') // Alt ignora o vínculo
  })

  it('teclas sem atalho e combinações com Alt não fazem nada', () => {
    expect(shortcutFor(key('a'))).toBeNull()
    expect(shortcutFor(key('s', { altKey: true }))).toBeNull()
    expect(shortcutFor(key('x', { ctrlKey: true }))).toBeNull()
  })

  it('ignora quando o foco está em campo de texto', () => {
    expect(shortcutFor(key(' ', { target: { tagName: 'INPUT', type: 'text' } as unknown as EventTarget }))).toBeNull()
    expect(shortcutFor(key('s', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget }))).toBeNull()
    expect(shortcutFor(key('z', { ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }))).toBeNull()
    expect(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false)
    expect(shortcutFor(key(' ', { target: { tagName: 'BUTTON' } as unknown as EventTarget }))).toBe('playPause')
    // Ctrl+S salva mesmo digitando num campo
    expect(shortcutFor(key('s', { ctrlKey: true, target: { tagName: 'INPUT', type: 'text' } as unknown as EventTarget }))).toBe('save')
  })
  it('J/K/L clássico: com K segurado, J e L andam um quadro', () => {
    expect(shortcutFor(key('j'), { kHeld: true })).toBe('prevFrame')
    expect(shortcutFor(key('L'), { kHeld: true })).toBe('nextFrame')
    expect(shortcutFor(key('j'), { kHeld: false })).toBe('shuttleBack')
    expect(shortcutFor(key('k'), { kHeld: true })).toBe('pause')
    expect(shortcutFor(key('s'), { kHeld: true })).toBe('split')
  })
})

describe('TRANSPORT_ACTIONS (painel não modal aberto)', () => {
  it('Espaço, J/K/L, setas e Home/End passam; edição não', () => {
    for (const k of [key(' '), key('j'), key('k'), key('l'), key('ArrowLeft'), key('ArrowRight', { shiftKey: true }), key('Home'), key('End')]) expect(TRANSPORT_ACTIONS.has(shortcutFor(k)!)).toBe(true)
    for (const k of [key('s'), key('Delete'), key('z', { ctrlKey: true }), key('b')]) expect(TRANSPORT_ACTIONS.has(shortcutFor(k)!)).toBe(false)
  })
})

describe('SHORTCUT_LABELS', () => {
  it('copiar/colar (itens ou keyframes selecionados) aparecem nas dicas', () => {
    expect(shortcutFor(key('c', { ctrlKey: true }))).toBe('copy')
    expect(shortcutFor(key('v', { ctrlKey: true }))).toBe('paste')
    expect(SHORTCUT_LABELS.copy).toBe('Ctrl+C')
    expect(SHORTCUT_LABELS.paste).toBe('Ctrl+V')
  })
})

describe('CURVE_EDITOR_ACTIONS', () => {
  it('com o editor de curvas aberto passam o transporte e desfazer/refazer; editar não', () => {
    for (const a of ['playPause', 'prevFrame', 'undo', 'redo'] as const) expect(CURVE_EDITOR_ACTIONS.has(a)).toBe(true)
    for (const a of ['delete', 'split', 'paste', 'copy'] as const) expect(CURVE_EDITOR_ACTIONS.has(a)).toBe(false)
  })
})

describe('exportar (Ctrl+E)', () => {
  it('Ctrl+E abre a exportação; E, Shift+E, Alt+Shift+E e Ctrl+Shift+E continuam como estavam', () => {
    expect(shortcutFor(key('e', { ctrlKey: true }))).toBe('export')
    expect(shortcutFor(key('E', { ctrlKey: true }))).toBe('export')
    expect(shortcutFor(key('e', { metaKey: true }))).toBe('export')
    expect(shortcutFor(key('e'))).toBeNull()
    expect(shortcutFor(key('E', { shiftKey: true }))).toBe('toggleEnabled')
    expect(shortcutFor(key('E', { shiftKey: true, altKey: true }))).toBe('toggleEnabledUnlinked')
    expect(shortcutFor(key('e', { ctrlKey: true, altKey: true }))).toBeNull()
    // digitando num campo não abre
    expect(shortcutFor(key('e', { ctrlKey: true, target: { tagName: 'INPUT', type: 'text' } as unknown as EventTarget }))).toBeNull()
    expect(SHORTCUT_LABELS.export).toBe('Ctrl+E')
  })
  it('Ctrl+Shift+E exporta o quadro atual como PNG (sem conflito com Shift+E / Alt+Shift+E / Ctrl+E)', () => {
    expect(shortcutFor(key('E', { ctrlKey: true, shiftKey: true }))).toBe('exportFrame')
    expect(shortcutFor(key('e', { ctrlKey: true, shiftKey: true }))).toBe('exportFrame')
    expect(shortcutFor(key('E', { metaKey: true, shiftKey: true }))).toBe('exportFrame')
    expect(shortcutFor(key('E', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
    expect(shortcutFor(key('E', { ctrlKey: true, shiftKey: true, target: { tagName: 'INPUT', type: 'text' } as unknown as EventTarget }))).toBeNull()
    expect(SHORTCUT_LABELS.exportFrame).toBe('Ctrl+Shift+E')
    expect(Object.entries(SHORTCUT_LABELS).filter(([, v]) => v === 'Ctrl+Shift+E')).toEqual([['exportFrame', 'Ctrl+Shift+E']])
  })
  it('nenhum outro atalho usa Ctrl+E', () => {
    const labels = Object.entries(SHORTCUT_LABELS).filter(([, v]) => v === 'Ctrl+E')
    expect(labels).toEqual([['export', 'Ctrl+E']])
  })
})
