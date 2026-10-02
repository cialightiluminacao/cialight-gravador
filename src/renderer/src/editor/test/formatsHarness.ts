import { contentEndUs } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { exportRange, frameCount } from '../export/exportPlan'
import { runEditorExport } from '../export/editorExport'
import { EditorExportCancelled } from '../export/finalize'
import { exportStill, renderStill, runAudioExport, runGifExport } from '../export/formatExport'
import { audioEstimateBytes, audioOnlyBlocker, gifDiskBytes, gifSize, stillFileName, type AudioFormat } from '../export/formatPlan'
import { queueProgress, type QueueItem, type QueueJob } from '../export/exportQueue'
import { exportQueue } from '../export/exportQueueStore'
import { useEditorStore } from '../state/editorStore'
import { effectsPreviewRef } from './exportHarness'

// Teste de integração dos formatos extras (CIALIGHT_TEST=editor-formats), rota index.html#editor-formats-test/<json>:
// pelo mesmo caminho do diálogo (formatPlan → formatExport) exporta o GIF 480 px / 12 fps do trecho I–O, dois
// cancelamentos do GIF (nos quadros e na paleta), o quadro PNG em 1,5 s (e em 4 s, para calibrar o borrado
// invertido), o "só áudio" em wav/mp3/m4a do mesmo trecho e um vídeo pequeno do mesmo trecho (áudio de referência).
// O PNG é comparado aqui com o preview (RenderClient.readPixels do compositor de preview no mesmo instante); o
// main valida os arquivos (editorFormatsTestMode.ts).
// Fila (F7 Task 4): pela fila do app (exportQueue, os executores reais) — vídeo 720p I–O, GIF, wav e outro vídeo
// com o MESMO nome do primeiro, enfileirados a partir do projeto aberto no store do editor; depois de enfileirar,
// os efeitos são apagados do projeto do editor (o item tem de exportar o instantâneo, com os efeitos). Depois, uma
// 2ª fila: o item rodando é cancelado no meio e o seguinte termina.

type Region = { x: number; y: number; w: number; h: number }
interface Params {
  projectId: string
  outputDir: string
  cancelDir: string
  cancelPaletteDir: string
  inUs: number
  outUs: number
  pngUs: number
  pngInvUs: number
  /** Instante sem mídia (depois do fim): só o fundo do projeto. */
  pngBackgroundUs: number
  /** Regiões normalizadas (centro, largura, altura) da tarja e do blur. */
  solid: Region
  blur: Region
  /** Fila: pastas, bloco e região "fora" dos oráculos de privacidade (checkEffects). */
  queueDir: string
  queueCancelDir: string
  block: number
  outside: Region
}

