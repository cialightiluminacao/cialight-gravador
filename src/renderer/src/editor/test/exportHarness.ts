import { projectDurationUs } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { EditorExportCancelled, runEditorExport, type EditorExportRequest } from '../export/editorExport'
import { composeSession } from '@/export/exportComposer'

// Teste de integração da exportação do editor (CIALIGHT_TEST=editor-export), rota
// index.html#editor-export-test/<json>: exporta o cenário, a falha simulada do hardware, um cancelamento e o
// projeto da sessão sintética, e compõe a mesma sessão pela v1 (composed.mp4; o main roda o job ffmpeg).
// Um preview vivo (RenderClient próprio) é lido antes e depois para provar que a exportação não o perturba.
// O main valida os arquivos (editorExportTestMode.ts).

declare global {
  interface Window {
    __captureTestSend?: (r: unknown) => void
  }
}

interface Params { projectId: string; sessionId: string; outputDir: string }

export async function runExportHarness(params: Params): Promise<void> {
  const report: Record<string, unknown> = { errors: [] as string[] }
  const errors = report.errors as string[]
  let ok = false
  try {
    const project = await window.api.project.load(params.projectId)
    const base = (p: Project, fileName: string): EditorExportRequest => ({
      project: p,
      width: p.canvas.width,
      height: p.canvas.height,
      fps: p.canvas.fps,
      fromUs: 0,
      toUs: projectDurationUs(p),
      videoBitrate: 8_000_000,
      audioBitrate: 128_000,
      outputDir: params.outputDir,
      fileName
    })

    // preview vivo durante as exportações (instância separada, como no editor)
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const preview = new RenderClient(canvas, { width: 640, height: 360, dpr: 1 })
    await preview.ready
    preview.setProject(project, mediaUrlsFor(project, 'preview'), true)
    const readPreview = async (): Promise<number[]> => {
      const r = await preview.requestFrame(1_000_000, false)
      if (r.t !== 'rendered') throw new Error(`preview: ${r.t === 'error' ? r.message : r.t}`)
      return [...(await preview.readPixels(160, 90, 1, 1)), ...(await preview.readPixels(480, 270, 1, 1))]
    }
    let before: number[] = []
    try {
      before = await readPreview()
    } catch (e) {
      report.previewUntouched = { error: String(e) }
    }

    report.scenario = await exportOnce(base(project, 'cenario.mp4'))
    report.fallback = await exportOnce({ ...base(project, 'cenario.mp4'), simulateHwFailure: true })
    report.cancel = await cancelOnce(base(project, 'cancelado.mp4'))

    if (!report.previewUntouched) {
      try {
        report.previewUntouched = { before, after: await readPreview() }
      } catch (e) {
        report.previewUntouched = { error: String(e) }
      }
    }
    preview.dispose()

    // paridade v1: projeto da sessão no editor (1920×1080) × composição v1 da mesma sessão
    const sp = await window.api.project.fromSession(params.sessionId)
    report.parity = await exportOnce({ ...base(sp, 'paridade-editor.mp4'), videoBitrate: 12_000_000 })
    report.v1Composed = await composeV1(params.sessionId)
    ok = true
  } catch (e) {
    errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
  }
  window.__captureTestSend?.({ ok, report })
}

async function exportOnce(req: EditorExportRequest): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  let speed: number | null = null
  let progressEvents = 0
  try {
    const r = await runEditorExport(req, {
      onProgress: (p) => {
        progressEvents++
        if (p.speed !== null) speed = p.speed
      }
    })
    return { ...r, ms: Math.round(performance.now() - t0), speed, progressEvents }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function cancelOnce(req: EditorExportRequest): Promise<Record<string, unknown>> {
  const ac = new AbortController()
  let afterFrames = 0
  try {
    await runEditorExport(req, {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.stage === 'render' && p.frame >= 20 && !ac.signal.aborted) {
          afterFrames = p.frame
          ac.abort()
        }
      }
    })
    return { cancelled: false, afterFrames, error: 'terminou sem cancelar' }
  } catch (e) {
    return { cancelled: e instanceof EditorExportCancelled, afterFrames, ...(e instanceof EditorExportCancelled ? {} : { error: String(e) }) }
  }
}

/** Composição v1 (exportComposer, a etapa 1 do __qaExport) com webcam + anotações, sessão inteira. */
async function composeV1(sessionId: string): Promise<Record<string, unknown>> {
  try {
    const session = await window.api.session.get(sessionId)
    if (!session) throw new Error('sessão não encontrada')
    const path = await composeSession({
      sessionId,
      session,
      options: {
        presetId: 'max', trimStartMs: 0, trimEndMs: null, includeWebcam: true, includeAnnotations: true, audioMode: 'mix', micOffsetMs: 0,
        targetSizeMB: null, reels: false, outputDir: '', fileName: 'paridade-v1', pipOverride: null
      },
      fps: session.video.fps,
      width: session.video.width,
      height: session.video.height,
      durationMs: session.durationMs ?? 0,
      autoFadeMs: null,
      onProgress: () => {},
      signal: new AbortController().signal
    })
    return { path }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
