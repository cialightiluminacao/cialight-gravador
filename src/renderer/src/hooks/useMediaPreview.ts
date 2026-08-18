import { useEffect, useState } from 'react'

// Abre um stream de preview (câmera ou microfone) e o fecha ao trocar/desmontar.
// `errorName` é o DOMException.name original (ex.: 'NotAllowedError'), para a UI
// reagir sem depender do texto traduzido.

export interface MediaPreview {
  stream: MediaStream | null
  error: string | null
  errorName: string | null
}

export function useCameraPreview(deviceId: string | null, enabled: boolean): MediaPreview {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorName, setErrorName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let s: MediaStream | null = null
    setError(null)
    setErrorName(null)
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
        if (cancelled) return
        setErrorName(e.name)
        setError(e.name === 'NotAllowedError' ? 'Permissão de câmera negada' : e.name === 'NotReadableError' ? 'Câmera em uso por outro programa' : `Câmera indisponível (${e.name})`)
      })
    return () => {
      cancelled = true
      s?.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
  }, [deviceId, enabled])
  return { stream, error, errorName }
}

export function useMicPreview(deviceId: string | null, enabled: boolean, echoCancellation: boolean): MediaPreview {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorName, setErrorName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let s: MediaStream | null = null
    setError(null)
    setErrorName(null)
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
        if (cancelled) return
        setErrorName(e.name)
        setError(e.name === 'NotAllowedError' ? 'Permissão de microfone negada' : `Microfone indisponível (${e.name})`)
      })
    return () => {
      cancelled = true
      s?.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
  }, [deviceId, enabled, echoCancellation])
  return { stream, error, errorName }
}