export async function runFormatsHarness(params: Params): Promise<void> {
  const report: Record<string, unknown> = { errors: [] as string[] }
  const errors = report.errors as string[]
  let ok = false
  try {
    const project = await window.api.project.load(params.projectId)
    const total = contentEndUs(project)
    const range = exportRange(total, params.inUs, params.outUs, 'inout')
    report.range = range

    // ---- GIF 480 px, 12 fps, trecho I–O (como o diálogo) ----
    const gif = gifSize(480, project.canvas)
    const gifReq = { project, ...gif, fps: 12, fromUs: range.fromUs, toUs: range.toUs, outputDir: params.outputDir, fileName: 'formatos.mp4', estimateBytes: gifDiskBytes(gif.width, gif.height, 12, range.fromUs, range.toUs) }
    const progress: { stage: string; percent: number }[] = []
    report.gif = await settle(() => runGifExport(gifReq, { onProgress: (p) => progress.push({ stage: p.stage, percent: +p.percent.toFixed(2) }) }))
    report.gifExpectedFrames = frameCount(range.fromUs, range.toUs, 12)
    report.gifProgress = {
      maxRender: Math.max(...progress.filter((p) => p.stage === 'render').map((p) => p.percent)),
      minFinalize: Math.min(...progress.filter((p) => p.stage === 'finalize').map((p) => p.percent)),
      last: progress[progress.length - 1] ?? null,
      monotonic: progress.every((p, i) => i === 0 || p.percent >= progress[i - 1].percent)
    }

    // ---- cancelamentos do GIF: nos quadros e na paleta (nada pode sobrar nas pastas) ----
    report.gifCancel = await cancelGif({ ...gifReq, outputDir: params.cancelDir, fileName: 'cancelado' }, (p) => p.stage === 'render' && p.frame >= 10)
    // já na finalização (pipeFinish em curso no main: fim da passada 1, paleta ou paletteuse)
    report.gifCancelPalette = await cancelGif({ ...gifReq, outputDir: params.cancelPaletteDir, fileName: 'cancelado-paleta' }, (p) => p.stage === 'finalize', 40)

    // ---- quadro PNG em 1,5 s (e 4 s): arquivo + comparação com o preview ----
    report.png = await pngCase(project, params.pngUs, params.outputDir, params)
    report.pngInv = await pngCase(project, params.pngInvUs, params.outputDir, params)
    report.pngBackground = await settle(() => exportStill({ project, tUs: params.pngBackgroundUs, outputDir: params.outputDir, fileName: 'fundo' }))

    // ---- só áudio (wav/mp3/m4a) do trecho + vídeo pequeno do mesmo trecho (áudio de referência) ----
    const audio: Record<string, unknown> = {}
    for (const format of ['wav', 'mp3', 'm4a'] as AudioFormat[]) {
      audio[format] = await settle(() =>
        runAudioExport({ project, fromUs: range.fromUs, toUs: range.toUs, format, outputDir: params.outputDir, fileName: `audio-${format}`, estimateBytes: audioEstimateBytes(format, range.toUs - range.fromUs) })
      )
    }
    report.audio = audio
    report.video = await settle(() =>
      runEditorExport({ project, width: 640, height: 360, fps: 30, fromUs: range.fromUs, toUs: range.toUs, videoBitrate: 2_000_000, audioBitrate: 192_000, outputDir: params.outputDir, fileName: 'referencia.mp4' })
    )
    // sem nada audível: bloqueado (diálogo) e recusado (pipeline)
    const mutedProject: Project = { ...project, tracks: project.tracks.map((t) => (t.kind === 'audio' ? { ...t, muted: true } : t)) }
    report.audioMuted = {
      blocker: audioOnlyBlocker(mutedProject),
      run: await settle(() => runAudioExport({ project: mutedProject, fromUs: range.fromUs, toUs: range.toUs, format: 'wav', outputDir: params.cancelDir, fileName: 'mudo' }))
    }

    // ---- fila de exportações ----
    await queueCases(project, range, params, report)
    ok = true
  } catch (e) {
    errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
  }
  window.__captureTestSend?.({ ok, report })
}

async function settle<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** GIF cancelado quando `when` vale (depois de `delayMs`, se dado). */
async function cancelGif(req: Parameters<typeof runGifExport>[0], when: (p: { stage: string; frame: number }) => boolean, delayMs = 0): Promise<Record<string, unknown>> {
  const ac = new AbortController()
  let at: { stage: string; frame: number; percent: number } | null = null
  try {
    await runGifExport(req, {
      signal: ac.signal,
      onProgress: (p) => {
        if (!at && when(p)) {
          at = { stage: p.stage, frame: p.frame, percent: +p.percent.toFixed(1) }
          if (delayMs) setTimeout(() => ac.abort(), delayMs)
          else ac.abort()
        }
      }
    })
    return { cancelled: false, at, error: 'terminou sem cancelar' }
  } catch (e) {
    return { cancelled: e instanceof EditorExportCancelled, at, ...(e instanceof EditorExportCancelled ? {} : { error: String(e) }) }
  }
}

