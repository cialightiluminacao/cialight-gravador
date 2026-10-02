// Fluxo da gravação de narração (renderer): microfone → contagem 3-2-1 → grava a partir do playhead com a timeline
// tocando → para (Espaço/Esc, botão, microfone desconectado) → asset 'generated' + item na faixa "Narração" num passo
// de desfazer → ingestão (peaks, fala, loudness). Também recupera, ao abrir o projeto, gravações que a janela/o app não
// chegaram a inserir (arquivo parcial + aviso).
import { toast } from 'sonner'
import { narrationAssetName, placeNarration } from '@shared/editor/narration'
import { formatTimecodeUs } from '@shared/editor/time'
import type { Us } from '@shared/editor/project'
import { ipcErrorMessage } from '@/lib/ipcError'
import { NarrationRecorder, type NarrationResult } from '../engine/narration'
import type { PlaybackController } from '../engine/PlaybackController'
import { flushAutosave, useEditorStore } from '../state/editorStore'
import { useNarration } from '../state/narration'
import { enqueueAsset } from './mediaImport'

const COUNTDOWN = 3
/** VU da tela Preparar (useVu): RMS × 3,2. */
const VU_GAIN = 3.2

let rec: NarrationRecorder | null = null
let recProjectId = ''
let countdownToken = 0
let countdownTimer: ReturnType<typeof setTimeout> | null = null
let finishing: Promise<void> | null = null

const nst = (): ReturnType<typeof useNarration.getState> => useNarration.getState()
const est = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

export function narrationActive(): boolean {
  return nst().phase !== 'idle'
}

/** Microfone → contagem regressiva → grava no playhead. `monitor`: a timeline toca audível (com fone). */
export async function beginNarration(playback: PlaybackController, projectId: string, opts: { deviceId: string | null; monitor: boolean }): Promise<void> {
  if (narrationActive() || !est().project) return
  if (playback.playing) playback.pause()
  const token = ++countdownToken
  recProjectId = projectId
  nst().set({ phase: 'countdown', count: COUNTDOWN, level: 0, recordedUs: 0, fromUs: est().playheadUs })
  const r = new NarrationRecorder(window.api, projectId, playback, (rms) => {
    nst().set({ level: Math.min(1, rms * VU_GAIN), ...(rec?.recording ? { recordedUs: rec.recordedUs } : {}) })
  })
  rec = r
  try {
    await r.arm(opts.deviceId, (reason) => {
      if (nst().phase === 'countdown') {
        cancelNarration()
        toast.error(reason === 'device' ? 'O microfone foi desconectado antes de gravar.' : 'Não foi possível gravar a narração.')
      } else void finishNarration()
    })
  } catch (e) {
    if (rec === r) {
      r.dispose()
      rec = null
      nst().reset()
    }
    toast.error(`Não foi possível abrir o microfone: ${micError(e)}`)
    return
  }
  // 3, 2, 1 — cancelável (Esc/Espaço) até o fim
  for (let n = COUNTDOWN; n > 0; n--) {
    if (token !== countdownToken) return
    nst().set({ count: n })
    await new Promise<void>((res) => (countdownTimer = setTimeout(res, 1000)))
  }
  countdownTimer = null
  if (token !== countdownToken || rec !== r) return
  const at = est().playheadUs
  try {
    await r.start(at, opts.monitor)
  } catch (e) {
    r.dispose()
    rec = null
    nst().reset()
    toast.error(`Não foi possível começar a gravar: ${ipcErrorMessage(e)}`)
    return
  }
  nst().set({ phase: 'recording', count: 0, fromUs: at })
}

/** Desiste durante a contagem (nada foi gravado). */
export function cancelNarration(): void {
  if (nst().phase !== 'countdown') return
  countdownToken++
  if (countdownTimer !== null) clearTimeout(countdownTimer)
  countdownTimer = null
  rec?.dispose()
  rec = null
  nst().reset()
}

/** Para a gravação e insere a narração na timeline (chamadas repetidas esperam a mesma). */
export function finishNarration(): Promise<void> {
  if (nst().phase === 'countdown') {
    cancelNarration()
    return Promise.resolve()
  }
  if (nst().phase !== 'recording' && !finishing) return Promise.resolve()
  if (!finishing) {
    finishing = doFinish().finally(() => {
      finishing = null
    })
  }
  return finishing
}

