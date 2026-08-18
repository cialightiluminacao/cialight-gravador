import { useState } from 'react'
import { AlertCircle, CheckCircle2, Download, ExternalLink, GitBranch, Loader2, RefreshCw, RotateCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { UpdateStatus } from '@shared/ipc'
import { useAppStore } from '@/app/store'
import { Button } from '@/components/ui/Button'
import { Badge, Progress, Section, Tip } from '@/components/ui/primitives'
import { Note } from '@/components/ui/SettingRow'
import { formatMB } from '@/lib/format'
import { cn } from '@/lib/cn'

// Aba Atualização e sobre: versão, updater (verificar/baixar/instalar), notas, repositório, licenças.

const REPO_URL = 'https://github.com/cialightiluminacao/cialight-gravador'
const RELEASES_URL = `${REPO_URL}/releases`

interface LicenseEntry {
  name: string
  license: string
  url: string
  note?: string
}

const LICENSES: LicenseEntry[] = [
  { name: 'Electron', license: 'MIT', url: 'https://github.com/electron/electron' },
  { name: 'React', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'Radix UI', license: 'MIT', url: 'https://github.com/radix-ui/primitives' },
  { name: 'lucide', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
  { name: 'mediabunny', license: 'MPL-2.0', url: 'https://github.com/Vanilagy/mediabunny' },
  { name: 'zustand', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
  { name: 'sonner', license: 'MIT', url: 'https://github.com/emilkowalski/sonner' },
  { name: 'Tailwind CSS', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss' },
  { name: 'electron-updater / electron-log', license: 'MIT', url: 'https://github.com/electron-userland/electron-builder' },
  { name: 'Fontes Manrope e Azeret Mono', license: 'OFL 1.1', url: 'https://github.com/fontsource/fontsource' },
  {
    name: 'FFmpeg (build BtbN)',
    license: 'GPL v3',
    url: 'https://github.com/BtbN/FFmpeg-Builds',
    note: 'Executável independente (não é vinculado ao app), chamado só na exportação, conforme a GPL v3. O código-fonte está no repositório do FFmpeg (github.com/FFmpeg/FFmpeg) e o texto da licença acompanha o ffmpeg.exe (LICENSE.txt na pasta de instalação).'
  }
]

/** Notas da release: markdown bem simples (títulos, listas, parágrafos). */
function ReleaseNotes({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-border bg-bg-2 px-3 py-2 text-xs leading-relaxed text-fg-2">
      {lines.map((line, i) => {
        const t = line.trim()
        if (!t) return <div key={i} className="h-1" />
        const heading = /^#{1,6}\s+(.*)$/.exec(t)
        if (heading)
          return (
            <div key={i} className="pt-1 font-semibold text-fg">
              {heading[1]}
            </div>
          )
        const bullet = /^[-*•]\s+(.*)$/.exec(t)
        if (bullet)
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="text-muted">•</span>
              <span>{bullet[1]}</span>
            </div>
          )
        return <p key={i}>{t}</p>
      })}
    </div>
  )
}

function statusLine(u: UpdateStatus | null): { icon: React.ReactNode; text: string; tone: 'muted' | 'ok' | 'warn' | 'danger' | 'info' } {
  if (!u || u.state === 'idle') return { icon: <RefreshCw className="h-4 w-4" />, text: 'O app verifica atualizações sozinho ao abrir e a cada hora.', tone: 'muted' }
  switch (u.state) {
    case 'checking':
      return { icon: <Loader2 className="h-4 w-4 animate-spin" />, text: 'Verificando atualizações…', tone: 'info' }
    case 'available':
      return { icon: <Sparkles className="h-4 w-4" />, text: `Nova versão ${u.version} disponível${u.bytesTotal ? ` (${formatMB(u.bytesTotal / 1048576)})` : ''}.`, tone: 'ok' }
    case 'downloading':
      return { icon: <Loader2 className="h-4 w-4 animate-spin" />, text: `Baixando a versão ${u.version}… ${u.percent ?? 0}%`, tone: 'info' }
    case 'downloaded':
      return { icon: <CheckCircle2 className="h-4 w-4" />, text: `Versão ${u.version} baixada e pronta para instalar.`, tone: 'ok' }
    case 'not-available':
      return { icon: <CheckCircle2 className="h-4 w-4" />, text: 'Você já está na versão mais recente.', tone: 'ok' }
    case 'error':
      return { icon: <AlertCircle className="h-4 w-4" />, text: `Não foi possível verificar: ${u.error ?? 'erro desconhecido'}.`, tone: 'danger' }
  }
}

export function UpdateTab(): React.JSX.Element {
  const appInfo = useAppStore((s) => s.appInfo)
  const update = useAppStore((s) => s.updateStatus)
  const phase = useAppStore((s) => s.phase)
  const [checking, setChecking] = useState(false)
  const busy = phase === 'recording' || phase === 'paused' || phase === 'countdown' || phase === 'stopping'
  const line = statusLine(update)
  const toneCls = { muted: 'text-muted', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', info: 'text-info' }[line.tone]
  const external = (url: string): void => void window.api.app.openExternal(url)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await window.api.update.check(true)
      const after = useAppStore.getState().updateStatus?.state ?? 'idle'
      if (after === 'idle') toast.info('O verificador de atualizações não está ativo nesta instalação.')
    } catch (err) {
      toast.error('Falha ao verificar atualização', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setChecking(false)
    }
  }

  const state = update?.state ?? 'idle'
  const canCheck = state !== 'checking' && state !== 'downloading' && !checking

  return (
    <div className="flex flex-col gap-4">
      <Section title="Sobre" className="rise-in">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/15 ring-1 ring-accent/30">
            <span className="h-4 w-4 rounded-full bg-accent shadow-[0_0_18px_rgba(255,77,79,0.6)]" />
          </div>
          <div className="shrink-0">
            <div className="flex items-baseline gap-3">
              <span className="whitespace-nowrap text-base font-bold tracking-tight">CiaLight Gravador</span>
              <span className="font-mono tnum text-sm text-fg-2">v{appInfo?.version ?? '—'}</span>
              {appInfo && !appInfo.isPackaged ? <Badge tone="info">desenvolvimento</Badge> : null}
            </div>
            <p className="mt-0.5 whitespace-nowrap text-xs text-muted">
              Electron <span className="font-mono">{appInfo?.electron ?? '—'}</span> · Chromium <span className="font-mono">{appInfo?.chrome ?? '—'}</span> · Windows x64
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => external(REPO_URL)}>
              <GitBranch className="h-3.5 w-3.5" /> Repositório
            </Button>
            <Button size="sm" variant="ghost" onClick={() => external(RELEASES_URL)}>
              Versões <ExternalLink className="h-3 w-3 text-muted" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => external(`${REPO_URL}/issues`)}>
              Relatar problema <ExternalLink className="h-3 w-3 text-muted" />
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Gravador de tela da Cia Light: monitor ou janela, câmera, som do sistema e microfone em faixas separadas, anotações ao vivo e exportação com presets. Código aberto sob a licença MIT.
        </p>
      </Section>

      <Section title="Atualizações" className="rise-in rise-in-1">
        <div className="flex items-center gap-3">
          <span className={cn('shrink-0', toneCls)}>{line.icon}</span>
          <span className="min-w-0 flex-1 text-sm text-fg-2">{line.text}</span>
          <div className="flex shrink-0 items-center gap-2">
            {state === 'available' ? (
              <Button size="sm" variant="primary" onClick={() => void window.api.update.download()}>
                <Download className="h-3.5 w-3.5" /> Baixar{update?.bytesTotal ? ` (${formatMB(update.bytesTotal / 1048576)})` : ''}
              </Button>
            ) : null}
            {state === 'downloaded' ? (
              <Tip content={busy ? 'Termine a gravação antes de atualizar' : 'Fecha o app, instala e abre de novo'}>
                <span>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void window.api.update.install()}>
                    <RotateCw className="h-3.5 w-3.5" /> Reiniciar e atualizar
                  </Button>
                </span>
              </Tip>
            ) : null}
            <Button size="sm" variant="secondary" disabled={!canCheck} onClick={() => void check()}>
              <RefreshCw className={cn('h-3.5 w-3.5', (checking || state === 'checking') && 'animate-spin')} /> Verificar agora
            </Button>
          </div>
        </div>
        {state === 'downloading' ? <Progress value={update?.percent ?? 0} className="mt-3" tone="info" /> : null}
        {update?.notes && (state === 'available' || state === 'downloading' || state === 'downloaded') ? (
          <div className="mt-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Novidades da versão {update.version}</div>
            <ReleaseNotes text={update.notes} />
          </div>
        ) : null}
        {appInfo && !appInfo.isPackaged ? (
          <Note tone="neutral" className="mt-3">
            Em modo de desenvolvimento o updater fica desligado — as atualizações automáticas só funcionam na versão instalada pelo instalador.
          </Note>
        ) : null}
      </Section>

      <Section title="Licenças de terceiros" className="rise-in rise-in-2">
        <ul className="grid grid-cols-3 gap-x-6">
          {LICENSES.map((l) => (
            <li key={l.name} className={cn('flex items-start gap-3 border-b border-border py-1', l.note && 'col-span-3 border-b-0 pt-2')}>
              <div className="min-w-0 flex-1">
                <button type="button" className="whitespace-nowrap text-left text-[13px] font-medium text-fg hover:text-accent-2 hover:underline" onClick={() => external(l.url)}>
                  {l.name}
                </button>
                {l.note ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{l.note}</p> : null}
              </div>
              <Badge tone="neutral" className="h-5 shrink-0 normal-case tracking-normal">
                {l.license}
              </Badge>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
