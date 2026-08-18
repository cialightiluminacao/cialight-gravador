import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Settings } from '@shared/types'
import { useAppStore } from '@/app/store'

export type SettingsPatch = (patch: Partial<Settings>) => Promise<void>

/**
 * Configurações atuais + função de persistência com preview otimista:
 * aplica o patch no store na hora e envia ao main (`settings:set`), que devolve
 * o objeto completo e emite `settings:changed` (já tratado pelo App).
 */
export function useSettingsPatch(): { settings: Settings; patch: SettingsPatch } {
  const settings = useAppStore((s) => s.settings)
  const patch = useCallback<SettingsPatch>(async (p) => {
    const st = useAppStore.getState()
    const previous = st.settings
    st.setSettings({ ...previous, ...p })
    try {
      await window.api.settings.set(p)
    } catch (err) {
      useAppStore.getState().setSettings(previous)
      const detail = err instanceof Error ? err.message : String(err)
      toast.error('Não foi possível salvar a configuração', { description: detail })
    }
  }, [])
  return { settings, patch }
}
