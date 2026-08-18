/**
 * Validação e normalização de atalhos globais (aceleradores do Electron).
 *
 * Forma canônica de saída: `CommandOrControl+Alt+Shift+Super+Tecla`
 * (modificadores nessa ordem, tecla por último, nomes como o Electron espera).
 */

type Modifier = 'CommandOrControl' | 'Alt' | 'Shift' | 'Super'

/** Ordem canônica dos modificadores na saída. */
const MODIFIER_ORDER: Modifier[] = ['CommandOrControl', 'Alt', 'Shift', 'Super']

/** Sinônimos aceitos (em minúsculas) → modificador canônico. */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  shift: 'Shift',
  alt: 'Alt',
  super: 'Super',
  win: 'Super',
  windows: 'Super',
  meta: 'Super'
}

/** Teclas nomeadas do Electron (minúsculas → canônico), incluindo sinônimos comuns. */
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  plus: 'Plus',
  minus: '-',
  printscreen: 'PrintScreen',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
  numdec: 'numdec',
  numadd: 'numadd',
  numsub: 'numsub',
  nummult: 'nummult',
  numdiv: 'numdiv'
}

/** Pontuação aceita pelo Electron como tecla (o `+` deve ser escrito como `Plus`). */
const PUNCTUATION_KEYS = new Set([...'`~!@#$%^&*()-_=[]{}\\|;:\'",.<>/?'])

/** Teclas que podem ser usadas sem modificador (o Electron aceita; a UI avisa quando for F1–F12). */
const STANDALONE_ALLOWED = /^(F([1-9]|1[0-9]|2[0-4])|PrintScreen|Volume(Up|Down|Mute)|Media(NextTrack|PreviousTrack|Stop|PlayPause))$/

/** Resolve o nome de uma tecla (qualquer caixa) para o canônico do Electron; `null` se desconhecida. */
function canonicalKey(raw: string): string | null {
  const lower = raw.toLowerCase()
  const fKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (fKey) return `F${fKey[1]}`
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  const numpad = /^num([0-9])$/.exec(lower)
  if (numpad) return `num${numpad[1]}`
  if (lower in NAMED_KEYS) return NAMED_KEYS[lower]
  if (raw.length === 1 && PUNCTUATION_KEYS.has(raw)) return raw
  return null
}

interface ParsedAccelerator {
  modifiers: Set<Modifier>
  key: string
}

/** Faz o parse de um acelerador em partes canônicas; `null` se inválido. */
function parseAccelerator(input: string): ParsedAccelerator | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const parts = trimmed.split('+').map((p) => p.trim())
  if (parts.some((p) => p === '')) return null
  const modifiers = new Set<Modifier>()
  let key: string | null = null
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod) {
      if (modifiers.has(mod)) return null // modificador repetido
      modifiers.add(mod)
      continue
    }
    if (key !== null) return null // mais de uma tecla
    key = canonicalKey(part)
    if (key === null) return null // tecla desconhecida
  }
  if (key === null) return null // só modificadores
  if (modifiers.size === 0 && !STANDALONE_ALLOWED.test(key)) return null
  return { modifiers, key }
}

function formatParsed(p: ParsedAccelerator): string {
  const mods = MODIFIER_ORDER.filter((m) => p.modifiers.has(m))
  return [...mods, p.key].join('+')
}

/**
 * Normaliza um acelerador para a forma canônica do Electron.
 * `'ctrl+shift+f9'` → `'CommandOrControl+Shift+F9'`; inválido → `null`.
 * Exige ao menos um modificador, exceto para teclas de função (F1–F24), PrintScreen e teclas de mídia.
 */
export function normalizeAccelerator(input: string): string | null {
  const parsed = parseAccelerator(input)
  return parsed ? formatParsed(parsed) : null
}

/** Rótulo curto para exibição na UI: `CommandOrControl+Shift+F9` → `Ctrl+Shift+F9`. */
export function formatAcceleratorLabel(acc: string): string {
  const norm = normalizeAccelerator(acc)
  if (!norm) return acc
  return norm.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').replace(/\+Plus$/, '++').replace(/\+Return$/, '+Enter').replace(/\+Escape$/, '+Esc')
}

export interface HotkeyBlacklistEntry {
  /** Acelerador já na forma canônica. */
  accelerator: string
  /** Motivo em pt-BR exibido na UI. */
  reason: string
}

