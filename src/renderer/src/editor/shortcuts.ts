// Atalhos de teclado do editor (spec §9). `shortcutFor` é puro (testável): traduz um evento de
// teclado na ação; quem executa é editor/ui/editorActions.ts. Ignora eventos vindos de campos de texto.

export type ShortcutAction =
  | 'playPause'
  | 'shuttleBack' // J: para trás 1× → 2× → 4× → 8×
  | 'pause' // K
  | 'shuttleForward' // L: para frente 1× → 2× → 4× → 8× (K segurado + J/L: quadro a quadro)
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
  | 'copy' // itens selecionados ou, com losangos selecionados na linha do tempo, os keyframes
  | 'paste' // o que foi copiado por último: itens no playhead ou keyframes no playhead do item selecionado
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
  | 'zoomTool' // Z: ferramenta "Zoom" do visualizador (Shift+Z continua sendo ajustar a timeline; Ctrl+Z desfazer)
  | 'toggleKeyframe' // Alt+K (K sozinho é pausa)
  | 'prevKeyframe' // [
  | 'nextKeyframe' // ]
  | 'toggleEnabled' // Shift+E (com os vinculados)
  | 'toggleEnabledUnlinked' // Alt+Shift+E (Alt ignora o vínculo, como mover/aparar)

/** Transporte (tocar/pausar, J/K/L, quadro a quadro, ±1 s, início/fim): o que passa com o painel não modal aberto. */
export const TRANSPORT_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['playPause', 'pause', 'shuttleBack', 'shuttleForward', 'prevFrame', 'nextFrame', 'back1s', 'fwd1s', 'home', 'end'])

/** Com o editor de curvas aberto (popover não modal): o transporte e desfazer/refazer continuam valendo. */
export const CURVE_EDITOR_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([...TRANSPORT_ACTIONS, 'undo', 'redo'])

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
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
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
  drawRegion: 'B',
  zoomTool: 'Z',
  toggleKeyframe: 'Alt+K',
  prevKeyframe: '[',
  nextKeyframe: ']',
  toggleEnabled: 'Shift+E'
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

/** Estado de teclas seguradas que muda o atalho (K segurado + J/L = quadro a quadro, como nos editores clássicos). */
export interface HeldKeys { kHeld?: boolean }

export function shortcutFor(e: KeyLike, held: HeldKeys = {}): ShortcutAction | null {
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
  if (e.altKey) {
    if (!e.shiftKey && (k === 'k' || e.code === 'KeyK')) return 'toggleKeyframe'
    if (e.shiftKey && (k === 'e' || e.code === 'KeyE')) return 'toggleEnabledUnlinked'
    return null
  }
  switch (k) {
    case ' ':
      return 'playPause'
    case 'j':
      return held.kHeld ? 'prevFrame' : 'shuttleBack'
    case 'k':
      return 'pause'
    case 'l':
      return held.kHeld ? 'nextFrame' : 'shuttleForward'
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
    case '[':
      return 'prevKeyframe'
    case ']':
      return 'nextKeyframe'
    case 'e':
      return e.shiftKey ? 'toggleEnabled' : null
    case 'z':
      return e.shiftKey ? 'zoomFit' : 'zoomTool'
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