async function sha256(b: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Quadro PNG em tUs: grava pelo caminho do editor (exportStill) e renderiza de novo (renderStill) para comparar,
 * decodificado, com o preview (RenderClient no tamanho do projeto, readPixels do compositor no mesmo instante).
 */
async function pngCase(project: Project, tUs: number, outputDir: string, params: Params): Promise<Record<string, unknown>> {
  try {
    const file = await exportStill({ project, tUs, outputDir, fileName: stillFileName(project.name, tUs) })
    const again = await renderStill(project, tUs)
    const { width: W, height: H } = project.canvas
    const bmp = await createImageBitmap(new Blob([again.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const oc = new OffscreenCanvas(W, H)
    const ctx = oc.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const png = ctx.getImageData(0, 0, W, H).data
    bmp.close()
    // preview: o compositor do preview (canvas da página) no mesmo instante
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const preview = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
    let pv: Uint8Array
    try {
      await preview.ready
      preview.setProject(project, mediaUrlsFor(project, 'preview'), true)
      const r = await preview.requestFrame(tUs, false)
      if (r.t !== 'rendered') throw new Error(`preview: ${JSON.stringify(r)}`)
      pv = await preview.readPixels(0, 0, W, H)
    } finally {
      preview.dispose()
      canvas.remove()
    }
    const px = (r: Region): { x0: number; y0: number; x1: number; y1: number } => ({ x0: Math.round((r.x - r.w / 2) * W), y0: Math.round((r.y - r.h / 2) * H), x1: Math.round((r.x + r.w / 2) * W), y1: Math.round((r.y + r.h / 2) * H) })
    let maxDiff = 0
    let diffCount = 0
    let alphaMin = 255
    const blurBox = px(params.blur)
    let blurMax = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        alphaMin = Math.min(alphaMin, png[i + 3])
        let d = 0
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(png[i + c] - pv[i + c]))
        if (d) diffCount++
        maxDiff = Math.max(maxDiff, d)
        if (x >= blurBox.x0 && x < blurBox.x1 && y >= blurBox.y0 && y < blurBox.y1) blurMax = Math.max(blurMax, d)
      }
    }
    // tarja: todo pixel a 2 px da borda da região, na decodificação do navegador e no preview
    const sb = px(params.solid)
    const tarja = { png: [0, 0, 0], preview: [0, 0, 0], worst: 0, pixels: 0 }
    const target = [0x12, 0x34, 0x56]
    for (let y = sb.y0 + 2; y < sb.y1 - 2; y++) {
      for (let x = sb.x0 + 2; x < sb.x1 - 2; x++) {
        const i = (y * W + x) * 4
        tarja.pixels++
        for (let c = 0; c < 3; c++) {
          const dp = Math.abs(png[i + c] - target[c])
          const dv = Math.abs(pv[i + c] - target[c])
          if (Math.max(dp, dv) > tarja.worst || tarja.pixels === 1) {
            tarja.worst = Math.max(dp, dv)
            tarja.png = [png[i], png[i + 1], png[i + 2]]
            tarja.preview = [pv[i], pv[i + 1], pv[i + 2]]
          }
        }
      }
    }
    return { file, sha256: await sha256(again.png), bytes: again.png.byteLength, warnings: again.warnings, vsPreview: { maxDiff, diffPixels: diffCount, blurMaxDiff: blurMax, alphaMin, tarja } }
  } catch (e) {
    return { error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
  }
}

/** Resolve quando a fila não tem nada rodando nem esperando. */
function whenQueueIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (!exportQueue.active()) return resolve()
    const off = exportQueue.subscribe(() => {
      if (exportQueue.active()) return
      off()
      resolve()
    })
  })
}

const effectCount = (p: Project): number => p.tracks.reduce((n, t) => n + t.items.filter((i) => i.type === 'effect').length, 0)
const itemOut = (i: QueueItem): Record<string, unknown> => ({ id: i.id, label: i.label, kind: i.job.kind, state: i.state, path: i.result?.path ?? null, message: i.message, startedAt: i.startedAt, endedAt: i.endedAt })

/**
 * Fila: 4 itens (vídeo 720p I–O, GIF, wav e um vídeo 360p com o MESMO nome do primeiro) a partir do projeto aberto
 * no store do editor; os efeitos são apagados do store depois de enfileirar. Registra a ordem, os horários de
 * início/fim, o máximo de itens rodando juntos (observado a cada mudança) e o progresso global. Depois, uma 2ª fila:
 * vídeo cancelado no meio (quadro ≥ 10) e um wav que tem de terminar.
 */
