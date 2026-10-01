import { describe, expect, it } from 'vitest'
import { isEditableTarget, shortcutFor, type KeyLike } from './shortcuts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

describe('shortcutFor', () => {
  it('mapa da spec §9', () => {
    expect(shortcutFor(key(' '))).toBe('playPause')
    expect(shortcutFor(key('j'))).toBe('shuttleBack')
    expect(shortcutFor(key('K'))).toBe('pause')
    expect(shortcutFor(key('l'))).toBe('play')
    expect(shortcutFor(key('ArrowLeft'))).toBe('prevFrame')
    expect(shortcutFor(key('ArrowRight', { shiftKey: true }))).toBe('fwd1s')
    expect(shortcutFor(key('Home'))).toBe('home')
    expect(shortcutFor(key('End'))).toBe('end')
    expect(shortcutFor(key('s'))).toBe('split')
    expect(shortcutFor(key('b', { ctrlKey: true }))).toBe('split')
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
  })
})
