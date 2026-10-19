import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Settings } from '@shared/types'
import { useAppStore } from '@/app/store'

/** Persiste um patch; resolve `true` se o main aceitou, `false` se houve rollback. */
export type SettingsPatch = (patch: Partial<Settings>) => Promise<boolean>
// Uma fila para todas as abas: uma escrita antiga termina antes da próxima prévia otimista.
let settingsWrites: Promise<void> = Promise.resolve()

/**
 * Configurações atuais + função de persistência com preview otimista:
 * aplica o patch no store ao iniciar seu envio ao main (`settings:set`), que devolve
 * o objeto completo e emite `settings:changed` (já tratado pelo App).
 * Se o patch mexe em pastas (outputDir/rawDir), recarrega `appInfo` para que
 * `paths.output`/`paths.raw` voltem a refletir o caminho efetivo.
 */
export function useSettingsPatch(): { settings: Settings; patch: SettingsPatch } {
  const settings = useAppStore((s) => s.settings)
  const patch = useCallback<SettingsPatch>((p) => {
    const write = async (): Promise<boolean> => {
      const st = useAppStore.getState()
      const previous = st.settings
      st.setSettings({ ...previous, ...p })
      try {
        await window.api.settings.set(p)
      } catch (err) {
        const current = useAppStore.getState().settings
        const restored = { ...current }
        for (const key of Object.keys(p) as (keyof Settings)[]) {
          if (JSON.stringify(current[key]) === JSON.stringify(p[key])) Object.assign(restored, { [key]: previous[key] })
        }
        useAppStore.getState().setSettings(restored)
        const detail = err instanceof Error ? err.message : String(err)
        toast.error('Não foi possível salvar a configuração', { description: detail })
        return false
      }
      if ('outputDir' in p || 'rawDir' in p) await refreshAppInfo()
      return true
    }
    const result = settingsWrites.then(write, write)
    settingsWrites = result.then(() => undefined, () => undefined)
    return result
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
