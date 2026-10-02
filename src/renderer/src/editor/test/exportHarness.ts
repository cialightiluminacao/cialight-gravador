import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import { projectDurationUs, updateItem } from '@shared/editor/ops'
import { createMediaItem } from '@shared/editor/factory'
import type { Asset, MediaItem, Project } from '@shared/editor/project'
import { exportMediaIssues, frameCount } from '../export/exportPlan'
import { exportRequestFor, presetAvailability, settingsForPreset, validateExport, type ExportSettings } from '../export/exportPresets'
import { probeHevc } from '../export/hevcSupport'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { EditorExportCancelled, runEditorExport, type EditorExportRequest } from '../export/editorExport'
import { composeSession } from '@/export/exportComposer'
import { channel, toneAmplitude } from '@shared/audio/pcmAnalysis'
import { AudioClient } from '../engine/audio/AudioClient'

// Teste de integração da exportação do editor (CIALIGHT_TEST=editor-export), rota
// index.html#editor-export-test/<json>: exporta o cenário, a falha simulada do hardware, um cancelamento e o
// projeto da sessão sintética, e compõe a mesma sessão pela v1 (composed.mp4; o main roda o job ffmpeg).
// Um preview vivo (RenderClient próprio) é lido antes e depois para provar que a exportação não o perturba.
// O main valida os arquivos (editorExportTestMode.ts).
// F7: configurações do diálogo (exportPresets) — tamanho alvo personalizado, 60 fps de um projeto de 30,
// intermediário (quadro-chave 0,5 s), Feed 1:1, HEVC (se o hardware tiver; senão o diálogo o bloqueia), a volta
// do HEVC para H.264 e a privacidade (tarja/blur) num preset reduzido (WhatsApp) e no HEVC.

declare global {
  interface Window {
    __captureTestSend?: (r: unknown) => void
  }
}

type Region = { x: number; y: number; w: number; h: number }
interface Params {
  projectId: string
  sessionId: string
  outputDir: string
  targetBytes: number
  colorProjects: string[]
  speedProjectId: string
  reverseProjectId: string
  denoiseProjectId: string
  duckingProjectId: string
  duckingHz: number
  /** blur/outside: regiões normalizadas (centro, largura, altura) do blur e de um trecho só de ruído. */
  effects: { projectId: string; width: number; height: number; tUs: number; block: number; blur: Region; outside: Region }
  /** F7: projeto de ~20 s (tamanho alvo personalizado) e projeto 1080×1080 (Feed 1:1). */
  longProjectId: string
  squareProjectId: string
  targetMB: number
}

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
    // falha que não é do codificador (intervalo vazio): mostra a causa real, sem tentar em software
    report.nonEncoder = await exportOnce({ ...base(project, 'vazio.mp4'), toUs: 0 })
    // mídia ausente no intervalo: a pré-checagem do diálogo a lista e, exportando mesmo assim, o resultado
    // traz o aviso (nunca uma exportação "ok" silenciosa com o quadriculado)
    const withMissing = projectWithMissingAsset(project)
    report.missingMedia = {
      preflight: exportMediaIssues(withMissing, 0, projectDurationUs(withMissing)),
      export: await exportOnce(base(withMissing, 'midia-ausente.mp4'))
    }
    // tamanho-alvo pequeno forçado: 1ª passada passa do alvo → refeita com bitrate corrigido
    report.sized = await exportOnce({ ...base(project, 'alvo.mp4'), targetBytes: params.targetBytes })
    // cor: fontes BT.601 marcada e sem marcação (o que o Chromium entrega no VideoFrame + o export)
    const color: Record<string, unknown> = {}
    for (const id of params.colorProjects) {
      const p = await window.api.project.load(id)
      color[id] = { export: await exportOnce(base(p, `${id}.mp4`)), frame: await colorDiag(mediaUrlsFor(p, 'export')[p.assets[0].id]?.original) }
    }
    report.color = color
    report.effects = await effectsParity(params.effects, params.outputDir, { fileName: 'efeitos.mp4' })
    await f7Cases(params, project, report)
    // velocidade 2× com tom preservado: voz sintética de 220 Hz (o main confere o tom e a duração)
    const speedProject = await window.api.project.load(params.speedProjectId)
    report.speed = await exportOnce(base(speedProject, 'velocidade-2x.mp4'))
    // determinismo: a mesma exportação de novo (workers novos) tem de dar o mesmo áudio
    report.speedAgain = await exportOnce(base(speedProject, 'velocidade-2x-de-novo.mp4'))
    // reverso: trecho de 3 s tocado de trás para frente (o main compara com o filtro reverse do ffmpeg)
    report.reverse = await exportOnce(base(await window.api.project.load(params.reverseProjectId), 'reverso.mp4'))
    // redução de ruído: o item pede denoise e o processado está pronto (generated/) → a exportação lê a versão
    // processada; com a opção desligada volta ao original (o main compara o ruído nas pausas)
    const dnProject = await window.api.project.load(params.denoiseProjectId)
    report.denoise = await exportOnce(base(dnProject, 'ruido-tratado.mp4'))
    const dnItem = dnProject.tracks.flatMap((t) => t.items).find((i) => i.type === 'media')!
    report.denoiseOff = await exportOnce(base(updateItem<MediaItem>(dnProject, dnItem.id, (d) => { d.audio.denoise = false }), 'ruido-original.mp4'))
    // ducking: música (seno) na faixa Música + voz (bursts) na faixa Voz com o speech.json da ingestão → a exportação
    // abaixa a música sob a fala; o mesmo projeto tocado pelo caminho do preview (AudioClient, blocos de 100 ms) dá os
    // níveis da música para o main comparar com a exportação
    const duckProject = await window.api.project.load(params.duckingProjectId)
    report.ducking = await exportOnce(base(duckProject, 'ducking.mp4'))
    report.duckingPreview = await previewToneLevels(duckProject, params.duckingHz)

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

