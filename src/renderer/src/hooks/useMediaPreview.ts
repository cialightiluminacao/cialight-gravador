import { useEffect, useState } from 'react'

// Abre um stream de preview (câmera ou microfone) e o fecha ao trocar/desmontar.
export function useCameraPreview(deviceId: string | null, enabled: boolean): { stream: MediaStream | null; error: string | null } {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let s: MediaStream | null = null
    setError(null)
    if (!enabled || !deviceId) {
      setStream(null)
      return
    }
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } })
      .then((st) => {
        if (cancelled) {
          st.getTracks().forEach((t) => t.stop())
          return
        }
        s = st
        setStream(st)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.name === 'NotAllowedError' ? 'Permissão de câmera negada' : e.name === 'NotReadableError' ? 'Câmera em uso por outro programa' : `Câmera indisponível (${e.name})`)
      })
    return () => {
      cancelled = true
      s?.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
  }, [deviceId, enabled])
  return { stream, error }
}

export function useMicPreview(deviceId: string | null, enabled: boolean, echoCancellation: boolean): { stream: MediaStream | null; error: string | null } {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let s: MediaStream | null = null
    setError(null)
    if (!enabled || !deviceId) {
      setStream(null)
      return
    }
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation, noiseSuppression: true, autoGainControl: true } })
      .then((st) => {
        if (cancelled) {
          st.getTracks().forEach((t) => t.stop())
          return
        }
        s = st
        setStream(st)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.name === 'NotAllowedError' ? 'Permissão de microfone negada' : `Microfone indisponível (${e.name})`)
      })
    return () => {
      cancelled = true
      s?.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
  }, [deviceId, enabled, echoCancellation])
  return { stream, error }
}
