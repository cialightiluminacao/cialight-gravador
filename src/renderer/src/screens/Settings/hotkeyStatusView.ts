import { useSyncExternalStore } from 'react'
import type { HotkeyStatus } from '@shared/ipc'
import { useAppStore } from '@/app/store'

// Enquanto o usuário grava uma combinação na aba Atalhos, os atalhos globais são
// suspensos (mapa vazio no main) e o status "real" do store passa a ser
// «nada registrado». Para a UI não piscar «não registrado» em todas as linhas,
// congelamos aqui a última leitura real e mostramos essa cópia até a captura terminar.

let frozen: HotkeyStatus[] | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Guarda o status atual e passa a exibi-lo até `unfreezeHotkeyStatus()`. Idempotente. */
export function freezeHotkeyStatus(): void {
  if (frozen) return
  frozen = useAppStore.getState().hotkeyStatus
  emit()
}

/** Volta a exibir o status ao vivo do store. Idempotente. */
export function unfreezeHotkeyStatus(): void {
  if (!frozen) return
  frozen = null
  emit()
}

export function isHotkeyStatusFrozen(): boolean {
  return frozen !== null
}

/** Status a exibir: a cópia congelada durante a captura, ou o status ao vivo. */
export function useDisplayedHotkeyStatus(): HotkeyStatus[] {
  const live = useAppStore((s) => s.hotkeyStatus)
  const snapshot = useSyncExternalStore(subscribe, () => frozen)
  return snapshot ?? live
}
