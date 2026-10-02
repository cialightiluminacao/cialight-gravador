import { Droplets, Focus, Grid3x3, Plus, RectangleHorizontal, ScanFace, ScanText } from 'lucide-react'
import type { EffectPresetId } from '@shared/editor/factory'
import { Tip } from '@/components/ui/primitives'
import { useEditorStore } from '../state/editorStore'
import { addEffectAt } from './editorActions'

// Aba "Efeitos" da biblioteca: predefinições de privacidade (spec §10). Arrastar o cartão para a
// linha do tempo (no ponto/faixa do ponteiro) ou para o visualizador (no playhead, região centrada
// onde soltar); duplo clique, Enter ou "+" adicionam no playhead com a região no centro.

export const EFFECT_MIME = 'application/x-cialight-effect'

export const EFFECT_PRESETS: { id: EffectPresetId; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'blur', label: 'Blur', hint: 'Desfoca uma área retangular', icon: <Droplets className="h-6 w-6" /> },
  { id: 'pixelate', label: 'Pixelizar', hint: 'Mosaico de blocos sobre a área', icon: <Grid3x3 className="h-6 w-6" /> },
  { id: 'solid', label: 'Tarja', hint: 'Cobre totalmente com uma cor sólida (irreversível)', icon: <RectangleHorizontal className="h-6 w-6 fill-current" /> },
  { id: 'blurFace', label: 'Esconder rosto', hint: 'Blur em elipse com borda suave', icon: <ScanFace className="h-6 w-6" /> },
  { id: 'blurText', label: 'Esconder texto', hint: 'Faixa estreita de blur para uma linha de texto', icon: <ScanText className="h-6 w-6" /> },
  { id: 'blurAllExcept', label: 'Borrar tudo menos…', hint: 'Desfoca o quadro inteiro, exceto a região', icon: <Focus className="h-6 w-6" /> }
]

/** Pega o preset de um arraste (null se o arraste não é de efeito). */
export function effectFromDrag(e: React.DragEvent): EffectPresetId | null {
  const v = e.dataTransfer.getData(EFFECT_MIME)
  return EFFECT_PRESETS.some((p) => p.id === v) ? (v as EffectPresetId) : null
}

export function isEffectDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(EFFECT_MIME)
}

const addAtPlayhead = (id: EffectPresetId): void => addEffectAt(id, useEditorStore.getState().playheadUs)

export function EffectLibrary(): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-1.5 p-2">
      {EFFECT_PRESETS.map((p) => (
        <div
          key={p.id}
          data-effect-preset={p.id}
          className="group relative flex min-w-0 cursor-grab flex-col gap-1 rounded-lg p-1 outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:cursor-grabbing"
          draggable
          tabIndex={0}
          role="button"
          aria-label={`${p.label}. Enter ou duplo clique adiciona no playhead`}
          title={p.hint}
          onDragStart={(e) => {
            e.dataTransfer.setData(EFFECT_MIME, p.id)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onDoubleClick={() => addAtPlayhead(p.id)}
          onKeyDown={(e) => {
            // só o cartão em foco: o Enter no botão "+" interno sobe até aqui e o botão já adiciona pelo clique
            if (e.key === 'Enter' && e.target === e.currentTarget) addAtPlayhead(p.id)
          }}
        >
          <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border bg-gradient-to-br from-accent/10 to-bg-2 text-fg-2">
            {p.icon}
            <Tip content="Adicionar no playhead">
              <button
                type="button"
                aria-label={`Adicionar ${p.label} no playhead`}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-accent text-white opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  addAtPlayhead(p.id)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          <span className="truncate px-0.5 text-[11px] leading-4 text-fg-2">{p.label}</span>
        </div>
      ))}
      <p className="col-span-2 px-1 pt-1 text-[10.5px] leading-relaxed text-muted">Arraste para a linha do tempo ou para o visualizador. A Tarja é a única proteção irreversível.</p>
    </div>
  )
}
