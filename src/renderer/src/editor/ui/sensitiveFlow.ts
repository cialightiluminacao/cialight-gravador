import { toast } from 'sonner'
import type { Asset } from '@shared/editor/project'
import type { SensitiveKind } from '@shared/editor/sensitive'
import type { ScanResult } from '@shared/editor/sensitiveScan'
import type { SensitiveScanProgress, SensitiveScanRequest } from '@shared/ipc'
import { ipcErrorMessage } from '@/lib/ipcError'
import type { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { useSensitiveScan } from '../state/sensitiveScan'
import { seekTo } from './editorActions'
import { makeThumbs } from './sensitiveThumbs'
import { buildRows, hideRows, hideToast, OCR_LANG_HINT, parseCustomWords, planScan, SCAN_DISCLAIMER, type ReviewRow, type ScanOutcome } from './sensitiveReview'

// Fluxo do "Procurar dados sensíveis" (G3): varreduras em sequência pelo IPC (uma por arquivo/trecho), cancelamento,
// miniaturas e a aplicação (um passo de desfazer). PRIVACIDADE: termos e resultados só na memória (state/sensitiveScan);
// nenhum console.log/localStorage/configuração aqui.

const ss = (): ReturnType<typeof useSensitiveScan.getState> => useSensitiveScan.getState()
const es = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Geração da busca: cancelar/fechar troca a geração e o que chega depois da antiga é descartado. */
let gen = 0
/** A varredura anterior (cancelada) ainda terminando no main: a próxima espera por ela (o main faz uma por vez). */
let lastDone: Promise<unknown> = Promise.resolve()
let thumbsAbort: AbortController | null = null

/** Caminho do arquivo de origem no disco (o main valida e lê; nunca pixels pelo IPC). */
async function sourcePath(a: Asset): Promise<string | null> {
  if (a.source.type === 'file') return a.source.path
  if (a.source.type === 'session') return window.api.session.filePath(a.source.sessionId, 'rec.mp4')
  return null
}

/** Uma varredura: assina antes de começar (o `done` pode chegar antes da resposta do start). */
function scanOnce(req: SensitiveScanRequest, onProgress: (p: SensitiveScanProgress) => void, onId: (id: string) => void): Promise<ScanResult> {
  const api = window.api.editor.sensitive
  const p = new Promise<ScanResult>((resolve) => {
    let id: string | null = null
    const early: { scanId: string; result: ScanResult }[] = []
    const earlyProg: SensitiveScanProgress[] = []
    const offProg = api.onProgress((pr) => {
      if (id === null) earlyProg.push(pr)
      else if (pr.scanId === id) onProgress(pr)
    })
    const finish = (r: ScanResult): void => {
      offDone()
      offProg()
      resolve(r)
    }
    const offDone = api.onDone((d) => {
      if (id === null) early.push(d)
      else if (d.scanId === id) finish(d.result)
    })
    api.start(req).then(
      (r) => {
        if (r.error) return finish({ occurrences: [], framesSampled: 0, framesOcr: 0, ms: 0, lang: '', error: r.error })
        id = r.scanId
        onId(r.scanId)
        for (const pr of earlyProg) if (pr.scanId === id) onProgress(pr)
        const d = early.find((x) => x.scanId === id)
        if (d) finish(d.result)
      },
      (e) => finish({ occurrences: [], framesSampled: 0, framesOcr: 0, ms: 0, lang: '', error: { code: 'ffmpeg', message: ipcErrorMessage(e) } })
    )
  })
  lastDone = p
  return p
}

/** Começa a busca com as escolhas do diálogo. */
export async function startSensitiveScan(): Promise<void> {
  const s = ss()
  const p = es().project
  if (!p || s.step === 'scanning') return
  const plan = planScan(p, s.clipId)
  if (plan.jobs.length === 0) {
    toast.error('Nada para procurar', { description: plan.unsupported ? 'Os clipes visuais são imagens ou mídia indisponível: a busca lê só vídeos.' : 'Não há clipes de vídeo ativos.' })
    return
  }
  const { words, dropped, tooLong } = parseCustomWords(s.wordsText)
  if (dropped || tooLong) toast.warning('Algumas palavras personalizadas ficaram de fora', { description: `Até 50 termos, cada um com até 100 caracteres (${dropped + tooLong} ignorado${dropped + tooLong === 1 ? '' : 's'}).` })
  // termo digitado entra mesmo com o tipo "Termo personalizado" desmarcado (foi pedido explicitamente)
  const kinds: SensitiveKind[] = words.length && !s.kinds.includes('custom') ? [...s.kinds, 'custom'] : s.kinds.filter((k) => k !== 'custom' || words.length > 0)
  if (kinds.length === 0) {
    toast.error('Escolha ao menos um tipo de dado ou escreva uma palavra personalizada')
    return
  }
  const my = ++gen
  const files = plan.jobs.length
  ss().patch({ step: 'scanning', progress: { file: 1, files, range: 1, ranges: plan.jobs[0].ranges.length, phase: 'amostrando', done: 0, total: 0 }, rows: [], unchecked: new Set(), ignored: new Set(), filter: new Set(), thumbs: {}, hover: null })
  await lastDone.catch(() => {})
  const outcomes: ScanOutcome[] = []
  for (let i = 0; i < plan.jobs.length; i++) {
    const job = plan.jobs[i]
    const asset = es().project?.assets.find((a) => a.id === job.assetId)
    const path = asset ? await sourcePath(asset).catch(() => null) : null
    if (my !== gen) return
    if (!path) {
      ss().patch({ step: 'setup', progress: null, scanId: null })
      toast.error('Não foi possível achar o arquivo de origem para procurar dados sensíveis', { description: asset?.name })
      return
    }
    const occurrences: ScanOutcome['occurrences'] = []
    for (let j = 0; j < job.ranges.length; j++) {
      const r = job.ranges[j]
      ss().patch({ progress: { file: i + 1, files, range: j + 1, ranges: job.ranges.length, phase: 'amostrando', done: 0, total: 0 } })
      const req: SensitiveScanRequest = { filePath: path, fromUs: r.fromUs, toUs: r.toUs, kinds, ...(words.length ? { customTerms: words } : {}), videoStreamIndex: job.videoStreamIndex }
      const result = await scanOnce(
        req,
        (pr) => {
          if (my === gen) ss().patch({ progress: { file: i + 1, files, range: j + 1, ranges: job.ranges.length, phase: pr.phase, done: pr.done, total: pr.total } })
        },
        (id) => {
          if (my === gen) ss().patch({ scanId: id })
        }
      )
      if (my !== gen) return // cancelada/fechada: o aviso já foi dado
      ss().patch({ scanId: null })
      if (result.cancelled) {
        ss().patch({ step: 'setup', progress: null })
        toast('Busca cancelada')
        return
      }
      if (result.error) {
        ss().patch({ step: 'setup', progress: null })
        if (result.error.code === 'ocrUnavailable') toast.error(result.error.message, { description: OCR_LANG_HINT, duration: 15_000 })
        else toast.error('A busca de dados sensíveis falhou', { description: result.error.message })
        return
      }
      occurrences.push(...result.occurrences)
    }
    outcomes.push({ assetId: job.assetId, ...(s.clipId ? { clipIds: job.clipIds } : {}), occurrences })
  }
  const project = es().project
  if (!project || my !== gen) return
  const rows = buildRows(project, outcomes)
  if (rows.length === 0) {
    ss().patch({ step: 'setup', progress: null })
    toast('Nenhum dado sensível encontrado', { description: SCAN_DISCLAIMER, duration: 10_000 })
    return
  }
  ss().patch({ step: 'review', progress: null, rows })
  thumbsAbort?.abort()
  const ac = (thumbsAbort = new AbortController())
  void makeThumbs(project, rows, ac.signal, (id, url) => {
    if (my === gen && !ac.signal.aborted) ss().patch({ thumbs: { ...ss().thumbs, [id]: url } })
  }).catch(() => {})
}

/** Cancela a busca em andamento (volta para as opções; com aviso). */
export function cancelSensitiveScan(quiet = false): void {
  const s = ss()
  if (s.step !== 'scanning') return
  gen++
  if (s.scanId) void window.api.editor.sensitive.cancel(s.scanId)
  ss().patch({ step: 'setup', progress: null, scanId: null })
  if (!quiet) toast('Busca cancelada')
}

/** Fecha o diálogo: cancela a busca, solta as miniaturas e apaga termos e resultados da memória. */
export function closeSensitiveDialog(): void {
  if (ss().step === 'scanning') cancelSensitiveScan(false)
  gen++
  thumbsAbort?.abort()
  thumbsAbort = null
  ss().close()
}

/** Esconde as linhas (um passo de desfazer), seleciona os efeitos novos e tira as linhas da lista. */
export function hideSensitiveRows(rows: readonly ReviewRow[]): void {
  if (rows.length === 0) return
  const style = ss().style
  let out: ReturnType<typeof hideRows> | null = null
  const ok = es().apply((p) => {
    out = hideRows(p, rows, style)
    return out.project
  })
  const o = out as ReturnType<typeof hideRows> | null
  if (!ok || !o) return
  if (o.itemIds.length === 0) {
    toast.warning('Nenhum efeito foi criado', { description: `${o.notHidden || rows.length} não puderam ser escondidos (faixa bloqueada ou fora dos clipes).` })
    return
  }
  es().select(o.itemIds)
  const t = hideToast(o)
  toast.success(t.title, t.description ? { description: t.description } : undefined)
  const done = new Set(rows.map((r) => r.id))
  const left = ss().rows.filter((r) => !done.has(r.id))
  if (left.length === 0 || left.every((r) => ss().ignored.has(r.id))) closeSensitiveDialog()
  else ss().patch({ rows: left, hover: null })
}

/** Linha em foco/sob o ponteiro: playhead no 1º instante em que ela aparece e contorno no visualizador. */
export function focusSensitiveRow(row: ReviewRow | null, playback: PlaybackController | null): void {
  if (!row) {
    if (ss().hover) ss().patch({ hover: null })
    return
  }
  const h = ss().hover
  if (h && h.itemId === row.clipId && h.tUs === row.atUs && h.box === row.box) return
  if (es().playing) playback?.pause()
  seekTo(playback, row.atUs)
  ss().patch({ hover: { itemId: row.clipId, tUs: row.atUs, box: row.box } })
}
