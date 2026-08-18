import { useState } from 'react'
import { useAppStore } from './store'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { formatDate } from '@/lib/format'

// Sessões interrompidas (queda de energia/crash): oferecer recuperar ou excluir.
export function RecoverDialog(): React.JSX.Element | null {
  const list = useAppStore((s) => s.recoverable)
  const setRecoverable = useAppStore((s) => s.setRecoverable)
  const setReviewSession = useAppStore((s) => s.setReviewSession)
  const setScreen = useAppStore((s) => s.setScreen)
  const [busy, setBusy] = useState(false)
  if (!list.length) return null
  const s = list[0]
  const rest = list.slice(1)
  const recover = async (): Promise<void> => {
    setBusy(true)
    try {
      const fresh = (await window.api.session.get(s.id)) ?? s
      fresh.state = 'stopped'
      await window.api.session.save(fresh)
      setReviewSession(fresh)
      setScreen('review')
    } finally {
      setBusy(false)
      setRecoverable(rest)
    }
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.session.delete(s.id)
    } finally {
      setBusy(false)
      setRecoverable(rest)
    }
  }
  return (
    <Dialog open>
      <DialogContent
        hideClose
        title="Encontrei uma gravação interrompida"
        description={`Gravação de ${formatDate(s.createdAt)} (${s.source.name}) não foi finalizada. O arquivo bruto está salvo até o último segundo gravado.`}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
              Excluir
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void recover()}>
              Recuperar e revisar
            </Button>
          </>
        }
      />
    </Dialog>
  )
}