/** Janela (50 ms = 11 ciclos de 220 Hz e 50 de 1 kHz: sem vazamento) e passo (10 ms) das medidas de nível da música. */
const DUCK_WIN = 2400
const DUCK_HOP = 480

/** Nível (dB relativo a 1) do tom `hz` ao longo do projeto tocado pelo caminho do preview (blocos de 100 ms). */
async function previewToneLevels(p: Project, hz: number): Promise<{ levelsDb?: number[]; error?: string }> {
  const audio = new AudioClient()
  const errors: string[] = []
  audio.onError((m) => errors.push(m))
  try {
    audio.setProject(p, mediaUrlsFor(p, 'preview'), true)
    const frames = Math.round((projectDurationUs(p) * 48000) / 1e6)
    const pcm = new Float32Array(frames * 2)
    for (let f = 0; f < frames; f += 4800) {
      const b = await audio.render(Math.round((f * 1e6) / 48000), Math.min(4800, frames - f))
      if (!b) throw new Error(`bloco ${f} sem resposta (${errors.join('; ')})`)
      pcm.set(b.pcm, f * 2)
    }
    const l = channel(pcm, 0)
    const levelsDb: number[] = []
    for (let i = 0; i + DUCK_WIN <= l.length; i += DUCK_HOP) levelsDb.push(+(20 * Math.log10(Math.max(1e-9, toneAmplitude(l, i, DUCK_WIN, hz, 48000)))).toFixed(3))
    return errors.length ? { levelsDb, error: errors.join('; ') } : { levelsDb }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    audio.dispose()
  }
}

/**
 * Paridade dos efeitos: o projeto de efeitos (quadro do projeto 1920×1080) exportado em outra resolução
 * (1280×720) × o preview do mesmo quadro (RenderClient 1920×1080) reduzido para a resolução da exportação.
 * Devolve a variância de luma por bloco (block×block, linha a linha) do preview reduzido; o main calcula a
 * mesma coisa no quadro decodificado da exportação e compara as máscaras de baixa variância (IoU).
 */
