import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../styles.css'
import { getReport, runRecordingSpike, testDisplayMediaGesture } from './recordSpike'

declare global {
  interface Window {
    __spikeStart?: (label: string) => void
  }
}

interface SourceInfo {
  id: string
  name: string
  display_id: string
  hasThumb: boolean
}

function SpikeApp(): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const startedRef = useRef(false)
  const screenVideo = useRef<HTMLVideoElement>(null)
  const camVideo = useRef<HTMLVideoElement>(null)

  const log = (msg: string): void => {
    setLines((l) => [...l.slice(-200), msg])
    window.api.spike.log(msg)
  }

  const chooseScreen = async (wantAudio: boolean): Promise<void> => {
    const list = (await window.api.spike.getSources()) as SourceInfo[]
    setSources(list)
    const screen = list.find((s) => s.id.startsWith('screen:'))
    if (!screen) throw new Error('nenhuma tela')
    await window.api.spike.chooseSource(screen.id, wantAudio)
  }

  const start = async (label: string): Promise<void> => {
    if (startedRef.current) {
      log(`start(${label}) ignorado: já iniciado`)
      return
    }
    // Teste A2/A3: getDisplayMedia a partir deste caminho
    const ok = await testDisplayMediaGesture(label, log, () => chooseScreen(false))
    if (!ok) {
      if (label === 'hotkey-ipc') {
        log('tentando via executeJavaScript(userGesture=true)...')
        await window.api.spike.requestGestureStart()
      }
      return
    }
    startedRef.current = true
    setPhase('running')
    try {
      await runRecordingSpike({
        log,
        chooseScreen,
        onPreview: (screen, cam) => {
          if (screenVideo.current) screenVideo.current.srcObject = screen
          if (camVideo.current && cam) camVideo.current.srcObject = cam
        }
      })
      log('enviando relatório...')
      const full = await window.api.spike.done(getReport())
      log(`RELATÓRIO: ${JSON.stringify(full).slice(0, 4000)}`)
    } catch (e) {
      log(`FALHA: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`)
      await window.api.spike.done({ ...getReport(), fatal: String(e) })
    }
    setPhase('done')
  }

  useEffect(() => {
    window.__spikeStart = (label) => void start(label)
    const offHot = window.api.spike.onHotkey(() => {
      log('hotkey recebido no renderer')
      void start('hotkey-ipc')
    })
    // Teste A1: sem gesto, ao carregar
    void (async () => {
      log('Teste A1: getDisplayMedia sem gesto de usuário (ao carregar)')
      const ok = await testDisplayMediaGesture('no-gesture-onload', log, () => chooseScreen(false))
      if (ok) {
        // se funciona sem gesto, roda a sequência completa direto (caminho do atalho global)
        void start('auto-after-A1')
      } else {
        log('Aguardando: clique em "Iniciar por clique" OU pressione Ctrl+Shift+F9 (com esta ou outra janela em foco)')
      }
    })()
    return () => {
      offHot()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">SPIKE — CiaLight Gravador</h1>
        <span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-muted">fase: {phase}</span>
        <button className="rounded bg-accent px-3 py-1 font-medium text-white disabled:opacity-40" disabled={phase !== 'idle'} onClick={() => void start('click')}>
          Iniciar por clique
        </button>
        <span className="text-xs text-muted">ou Ctrl+Shift+F9</span>
      </div>
      <div className="flex gap-3">
        <video ref={screenVideo} autoPlay muted playsInline className="h-40 rounded border border-border bg-black" />
        <video ref={camVideo} autoPlay muted playsInline className="h-40 rounded-full border border-border bg-black object-cover" style={{ width: 160 }} />
        <div className="max-h-40 flex-1 overflow-auto rounded border border-border bg-surface p-2 text-xs">
          <div className="mb-1 text-muted">fontes ({sources.length})</div>
          {sources.slice(0, 12).map((s) => (
            <div key={s.id} className="truncate">
              {s.id} · {s.name} · display={s.display_id || '—'} · thumb={String(s.hasThumb)}
            </div>
          ))}
        </div>
      </div>
      <pre className="flex-1 overflow-auto rounded border border-border bg-surface p-2 text-xs leading-relaxed whitespace-pre-wrap">{lines.join('\n')}</pre>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<SpikeApp />)
