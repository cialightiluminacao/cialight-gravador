// Stub temporário (a tela real vem da task D2): seleciona a fonte padrão e oferece o botão Gravar.
import { useAppStore, buildRecordingConfig } from '@/app/store'
import { useSources } from '@/hooks/useSources'
import { startRecording } from '@/app/recordingController'
import { Button } from '@/components/ui/Button'

export function PrepareScreen(): React.JSX.Element {
  useSources(true)
  const selected = useAppStore((s) => s.selectedSource)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-sm text-muted">
      <div>Fonte: {selected?.name ?? '…'}</div>
      <Button
        variant="primary"
        size="xl"
        onClick={() => {
          const cfg = buildRecordingConfig(useAppStore.getState())
          if (cfg) void startRecording(cfg)
        }}
      >
        Gravar
      </Button>
    </div>
  )
}