async function effectsParity(fx: Params['effects'], outputDir: string, variant: { fileName: string; settings?: ExportSettings }): Promise<Record<string, unknown>> {
  try {
    const p = await window.api.project.load(fx.projectId)
    const toUs = projectDurationUs(p)
    // sem configurações: 12 Mbps na resolução pedida — o fundo de ruído é o pior caso do H.264; com menos bits o
    // quantizador desvia a cor dos macroblocos chapados vizinhos dele (medido: até 4–6 níveis a 8 Mbps)
    const req: EditorExportRequest = variant.settings
      ? { project: p, fromUs: 0, toUs, ...exportRequestFor(variant.settings, toUs), outputDir, fileName: variant.fileName }
      : { project: p, width: fx.width, height: fx.height, fps: p.canvas.fps, fromUs: 0, toUs, videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir, fileName: variant.fileName }
    const exported = await exportOnce(req)
    return { export: exported, ...(await effectsPreviewRef(p, fx.tUs, req.width, req.height, fx)) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Referência do preview para os oráculos de privacidade (checkEffects no main): o quadro `tUs` do projeto no
 * preview (RenderClient no tamanho do projeto) reduzido para OW×OH — variância de luma por bloco, RGB do miolo
 * borrado e energia de detalhe do miolo e de fora. Também usada pela fila (formatsHarness).
 */
export async function effectsPreviewRef(p: Project, tUs: number, OW: number, OH: number, fx: { block: number; blur: Region; outside: Region }): Promise<Record<string, unknown>> {
  // miolo da região borrada na saída, longe do feather (24 px a 720p, proporcional à altura)
  const inset = Math.round((24 * OH) / 720)
  // recortes pares (o crop do ffmpeg em yuv420p arredonda ímpares e o RGB sairia com outro tamanho)
  const ev2 = (v: number): number => Math.round(v / 2) * 2
  const crop = (r: Region, pad: number): Region => ({ x: ev2((r.x - r.w / 2) * OW + pad), y: ev2((r.y - r.h / 2) * OH + pad), w: ev2(r.w * OW - 2 * pad), h: ev2(r.h * OH - 2 * pad) })
  const blurCrop = crop(fx.blur, inset)
  const outsideCrop = crop(fx.outside, 0)
  const PW = p.canvas.width
  const PH = p.canvas.height
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: PW, height: PH, dpr: 1 })
  try {
    await client.ready
    client.setProject(p, mediaUrlsFor(p, 'preview'), true)
    const r = await client.requestFrame(tUs, false)
    if (r.t !== 'rendered') throw new Error(`preview: ${JSON.stringify(r)}`)
    const full = await client.readPixels(0, 0, PW, PH)
    const src = new OffscreenCanvas(PW, PH)
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(full), PW, PH), 0, 0)
    const dst = new OffscreenCanvas(OW, OH)
    const ctx = dst.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, OW, OH)
    const small = ctx.getImageData(0, 0, OW, OH).data
    // RGB do miolo da região borrada no preview reduzido (o main compara com a exportação por PSNR)
    const c = blurCrop
    const blurRgb: number[] = []
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) blurRgb.push(small[(y * OW + x) * 4], small[(y * OW + x) * 4 + 1], small[(y * OW + x) * 4 + 2])
    return {
      width: OW,
      height: OH,
      blurCrop,
      outsideCrop,
      previewBlockVar: blockVariance(small, OW, OH, fx.block),
      previewBlurRgb: blurRgb,
      previewEnergy: { blur: detailEnergy(small, OW, blurCrop), outside: detailEnergy(small, OW, outsideCrop) }
    }
  } finally {
    client.dispose()
    canvas.remove()
  }
}

/** Energia de detalhe: média de (ΔL)² entre vizinhos (horizontal + vertical) no recorte de uma imagem RGBA. */
function detailEnergy(d: Uint8ClampedArray, w: number, c: Region): number {
  const L = (x: number, y: number): number => {
    const i = (y * w + x) * 4
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  }
  let s = 0
  let n = 0
  for (let y = c.y; y < c.y + c.h - 1; y++) {
    for (let x = c.x; x < c.x + c.w - 1; x++) {
      const l = L(x, y)
      s += (L(x + 1, y) - l) ** 2 + (L(x, y + 1) - l) ** 2
      n++
    }
  }
  return n ? +(s / n).toFixed(3) : 0
}

/**
 * Casos da F7, pelo mesmo caminho do ExportDialog (settingsForPreset → ajustes → exportRequestFor →
 * runEditorExport). O main valida os arquivos.
 */
