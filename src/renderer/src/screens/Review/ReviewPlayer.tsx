import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import type { PipKeyframe, Session } from '@shared/types'
import { drawFrame } from '@shared/compositor'
import { cn } from '@/lib/cn'

// Player da revisão: <video> do proxy (tela + áudio mixado) e <video> da webcam ficam
// invisíveis; TUDO (tela + PiP + traços) é desenhado no <canvas> com o mesmo drawFrame da
// exportação → o que se vê é o que sai no arquivo.

export interface PlayerDrawOptions {
  includeWebcam: boolean
  includeAnnotations: boolean
  autoFadeMs: number | null
  pipOverride: PipKeyframe[] | null
}

export interface ReviewPlayerHandle {
  play(): void
  pause(): void
  toggle(): void
  seek(ms: number): void
  setMuted(muted: boolean): void
}

interface Props {
  session: Session
  proxyUrl: string
  webcamUrl: string | null
  draw: PlayerDrawOptions
  trimStartMs: number
  trimEndMs: number
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  onDuration: (ms: number) => void
  onError: (message: string) => void
  className?: string
}

/** Diferença máxima tolerada entre webcam e tela antes de ressincronizar (s). */
const SYNC_TOLERANCE_SEC = 0.12

export const ReviewPlayer = forwardRef<ReviewPlayerHandle, Props>(function ReviewPlayer(
  { session, proxyUrl, webcamUrl, draw, trimStartMs, trimEndMs, onTime, onPlaying, onDuration, onError, className },
  ref
): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const camRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const drawRef = useRef(draw)
  drawRef.current = draw
  const trimRef = useRef({ start: trimStartMs, end: trimEndMs })
  trimRef.current = { start: trimStartMs, end: trimEndMs }
  const width = session.video.width
  const height = session.video.height

  const paint = useCallback((): void => {
    const v = videoRef.current
    const canvas = canvasRef.current
    if (!v || !canvas || v.readyState < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cam = camRef.current
    const camReady = !!cam && cam.readyState >= 2 && !!webcamUrl
    const tMs = v.currentTime * 1000
    const d = drawRef.current
    drawFrame(
      ctx,
      canvas.width,
      canvas.height,
      { screen: v, cam: camReady ? cam : null, camMirrored: session.webcam?.mirrored ?? false },
      session,
      tMs,
      { includeWebcam: d.includeWebcam, includeAnnotations: d.includeAnnotations, autoFadeMs: d.autoFadeMs, pipOverride: d.pipOverride }
    )
  }, [session, webcamUrl])

  // Repinta quando as opções de composição mudam (parado).
  useEffect(() => {
    paint()
  }, [draw.includeWebcam, draw.includeAnnotations, draw.autoFadeMs, draw.pipOverride, paint])

  const syncCam = useCallback((force = false): void => {
    const v = videoRef.current
    const cam = camRef.current
    if (!v || !cam || !webcamUrl || cam.readyState < 1) return
    if (force || Math.abs(cam.currentTime - v.currentTime) > SYNC_TOLERANCE_SEC) cam.currentTime = v.currentTime
  }, [webcamUrl])

  // Loop de desenho enquanto toca.
  useEffect(() => {
    if (!playing) return
    const tick = (): void => {
      const v = videoRef.current
      if (!v) return
      const endSec = trimRef.current.end / 1000
      if (v.currentTime >= endSec) {
        v.pause()
        v.currentTime = endSec
        camRef.current?.pause()
      } else {
        syncCam()
      }
      onTime(v.currentTime * 1000)
      paint()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, paint, syncCam, onTime])

  const play = useCallback((): void => {
    const v = videoRef.current
    if (!v) return
    const { start, end } = trimRef.current
    if (v.currentTime * 1000 >= end - 40 || v.currentTime * 1000 < start) {
      v.currentTime = start / 1000
      syncCam(true)
    }
    void v.play().catch(() => {})
    void camRef.current?.play().catch(() => {})
  }, [syncCam])

  const pause = useCallback((): void => {
    videoRef.current?.pause()
    camRef.current?.pause()
  }, [])

  const seek = useCallback(
    (ms: number): void => {
      const v = videoRef.current
      if (!v) return
      const dur = Number.isFinite(v.duration) ? v.duration * 1000 : session.durationMs ?? ms
      const clamped = Math.max(0, Math.min(dur, ms))
      v.currentTime = clamped / 1000
      syncCam(true)
      onTime(clamped)
    },
    [session.durationMs, syncCam, onTime]
  )

  useImperativeHandle(
    ref,
    () => ({
      play,
      pause,
      toggle: () => (videoRef.current?.paused ? play() : pause()),
      seek,
      setMuted: (m) => {
        if (videoRef.current) videoRef.current.muted = m
      }
    }),
    [play, pause, seek]
  )

  const onVideoEvent = {
    onLoadedMetadata: () => {
      const v = videoRef.current
      if (v && Number.isFinite(v.duration)) onDuration(v.duration * 1000)
    },
    onLoadedData: () => {
      setReady(true)
      paint()
    },
    onSeeked: () => {
      paint()
      onTime((videoRef.current?.currentTime ?? 0) * 1000)
    },
    onTimeUpdate: () => {
      if (!playing) paint()
    },
    onPlay: () => {
      setPlaying(true)
      onPlaying(true)
    },
    onPause: () => {
      setPlaying(false)
      onPlaying(false)
      paint()
    },
    onError: () => onError('Não foi possível reproduzir a prévia (preview.mp4).')
  }

  return (
    <div
      className={cn('group relative h-full w-full overflow-hidden rounded-2xl border border-border-strong bg-black shadow-[0_20px_60px_rgba(0,0,0,0.5)]', className)}
      onClick={() => (videoRef.current?.paused ? play() : pause())}
      role="presentation"
    >
      <video ref={videoRef} src={proxyUrl} preload="auto" playsInline className="pointer-events-none absolute inset-0 h-full w-full opacity-0" {...onVideoEvent} />
      {webcamUrl ? <video ref={camRef} src={webcamUrl} preload="auto" muted playsInline className="pointer-events-none absolute inset-0 h-px w-px opacity-0" onLoadedData={paint} /> : null}
      <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0 h-full w-full" />
      {!ready ? <div className="absolute inset-0 animate-pulse bg-surface-2" /> : null}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-200',
          playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        )}
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white shadow-2xl backdrop-blur-sm">
          {playing ? <Pause className="h-7 w-7" /> : <Play className="ml-1 h-7 w-7" />}
        </span>
      </div>
    </div>
  )
})
