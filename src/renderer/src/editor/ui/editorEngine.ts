// Motor do editor montado pela tela: canvas (transferido uma única vez ao render worker), áudio e
// reprodução, mais a sincronização store → workers (projeto, seleção, quadro parado).
import { toast } from 'sonner'
import { RenderClient } from '../engine/RenderClient'
import { AudioClient } from '../engine/audio/AudioClient'
import { PlaybackController } from '../engine/PlaybackController'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { RENDER_STALL_MS, RenderWatchdog } from '../engine/renderWatchdog'
import { useEditorStore } from '../state/editorStore'

export interface EditorEngine {
  /**
   * Canvas do compositor: criado aqui (fora do React) para nunca ser transferido duas vezes. Muda quando o
   * watchdog reinicia o render (canvas novo no mesmo lugar do DOM): leia sempre daqui.
   */
  readonly canvas: HTMLCanvasElement
  render: RenderClient
  audio: AudioClient
  playback: PlaybackController
  /** Para a sincronização e libera workers/decoders. */
  dispose(): void
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'block'
  canvas.setAttribute('aria-label', 'Visualização do projeto')
  return canvas
}

/** stallMs: prazo do watchdog (testes usam um menor). */
export function createEditorEngine(opts: { stallMs?: number } = {}): EditorEngine {
  let canvas = makeCanvas()
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
  // speech.json que não carregou: o inspetor mostra "sem dados de fala" para o asset
  const offSpeech = audio.onSpeechError((assetId) => useEditorStore.getState().setSpeechFailed(assetId))
  // watchdog (spec §13): tocando com pedido de quadro sem resposta há 5 s → worker novo num canvas novo, mesmo projeto/estado
  const watchdog = new RenderWatchdog(opts.stallMs ?? RENDER_STALL_MS)
  const offRender = render.onMessage((m) => {
    if (m.t === 'rendered') watchdog.rendered()
    // fonte de texto que não carregou: um aviso por família (o texto aparece com a fonte padrão)
    if (m.t === 'fontWarning') {
      for (const f of m.families) {
        if (reported.has(`font:${f}`)) continue
        reported.add(`font:${f}`)
        toast.warning(`A fonte “${f}” não carregou`, { description: 'Os textos com ela aparecem com uma fonte padrão (e assim sairiam na exportação).' })
      }
    }
    if (m.t === 'error' && m.fatal && !reported.has('render:fatal')) {
      reported.add('render:fatal')
      toast.error('O visualizador parou de funcionar', { description: m.message })
    }
  })
  const restartRender = (): void => {
    const next = makeCanvas()
    next.style.cssText = canvas.style.cssText
    canvas.replaceWith(next) // sem pai (fora do DOM): só troca a referência
    canvas = next
    render.restart(next)
    reported.delete('render:fatal')
    console.warn('[editor] render sem quadros há mais de 5 s: worker reiniciado')
    toast.warning('O visualizador travou e foi reiniciado.', { description: 'A reprodução continua de onde estava.' })
    const s = useEditorStore.getState()
    if (!s.playing && s.project) void render.requestFrame(s.playheadUs, false)
  }
  const watchTimer = setInterval(() => {
    if (watchdog.check(useEditorStore.getState().playing, render.pendingFrames > 0)) restartRender()
  }, Math.min(1000, Math.max(100, Math.round((opts.stallMs ?? RENDER_STALL_MS) / 5))))

  // store → workers, no máximo uma vez por quadro de tela
  let raf = 0
  let lastProject: unknown = null
  let lastBypass = false
  let lastSelection: unknown = null
  const flush = (): void => {
    raf = 0
    const s = useEditorStore.getState()
    if (!s.project) return
    if (s.project !== lastProject || s.audioBypass !== lastBypass) {
      const urls = mediaUrlsFor(s.project, 'preview')
      if (s.project !== lastProject) render.setProject(s.project, urls, true)
      // comparar A/B (botão segurado no inspetor de áudio): toca o original sem ruído/normalização
      audio.setProject(s.project, urls, true, s.audioBypass)
      lastProject = s.project
      lastBypass = s.audioBypass
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
    if (s.project !== prev.project || s.audioBypass !== prev.audioBypass || s.selection !== prev.selection || (!s.playing && s.playheadUs !== prev.playheadUs)) schedule()
  })
  schedule()

  return {
    get canvas() {
      return canvas
    },
    render,
    audio,
    playback,
    dispose() {
      unsub()
      offError()
      offSpeech()
      offRender()
      clearInterval(watchTimer)
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
