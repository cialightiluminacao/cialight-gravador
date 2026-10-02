import { screen, type WebContents } from 'electron'
import { performance } from 'perf_hooks'
import { dipToPhysical, hwndFromSourceId, physicalDisplays, type CursorButton, type CursorTrackV1, type DisplayGeometry, type Rect } from '@shared/cursor'
import type { CursorBeginInfo } from '@shared/ipc'
import { CursorRecorder, CURSOR_TICK_MS, writeCursorTrack, type CursorRecorderDeps } from './cursorRecorder'
import { ButtonEdges } from './buttonEdges'
import { loadWinInput, winInputLoadError, type WinInput } from './winInput'
import { log } from '../log'

// Trilha do cursor durante a gravação (F6). O engine do renderer avisa começo/pausa/retomada/parada (IPC sem
// espera, nunca atrasa o início da gravação); aqui um CursorRecorder amostra o cursor (screen.getCursorScreenPoint,
// DIP → px físicos por monitor) e os cliques (GetAsyncKeyState via koffi, se carregar) e grava <sessão>/cursor.json
// na parada. Falha do nativo: segue só com amostras, uma linha de log. O session.json não muda.

interface Active {
  sessionId: string
  dir: string
  rec: CursorRecorder
  release: () => void
}

/** Ganchos do teste de integração (CIALIGHT_TEST=capture): fonte sintética no MESMO pipeline, sem input do SO. */
export interface CursorTestHooks {
  /** Substitui screen.getCursorScreenPoint() (ponto DIP). */
  readDipPoint?: () => { x: number; y: number }
  /** Desliga os cliques nativos (os cliques do teste chegam por injectTestClick). */
  disableNativeClicks?: boolean
  /** Recebe a trilha e o gravador na parada (relógio/pausas para conferência). */
  onStopped?: (track: CursorTrackV1, rec: CursorRecorder) => void
}

let active: Active | null = null
let testHooks: CursorTestHooks | null = null
let nativeFailureLogged = false

export function setCursorTestHooks(h: CursorTestHooks | null): void {
  testHooks = h
}

function displayTable(): DisplayGeometry[] {
  return physicalDisplays(screen.getAllDisplays(), (r) => screen.dipToScreenRect(null, r))
}

function logNativeFailure(what: string, e: unknown): void {
  if (nativeFailureLogged) return
  nativeFailureLogged = true
  log.warn(`cursor: ${what}; a trilha segue só com a posição (sem cliques)`, e)
}

