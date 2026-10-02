import { Info } from 'lucide-react'
import { audioMixOf } from '@shared/editor/audioPlan'
import type { AudioMix, Project } from '@shared/editor/project'
import { Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { NumberField } from './NumberField'
import { PanelSection } from './common'
import { duckingHint } from '../duckingHint'

// Painel do projeto: ducking (a música abaixa sozinha quando há fala nas faixas de Voz) — ligar/desligar, intensidade
// (dB), ataque e soltura. Mostra por que não vai abaixar (sem faixa de Música/Voz, fala ainda não analisada).

function setMix(patch: Partial<AudioMix>, transient = false): void {
  useEditorStore.getState().apply((p) => ({ ...p, audioMix: { ...audioMixOf(p), ...patch } }), transient ? { transient: true } : undefined)
}

export function AudioMixPanel({ project }: { project: Project }): React.JSX.Element {
  const mix = audioMixOf(project)
  const hint = mix.enabled ? duckingHint(project) : null
  return (
    <PanelSection title="Música sob a voz" aside={<Toggle size="sm" checked={mix.enabled} onCheckedChange={(on) => setMix({ enabled: on })} aria-label="Abaixar a música quando houver fala (ducking)" />}>
      <p className="text-[11px] leading-relaxed text-muted">A música abaixa sozinha enquanto há fala nas faixas de Voz e volta ao fim da fala.</p>
      <NumberField label="Intensidade" value={mix.duckingDb} min={-30} max={-1} step={1} unit="dB" disabled={!mix.enabled} title="Quanto a música abaixa durante a fala" onChange={(v) => setMix({ duckingDb: Math.round(v) }, true)} />
      <div className="grid grid-cols-2 gap-x-3">
        <NumberField compact label="Ataque" value={mix.attackMs} min={10} max={2000} step={10} unit="ms" disabled={!mix.enabled} title="Rampa até abaixar (termina no início da fala)" onChange={(v) => setMix({ attackMs: Math.round(v) }, true)} />
        <NumberField compact label="Soltura" value={mix.releaseMs} min={10} max={5000} step={10} unit="ms" disabled={!mix.enabled} title="Rampa de volta depois da fala (e da espera de 300 ms)" onChange={(v) => setMix({ releaseMs: Math.round(v) }, true)} />
      </div>
      {hint ? (
        <p className="flex items-start gap-1.5 pt-0.5 text-[11px] leading-relaxed text-muted-2" data-ducking-hint="">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{hint}</span>
        </p>
      ) : null}
    </PanelSection>
  )
}
