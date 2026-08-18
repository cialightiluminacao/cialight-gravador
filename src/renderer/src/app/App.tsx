import { useEffect } from 'react'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/primitives'
import { useAppStore, type Screen } from './store'
import { wireController } from './recordingController'
import { Titlebar } from './Titlebar'
import { UpdateBanner } from './UpdateBanner'
import { RecoverDialog } from './RecoverDialog'
import { useDevices } from '@/hooks/useDevices'
import { PrepareScreen } from '@/screens/Prepare/PrepareScreen'
import { RecordingScreen } from '@/screens/Recording/RecordingScreen'
import { ReviewScreen } from '@/screens/Review/ReviewScreen'
import { SettingsScreen } from '@/screens/Settings/SettingsScreen'
import { HistoryScreen } from '@/screens/History/HistoryScreen'

// Shell do gravador: título, banner de atualização, tela atual, toasts.
// A tela é escolhida pelo estado (`screen`) — sem router.

declare global {
  interface Window {
    __navigate?: (screen: string) => void
  }
}

function useBoot(): void {
  const st = useAppStore
  useEffect(() => {
    let alive = true
    wireController()
    window.__navigate = (screen) => {
      // 'review:<sessionId>' abre uma sessão bruta na Revisão (QA/histórico)
      if (screen.startsWith('settings:')) {
        sessionStorage.setItem('settingsTab', screen.slice(9))
        st.getState().setScreen('settings')
        return
      }
      if (screen.startsWith('review:')) {
        void window.api.session.get(screen.slice(7)).then((s) => {
          if (s) {
            st.getState().setReviewSession(s)
            st.getState().setScreen('review')
          }
        })
        return
      }
      st.getState().setScreen(screen as Screen)
    }
    void (async () => {
      const [info, settings, hk, upd] = await Promise.all([window.api.app.info(), window.api.settings.get(), window.api.hotkeys.status(), window.api.update.status()])
      if (!alive) return
      st.getState().setAppInfo(info)
      st.getState().setSettings(settings)
      st.getState().setPipDraft({ ...settings.pip, tMs: 0, visible: true })
      st.getState().setHotkeyStatus(hk)
      st.getState().setUpdateStatus(upd)
    })()
    const offs = [
      window.api.settings.onChange((s) => st.getState().setSettings(s)),
      window.api.hotkeys.onStatus((h) => st.getState().setHotkeyStatus(h)),
      window.api.update.onStatus((u) => {
        const prev = st.getState().updateStatus
        st.getState().setUpdateStatus(u)
        if (u.state === 'available' && prev?.state !== 'available') toast(`Nova versão ${u.version} disponível`, { description: 'Clique no banner para baixar.' })
        if (u.state === 'error' && u.error) toast.error(`Atualização: ${u.error}`)
      }),
      window.api.recording.onRecover((sessions) => st.getState().setRecoverable(sessions))
    ]
    return () => {
      alive = false
      offs.forEach((o) => o())
    }
  }, [st])
}

export function App(): React.JSX.Element {
  useBoot()
  useDevices()
  const screen = useAppStore((s) => s.screen)
  return (
    <TooltipProvider>
      <div className="app-bg flex h-full flex-col overflow-hidden">
        <Titlebar />
        <UpdateBanner />
        <main className="relative flex min-h-0 flex-1 flex-col">
          {screen === 'prepare' && <PrepareScreen />}
          {screen === 'recording' && <RecordingScreen />}
          {screen === 'review' && <ReviewScreen />}
          {screen === 'settings' && <SettingsScreen />}
          {screen === 'history' && <HistoryScreen />}
        </main>
        <RecoverDialog />
        <Toaster
          theme="dark"
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ style: { background: 'var(--surface-3)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontFamily: 'var(--font-sans)' } }}
        />
      </div>
    </TooltipProvider>
  )
}
