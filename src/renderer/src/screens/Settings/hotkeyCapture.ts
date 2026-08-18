import { normalizeAccelerator } from '@shared/hotkeys'

// Tradução de um evento de teclado (KeyboardEvent) para um acelerador do Electron.
// Lógica pura, sem DOM, para ser testável.

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export type CaptureResult =
  /** Só modificadores pressionados: continua esperando a tecla. */
  | { kind: 'pending'; modifiers: string[] }
  /** Backspace/Delete sem modificadores: limpar o atalho. */
  | { kind: 'clear' }
  /** Escape sem modificadores: sair sem alterar. */
  | { kind: 'cancel' }
  /** Combinação completa; `accelerator` já normalizado, ou `null` se o Electron não aceita. */
  | { kind: 'done'; accelerator: string | null; raw: string }

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

/** Teclas nomeadas: `code` do DOM → nome do Electron. */
const CODE_TO_ELECTRON: Record<string, string> = {
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  ScrollLock: 'Scrolllock',
  Pause: 'Pause',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/'
}

/** Nome da tecla (sem modificadores) no vocabulário do Electron; `null` se não for mapeável. */
export function electronKeyName(e: Pick<KeyLike, 'key' | 'code'>): string | null {
  const { code, key } = e
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad([0-9])$/.exec(code)
  if (numpad) return `num${numpad[1]}`
  const fKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (fKey) return `F${fKey[1]}`
  if (code in CODE_TO_ELECTRON) return CODE_TO_ELECTRON[code]
  // Teclado ABNT2 e outros layouts: cai no caractere produzido, se for imprimível.
  if (key.length === 1) {
    if (key === '+') return 'Plus'
    if (/^[a-z]$/i.test(key)) return key.toUpperCase()
    if (/^[0-9]$/.test(key)) return key
    if (key !== ' ') return key
  }
  return null
}

/** Lista de modificadores ativos, na ordem canônica do Electron. */
export function activeModifiers(e: Pick<KeyLike, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string[] {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  return mods
}

/** Interpreta um keydown durante a captura de atalho. */
export function captureFromKey(e: KeyLike): CaptureResult {
  const mods = activeModifiers(e)
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'pending', modifiers: mods }
  if (mods.length === 0) {
    if (e.code === 'Backspace' || e.code === 'Delete') return { kind: 'clear' }
    if (e.code === 'Escape') return { kind: 'cancel' }
  }
  const name = electronKeyName(e)
  const raw = [...mods, name ?? e.key].join('+')
  const accelerator = name ? normalizeAccelerator([...mods, name].join('+')) : null
  return { kind: 'done', accelerator, raw }
}
