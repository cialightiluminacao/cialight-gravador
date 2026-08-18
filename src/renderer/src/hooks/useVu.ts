import { useEffect, useState } from 'react'

// Nível RMS (0–1) de um MediaStream via AnalyserNode. Para preview de microfone.
export function useVu(stream: MediaStream | null, enabled = true): number {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!stream || !enabled || stream.getAudioTracks().length === 0) {
      setLevel(0)
      return
    }
    const ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 512
    an.smoothingTimeConstant = 0.6
    src.connect(an)
    const buf = new Uint8Array(an.fftSize)
    const t = setInterval(() => {
      an.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.2))
    }, 80)
    return () => {
      clearInterval(t)
      void ctx.close().catch(() => {})
    }
  }, [stream, enabled])
  return level
}