export function cursorBegin(info: CursorBeginInfo, dir: string, owner?: WebContents): void {
  if (active) cursorStop(active.sessionId)
  const cleanups: (() => void)[] = []
  const release = (): void => {
    for (const c of cleanups.splice(0)) c()
  }
  try {
    let displays = displayTable()
    const onMetrics = (): void => {
      displays = displayTable()
    }
    screen.on('display-metrics-changed', onMetrics)
    screen.on('display-added', onMetrics)
    screen.on('display-removed', onMetrics)
    cleanups.push(() => {
      screen.off('display-metrics-changed', onMetrics)
      screen.off('display-added', onMetrics)
      screen.off('display-removed', onMetrics)
    })
    // o binding nativo só carrega DEPOIS de o relógio começar (rec.begin abaixo): o require síncrono (~45 ms) não
    // pode atrasar o zero da trilha; até lá não há cliques nem limites de janela
    let native: WinInput | null = null

    let readFrame: () => Rect | null
    if (info.source.kind === 'screen') {
      const id = info.source.displayId
      readFrame = () => displays.find((d) => d.id === id)?.phys ?? null
      if (!id) log.warn('cursor: monitor gravado sem displayId; trilha do cursor desligada')
    } else {
      const hwnd = hwndFromSourceId(info.source.id)
      readFrame = () => (hwnd && native ? native.windowFrame(hwnd) : null)
      if (!hwnd) log.warn('cursor: janela gravada sem HWND; trilha do cursor desligada')
    }
    const readDip = testHooks?.readDipPoint ?? (() => screen.getCursorScreenPoint())
    const clicksWanted = !testHooks?.disableNativeClicks
    const edges = new ButtonEdges()
    const pollClicks: CursorRecorderDeps['pollClicks'] = () => (native && clicksWanted ? edges.update(native.readButtons(), native.buttonsSwapped()) : [])
    const rec = new CursorRecorder(
      {
        now: () => performance.now(),
        readPoint: () => dipToPhysical(readDip(), displays),
        readFrame,
        pollClicks,
        onClickSourceError: (e) => logNativeFailure('leitura dos botões falhou', e),
        onTickError: (e) => log.warn('cursor: falha numa amostra do cursor (as próximas seguem)', e)
      },
      { width: info.width, height: info.height },
      // modo janela: o encoder encaixa a janela redimensionada no tamanho inicial com 'contain' (RecordingEngine)
      info.source.kind === 'window' ? 'contain' : 'stretch'
    )
    const onGone = (): void => {
      if (active?.rec === rec) cursorStop(info.sessionId)
    }
    if (owner) {
      owner.once('destroyed', onGone)
      owner.once('render-process-gone', onGone)
      cleanups.push(() => {
        if (owner.isDestroyed()) return
        owner.off('destroyed', onGone)
        owner.off('render-process-gone', onGone)
      })
    }
    active = { sessionId: info.sessionId, dir, rec, release }
    rec.begin()
    native = loadWinInput()
    if (!native) logNativeFailure('módulo nativo indisponível', winInputLoadError())
    else if (clicksWanted) {
      // descarta o bit "pressionado desde a última leitura" de antes do início (falha aqui: a fonte se desliga no tick)
      try {
        pollClicks()
      } catch {
        /* o CursorRecorder registra e desliga os cliques na próxima leitura */
      }
    }
    if (info.source.kind === 'window' && !native) log.warn('cursor: limites da janela gravada indisponíveis; trilha do cursor sem amostras')
    log.info(`cursor: trilha iniciada (${info.source.kind}, tick ${CURSOR_TICK_MS} ms, cliques ${native && clicksWanted ? 'sim' : 'não'})`)
  } catch (e) {
    active = null
    release()
    log.warn('cursor: falha ao iniciar a trilha do cursor; a gravação segue sem ela', e)
  }
}

export function cursorPause(): void {
  try {
    active?.rec.pause()
  } catch (e) {
    log.warn('cursor: falha ao pausar a trilha', e)
  }
}

export function cursorResume(): void {
  try {
    active?.rec.resume()
  } catch (e) {
    log.warn('cursor: falha ao retomar a trilha', e)
  }
}

/** Encerra e grava cursor.json (se a sessão ainda existe). Devolve se gravou. */
export function cursorStop(sessionId: string): boolean {
  if (!active || active.sessionId !== sessionId) return false
  const { rec, dir, release } = active
  active = null
  release()
  try {
    const track = rec.stop()
    testHooks?.onStopped?.(track, rec)
    if (!track.samples.length && !track.clicks.length) return false
    const wrote = writeCursorTrack(dir, track)
    log.info(`cursor: ${wrote ? 'cursor.json salvo' : 'sessão inexistente, cursor.json não salvo'} (${track.samples.length} amostras, ${track.clicks.length} cliques)`)
    return wrote
  } catch (e) {
    log.warn('cursor: falha ao salvar cursor.json', e)
    return false
  }
}

/** Gravação descartada: para sem escrever nada. */
export function cursorDiscard(sessionId: string): void {
  if (!active || active.sessionId !== sessionId) return
  const { rec, release } = active
  active = null
  release()
  try {
    rec.stop()
  } catch {
    /* descartada de qualquer forma */
  }
}

/** Teste de integração: clique sintético num ponto DIP de tela, no mesmo pipeline. Devolve o tMs dado (ou null). */
export function injectTestClick(button: CursorButton, dip: { x: number; y: number }): number | null {
  if (!active) return null
  const t = active.rec.mediaTimeMs()
  active.rec.addClick(button, dipToPhysical(dip, displayTable()))
  return t
}
