import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppWindow, Info, Monitor, MonitorOff, Move } from 'lucide-react'
import type { CaptureSource, DisplayInfo, Fps, PipKeyframe, Quality } from '@shared/types'
import { QUALITY_PRESETS } from '@shared/defaults'
import { cn } from '@/lib/cn'
import { PipOverlay } from './PipOverlay'

// Centro do Preparar: palco com a miniatura da fonte (atualizada a ~1 fps via
// sources.thumbnail enquanto a tela está visível) e a PiP posicionável por cima.
// A proporção do palco segue a fonte (monitor: bounds; janela: miniatura), com
// limites para não distorcer o layout; padrão 16:9.

export interface PreviewStageProps {
  source: CaptureSource | null
  display: DisplayInfo | undefined
  quality: Quality
  fps: Fps
  cameraOn: boolean
  camStream: MediaStream | null
  pip: PipKeyframe
  onPipChange: (k: Omit<PipKeyframe, 'tMs'>) => void
  mirrored: boolean
  onToggleMirror: () => void
  /** false pausa a atualização da miniatura (janela oculta/minimizada). */
  active: boolean
}

const THUMB_W = 960
const THUMB_H = 540
const REFRESH_MS = 1000
const MIN_ASPECT = 1.15
const MAX_ASPECT = 2.4
const DEFAULT_ASPECT = 16 / 9

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/** Miniatura em alta da fonte, renovada a ~1 fps enquanto ativo. */
function useLiveThumbnail(source: CaptureSource | null, active: boolean): string | null {
  const [thumb, setThumb] = useState<string | null>(null)
  const sourceId = source?.id ?? null
  useEffect(() => {
    setThumb(null)
    if (!sourceId || !active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      const started = performance.now()
      try {
        const url = await window.api.sources.thumbnail(sourceId, THUMB_W, THUMB_H)
        if (alive && url) setThumb(url)
      } catch {
        /* fonte fechou; a lista será atualizada pelo useSources */
      }
      if (!alive) return
      const wait = Math.max(200, REFRESH_MS - (performance.now() - started))
      timer = setTimeout(() => void tick(), wait)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sourceId, active])
  return thumb
}

function qualityLabel(quality: Quality, fps: Fps, display: DisplayInfo | undefined): string {
  const p = QUALITY_PRESETS[quality]
  const res = p.width && p.height ? `${p.width}×${p.height}` : display ? `${Math.round(display.bounds.width * display.scaleFactor)}×${Math.round(display.bounds.height * display.scaleFactor)}` : 'Nativa'
  return `${res} · ${fps} fps`
}

export function PreviewStage({ source, display, quality, fps, cameraOn, camStream, pip, onPipChange, mirrored, onToggleMirror, active }: PreviewStageProps): React.JSX.Element {
  const pageVisible = usePageVisible()
  const liveThumb = useLiveThumbnail(source, active && pageVisible)
  const imgSrc = liveThumb ?? source?.thumbnailDataUrl ?? null

  // proporção do palco
  const [imgAspect, setImgAspect] = useState<number | null>(null)
  useEffect(() => setImgAspect(null), [source?.id])
  const rawAspect = source?.kind === 'screen' && display ? display.bounds.width / display.bounds.height : (imgAspect ?? DEFAULT_ASPECT)
  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, rawAspect || DEFAULT_ASPECT))

  // ajusta o palco ao espaço disponível mantendo a proporção
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const update = (): void => setBox({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const stageW = Math.floor(Math.min(box.w, box.h * aspect))
  const stageH = Math.floor(stageW / aspect)

  const isWindow = source?.kind === 'window'
  const KindIcon = isWindow ? AppWindow : Monitor

  return (
    <section className="card flex min-h-0 flex-col overflow-hidden">
      <div ref={boxRef} className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {stageW > 0 && stageH > 0 ? (
          <div
            className="relative overflow-hidden rounded-xl bg-bg-2 shadow-[0_18px_50px_rgba(0,0,0,0.5)] ring-1 ring-white/8"
            style={{ width: stageW, height: stageH }}
          >
            {source && imgSrc ? (
              <img
                key={source.id}
                src={imgSrc}
                alt=""
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget
                  if (el.naturalWidth && el.naturalHeight) setImgAspect(el.naturalWidth / el.naturalHeight)
                }}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted">
                {source ? (
                  <>
                    <div className="h-8 w-8 animate-pulse rounded-full bg-white/8" />
                    <span className="text-xs">Carregando pré-visualização…</span>
                  </>
                ) : (
                  <>
                    <MonitorOff className="h-8 w-8" strokeWidth={1.5} />
                    <span className="text-sm font-semibold text-fg-2">Nenhuma fonte selecionada</span>
                    <span className="text-xs">Escolha um monitor ou uma janela à esquerda.</span>
                  </>
                )}
              </div>
            )}

            {/* chips */}
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
              {source ? (
                <span className="flex max-w-[60%] items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1 text-xs font-semibold text-fg shadow backdrop-blur">
                  <KindIcon className="h-3.5 w-3.5 shrink-0 text-fg-2" />
                  <span className="truncate">{source.name}</span>
                </span>
              ) : (
                <span />
              )}
              <span className="font-mono tnum flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1 text-[11px] font-medium text-fg-2 shadow backdrop-blur">
                {qualityLabel(quality, fps, display)}
              </span>
            </div>

            {source && cameraOn ? <PipOverlay pip={pip} onChange={onPipChange} mirrored={mirrored} onToggleMirror={onToggleMirror} camStream={camStream} /> : null}
          </div>
        ) : null}
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border px-4 text-[11px] text-muted">
        {isWindow ? (
          <span className="flex min-w-0 items-center gap-1.5 text-warn/90">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Menus suspensos e dicas de ferramenta podem não aparecer.</span>
          </span>
        ) : (
          <span className="truncate">{source ? 'A pré-visualização é atualizada a cada segundo; a gravação será em tempo real.' : 'Selecione uma fonte para ver a pré-visualização.'}</span>
        )}
        <span className={cn('flex shrink-0 items-center gap-1.5', !(source && cameraOn) && 'invisible')}>
          <Move className="h-3.5 w-3.5" />
          Arraste a câmera para posicionar · alça no canto para redimensionar
        </span>
      </div>
    </section>
  )
}
