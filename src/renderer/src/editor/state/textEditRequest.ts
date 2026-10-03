import { create } from 'zustand'

// Pedido de edição direta de um texto vindo do teclado (Enter/F2): quem abre a caixa é o ViewerOverlay, que só
// conhece a geometria do quadro depois que o playhead chegou ao item — por isso é um pedido, não uma chamada direta.
export const useTextEditRequest = create<{ itemId: string | null; request(id: string | null): void }>()((set) => ({
  itemId: null,
  request: (itemId) => set({ itemId })
}))
