import { useState } from 'react'
import { AlertTriangle, Camera, Headphones, Mic, RefreshCw, ShieldCheck, Speaker, Volume2 } from 'lucide-react'
import { toast } from 'sonner'
import type { MicMode } from '@shared/types'
import { useAppStore } from '@/app/store'
import { refreshDevices } from '@/hooks/useDevices'
import { Button } from '@/components/ui/Button'
import { Section, Segmented, Select, Tip, Toggle, type SelectOption } from '@/components/ui/primitives'
import { Note, SettingRow, SettingRows } from '@/components/ui/SettingRow'
import { cn } from '@/lib/cn'
import { useSettingsPatch } from './useSettingsPatch'

// Aba Dispositivos: câmera/microfone padrão, modo do microfone, toggles ao abrir, permissões.

const AUTO = 'auto'

function deviceOptions(list: MediaDeviceInfo[], fallback: string): SelectOption[] {
  return [{ value: AUTO, label: 'Automático', hint: 'primeiro disponível' }, ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))]
}

function ensureCurrent(options: SelectOption[], id: string | null): SelectOption[] {
  if (!id || options.some((o) => o.value === id)) return options
  return [...options, { value: id, label: 'Dispositivo desconectado', hint: 'não encontrado agora' }]
}

export function DevicesTab(): React.JSX.Element {
  const { settings, patch } = useSettingsPatch()
  const devices = useAppStore((s) => s.devices)
  const [refreshing, setRefreshing] = useState(false)
  const d = settings.devices
  const setDevices = (p: Partial<typeof d>): void => void patch({ devices: { ...d, ...p } })

  const cameraOptions = ensureCurrent(deviceOptions(devices.cameras, 'Câmera'), d.cameraId)
  const micOptions = ensureCurrent(deviceOptions(devices.mics, 'Microfone'), d.micId)
  const noCamera = devices.ready && devices.cameras.length === 0
  const noMic = devices.ready && devices.mics.length === 0

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshDevices()
      const st = useAppStore.getState().devices
      toast.success(`${st.cameras.length} câmera(s) e ${st.mics.length} microfone(s) encontrados`)
    } finally {
      setRefreshing(false)
    }
  }
  const openPrivacy = (page: 'webcam' | 'microphone'): void => void window.api.app.openExternal(`ms-settings:privacy-${page}`)

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Dispositivos padrão"
        className="rise-in"
        aside={
          <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Atualizar dispositivos
          </Button>
        }
      >
        <SettingRows>
          <SettingRow label="Câmera" description={noCamera ? 'Nenhuma câmera encontrada — conecte uma e clique em Atualizar.' : 'Usada no PiP. «Automático» pega a primeira que o Windows listar.'}>
            <Select className="w-72" value={d.cameraId ?? AUTO} onValueChange={(v) => setDevices({ cameraId: v === AUTO ? null : v })} options={cameraOptions} disabled={!devices.ready} />
          </SettingRow>
          <SettingRow label="Microfone" description={noMic ? 'Nenhum microfone encontrado — conecte um e clique em Atualizar.' : 'Sua voz. O nível aparece na tela Preparar antes de gravar.'}>
            <Select className="w-72" value={d.micId ?? AUTO} onValueChange={(v) => setDevices({ micId: v === AUTO ? null : v })} options={micOptions} disabled={!devices.ready} />
          </SettingRow>
          <SettingRow
            label="Como você ouve o computador"
            description={
              d.micMode === 'speakers'
                ? 'Caixas de som ligam o cancelamento de eco: o som do computador não volta pelo microfone.'
                : 'Com fone de ouvido o microfone não capta o som do computador; o áudio fica mais limpo sem processamento extra.'
            }
          >
            <Segmented<MicMode>
              value={d.micMode}
              onValueChange={(m) => setDevices({ micMode: m })}
              options={[
                {
                  value: 'headset',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Headphones className="h-3.5 w-3.5" /> Fone de ouvido
                    </span>
                  )
                },
                {
                  value: 'speakers',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Speaker className="h-3.5 w-3.5" /> Caixas de som
                    </span>
                  )
                }
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Acesso à câmera e ao microfone"
            description="Se os dispositivos não aparecem ou a gravação falha com «acesso negado», libere o acesso para aplicativos da área de trabalho na privacidade do Windows."
          >
            <Button size="sm" variant="secondary" onClick={() => openPrivacy('webcam')}>
              <ShieldCheck className="h-3.5 w-3.5" /> Privacidade do Windows
            </Button>
            <Tip content="Abrir as permissões de microfone">
              <Button size="sm" variant="ghost" onClick={() => openPrivacy('microphone')} aria-label="Permissões de microfone">
                <Mic className="h-3.5 w-3.5" />
              </Button>
            </Tip>
          </SettingRow>
        </SettingRows>
        {(noCamera || noMic) && (
          <Note tone="warn" icon={<AlertTriangle />} className="mt-3">
            {noCamera && noMic ? 'Nenhuma câmera nem microfone encontrados.' : noCamera ? 'Nenhuma câmera encontrada.' : 'Nenhum microfone encontrado.'} Verifique a conexão e se o Windows permite o acesso a aplicativos
            da área de trabalho (botão «Privacidade do Windows»).
          </Note>
        )}
      </Section>

      <Section title="Ao abrir o gravador" className="rise-in rise-in-1">
        <SettingRows>
          <SettingRow
            label={
              <span className="inline-flex items-center gap-2">
                <Camera className="h-4 w-4 text-muted" /> Câmera ligada
              </span>
            }
            description="Começar cada gravação com a câmera no vídeo. Dá para desligar na hora."
            htmlFor="camOn"
          >
            <Toggle id="camOn" checked={d.cameraOn} onCheckedChange={(v) => setDevices({ cameraOn: v })} />
          </SettingRow>
          <SettingRow
            label={
              <span className="inline-flex items-center gap-2">
                <Mic className="h-4 w-4 text-muted" /> Microfone ligado
              </span>
            }
            description="Gravar sua voz por padrão."
            htmlFor="micOn"
          >
            <Toggle id="micOn" checked={d.micOn} onCheckedChange={(v) => setDevices({ micOn: v })} />
          </SettingRow>
          <SettingRow
            label={
              <span className="inline-flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-muted" /> Áudio do sistema ligado
              </span>
            }
            description="Capturar o som do computador (vídeos, chamadas, notificações) numa faixa separada."
            htmlFor="sysOn"
          >
            <Toggle id="sysOn" checked={d.systemAudioOn} onCheckedChange={(v) => setDevices({ systemAudioOn: v })} />
          </SettingRow>
        </SettingRows>
      </Section>
    </div>
  )
}
