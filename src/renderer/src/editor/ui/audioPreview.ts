import { useSyncExternalStore } from 'react'

// Prévia de áudio da biblioteca (aba Áudio): um único <audio> tocando o arquivo do asset pelo protocolo (com Range),
// fora do motor do editor. Tocar outro cartão troca a música; tocar a linha do tempo ou fechar o editor para a prévia.

let el: HTMLAudioElement | null = null
let current: string | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

/** Toca `url` como prévia do asset (o que estava tocando para); de novo no mesmo asset = parar. */
export function toggleAudioPreview(assetId: string, url: string, onError?: () => void): void {
  if (current === assetId) {
    stopAudioPreview()
    return
  }
  stopAudioPreview()
  const a = new Audio(url)
  el = a
  current = assetId
  a.onended = () => stopAudioPreview()
  a.onerror = () => {
    if (el !== a) return
    stopAudioPreview()
    onError?.()
  }
  void a.play().catch(() => {
    if (el === a) {
      stopAudioPreview()
      onError?.()
    }
  })
  emit()
}

export function stopAudioPreview(): void {
  if (!el && current === null) return
  if (el) {
    el.onended = null
    el.onerror = null
    el.pause()
    el.removeAttribute('src')
    el.load() // solta o arquivo (o protocolo deixa de ler)
  }
  el = null
  current = null
  emit()
}

/** Asset tocando na prévia (null = nenhum). */
export function useAudioPreview(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}
