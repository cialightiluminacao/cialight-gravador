import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppWindow, Circle, FlipHorizontal2, Info, Monitor, MonitorOff, Move, RectangleHorizontal } from 'lucide-react'
import type { CaptureSource, DisplayInfo, Fps, PipKeyframe, Quality } from '@shared/types'
import { QUALITY_PRESETS } from '@shared/defaults'
import { targetDimensions } from '@/engine/encoderSupport'
import { cn } from '@/lib/cn'
import { usePageVisible } from '@/hooks/usePageVisible'
import { Tip } from '@/components/ui/primitives'
import { PipOverlay, pipWithShape } from './PipOverlay'

// Centro do Preparar: palco com a miniatura da fonte (atualizada via
// sources.thumbnail enquanto a tela está visível) e a PiP posicionável por cima,
// com uma barra fixa de forma/espelho no canto do palco (sempre visível com a
// câmera ligada). A proporção do palco segue a fonte (monitor: bounds; janela:
// miniatura) — a mesma que a gravação mantém (targetDimensions) — para que a
// posição/tamanho da PiP no palco correspondam ao arquivo final; padrão 16:9.
// Limites só para casos extremos (fontes muito estreitas/largas) não quebrarem o layout.

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
// monitor: 1 fps; janela: 0,5 fps (a captura de janelas é mais cara no processo principal)
const REFRESH_SCREEN_MS = 1000
const REFRESH_WINDOW_MS = 2000
const MIN_ASPECT = 0.4
const MAX_ASPECT = 4
const DEFAULT_ASPECT = 16 / 9
const STAGE_PAD = 16

/** Miniatura em alta da fonte, renovada periodicamente enquanto ativo. */
function useLiveThumbnail(source: CaptureSource | null, active: boolean): string | null {
  const [thumb, setThumb] = useState<string | null>(null)
  const sourceId = source?.id ?? null
  const refreshMs = source?.kind === 'window' ? REFRESH_WINDOW_MS : REFRESH_SCREEN_MS
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
      const wait = Math.max(200, refreshMs - (performance.now() - started))
      timer = setTimeout(() => void tick(), wait)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sourceId, active, refreshMs])
  return thumb
}

/**
 * Resolução prevista da gravação: a fonte mantém a proporção e só é limitada pela
 * altura do preset (mesma regra do encoder). Monitor: bounds×scaleFactor; janela: só
 * a proporção é conhecida (miniatura), então mostramos o preset ("1080p", "Nativa").
 */
function resolutionLabel(quality: Quality, source: CaptureSource | null, display: DisplayInfo | undefined): string {
  const p = QUALITY_PRESETS[quality]
  if (source?.kind === 'screen' && display) {
    const srcW = Math.round(display.bounds.width * display.scaleFactor)
    const srcH = Math.round(display.bounds.height * display.scaleFactor)
    const { width, height } = targetDimensions(quality, srcW, srcH)
    return `${width}×${height}`
  }
  return p.label
}

interface StageToolbarProps {
  pip: PipKeyframe
  stageW: number
  stageH: number
  onPipChange: (k: Omit<PipKeyframe, 'tMs'>) => void
  mirrored: boolean
  onToggleMirror: () => void
}