async function doFinish(): Promise<void> {
  const r = rec
  if (!r) return
  nst().set({ phase: 'saving' })
  let result: NarrationResult
  try {
    result = await r.stop()
  } catch (e) {
    toast.error(`A gravação da narração falhou: ${ipcErrorMessage(e)}`)
    r.dispose()
    rec = null
    nst().reset()
    return
  }
  r.dispose()
  rec = null
  try {
    if (result.recordedUs <= 0) {
      toast.error('Nada foi gravado: o microfone não mandou áudio.')
      return
    }
    const ok = await insertNarration(recProjectId, result.rel, { startUs: result.startUs, inUs: result.inUs }, false)
    if (!ok) return
    if (result.interrupted) {
      toast.warning(result.interrupted === 'device' ? 'O microfone foi desconectado: a narração gravada até ali foi inserida.' : 'A gravação parou por um erro: o que foi gravado até ali foi inserido.', {
        // o motivo do erro do encoder (o do microfone já está no título)
        description: result.interrupted === 'device' ? undefined : result.message,
        duration: 12_000
      })
    } else toast.success(`Narração inserida em ${formatTimecodeUs(result.startUs, est().project?.canvas.fps ?? 30)}.`)
  } finally {
    nst().reset()
  }
}

/**
 * Asset do arquivo + item na faixa "Narração" (um passo de desfazer), seleciona, salva e só então tira o marcador de
 * recuperação; depois a ingestão (peaks, fala, loudness). `repair`: arquivo de uma gravação interrompida.
 */
export async function insertNarration(projectId: string, rel: string, at: { startUs: Us; inUs: Us }, repair: boolean): Promise<boolean> {
  try {
    const asset = await window.api.project.generatedAsset(projectId, rel, { name: narrationAssetName(rel), repair })
    if (est().project?.id !== projectId) return false // o projeto mudou: o marcador fica e ele volta ao abrir
    let itemId = ''
    const ok = est().apply((p) => {
      const r = placeNarration(p, asset, at)
      itemId = r.itemId
      return r.project
    })
    if (!ok) return false
    est().select([itemId])
    await flushAutosave()
    await window.api.project.clearPendingGenerated(projectId, rel)
    void enqueueAsset(projectId, asset)
    return true
  } catch (e) {
    toast.error(`Não foi possível inserir a narração gravada: ${ipcErrorMessage(e)}`, { description: `O arquivo continua em ${rel} na pasta do projeto.` })
    return false
  }
}

/** Ao abrir o projeto: gravações interrompidas (janela fechada/travada) entram na timeline com um aviso. */
export async function recoverNarrations(projectId: string): Promise<void> {
  let pending: Awaited<ReturnType<typeof window.api.project.pendingGenerated>>
  try {
    pending = await window.api.project.pendingGenerated(projectId)
  } catch {
    return
  }
  for (const g of pending) {
    if (est().project?.id !== projectId) return
    const ok = await insertNarration(projectId, g.rel, { startUs: g.meta.startUs, inUs: g.meta.inUs }, true)
    if (ok) {
      toast.warning(`${narrationAssetName(g.rel)} recuperada`, {
        description: `A gravação foi interrompida antes de terminar (janela fechada ou travada). O trecho gravado foi inserido em ${formatTimecodeUs(g.meta.startUs, est().project?.canvas.fps ?? 30)}; confira o final.`,
        duration: 15_000
      })
    }
  }
}

/** Sai do editor/fecha a janela no meio: grava o que deu (finishNarration) ou só desiste da contagem. */
export async function settleNarration(): Promise<void> {
  if (nst().phase === 'countdown') cancelNarration()
  else await finishNarration()
}

/** Desmontando sem tempo de inserir (troca brusca de tela): fecha o arquivo; o projeto o recupera ao abrir. */
export function abandonNarration(): void {
  cancelNarration()
  rec?.dispose()
  rec = null
  if (!finishing) nst().reset()
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError') return 'o acesso ao microfone foi negado (Configurações do Windows › Privacidade › Microfone).'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'o microfone escolhido não está disponível.'
  if (name === 'NotReadableError') return 'o microfone está em uso por outro programa.'
  return ipcErrorMessage(e)
}
