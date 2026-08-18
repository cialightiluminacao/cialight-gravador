import { useEffect } from 'react'
import { useAppStore } from '@/app/store'

// Enumera câmeras e microfones (labels só aparecem após permissão; pedimos uma
// vez um stream curto de áudio+vídeo para destravar os nomes) e reage a devicechange.

let primed = false

async function prime(): Promise<void> {
  if (primed) return
  primed = true
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    s.getTracks().forEach((t) => t.stop())
  } catch {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    } catch {
      /* sem permissão/dispositivo */
    }
  }
}

export async function refreshDevices(): Promise<void> {
  await prime()
  const list = await navigator.mediaDevices.enumerateDevices()
  const cameras = list.filter((d) => d.kind === 'videoinput')
  const mics = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
  useAppStore.getState().setDevices({ cameras, mics, ready: true })
}

export function useDevices(): void {
  useEffect(() => {
    void refreshDevices()
    const on = (): void => void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', on)
    return () => navigator.mediaDevices.removeEventListener('devicechange', on)
  }, [])
}
