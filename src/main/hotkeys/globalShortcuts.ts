import { globalShortcut } from 'electron'
import type { HotkeyStatus } from '@shared/ipc'
import type { HotkeyAction, RecorderCommand } from '@shared/types'
import { hotkeyProblems, normalizeAccelerator } from '@shared/hotkeys'
import { broadcastCommand, getPhase } from '../recording/state'
import { log } from '../log'

// Atalhos globais (funcionam com qualquer app em foco — validado no spike).
// globalShortcut.register() retorna false silenciosamente quando outro app já
// registrou a combinação — por isso devolvemos HotkeyStatus para a UI.

const ACTION_TO_COMMAND: Record<HotkeyAction, RecorderCommand> = {
  toggleRecord: 'toggleRecord',
  pauseResume: 'pauseResume',
  cancel: 'cancel',
  toggleBar: 'toggleBar',
  restart: 'restart',
  annotate: 'annotate',
  arrow: 'arrow',
  clearAnnotations: 'clearAnnotations',
  muteMic: 'muteMic',
  toggleCamera: 'toggleCamera'
}

// Ações que só fazem sentido com gravação ativa (evita, p.ex., abrir modo desenho ocioso).
const NEEDS_ACTIVE = new Set<HotkeyAction>(['pauseResume', 'cancel', 'toggleBar', 'restart', 'annotate', 'arrow', 'clearAnnotations'])

let currentStatus: HotkeyStatus[] = []
let statusListener: ((s: HotkeyStatus[]) => void) | null = null

export function onHotkeyStatus(cb: (s: HotkeyStatus[]) => void): void {
  statusListener = cb
}

export function dispatch(action: HotkeyAction): void {
  const phase = getPhase()
  const active = phase === 'recording' || phase === 'paused' || phase === 'countdown'
  if (NEEDS_ACTIVE.has(action) && !active) {
    log.debug(`atalho ${action} ignorado (fase ${phase})`)
    return
  }
  log.info(`atalho: ${action}`)
  broadcastCommand(ACTION_TO_COMMAND[action])
}

export function applyHotkeys(map: Record<HotkeyAction, string | null>): HotkeyStatus[] {
  globalShortcut.unregisterAll()
  const status: HotkeyStatus[] = []
  const used = new Map<string, HotkeyAction>()
  for (const action of Object.keys(map) as HotkeyAction[]) {
    const raw = map[action]
    if (!raw) {
      status.push({ action, accelerator: null, registered: false, problems: [] })
      continue
    }
    const acc = normalizeAccelerator(raw)
    if (!acc) {
      status.push({ action, accelerator: raw, registered: false, problems: ['Combinação inválida'] })
      continue
    }
    const problems = [...hotkeyProblems(acc)]
    const dup = used.get(acc)
    if (dup) {
      status.push({ action, accelerator: acc, registered: false, problems: [`Mesma combinação de "${dup}"`, ...problems] })
      continue
    }
    let ok = false
    try {
      ok = globalShortcut.register(acc, () => dispatch(action))
    } catch (e) {
      log.warn(`register(${acc}) lançou`, e)
    }
    if (!ok) problems.unshift('Não foi possível registrar (outro programa usa esta combinação)')
    else used.set(acc, action)
    status.push({ action, accelerator: acc, registered: ok, problems })
  }
  currentStatus = status
  statusListener?.(status)
  log.info(`atalhos aplicados: ${status.filter((s) => s.registered).length}/${status.filter((s) => s.accelerator).length} registrados`)
  return status
}

export function getHotkeyStatus(): HotkeyStatus[] {
  return currentStatus
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll()
}