export const REASON_XBOX = 'Reservado pela Xbox Game Bar'
export const REASON_SNIP = 'Reservado pela Ferramenta de Captura do Windows'
export const REASON_TASKMGR = 'Reservado pelo Gerenciador de Tarefas'
export const REASON_LOOM = 'Usado pelo Loom'
export const REASON_ZIGHT = 'Usado pelo Zight'
export const REASON_FKEY_ALONE = 'Tecla de função sozinha pode conflitar com o app em foco'
export const REASON_ALTGR = 'Ctrl+Alt equivale a AltGr no teclado ABNT2 — pode digitar caracteres em vez de acionar'
export const REASON_INVALID = 'Atalho inválido'
export const REASON_WINDOWS = 'Reservado pelo Windows (Win+tecla)'

/** Atalhos conhecidos por conflitar no Windows / com apps de gravação populares (reuso na UI). */
export const HOTKEY_BLACKLIST: readonly HotkeyBlacklistEntry[] = [
  // Xbox Game Bar
  { accelerator: 'Super+G', reason: REASON_XBOX },
  { accelerator: 'Alt+Super+R', reason: REASON_XBOX },
  { accelerator: 'Alt+Super+M', reason: REASON_XBOX },
  { accelerator: 'Alt+Super+PrintScreen', reason: REASON_XBOX },
  // Ferramenta de Captura
  { accelerator: 'Shift+Super+S', reason: REASON_SNIP },
  { accelerator: 'Shift+Super+R', reason: REASON_SNIP },
  { accelerator: 'PrintScreen', reason: REASON_SNIP },
  // Gerenciador de Tarefas
  { accelerator: 'CommandOrControl+Shift+Escape', reason: REASON_TASKMGR },
  // Loom
  { accelerator: 'CommandOrControl+Shift+L', reason: REASON_LOOM },
  { accelerator: 'Alt+Shift+P', reason: REASON_LOOM },
  { accelerator: 'Alt+Shift+C', reason: REASON_LOOM },
  { accelerator: 'CommandOrControl+Shift+R', reason: REASON_LOOM },
  { accelerator: 'CommandOrControl+Shift+D', reason: REASON_LOOM },
  // Zight
  { accelerator: 'Alt+Shift+6', reason: REASON_ZIGHT },
  { accelerator: 'CommandOrControl+Alt+Shift+I', reason: REASON_ZIGHT },
  // Teclas de função puras
  ...Array.from({ length: 12 }, (_, i) => ({ accelerator: `F${i + 1}`, reason: REASON_FKEY_ALONE }))
]

const BLACKLIST_BY_ACC: ReadonlyMap<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  for (const e of HOTKEY_BLACKLIST) {
    const list = m.get(e.accelerator) ?? []
    if (!list.includes(e.reason)) list.push(e.reason)
    m.set(e.accelerator, list)
  }
  return m
})()

/**
 * Avisos (pt-BR) sobre um acelerador: AltGr/ABNT2, reservas do Windows, conflitos
 * com Loom/Zight, tecla de função sozinha. Lista vazia = sem problemas conhecidos.
 */
export function hotkeyProblems(acc: string): string[] {
  const parsed = parseAccelerator(acc)
  if (!parsed) return [REASON_INVALID]
  const problems: string[] = []
  if (parsed.modifiers.has('CommandOrControl') && parsed.modifiers.has('Alt')) problems.push(REASON_ALTGR)
  // Win+letra/dígito (sem outros modificadores) é quase todo reservado pelo Windows 11
  const listed = BLACKLIST_BY_ACC.get(formatParsed(parsed))
  if (listed) for (const r of listed) if (!problems.includes(r)) problems.push(r)
  else if (parsed.modifiers.has('Super') && parsed.modifiers.size === 1 && /^[A-Z0-9]$/.test(parsed.key)) problems.push(REASON_WINDOWS)
  return problems
}

/**
 * Pares de ações que compartilham o mesmo acelerador normalizado.
 * Ignora `null` e aceleradores inválidos. Ordem segue a das chaves do objeto.
 */
export function findDuplicateHotkeys(map: Record<string, string | null>): [string, string][] {
  const entries: { action: string; acc: string }[] = []
  for (const [action, raw] of Object.entries(map)) {
    if (!raw) continue
    const acc = normalizeAccelerator(raw)
    if (acc) entries.push({ action, acc })
  }
  const dupes: [string, string][] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].acc === entries[j].acc) dupes.push([entries[i].action, entries[j].action])
    }
  }
  return dupes
}
