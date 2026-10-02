import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ArrowDown, ArrowUp, CircleCheckBig, Clock3, Copy, FolderOpen, ListVideo, LoaderCircle, ShieldAlert, TriangleAlert, X, XCircle } from 'lucide-react'
import { create } from 'zustand'
import { exportQuitText } from '@shared/exportQuit'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Progress } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import { copyOutputFile, showOutputInFolder } from '@/screens/Review/outputActions'
import { queueProgress, type QueueItem } from '../export/exportQueue'
import { exportQueue, useExportQueue } from '../export/exportQueueStore'

// Painel "Exportações" (barra superior do editor): a fila com o estado de cada item (na fila, exportando com %
// e tempo restante, concluída, com erro, cancelada), os avisos de privacidade guardados ao enfileirar, cancelar,
// reordenar os pendentes (botões, acessíveis pelo teclado), abrir pasta/copiar os concluídos, "Cancelar todas" e
// "Limpar concluídas". O botão mostra o número de itens ativos e um anel com o progresso global.
// QueueLeaveDialog: sair do editor com a fila ativa pergunta (o mesmo texto da confirmação de saída do app).

function Ring({ fraction }: { fraction: number }): React.JSX.Element {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2.5" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))} strokeLinecap="round" />
    </svg>
  )
}

const pct = (p: number): string => `${Math.floor(p)}%`

function stateText(it: QueueItem, position: number): string {
  switch (it.state) {
    case 'pending':
      return `Na fila · posição ${position}`
    case 'running': {
      const p = it.progress
      if (!p) return 'Preparando…'
      if (p.stage === 'finalize') return `Finalizando… ${pct(p.percent)}`
      const eta = p.etaS != null ? ` · faltam ${formatClock(p.etaS * 1000, false)}` : ''
      const what = p.reserve ? 'Codificador de reserva' : p.stage === 'resize' ? 'Ajustando tamanho' : 'Exportando'
      return `${what} ${pct(p.percent)}${eta}`
    }
    case 'done':
      return `Concluída · ${it.result?.path.split(/[\\/]/).pop() ?? ''}`
    case 'error':
      return `Erro: ${it.message ?? 'falha desconhecida'}`
    case 'cancelled':
      return 'Cancelada'
  }
}

function StateIcon({ state }: { state: QueueItem['state'] }): React.JSX.Element {
  if (state === 'running') return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent-2" aria-hidden />
  if (state === 'done') return <CircleCheckBig className="h-3.5 w-3.5 text-ok" aria-hidden />
  if (state === 'error') return <TriangleAlert className="h-3.5 w-3.5 text-danger" aria-hidden />
  if (state === 'cancelled') return <XCircle className="h-3.5 w-3.5 text-muted" aria-hidden />
  return <Clock3 className="h-3.5 w-3.5 text-muted" aria-hidden />
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-30">
      {children}
    </button>
  )
}

