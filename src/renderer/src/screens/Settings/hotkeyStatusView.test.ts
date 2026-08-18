import { describe, expect, it } from 'vitest'
import type { HotkeyStatus } from '@shared/ipc'
import { useAppStore } from '@/app/store'
import { freezeHotkeyStatus, isHotkeyStatusFrozen, unfreezeHotkeyStatus } from './hotkeyStatusView'

const real: HotkeyStatus[] = [{ action: 'toggleRecord', accelerator: 'CommandOrControl+Shift+F9', registered: true, problems: [] }]
const suspended: HotkeyStatus[] = [{ action: 'toggleRecord', accelerator: null, registered: false, problems: [] }]

describe('hotkeyStatusView', () => {
  it('congela a última leitura real e ignora o status «suspenso» até descongelar', () => {
    useAppStore.getState().setHotkeyStatus(real)
    expect(isHotkeyStatusFrozen()).toBe(false)
    freezeHotkeyStatus()
    expect(isHotkeyStatusFrozen()).toBe(true)
    // o main devolve «nada registrado» enquanto os atalhos estão suspensos
    useAppStore.getState().setHotkeyStatus(suspended)
    expect(useAppStore.getState().hotkeyStatus).toBe(suspended)
    unfreezeHotkeyStatus()
    expect(isHotkeyStatusFrozen()).toBe(false)
  })
  it('freeze/unfreeze são idempotentes', () => {
    useAppStore.getState().setHotkeyStatus(real)
    freezeHotkeyStatus()
    useAppStore.getState().setHotkeyStatus(suspended)
    freezeHotkeyStatus()
    expect(isHotkeyStatusFrozen()).toBe(true)
    unfreezeHotkeyStatus()
    unfreezeHotkeyStatus()
    expect(isHotkeyStatusFrozen()).toBe(false)
  })
})