async function f7Cases(params: Params, scenario: Project, report: Record<string, unknown>): Promise<void> {
  const out = params.outputDir
  const req = (p: Project, s: ExportSettings, fileName: string): EditorExportRequest => {
    const toUs = projectDurationUs(p)
    return { project: p, fromUs: 0, toUs, ...exportRequestFor(s, toUs), outputDir: out, fileName }
  }
  // a) tamanho alvo personalizado (não WhatsApp) num projeto de ~20 s: o pedido leva targetBytes (2ª passada)
  const long = await window.api.project.load(params.longProjectId)
  const targetSettings: ExportSettings = { ...settingsForPreset('youtube1080', long.canvas), quality: { kind: 'target', mb: params.targetMB } }
  const targetReq = req(long, targetSettings, 'f7-alvo.mp4')
  report.f7Target = { ...(await exportOnce(targetReq)), requestTargetBytes: targetReq.targetBytes ?? null, requestVideoBitrate: targetReq.videoBitrate, durationUs: projectDurationUs(long) }
  // a2) o mesmo pedido com a 1ª passada forçada acima do alvo (4× o bitrate): a 2ª passada do alvo personalizado
  report.f7TargetResize = await exportOnce({ ...req(long, targetSettings, 'f7-alvo-2a-passada.mp4'), simulateFirstPassOvershoot: true })
  // b) 60 fps de um projeto de 30 fps: quadros exatos (frameCount)
  const fps60: ExportSettings = { ...settingsForPreset('youtube1080', scenario.canvas), fps: 60 }
  report.f7Fps60 = { ...(await exportOnce(req(scenario, fps60, 'f7-60fps.mp4'))), expectedFrames: frameCount(0, projectDurationUs(scenario), 60) }
  // c) intermediário: quadro-chave a cada 0,5 s, áudio 320 kbps
  report.f7Intermediate = await exportOnce(req(scenario, settingsForPreset('intermediate', scenario.canvas), 'f7-intermediario.mp4'))
  // áudio de 320 kbps pedido direto: ou sai a 320 sem aviso, ou sai menor COM aviso (nunca em silêncio)
  report.f7Audio320 = await exportOnce({ ...req(scenario, settingsForPreset('youtube1080', scenario.canvas), 'f7-audio-320.mp4'), audioBitrate: 320_000 })
  // d) Feed 1:1 num projeto 1080×1080 (e indisponível no 16:9)
  const square = await window.api.project.load(params.squareProjectId)
  report.f7Feed11 = {
    ...(await exportOnce(req(square, settingsForPreset('feed11', square.canvas), 'f7-feed11.mp4'))),
    availability: presetAvailability('feed11', square.canvas, projectDurationUs(square)),
    unavailableOn169: presetAvailability('feed11', scenario.canvas, projectDurationUs(scenario))
  }
  // e) HEVC: só se o hardware confirmar (o diálogo usa o mesmo probeHevc); privacidade no arquivo HEVC
  const fxProject = await window.api.project.load(params.effects.projectId)
  const hevcOriginal: ExportSettings = { ...settingsForPreset('original', fxProject.canvas), codec: 'hevc' }
  const hevcSupported = await probeHevc(hevcOriginal.width, hevcOriginal.height, hevcOriginal.fps)
  report.f7Hevc = hevcSupported
    ? { supported: true, effects: await effectsParity(params.effects, out, { fileName: 'f7-hevc-efeitos.mp4', settings: hevcOriginal }) }
    : { supported: false, dialogBlocker: validateExport(hevcOriginal, fxProject.canvas, projectDurationUs(fxProject), false).blocker }
  // falha injetada do HEVC antes do 1º pacote → a mesma exportação em H.264
  report.f7HevcFallback = await exportOnce({ ...req(scenario, { ...settingsForPreset('youtube1080', scenario.canvas), codec: 'hevc' }, 'f7-hevc-falha.mp4'), simulateHevcFailure: true })
  // f) privacidade num preset reduzido: WhatsApp (1280×720 a partir do projeto 1920×1080)
  report.f7Whatsapp = await effectsParity(params.effects, out, { fileName: 'f7-whatsapp-efeitos.mp4', settings: settingsForPreset('whatsapp', fxProject.canvas) })
}

/** Variância de luma por bloco b×b (blocos inteiros, linha a linha) de uma imagem RGBA. */
function blockVariance(d: Uint8ClampedArray, w: number, h: number, b: number): number[] {
  const out: number[] = []
  for (let by = 0; by + b <= h; by += b) {
    for (let bx = 0; bx + b <= w; bx += b) {
      let s = 0
      let s2 = 0
      for (let y = by; y < by + b; y++) {
        for (let x = bx; x < bx + b; x++) {
          const i = (y * w + x) * 4
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          s += l
          s2 += l * l
        }
      }
      const n = b * b
      out.push(Math.round(s2 / n - (s / n) ** 2))
    }
  }
  return out
}

/** colorSpace do VideoFrame decodificado (o que o Chromium assume para a fonte). */
async function colorDiag(url: string | undefined): Promise<Record<string, unknown>> {
  if (!url) return { error: 'sem URL' }
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    const sample = track ? await new VideoSampleSink(track).getSample(0.5) : null
    if (!sample) return { error: 'sem quadro' }
    const frame = sample.toVideoFrame()
    const out = { colorSpace: frame.colorSpace.toJSON(), format: frame.format, trackColorSpace: await track!.getColorSpace().catch(() => null) }
    frame.close()
    sample.close()
    return out
  } catch (e) {
    return { error: String(e) }
  } finally {
    input.dispose()
  }
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

/** O projeto com uma mídia ausente (arquivo apagado) numa faixa de vídeo nova, no primeiro segundo. */
function projectWithMissingAsset(p: Project): Project {
  const gone: Asset = {
    id: 'a_ausente', name: 'apagado.mp4', kind: 'video', source: { type: 'file', path: 'C:/nao-existe/apagado.mp4', size: 1, mtimeMs: 1 }, durationUs: 1_000_000,
    video: { width: 640, height: 360, fps: 30, codec: 'h264', rotation: 0, decodable: true, gopUs: 1_000_000 }, status: 'missing'
  }
  const item = { ...createMediaItem(gone, 0, 'video'), durationUs: 1_000_000 }
  return { ...p, assets: [...p.assets, gone], tracks: [{ id: 't_ausente', kind: 'video', name: 'Ausente', muted: false, hidden: false, locked: false, volume: 1, items: [item] }, ...p.tracks] }
}
