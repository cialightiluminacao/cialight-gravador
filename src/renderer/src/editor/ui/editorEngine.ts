// Motor do editor montado pela tela: canvas (transferido uma única vez ao render worker), áudio e
// reprodução, mais a sincronização store → workers (projeto, seleção, quadro parado).
import { toast } from 'sonner'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { PlaybackController } from '../engine/PlaybackController'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { useEditorStore } from '../state/editorStore'

export interface EditorEngine {
  /** Canvas do compositor: criado aqui (fora do React) para nunca ser transferido duas vezes. */
  canvas: HTMLCanvasElement
  render: RenderClient
  audio: AudioClient
  playback: PlaybackController
  /** Para a sincronização e libera workers/decoders. */
  dispose(): void
}

export function createEditorEngine(): EditorEngine {
  const canvas = document.createElement('canvas')
  canvas.className = 'block'
  canvas.setAttribute('aria-label', 'Visualização do projeto')
  const render = new RenderClient(canvas, { width: 640, height: 360, dpr: window.devicePixelRatio || 1 })
  const audio = new AudioClient()
  const playback = new PlaybackController(render, audio, useEditorStore)

  // erros de mídia na reprodução: um aviso por asset (ou por mensagem, se não houver asset)
  const reported = new Set<string>()
  const offError = playback.onError((message, assetId) => {
    const key = assetId ?? message
    if (reported.has(key)) return
    reported.add(key)
    const asset = assetId ? useEditorStore.getState().project?.assets.find((a) => a.id === assetId) : undefined
    toast.error(asset ? `Não foi possível tocar o áudio de “${asset.name}”` : 'Problema na reprodução do áudio', { description: message })
  })
  const offRender = render.onMessage((m) => {
    if (m.t === 'error' && m.fatal && !reported.has('render:fatal')) {
      reported.add('render:fatal')
      toast.error('O visualizador parou de funcionar', { description: m.message })
    }
  })

  // store → workers, no máximo uma vez por quadro de tela
  let raf = 0
  let lastProject: unknown = null
  let lastSelection: unknown = null
  const flush = (): void => {
    raf = 0
    const s = useEditorStore.getState()
    if (!s.project) return
    if (s.project !== lastProject) {
      lastProject = s.project
      const urls = mediaUrlsFor(s.project, 'preview')
      render.setProject(s.project, urls, true)
      audio.setProject(s.project, urls, true)
    }
    if (s.selection !== lastSelection) {
      lastSelection = s.selection
      render.setOverlay(s.selection)
    }
    // tocando, quem pede quadros é o PlaybackController
    if (!s.playing) void render.requestFrame(s.playheadUs, false)
  }
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(flush)
  }
  const unsub = useEditorStore.subscribe((s, prev) => {
    if (prev.playing && !s.playing) render.idle()
    if (s.project !== prev.project || s.selection !== prev.selection || (!s.playing && s.playheadUs !== prev.playheadUs)) schedule()
  })
  schedule()

  return {
    canvas,
    render,
    audio,
    playback,
    dispose() {
      unsub()
      offError()
      offRender()
      cancelAnimationFrame(raf)
      playback.dispose()
      render.dispose()
      audio.dispose()
    }
  }
}

/** Redesenha o quadro parado (após redimensionar o canvas). */
export function redrawStill(engine: EditorEngine): void {
  const s = useEditorStore.getState()
  if (!s.playing && s.project) void engine.render.requestFrame(s.playheadUs, false)
}
