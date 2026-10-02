// Atalhos de teclado do editor (spec §9). `shortcutFor` é puro (testável): traduz um evento de
// teclado na ação; quem executa é editor/ui/editorActions.ts. Ignora eventos vindos de campos de texto.

export type ShortcutAction =
  | 'playPause'
  | 'shuttleBack' // J
  | 'pause' // K
  | 'shuttleForward' // L
  | 'prevFrame'
  | 'nextFrame'
  | 'back1s'
  | 'fwd1s'
  | 'home'
  | 'end'
  | 'split'
  | 'rippleTrimStart' // Q
  | 'rippleTrimEnd' // W
  | 'delete'
  | 'rippleDelete'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'undo'
  | 'redo'
  | 'markIn'
  | 'markOut'
  | 'deleteRange'
  | 'marker'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'save'
  | 'toggleSnap'
  | 'deselect'
  | 'drawRegion' // B: ferramenta "Desenhar região" do visualizador (Ctrl+B continua sendo dividir)

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey?: boolean
  shiftKey: boolean
  altKey: boolean
  target?: EventTarget | null
}

/** Rótulos dos atalhos para tooltips (formato do <Kbd>). */
export const SHORTCUT_LABELS: Partial<Record<ShortcutAction, string>> = {
  playPause: 'Espaço',
  prevFrame: '←',
  nextFrame: '→',
  home: 'Home',
  end: 'End',
  split: 'S',
  delete: 'Del',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  markIn: 'I',
  markOut: 'O',
  marker: 'M',
  save: 'Ctrl+S',
  rippleDelete: 'Shift+Del',
  duplicate: 'Ctrl+D',
  deleteRange: 'Ctrl+Shift+X',
  toggleSnap: 'N',
  zoomIn: '+',
  zoomOut: '-',
  zoomFit: 'Shift+Z',
  drawRegion: 'B'
}

/** Foco em campo editável: atalhos de uma tecla não podem roubar a digitação. */
export function isEditableTarget(t: EventTarget | null | undefined): boolean {
  if (!t || typeof t !== 'object') return false
  const el = t as { tagName?: string; isContentEditable?: boolean; type?: string }
  if (el.isContentEditable) return true
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !['checkbox', 'radio', 'range', 'button'].includes((el.type ?? 'text').toLowerCase())
  return false
}

export function shortcutFor(e: KeyLike): ShortcutAction | null {
  const ctrl = e.ctrlKey || !!e.metaKey
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  // num campo de texto só Ctrl+S (salvar) vale; o resto é da digitação
  if (isEditableTarget(e.target)) return ctrl && !e.altKey && !e.shiftKey && k === 's' ? 'save' : null
  if (ctrl) {
    if (e.altKey) return null
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (k === 'y') return 'redo'
    if (k === 's') return 'save'
    if (k === 'b') return 'split'
    if (k === 'c' && !e.shiftKey) return 'copy'
    if (k === 'v' && !e.shiftKey) return 'paste'
    if (k === 'd' && !e.shiftKey) return 'duplicate'
    if (k === 'x' && e.shiftKey) return 'deleteRange'
    return null
  }
  if (e.altKey) return null
  switch (k) {
    case ' ':
      return 'playPause'
    case 'j':
      return 'shuttleBack'
    case 'k':
      return 'pause'
    case 'l':
      return 'shuttleForward'
    case 'ArrowLeft':
      return e.shiftKey ? 'back1s' : 'prevFrame'
    case 'ArrowRight':
      return e.shiftKey ? 'fwd1s' : 'nextFrame'
    case 'Home':
      return 'home'
    case 'End':
      return 'end'
    case 's':
      return 'split'
    case 'q':
      return 'rippleTrimStart'
    case 'w':
      return 'rippleTrimEnd'
    case 'Delete':
    case 'Backspace':
      return e.shiftKey ? 'rippleDelete' : 'delete'
    case 'i':
      return 'markIn'
    case 'o':
      return 'markOut'
    case 'm':
      return 'marker'
    case 'n':
      return 'toggleSnap'
    case 'b':
      return 'drawRegion'
    case 'z':
      return e.shiftKey ? 'zoomFit' : null
    case '+':
    case '=':
      return 'zoomIn'
    case '-':
    case '_':
      return 'zoomOut'
    case 'Escape':
      return 'deselect'
    default:
      return null
  }
}