function ItemRow({ it, position, first, last }: { it: QueueItem; position: number; first: boolean; last: boolean }): React.JSX.Element {
  const path = it.result?.path
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border bg-bg-2/60 px-2.5 py-2" data-queue-item={it.state} aria-label={`${it.label} — ${stateText(it, position)}`}>
      <div className="flex items-center gap-2">
        <StateIcon state={it.state} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg" title={it.label}>
          {it.label}
        </span>
        {it.state === 'pending' ? (
          <>
            <IconButton label={`Mover para cima: ${it.label}`} onClick={() => exportQueue.move(it.id, -1)} disabled={first}>
              <ArrowUp className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={`Mover para baixo: ${it.label}`} onClick={() => exportQueue.move(it.id, 1)} disabled={last}>
              <ArrowDown className="h-3.5 w-3.5" />
            </IconButton>
          </>
        ) : null}
        {it.state === 'pending' || it.state === 'running' ? (
          <IconButton label={`Cancelar: ${it.label}`} onClick={() => exportQueue.cancel(it.id)}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        ) : null}
        {it.state === 'done' && path ? (
          <>
            <IconButton label={`Copiar arquivo: ${it.label}`} onClick={() => void copyOutputFile(path)}>
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={`Abrir pasta: ${it.label}`} onClick={() => showOutputInFolder(path)}>
              <FolderOpen className="h-3.5 w-3.5" />
            </IconButton>
          </>
        ) : null}
      </div>
      <span className={cn('truncate pl-5 text-[11px]', it.state === 'error' ? 'text-danger' : 'text-muted')} title={it.state === 'error' ? (it.message ?? undefined) : undefined}>
        {stateText(it, position)}
      </span>
      {it.state === 'running' ? <Progress value={it.progress?.percent ?? 0} className="ml-5 h-1 w-auto" /> : null}
      {it.privacy.length ? (
        <ul className="ml-5 flex flex-col gap-0.5 text-[11px] text-warn" aria-label="Avisos de privacidade" data-queue-privacy="">
          {it.privacy.map((w) => (
            <li key={w} className="flex items-start gap-1">
              <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{w}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** Botão "Exportações" da barra superior (só aparece com itens na fila) + o painel. */
export function ExportQueueButton(): React.JSX.Element | null {
  const items = useExportQueue()
  const [open, setOpen] = useState(false)
  // fila vazia: some — mas não com o painel aberto ("Limpar concluídas"): desmontar um popover aberto deixa a
  // camada dele registrada e o Esc dos diálogos seguintes para de funcionar; some quando o painel fechar
  if (!items.length && !open) return null
  const active = items.filter((i) => i.state === 'pending' || i.state === 'running')
  const prog = queueProgress(items)
  const finished = items.some((i) => i.state === 'done' || i.state === 'error' || i.state === 'cancelled')
  const pendingIds = items.filter((i) => i.state === 'pending').map((i) => i.id)
  const summary =
    prog.fraction == null
      ? items.length
        ? 'Nada em andamento'
        : 'Nada na fila'
      : `${prog.finished} de ${prog.total} · ${pct(prog.fraction * 100)}${prog.etaS != null ? ` · faltam ${formatClock(prog.etaS * 1000, false)}` : ''}`
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="relative h-8 gap-1.5 px-2.5" aria-label={active.length ? `Exportações: ${active.length} na fila` : 'Exportações'} data-export-queue-button="">
          {active.length ? <Ring fraction={prog.fraction ?? 0} /> : <ListVideo className="h-3.5 w-3.5" />}
          Exportações
          {active.length ? (
            <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold tabular-nums text-white" data-export-queue-badge="">
              {active.length}
            </span>
          ) : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="Exportações"
          data-export-queue-panel=""
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 flex w-[380px] flex-col gap-2.5 rounded-xl border border-border-strong bg-surface-3 p-3 shadow-2xl animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-fg">Exportações</span>
            <span className="text-[11px] tabular-nums text-muted" aria-live="polite" data-export-queue-summary="">
              {summary}
            </span>
          </div>
          {prog.fraction != null && active.length ? <Progress value={prog.fraction * 100} className="h-1.5" /> : null}
          <ol className="flex max-h-[min(60vh,420px)] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {items.map((it) => {
              const k = pendingIds.indexOf(it.id)
              const position = it.state === 'pending' ? k + 1 + (active.length - pendingIds.length) : 1
              return <ItemRow key={it.id} it={it} position={position} first={k === 0} last={k === pendingIds.length - 1} />
            })}
          </ol>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">A fila não é salva ao sair do app.</span>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" disabled={!finished} onClick={() => exportQueue.clearFinished()}>
                Limpar concluídas
              </Button>
              <Button variant="secondary" size="sm" className="h-7 px-2 text-[12px]" disabled={!active.length} onClick={() => exportQueue.cancelAll()}>
                Cancelar todas
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

// ---- sair do editor com a fila ativa ----

const useLeaveGuard = create<{ proceed: (() => void) | null }>(() => ({ proceed: null }))

/**
 * Sair do editor (voltar aos projetos): com a fila ativa, pergunta antes ("Há 1 exportação em andamento e 2 na
 * fila. Sair cancela todas…"); confirmado, cancela todas e segue. Sem fila, segue direto.
 */
export function requestLeaveEditor(proceed: () => void): void {
  if (!exportQueue.active()) proceed()
  else useLeaveGuard.setState({ proceed })
}

export function QueueLeaveDialog(): React.JSX.Element {
  const proceed = useLeaveGuard((s) => s.proceed)
  const items = useExportQueue()
  const close = (): void => useLeaveGuard.setState({ proceed: null })
  const text = exportQuitText({ running: items.some((i) => i.state === 'running') ? 1 : 0, pending: items.filter((i) => i.state === 'pending').length })
  return (
    <Dialog open={!!proceed} onOpenChange={(o) => !o && close()}>
      <DialogContent title="Sair do editor?" className="w-[min(460px,92vw)]">
        <div className="flex flex-col gap-4" data-queue-leave="">
          <div className="flex items-start gap-2 text-[13px] text-fg-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span>
              <span className="block font-semibold text-fg">{text.message}</span>
              {text.detail}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} autoFocus>
              Continuar exportando
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const go = proceed
                close()
                exportQueue.cancelAll()
                go?.()
              }}
            >
              Sair e cancelar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