async function queueCases(project: Project, range: { fromUs: number; toUs: number }, params: Params, report: Record<string, unknown>): Promise<void> {
  const st = useEditorStore.getState
  st().open(project)
  const snap = st().project!
  const base = (dir: string, fileName: string) => ({ project: snap, outputDir: dir, fileName, fromUs: range.fromUs, toUs: range.toUs })
  const video = (dir: string, fileName: string, w: number, h: number, bps: number): QueueJob => ({ kind: 'video', request: { ...base(dir, fileName), width: w, height: h, fps: 30, videoBitrate: bps, audioBitrate: 128_000 } })
  const gif = gifSize(480, snap.canvas)
  const jobs: QueueJob[] = [
    video(params.queueDir, 'fila.mp4', 1280, 720, 12_000_000),
    { kind: 'gif', request: { ...base(params.queueDir, 'fila.gif'), ...gif, fps: 12, estimateBytes: gifDiskBytes(gif.width, gif.height, 12, range.fromUs, range.toUs) } },
    { kind: 'audio', request: { ...base(params.queueDir, 'fila.wav'), format: 'wav' } },
    video(params.queueDir, 'fila.mp4', 640, 360, 2_000_000)
  ]
  let maxRunning = 0
  let fractions: number[] = []
  const off = exportQueue.subscribe(() => {
    maxRunning = Math.max(maxRunning, exportQueue.items.filter((i) => i.state === 'running').length)
    const f = queueProgress(exportQueue.items).fraction
    if (f != null) fractions.push(f)
  })
  try {
    const ids = jobs.map((job, k) => exportQueue.enqueue({ job, label: `item ${k + 1}`, durationUs: range.toUs - range.fromUs, privacy: [] }).id)
    // editar depois de enfileirar: sem nenhum efeito no projeto do editor (o item exporta o instantâneo)
    st().apply((p) => ({ ...p, tracks: p.tracks.filter((t) => !t.items.some((i) => i.type === 'effect')) }))
    const queued = exportQueue.items.find((i) => i.id === ids[0])!
    report.queueSnapshot = { storeEffects: effectCount(st().project!), itemEffects: effectCount(queued.job.request.project), sameAsSnapshot: queued.job.request.project === snap, frozen: Object.isFrozen(queued.job.request.project) }
    await whenQueueIdle()
    const items = ids.map((id) => exportQueue.items.find((i) => i.id === id)!)
    report.queue = { items: items.map(itemOut), maxRunning, fractionMonotonic: fractions.every((f, i) => i === 0 || f >= fractions[i - 1] - 1e-9), lastFraction: fractions[fractions.length - 1] ?? null }
    // privacidade do item de vídeo: referência do preview do INSTANTÂNEO no quadro 1 s do arquivo (= I + 1 s)
    const first = items[0]
    report.queueEffects = first.result
      ? { export: first.result, ...(await effectsPreviewRef(snap, range.fromUs + 1_000_000, 1280, 720, { block: params.block, blur: params.blur, outside: params.outside })) }
      : { error: first.message ?? first.state }
    exportQueue.clearFinished()

    // 2ª fila: o vídeo rodando é cancelado no meio; o wav seguinte termina
    maxRunning = 0
    fractions = []
    let at: { frame: number; percent: number } | null = null
    const a = exportQueue.enqueue({ job: video(params.queueCancelDir, 'fila-cancelada.mp4', 1280, 720, 12_000_000), label: 'cancelado', durationUs: range.toUs - range.fromUs, privacy: [] }).id
    const b = exportQueue.enqueue({ job: { kind: 'audio', request: { ...base(params.queueCancelDir, 'fila-depois.wav'), format: 'wav' } }, label: 'depois', durationUs: range.toUs - range.fromUs, privacy: [] }).id
    const offCancel = exportQueue.subscribe(() => {
      const it = exportQueue.items.find((i) => i.id === a)
      if (!at && it?.state === 'running' && it.progress && it.progress.stage === 'render' && it.progress.frame >= 10) {
        at = { frame: it.progress.frame, percent: +it.progress.percent.toFixed(1) }
        exportQueue.cancel(a)
      }
    })
    try {
      await whenQueueIdle()
    } finally {
      offCancel()
    }
    report.queueCancel = { at, maxRunning, items: [a, b].map((id) => itemOut(exportQueue.items.find((i) => i.id === id)!)) }
    exportQueue.clearFinished()
  } finally {
    off()
    st().close()
  }
}
