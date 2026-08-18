import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Settings } from '@shared/types'
import { useAppStore } from '@/app/store'

/** Persiste um patch; resolve `true` se o main aceitou, `false` se houve rollback. */
export type SettingsPatch = (patch: Partial<Settings>) => Promise<boolean>

/**
 * Configurações atuais + função de persistência com preview otimista:
 * aplica o patch no store na hora e envia ao main (`settings:set`), que devolve
 * o objeto completo e emite `settings:changed` (já tratado pelo App).
 * Se o patch mexe em pastas (outputDir/rawDir), recarrega `appInfo` para que
 * `paths.output`/`paths.raw` voltem a refletir o caminho efetivo.
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
      return false
    }
    if ('outputDir' in p || 'rawDir' in p) await refreshAppInfo()
    return true
  }, [])
  return { settings, patch }
}

/** Relê `app.info()` (caminhos efetivos) e atualiza o store; falha é silenciosa. */
export async function refreshAppInfo(): Promise<void> {
  try {
    const info = await window.api.app.info()
    useAppStore.getState().setAppInfo(info)
  } catch {
    // sem appInfo novo o campo mostra o último caminho conhecido
  }
}