/** Barra fixa no canto do palco: forma da câmera e espelho (sempre acessível, sem depender do hover na PiP). */
function StageToolbar({ pip, stageW, stageH, onPipChange, mirrored, onToggleMirror }: StageToolbarProps): React.JSX.Element {
  const isCircle = pip.shape === 'circle'
  const setShape = (shape: PipKeyframe['shape']): void => {
    if (shape === pip.shape) return
    const { x, y, w, h, visible } = pip
    onPipChange(pipWithShape({ x, y, w, h, shape, visible }, shape, stageW, stageH))
  }
  const btn = 'flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-colors'
  const on = 'bg-white/15 text-fg shadow-sm'
  const off = 'text-fg-2 hover:bg-white/8 hover:text-fg'
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 flex items-center gap-1.5">
      <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/55 p-0.5 shadow backdrop-blur" role="radiogroup" aria-label="Forma da câmera">
        <Tip content="Câmera em círculo" side="top">
          <button type="button" role="radio" aria-checked={isCircle} className={cn(btn, isCircle ? on : off)} onClick={() => setShape('circle')}>
            <Circle className="h-3.5 w-3.5" />
            Círculo
          </button>
        </Tip>
        <Tip content="Câmera em retângulo arredondado (16:9)" side="top">
          <button type="button" role="radio" aria-checked={!isCircle} className={cn(btn, !isCircle ? on : off)} onClick={() => setShape('rounded')}>
            <RectangleHorizontal className="h-3.5 w-3.5" />
            Retângulo
          </button>
        </Tip>
      </div>
      <Tip content={mirrored ? 'Desativar espelho (a imagem sai como os outros veem você)' : 'Espelhar a câmera (como num espelho)'} side="top">
        <button
          type="button"
          aria-pressed={mirrored}
          className={cn('flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2 text-[11px] font-semibold shadow backdrop-blur transition-colors', mirrored ? 'text-accent-2' : 'text-fg-2 hover:bg-black/70 hover:text-fg')}
          onClick={onToggleMirror}
        >
          <FlipHorizontal2 className="h-3.5 w-3.5" />
          Espelhar
        </button>
      </Tip>
    </div>
  )
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

  // ajusta o palco à área de conteúdo (sem o padding) mantendo a proporção
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const update = (): void => {
      const w = Math.max(0, el.clientWidth - STAGE_PAD * 2)
      const h = Math.max(0, el.clientHeight - STAGE_PAD * 2)
      setBox((cur) => (cur.w === w && cur.h === h ? cur : { w, h }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const stageW = Math.floor(Math.min(box.w, box.h * aspect))
  const stageH = Math.floor(stageW / aspect)

  const isWindow = source?.kind === 'window'
  const KindIcon = isWindow ? AppWindow : Monitor
  const showPip = !!source && cameraOn

  return (
    <section className="card @container flex min-h-0 flex-1 flex-col overflow-hidden">
      <div ref={boxRef} className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {stageW > 0 && stageH > 0 ? (
          <div className="relative overflow-hidden rounded-xl bg-bg-2 shadow-[0_18px_50px_rgba(0,0,0,0.5)] ring-1 ring-white/8" style={{ width: stageW, height: stageH }}>
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
                <span className="flex min-w-0 max-w-[65%] items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1 text-xs font-semibold text-fg shadow backdrop-blur">
                  <KindIcon className="h-3.5 w-3.5 shrink-0 text-fg-2" />
                  <span className="truncate">{source.name}</span>
                </span>
              ) : (
                <span />
              )}
              <span className="font-mono tnum flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-white/10 bg-black/55 px-2.5 py-1 text-[11px] font-medium text-fg-2 shadow backdrop-blur">
                {resolutionLabel(quality, source, display)}
                <span className="text-muted">·</span>
                {fps}
                <span className="@max-[560px]:hidden">fps</span>
              </span>
            </div>

            {showPip ? <StageToolbar pip={pip} stageW={stageW} stageH={stageH} onPipChange={onPipChange} mirrored={mirrored} onToggleMirror={onToggleMirror} /> : null}
            {showPip ? <PipOverlay pip={pip} onChange={onPipChange} mirrored={mirrored} onToggleMirror={onToggleMirror} camStream={camStream} /> : null}
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
          <span className={cn('truncate', showPip && '@max-[640px]:hidden')}>{source ? 'A pré-visualização é atualizada a cada segundo; a gravação será em tempo real.' : 'Selecione uma fonte para ver a pré-visualização.'}</span>
        )}
        {showPip ? (
          <span className="flex min-w-0 shrink items-center gap-1.5">
            <Move className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Arraste a câmera para posicionar<span className="@max-[720px]:hidden"> · alça no canto para redimensionar</span>
            </span>
          </span>
        ) : null}
      </div>
    </section>
  )
}
