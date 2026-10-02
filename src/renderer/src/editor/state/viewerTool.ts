import { create } from 'zustand'

// Ferramenta ativa do visualizador (fora do histórico do projeto): "Desenhar região" (B) cria um
// efeito de privacidade arrastando no quadro, com o tipo e a forma escolhidos na barra do visualizador.

export type DrawEffect = 'blur' | 'pixelate' | 'solid'
export type DrawShape = 'rect' | 'ellipse'

export interface ViewerToolState {
  drawing: boolean
  effect: DrawEffect
  shape: DrawShape
  setDrawing(on: boolean): void
  setEffect(effect: DrawEffect): void
  setShape(shape: DrawShape): void
}

export const useViewerTool = create<ViewerToolState>()((set) => ({
  drawing: false,
  effect: 'blur',
  shape: 'rect',
  setDrawing: (drawing) => set({ drawing }),
  setEffect: (effect) => set({ effect }),
  setShape: (shape) => set({ shape })
}))
