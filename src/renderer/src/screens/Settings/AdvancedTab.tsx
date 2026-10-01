import { useState } from 'react'
import { Cpu, EyeOff, FileText, FolderOpen, HardDrive, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { ENCODER_LABELS } from '@shared/defaults'
import { useAppStore } from '@/app/store'
import { Button } from '@/components/ui/Button'
import { Badge, Section, Tip, Toggle } from '@/components/ui/primitives'
import { Note, SettingRow, SettingRows } from '@/components/ui/SettingRow'
import { PathField } from '@/components/ui/PathField'
import { formatDate } from '@/lib/format'
import { useSettingsPatch } from './useSettingsPatch'

// Aba Avançado: proteção das janelas, encoder de exportação, pasta de brutos, logs e dados.

export function AdvancedTab(): React.JSX.Element {
  const { settings, patch } = useSettingsPatch()
  const appInfo = useAppStore((s) => s.appInfo)
  const setSettings = useAppStore((s) => s.setSettings)
  const [probing, setProbing] = useState(false)
  const probe = settings.encoderProbeV2

  const reprobe = async (): Promise<void> => {
    setProbing(true)
    try {
      const result = await window.api.export.probeEncoders(true)
      setSettings({ ...useAppStore.getState().settings, encoderProbeV2: result })
      toast.success(`Encoder preferido: ${ENCODER_LABELS[result.preferred]}`)
    } catch (err) {
      toast.error('Falha ao testar os encoders', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setProbing(false)
    }
  }

  const openPath = (p: string | undefined): void => {
    if (p) void window.api.app.openPath(p)
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title="Proteção das janelas" className="rise-in">
        <SettingRow
          label={
            <span className="inline-flex items-center gap-2">
              <EyeOff className="h-4 w-4 text-muted" /> Esconder o gravador da gravação
            </span>
          }
          description="Esconde o gravador, a barra e as anotações da gravação. Desligue se estiver usando acesso remoto (RustDesk/RDP) e as janelas do gravador sumirem para você."
          htmlFor="protectWindows"
        >
          <Toggle id="protectWindows" checked={settings.protectWindows} onCheckedChange={(v) => void patch({ protectWindows: v })} />
        </SettingRow>
      </Section>

      <Section
        title="Encoder de exportação"
        className="rise-in rise-in-1"
        aside={
          <Button size="sm" variant="secondary" onClick={() => void reprobe()} disabled={probing}>
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {probing ? 'Testando…' : 'Testar de novo'}
          </Button>
        }
      >
        {probe ? (
          <SettingRows>
            <SettingRow label="Preferido" description={probe.probedAt ? `Detectado em ${formatDate(probe.probedAt)} para a placa de vídeo atual.` : 'Escolhido automaticamente pela placa de vídeo.'}>
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-fg" title={`GPU: ${probe.gpuKey}`}>
                <Cpu className="h-4 w-4 text-ok" /> {ENCODER_LABELS[probe.preferred]}
              </span>
            </SettingRow>
            <SettingRow label="Disponíveis nesta máquina" description="Se o preferido falhar na hora de exportar, o app tenta o próximo da lista automaticamente.">
              <div className="flex flex-wrap justify-end gap-1.5">
                {probe.available.map((e) => (
                  <Badge key={e} tone={e === probe.preferred ? 'ok' : 'neutral'} className="normal-case tracking-normal">
                    {ENCODER_LABELS[e]}
                  </Badge>
                ))}
              </div>
            </SettingRow>
          </SettingRows>
        ) : (
          <Note tone="neutral" icon={<Cpu />}>
            Ainda não testado — o app detecta o melhor encoder (NVIDIA, Intel, Media Foundation ou software) na primeira exportação. Clique em «Testar de novo» para detectar agora.
          </Note>
        )}
      </Section>

      <Section title="Pastas e diagnóstico" className="rise-in rise-in-2">
        <SettingRows>
          <SettingRow label="Onde ficam as gravações brutas" description="Cada gravação vira uma pasta com o vídeo original, a câmera e o áudio separados. A limpeza automática segue a retenção da aba Geral." stack>
            <PathField value={settings.rawDir} defaultPath={appInfo?.paths.raw ?? null} onChange={(v) => void patch({ rawDir: v })} />
          </SettingRow>
          <SettingRow
            label={
              <span className="inline-flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted" /> Logs e dados do aplicativo
              </span>
            }
            description="Registro de erros (envie o mais recente ao pedir suporte) e pasta de configurações e cache."
          >
            <Tip content={appInfo?.paths.logs ?? 'Pasta de logs'}>
              <span>
                <Button size="sm" variant="secondary" disabled={!appInfo} onClick={() => openPath(appInfo?.paths.logs)}>
                  <FolderOpen className="h-3.5 w-3.5" /> Abrir pasta de logs
                </Button>
              </span>
            </Tip>
            <Tip content={appInfo?.paths.userData ?? 'Pasta de dados do aplicativo'}>
              <span>
                <Button size="sm" variant="ghost" disabled={!appInfo} onClick={() => openPath(appInfo?.paths.userData)}>
                  <HardDrive className="h-3.5 w-3.5" /> Pasta de dados
                </Button>
              </span>
            </Tip>
          </SettingRow>
        </SettingRows>
      </Section>
    </div>
  )
}
