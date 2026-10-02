import { create } from 'zustand'
import type { Ease, Us } from '@shared/editor/project'

// Ferramenta ativa do visualizador (fora do histórico do projeto): "Desenhar região" (B) cria um
// efeito de privacidade arrastando no quadro, com o tipo e a forma escolhidos na barra do visualizador;
// "Zoom" (Z) desenha o enquadramento-alvo e grava keyframes de escala/posição no clipe sob o cursor, com as
// opções do popover da barra. As duas ferramentas se excluem.

export type DrawEffect = 'blur' | 'pixelate' | 'solid'
export type DrawShape = 'rect' | 'ellipse'

export interface ZoomSettings {
  /** Duração da ida (e da volta): 0,3–3 s. */
  durUs: Us
  ease: Ease
  /** "Voltar ao normal depois de N s". */
  returnBack: boolean
  holdUs: Us
  /** Sem bordas pretas: a posição é presa para a camada continuar cobrindo o quadro. */
  clamp: boolean
}

export interface ViewerToolState {
  drawing: boolean
  zooming: boolean
  effect: DrawEffect
  shape: DrawShape
  zoom: ZoomSettings
  setDrawing(on: boolean): void
  setZooming(on: boolean): void
  setEffect(effect: DrawEffect): void
  setShape(shape: DrawShape): void
  setZoom(patch: Partial<ZoomSettings>): void
}

export const DEFAULT_ZOOM: ZoomSettings = { durUs: 1_000_000, ease: 'inOut', returnBack: false, holdUs: 2_000_000, clamp: true }

export const useViewerTool = create<ViewerToolState>()((set) => ({
  drawing: false,
  zooming: false,
  effect: 'blur',
  shape: 'rect',
  zoom: DEFAULT_ZOOM,
  setDrawing: (drawing) => set(drawing ? { drawing, zooming: false } : { drawing }),
  setZooming: (zooming) => set(zooming ? { zooming, drawing: false } : { zooming }),
  setEffect: (effect) => set({ effect }),
  setShape: (shape) => set({ shape }),
  setZoom: (patch) => set((s) => ({ zoom: { ...s.zoom, ...patch } }))
}))
