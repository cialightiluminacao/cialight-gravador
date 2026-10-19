import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, Check, Copy, LoaderCircle, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentConnectionStatus } from '@shared/agentProtocol'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../state/editorStore'
import { agentRevision, executeAgentRequest, getAgentJobs, subscribeAgentJobs } from './bridge'

const EXAMPLE = 'Use o CiaLight para editar o projeto aberto. Examine os arquivos e a transcrição, remova pausas longas, normalize a voz e crie legendas em português. Confira quadros da prévia, preserve o sentido da fala e exporte em YouTube 1080p. Acompanhe a exportação até concluir e informe o caminho do vídeo. Não baixe modelos sem me avisar.'

export function AgentPanel(): React.JSX.Element {
  const [status, setStatus] = useState<AgentConnectionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [download, setDownload] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const project = useEditorStore(s => s.project)
  const jobs = useSyncExternalStore(subscribeAgentJobs, getAgentJobs)
  const running = jobs.some(j => j.state === 'running')
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.api.agents.status().then(s => { if (alive) setStatus(s) }, e => { if (alive) setError(String(e)) }) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const copy = async (value: string): Promise<void> => { await window.api.app.copyText(value); toast.success('Copiado') }
  return (
    <div className="space-y-5 text-sm" data-agent-panel="">
      <div className="rounded-xl border border-border bg-surface-2 p-4">
        <div className="flex items-center justify-between gap-4">
          <div><h3 className="flex items-center gap-2 font-semibold"><Bot className="h-4 w-4 text-accent" /> Conectar Codex e Claude Code</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted">Os agentes podem montar, legendar, revisar e exportar projetos no seu editor. Cada lote de edição pode ser desfeito com Ctrl+Z.</p></div>
          <Toggle aria-label="Permitir conexão com agentes de IA" checked={status?.enabled ?? false} disabled={busy || !status} onCheckedChange={v => void run(async () => setStatus(await window.api.agents.enable(v)))} />
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted"><span className={`h-2 w-2 rounded-full ${status?.enabled ? 'bg-ok' : 'bg-muted'}`} />{status?.enabled ? status.lastActivity ? 'Conexão ativa · houve atividade de um agente' : 'Pronto para conectar um agente' : 'Conexão desativada'}</div>
        {status?.lastAction && <p className="mt-1 text-xs text-muted">Última atividade: {new Date(status.lastActivity!).toLocaleTimeString('pt-BR')}</p>}
        <p className="mt-3 text-xs leading-relaxed text-muted">A conexão é local e exige o aplicativo aberto. Os arquivos originais ficam no computador; o agente conectado pode receber transcrição e imagens da prévia para analisar o conteúdo.</p>
      </div>
      {status && <div className="space-y-2">
        <h3 className="font-semibold">Conectar seu agente</h3>
        <p className="text-xs text-muted">Ative a conexão e cadastre o CiaLight no seu agente. Depois, atualize a conexão MCP do agente.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void copy(status.codexCommand)}><Copy className="h-3.5 w-3.5" /> Copiar comando do Codex</Button>
          <Button size="sm" variant="secondary" onClick={() => void copy(JSON.stringify(status.config, null, 2))}><Copy className="h-3.5 w-3.5" /> Copiar configuração MCP</Button>
          <Button size="sm" variant="ghost" onClick={() => void copy(EXAMPLE)}>Copiar exemplo de pedido</Button>
        </div>
        <details className="text-xs text-muted"><summary className="cursor-pointer py-1">Ver configuração para Claude Code e outros clientes MCP</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/20 p-3">{JSON.stringify(status.config, null, 2)}</pre></details>
      </div>}
      {project && <div className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-accent" /> Preparar vídeo automaticamente</h3>
        <p className="text-xs leading-relaxed text-muted">Remove pausas longas mantendo a sincronia, normaliza a voz e gera legendas em português. Tudo local, no projeto aberto, em um passo de desfazer. A escolha criativa dos melhores momentos pode ser feita pelo agente conectado.</p>
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={download} onChange={e => setDownload(e.target.checked)} /> Permitir baixar o modelo de legendas se estiver faltando</label>
        <Button size="sm" disabled={busy || running} onClick={() => void run(() => executeAgentRequest({ tool: 'cialight_analyze', args: { projectId: project.id, revision: agentRevision(), task: 'prepare', apply: true, downloadModel: download } }))}>{busy || running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Preparar vídeo</Button>
      </div>}
      {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</p>}
      {jobs.length > 0 && <div className="space-y-2"><h3 className="font-semibold">Atividades de edição</h3>{[...jobs].reverse().slice(0, 6).map(job => <div key={job.id} className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-xs">
        {job.state === 'running' ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : job.state === 'done' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />}
        <div className="min-w-0 flex-1 break-words">{job.progress}</div>
        {job.state === 'running' && <button className="text-muted underline" onClick={() => void run(() => executeAgentRequest({ tool: 'cialight_jobs', args: { jobId: job.id, cancel: true } }))}>Cancelar</button>}
      </div>)}</div>}
    </div>
  )
}

export function AgentButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-label="Agentes de IA"><Bot className="h-3.5 w-3.5" /> IA</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent title="Edição com agentes de IA" description="Automação local, com projeto editável e histórico." className="max-h-[85vh] max-w-2xl overflow-y-auto"><AgentPanel /></DialogContent></Dialog>
  </>
}
