import { Download, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from './store'
import { Button } from '@/components/ui/Button'
import { Progress } from '@/components/ui/primitives'

// Banner de atualização (main → update:statusChanged). Some quando não há nada a fazer.
export function UpdateBanner(): React.JSX.Element | null {
  const u = useAppStore((s) => s.updateStatus)
  const phase = useAppStore((s) => s.phase)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!u || u.state === 'idle' || u.state === 'checking' || u.state === 'not-available' || u.state === 'error') return null
  if (dismissed === `${u.state}:${u.version}`) return null
  const busy = phase === 'recording' || phase === 'paused' || phase === 'countdown' || phase === 'stopping'
  return (
    <div className="relative z-10 flex items-center gap-3 border-b border-accent/30 bg-accent/10 px-4 py-2 text-sm">
      <span className="font-semibold">Nova versão {u.version}</span>
      {u.state === 'available' && (
        <>
          <span className="text-fg-2">disponível para todas as máquinas.</span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => void window.api.update.download()}>
            <Download className="h-3.5 w-3.5" /> Baixar{u.bytesTotal ? ` (${Math.round(u.bytesTotal / 1048576)} MB)` : ''}
          </Button>
        </>
      )}
      {u.state === 'downloading' && (
        <div className="ml-auto flex w-64 items-center gap-2 text-xs text-muted">
          <Progress value={u.percent ?? 0} className="flex-1" />
          <span className="font-mono tnum">{u.percent ?? 0}%</span>
        </div>
      )}
      {u.state === 'downloaded' && (
        <>
          <span className="text-fg-2">baixada e pronta.</span>
          <Button size="sm" variant="primary" className="ml-auto" disabled={busy} title={busy ? 'Termine a gravação antes de atualizar' : undefined} onClick={() => void window.api.update.install()}>
            <RefreshCw className="h-3.5 w-3.5" /> Reiniciar e atualizar
          </Button>
        </>
      )}
      <button className="rounded p-1 text-muted hover:bg-white/5 hover:text-fg" onClick={() => setDismissed(`${u.state}:${u.version}`)} aria-label="Fechar aviso">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
