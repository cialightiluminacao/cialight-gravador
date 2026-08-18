import type { BarState } from '@shared/ipc'
import type { RecorderCommand, RecorderPhase } from '@shared/types'

// Espelho do estado da gravação no main. A fonte de verdade é o engine no
// renderer do gravador; o main só precisa saber a fase para bandeja, barra,
// overlays, atalhos e proteção das janelas.

type PhaseListener = (phase: RecorderPhase, prev: RecorderPhase) => void
type CommandSink = (cmd: RecorderCommand) => void

let phase: RecorderPhase = 'idle'
let barState: BarState | null = null
const listeners = new Set<PhaseListener>()
let commandSink: CommandSink | null = null

export function getPhase(): RecorderPhase {
  return phase
}

export function isRecordingActive(): boolean {
  return phase === 'countdown' || phase === 'recording' || phase === 'paused' || phase === 'stopping'
}

export function setPhaseValue(next: RecorderPhase): void {
  const prev = phase
  if (prev === next) return
  phase = next
  for (const l of listeners) l(next, prev)
}

export function onPhase(cb: PhaseListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setBarState(s: BarState): void {
  barState = s
}

export function getBarState(): BarState | null {
  return barState
}

/** Registrado pelo bootstrap: envia comandos ao renderer do gravador. */
export function setCommandSink(sink: CommandSink): void {
  commandSink = sink
}

export function broadcastCommand(cmd: RecorderCommand): void {
  commandSink?.(cmd)
}
