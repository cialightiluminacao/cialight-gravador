import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Asset, MediaItem, Project, Track } from '@shared/editor/project'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import type { ProjectStore } from './project/projectStore'
import type { SessionStore } from './session/sessionStore'
import { runFfmpeg } from './export/ffmpegRunner'
import { probe } from './media/probe'
import { assetFromInfo } from './media/ingest'
import { loadPage, preloadPath } from './windows/recorderWindow'

// Teste de integração do render do editor (CIALIGHT_TEST=editor-render, `npm run test:editor`).
// Gera testsrc2 + PNG vermelho, registra um projeto temporário no ProjectStore do protocolo de mídia,
// abre uma janela oculta em index.html#editor-test/<id> (só o RenderClient) e valida os pixels.
// Não grava settings.json (o app instalado divide a pasta userData): o teste confere o hash.

const PROJECT_ID = 'p-editor-render-test'
// projeto do passe de efeitos (F2): o harness monta as variantes em memória (mesmos assets)
const EFFECTS_PROJECT_ID = 'p-editor-effects-test'
const SESSION_ID = 'editor-render-test-session'
type Rgba = [number, number, number, number]
type Rendered = { t: 'rendered'; seq: number; tUs: number; ms: number; missing: string[] } | { t: 'error'; message: string }

interface HarnessReport {
  errors: string[]
  first?: Rendered
  pixels?: { circleCenter: Rgba; boxCorner: Rgba; missing: Rgba; corrupt: Rgba; stroke: Rgba; webcam: Rgba }
  rotated?: { frame: Rendered; pillarLeft: Rgba; pillarRight: Rgba; topLeft: Rgba; topRight: Rgba; bottomLeft: Rgba; bottomRight: Rgba }
  rotationDiag?: Record<string, unknown>
  videoMean?: number[]
  sequential?: Rendered[]
  seek?: Rendered
  videoDiff?: number
  burst?: string[]
  effects?: EffectsReport
  watchdog?: { error?: string; before?: number[]; after?: number[]; restartMs?: number; swapped?: boolean; renderedBeforeStall?: number; renderedAfterRestart?: number; playing?: boolean }
  playback?: {
    error?: string; peak?: { l: number; r: number }; frames?: number; driftLastUs?: number | null; driftMaxTailUs?: number | null
    clockAdvanceUs?: number; wallAdvanceUs?: number; playheadUs?: number; playing?: boolean; pausedPlaying?: boolean; audioErrors?: string[]
    seek?: { error?: string; seekToUs?: number; clockAfterUs?: number | null; playing?: boolean; scheduledAfter?: { fromUs: number; startS: number }[]; seekCtxS?: number; badSchedules?: number }
  }
}

type Stats = { n: number; median: number; p95: number; max: number }
interface EffectsReport {
  error?: string
  /** energia de detalhe (média de ΔL² entre vizinhos) na região: original × com efeito */
  blurDetail?: { ref: number; fx: number }
  /** maior diferença por canal fora das regiões (+ feather + 2 px) com efeitos × sem */
  outsideMaxDiff?: number
  pixelate?: { blocks: number; maxDev: number; changedMaxDiff: number; cell: number }
  /** pixelização sobre ruído em movimento: cor de cada bloco × média da fonte no bloco (2 quadros) */
  pixelateMean?: { blocks: number; maxErr: number; maxDev: number; cell: number }
  /** "Borrar tudo menos…" sobre texto fora da região: contraste local e laplaciano saída/fonte por linha de texto */
  invertText?: { boxes: number; byStrength: { strength: number; lines: { c: number; lap: number }[] }[]; centerMaxDiff: number }
  solid?: { pixels: number; wrong: number; sample: number[] }
  ellipse?: { cornerDiff: number; centerDetail: { ref: number; fx: number } }
  invert?: { centerMaxDiff: number; cornerDetail: { ref: number; fx: number } }
  halfOutside?: { detail: { ref: number; fx: number }; edgeMean: number; refBandMean: number; outsideMaxDiff: number }
  keyframe?: { centroidX: number; centroidX1s: number; maskPixels: number }
  track?: { insideLayer: number[]; outsideLayerDiff: number }
  trackGap?: { maxDiff: number; hiddenSkipped: number[] }
  invertFeather?: { featherPx: number; justOutsideDiff: number; justOutsideVsRef: number; centerMaxDiff: number }
  featherTail?: { rectRing: number; ellipseRing: number; outsideMaxDiff: number; changed: number[] }
  realloc?: { maxDiff: number }
  bench?: { renderer?: string; noFx: Stats; fx3: Stats; fx3Frame: Stats; error?: string }
}

function check(cond: boolean, msg: string, failures: string[]): void {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'OK ' : 'FAIL'} ${msg}`)
}

function settingsHash(): string | null {
  const f = join(app.getPath('userData'), 'settings.json')
  return existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex') : null
}

const isRed = (p: Rgba | undefined): boolean => !!p && p[0] > 200 && p[1] < 40 && p[2] < 40
// xadrez do placeholder: cinza neutro (0,33 / 0,45 → ~84 / ~115)
const isGray = (p: Rgba | undefined): boolean => !!p && Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 4 && p[0] >= 70 && p[0] <= 130

function track(id: string, name: string, item: MediaItem): Track {
  return { id, kind: 'video', name, muted: false, hidden: false, locked: false, volume: 1, items: [item] }
}

function placed(asset: Asset, cx: number, cy: number, scale: number, shape?: 'circle'): MediaItem {
  const it = { ...createMediaItem(asset, 0, 'video'), durationUs: 3_000_000 }
  const v = it.visual!
  return { ...it, visual: { ...v, transform: { ...v.transform, x: { value: cx }, y: { value: cy }, scale: { value: scale } }, ...(shape ? { shape } : {}) } }
}

export async function testEditorRender(projects: ProjectStore, sessions: SessionStore, outDir: string): Promise<number> {
  const failures: string[] = []
  const hashBefore = settingsHash()
  const dir = join(outDir, 'editor-render')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const video = join(dir, 'testsrc2.mp4')
  const red = join(dir, 'vermelho.png')
  const corrupt = join(dir, 'corrompido.mp4')
  const quadRaw = join(dir, 'quadrante.mp4')
  const rotated = join(dir, 'quadrante-girado.mp4')
  const avTracks = join(dir, 'audio-multifaixa.mp4')
  const gen = (args: string[], label: string): Promise<unknown> => runFfmpeg(['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats'], { label })
  await gen(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', video], 'editor: testsrc2')
  await gen(['-f', 'lavfi', '-i', 'color=c=red:s=256x256', '-frames:v', '1', '-update', '1', red], 'editor: vermelho')
  // 1920×1080 azul com o quadrante superior esquerdo vermelho; depois giro horário de 90° só nos metadados
  // (displaymatrix −90, como vídeo de celular — mesmo método da Task 6): exibido em pé 1080×1920 com o
  // vermelho no quadrante superior DIREITO.
  await gen(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30,drawbox=x=0:y=0:w=960:h=540:color=red:t=fill', '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', quadRaw], 'editor: quadrante')
  await gen(['-display_rotation', '-90', '-i', quadRaw, '-c', 'copy', rotated], 'editor: quadrante girado')
  // vídeo + 2 faixas de áudio: a:0 silêncio, a:1 senoide 1 kHz amplitude 0,5 (mono) — como o rec.mp4 multi-faixa
  await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000,volume=4', '-t', '4', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', avTracks], 'editor: áudio multi-faixa')
  writeFileSync(corrupt, Buffer.alloc(64 * 1024, 0x5a)) // não é MP4: o decoder falha
  // sessão mínima com um traço verde horizontal (anotações v1 via cialight-file://<sessionId>/session.json)
  const sdir = sessions.dirOf(SESSION_ID)
  rmSync(sdir, { recursive: true, force: true })
  mkdirSync(sdir, { recursive: true })
  const stroke = { id: 's1', tMs: 0, tool: 'line', color: '#00ff00', width: 40, points: [{ x: 0.5, y: 0.3, tMs: 0 }, { x: 0.6, y: 0.3, tMs: 0 }] }
  writeFileSync(join(sdir, 'session.json'), JSON.stringify({ id: SESSION_ID, strokes: [stroke], clearEvents: [] }))
  // rec.mp4 da sessão com duas faixas de vídeo, como a gravação v1: v:0 tela (azul) e v:1 webcam (vermelho)
  await gen(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30', '-t', '3', '-map', '0:v', '-map', '1:v', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', join(sdir, 'rec.mp4')], 'editor: rec.mp4 multi-faixa')

  const iVideo = await probe(video)
  const iRed = await probe(red)
  const iRot = await probe(rotated)
  check(iRot.video?.rotation === 90 && iRot.video?.width === 1920 && iRot.video?.height === 1080, `fixture girada: probe 1920×1080 rotation 90 (${iRot.video?.width}×${iRot.video?.height} r${iRot.video?.rotation})`, failures)
  const aRot: Asset = { ...assetFromInfo('a_rot', rotated, statSync(rotated), iRot), status: 'ready' }
  const aVideo: Asset = { ...assetFromInfo('a_video', video, statSync(video), iVideo), status: 'ready' }
  const aRed = assetFromInfo('a_red', red, statSync(red), iRed)
  // webcam de sessão: rec.mp4 (protocolo de mídia → sessions.filePath), faixa v:1
  const aCam: Asset = {
    id: 'a_cam', name: 'Webcam', kind: 'video', source: { type: 'session', sessionId: SESSION_ID, stream: 'webcam' }, durationUs: 3_000_000,
    video: { width: 320, height: 240, fps: 30, codec: 'h264', rotation: 0, decodable: true, gopUs: 500_000 }, status: 'ready', videoTrackIndex: 1
  }
  const aAv: Asset = { ...assetFromInfo('a_av', avTracks, statSync(avTracks), await probe(avTracks)), status: 'ready', audioTrackIndex: 1 }
  const aMissing: Asset = { ...aVideo, id: 'a_missing', name: 'nao-existe.mp4', source: { type: 'file', path: join(dir, 'nao-existe.mp4'), size: 1, mtimeMs: 0 } }
  const aCorrupt: Asset = { ...aVideo, id: 'a_corrupt', name: 'corrompido.mp4', source: { type: 'file', path: corrupt, size: statSync(corrupt).size, mtimeMs: Math.round(statSync(corrupt).mtimeMs) } }

  const base = createEmptyProject('Teste de render', { width: 1920, height: 1080, fps: 30, background: '#000000' })
  const project: Project = {
    ...base,
    id: PROJECT_ID,
    assets: [aVideo, aRed, aMissing, aCorrupt, aRot, aAv, aCam],
    tracks: [
      track('t_video', 'Vídeo', { ...createMediaItem(aVideo, 0, 'video'), durationUs: 3_000_000 }),
      track('t_red', 'Vermelho', placed(aRed, 0.875, 0.125, 0.25, 'circle')),
      track('t_missing', 'Ausente', placed(aMissing, 0.125, 0.875, 0.25)),
      track('t_corrupt', 'Corrompido', placed(aCorrupt, 0.375, 0.875, 0.25)),
      // mesmo asset do fundo numa 2ª camada simultânea (outro ponto da fonte): slot de decoder próprio
      track('t_dup', 'Duplicado', { ...placed(aVideo, 0.625, 0.875, 0.25), inUs: 1_500_000, durationUs: 1_500_000 }),
      track('t_cam', 'Webcam', placed(aCam, 0.875, 0.875, 0.25)),
      track('t_rot', 'Girado', { ...placed(aRot, 0.5, 0.5, 1), startUs: 3_000_000, durationUs: 2_000_000 }),
      { id: 't_audio', kind: 'audio', name: 'Áudio', muted: false, hidden: false, locked: false, volume: 1, items: [{ ...createMediaItem(aAv, 0, 'audio'), durationUs: 3_500_000 }] },
      { id: 't_ann', kind: 'video', name: 'Anotações', muted: false, hidden: false, locked: false, volume: 1, items: [{ id: 'i_ann', type: 'annotations', sessionId: SESSION_ID, inUs: 0, startUs: 0, durationUs: 3_000_000 }] }
    ]
  }
  rmSync(projects.dirOf(PROJECT_ID), { recursive: true, force: true })
  projects.create(project)

  // efeitos (F2): testsrc2 1080p + imagem de ruído (quadro estático com detalhe em todo pixel, para o centro
  // de massa da área borrada) + PNG vermelho (escopo `track`)
  const noise = join(dir, 'ruido.png')
  await gen(['-f', 'lavfi', '-i', 'nullsrc=s=1920x1080,format=gray,geq=lum=random(1)*255', '-frames:v', '1', '-update', '1', noise], 'editor: ruído')
  const aNoise = assetFromInfo('a_noise', noise, statSync(noise), await probe(noise))
  // texto branco de ~47 px de altura (Consolas 72) fora da faixa central: legibilidade com "Borrar tudo menos…"
  const textPng = join(dir, 'texto.png')
  const font = "fontfile='C\\:/Windows/Fonts/consola.ttf'"
  const line = (text: string, x: number, y: number): string => `drawtext=${font}:text='${text}':fontsize=72:fontcolor=white:x=${x}:y=${y}`
  await gen(['-f', 'lavfi', '-i', 'color=c=0x1e293b:s=1920x1080', '-vf', `${line('CPF 123.456.789-00', 200, 200)},${line('Senha 4821', 1100, 820)}`, '-frames:v', '1', '-update', '1', textPng], 'editor: texto')
  const aText = assetFromInfo('a_text', textPng, statSync(textPng), await probe(textPng))
  const fxBase = createEmptyProject('Teste de efeitos', { width: 1920, height: 1080, fps: 30, background: '#000000' })
  const fxProject: Project = {
    ...fxBase,
    id: EFFECTS_PROJECT_ID,
    assets: [aVideo, aNoise, aRed, aText],
    tracks: [track('t_video', 'Vídeo', { ...createMediaItem(aVideo, 0, 'video'), durationUs: 3_000_000 })]
  }
  rmSync(projects.dirOf(EFFECTS_PROJECT_ID), { recursive: true, force: true })
  projects.create(fxProject)

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=recorder'] } })
  const result = await new Promise<{ ok: boolean; report: HarnessReport }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, report: { errors: ['timeout de 120 s'] } }), 120_000)
    ipcMain.once('test:result', (_e, r: { ok: boolean; report: HarnessReport }) => {
      clearTimeout(timer)
      resolve(r)
    })
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer] ${e.message}`)
    })
    loadPage(win, `index.html#editor-test/${PROJECT_ID}`)
  })
  win.destroy()

  const r = result.report
  check(result.ok && r.errors.length === 0, `harness sem exceção nem erro do worker (${JSON.stringify(r.errors)})`, failures)
  const first = r.first
  check(first?.t === 'rendered', `quadro em t=1 s renderizado (${JSON.stringify(first)})`, failures)
  if (first?.t === 'rendered') {
    check(first.missing.length === 2 && first.missing.includes('a_missing') && first.missing.includes('a_corrupt'), `missing = ausente + corrompido (${first.missing.join(', ')})`, failures)
  }
  const px = r.pixels
  check(isRed(px?.circleCenter), `centro do círculo vermelho (${px?.circleCenter})`, failures)
  check(!!px && !isRed(px.boxCorner), `canto da caixa fora do círculo não é vermelho (${px?.boxCorner})`, failures)
  check(isGray(px?.missing), `asset ausente → placeholder cinza (${px?.missing})`, failures)
  check(isGray(px?.corrupt), `asset corrompido → placeholder cinza (${px?.corrupt})`, failures)
  check(isRed(px?.webcam), `webcam da sessão (rec.mp4 v:1 vermelho, v:0 azul) desenhada da faixa v:1 (${px?.webcam})`, failures)
  const st = px?.stroke
  check(!!st && st[1] > 200 && st[0] < 40 && st[2] < 40, `anotação (traço verde) desenhada sobre o vídeo (${st})`, failures)
  check(!!r.videoMean && r.videoMean.some((c) => c > 20), `vídeo desenhado no centro (média ${r.videoMean})`, failures)
  check(!!r.sequential && r.sequential.length === 5 && r.sequential.every((s) => s.t === 'rendered'), `reprodução sequencial: 5 quadros (${r.sequential?.map((s) => (s.t === 'rendered' ? `${s.ms.toFixed(1)} ms` : s.message)).join(', ')})`, failures)
  check(r.seek?.t === 'rendered', `seek para 2,5 s (${JSON.stringify(r.seek)})`, failures)
  check((r.videoDiff ?? 0) > 2, `quadro em 2,5 s difere do de 1 s (diferença média ${r.videoDiff?.toFixed(1)})`, failures)
  const ro = r.rotated
  const isBlack = (p: Rgba | undefined): boolean => !!p && p[0] < 16 && p[1] < 16 && p[2] < 16
  const isBlue = (p: Rgba | undefined): boolean => !!p && p[2] > 200 && p[0] < 40 && p[1] < 40
  console.log(`diagnóstico de rotação (mediabunny/VideoFrame): ${JSON.stringify(r.rotationDiag)}`)
  check(ro?.frame.t === 'rendered', `girado: quadro em 4 s renderizado (${JSON.stringify(ro?.frame)})`, failures)
  check(isBlack(ro?.pillarLeft) && isBlack(ro?.pillarRight), `girado: em pé com pillarbox de fundo (${ro?.pillarLeft} | ${ro?.pillarRight})`, failures)
  check(isRed(ro?.topRight), `girado: vermelho no quadrante superior direito (${ro?.topRight})`, failures)
  check(isBlue(ro?.topLeft) && isBlue(ro?.bottomLeft) && isBlue(ro?.bottomRight), `girado: azul nos outros quadrantes (${ro?.topLeft} | ${ro?.bottomLeft} | ${ro?.bottomRight})`, failures)
  check(!!r.burst && r.burst.length === 5 && r.burst.every((t) => t === 'rendered'), `rajada de 5 pedidos resolvida (${r.burst?.join(', ')})`, failures)
  const pb = r.playback
  const frameUs = 1e6 / 30
  console.log(`reprodução: ${JSON.stringify(pb)}`)
  check(!!pb && !pb.error && (pb.audioErrors?.length ?? 0) === 0, `reprodução de 2 s sem erro (${pb?.error ?? ''} ${JSON.stringify(pb?.audioErrors ?? [])})`, failures)
  check(!!pb?.peak && pb.peak.l > 0.1 && pb.peak.r > 0.1, `nível de áudio (VU) > 0,1 com a faixa a:1 (${JSON.stringify(pb?.peak)})`, failures)
  check((pb?.frames ?? 0) > 20, `quadros renderizados durante a reprodução (${pb?.frames})`, failures)
  check(pb?.driftMaxTailUs != null && pb.driftMaxTailUs < frameUs, `deriva vídeo × relógio do áudio < 1 quadro ao fim (máx. dos últimos 10: ${pb?.driftMaxTailUs} µs)`, failures)
  check(pb?.clockAdvanceUs != null && pb.wallAdvanceUs != null && Math.abs(pb.clockAdvanceUs - pb.wallAdvanceUs) < frameUs, `relógio do áudio acompanha o tempo real em 2 s (${pb?.clockAdvanceUs} × ${pb?.wallAdvanceUs} µs)`, failures)
  check(pb?.playing === true && pb.pausedPlaying === false && (pb.playheadUs ?? 0) > 2_300_000, `store: playing durante, false após pause; playhead avançou (${pb?.playheadUs})`, failures)
  const sk = pb?.seek
  console.log(`seek durante a reprodução: ${JSON.stringify(sk)}`)
  check(!!sk && !sk.error && sk.playing === true && sk.clockAfterUs != null && sk.seekToUs != null && sk.clockAfterUs >= sk.seekToUs && sk.clockAfterUs < sk.seekToUs + 700_000, `seek tocando: relógio continua do novo ponto (${sk?.clockAfterUs} a partir de ${sk?.seekToUs}) ${sk?.error ?? ''}`, failures)
  check(!!sk && (sk.scheduledAfter?.length ?? 0) > 0 && sk.badSchedules === 0, `seek tocando: nenhum nó do ponto antigo agendado depois do seek (${sk?.scheduledAfter?.length} agendados, ${sk?.badSchedules} inválidos)`, failures)
  const fx = r.effects
  console.log(`efeitos: ${JSON.stringify(fx)}`)
  check(!!fx && !fx.error, `efeitos: harness sem erro (${fx?.error ?? ''})`, failures)
  const bl = fx?.blurDetail
  check(!!bl && bl.ref > 0 && bl.fx < 0.15 * bl.ref, `blur: energia de detalhe (ΔL²) na região < 15 % da original (${bl?.fx.toFixed(1)} de ${bl?.ref.toFixed(1)})`, failures)
  check(fx?.outsideMaxDiff !== undefined && fx.outsideMaxDiff <= 2, `fora das regiões + feather: idêntico ao quadro sem efeito (diferença máx. ${fx?.outsideMaxDiff})`, failures)
  const pz = fx?.pixelate
  check(!!pz && pz.blocks >= 20 && pz.maxDev <= 3 && pz.changedMaxDiff > 50, `pixelização: blocos uniformes (${pz?.blocks} blocos de ${pz?.cell?.toFixed(1)} px, desvio máx. ${pz?.maxDev}; região alterada, dif. máx. ${pz?.changedMaxDiff})`, failures)
  const pm = fx?.pixelateMean
  check(!!pm && pm.blocks >= 20 && pm.maxErr <= 2 && pm.maxDev <= 3, `pixelização = média do bloco (ruído em movimento, 2 quadros): ${pm?.blocks} blocos de ${pm?.cell?.toFixed(1)} px, erro máx. ${pm?.maxErr} da média da fonte (±2), desvio interno ${pm?.maxDev}`, failures)
  const itx = fx?.invertText
  const legible = (s: number): { c: number; lap: number }[] | undefined => itx?.byStrength.find((b) => b.strength === s)?.lines
  console.log(`invertido sobre texto (contraste local / laplaciano, saída ÷ fonte): ${JSON.stringify(itx?.byStrength)}`)
  for (const s of [80, 50]) {
    const ls = legible(s)
    check(!!ls && ls.length === 2 && ls.every((l) => l.c < 0.15 && l.lap < 0.2), `"Borrar tudo menos…" a ${s}${s === 80 ? ' (preset)' : ' (piso do aviso)'}: texto de 47 px fora da região ilegível (contraste ${ls?.map((l) => l.c.toFixed(3))} < 0,15; laplaciano ${ls?.map((l) => l.lap.toFixed(4))} < 0,2)`, failures)
  }
  check(!!itx && itx.centerMaxDiff <= 2, `"Borrar tudo menos…": miolo da região intocado (dif. ${itx?.centerMaxDiff})`, failures)
  const so = fx?.solid
  check(!!so && so.pixels > 10_000 && so.wrong === 0, `tarja #123456 feather 0: todos os pixels da região exatos (${so?.wrong} errados de ${so?.pixels}; amostra ${so?.sample})`, failures)
  const el = fx?.ellipse
  check(!!el && el.cornerDiff <= 2 && el.centerDetail.fx < 0.15 * el.centerDetail.ref, `elipse rotacionada 30°: canto da caixa fora da elipse inalterado (dif. ${el?.cornerDiff}), centro borrado (${el?.centerDetail.fx.toFixed(1)} de ${el?.centerDetail.ref.toFixed(1)})`, failures)
  const iv = fx?.invert
  check(!!iv && iv.centerMaxDiff <= 2 && iv.cornerDetail.fx < 0.15 * iv.cornerDetail.ref, `invertido: centro inalterado (dif. ${iv?.centerMaxDiff}), canto borrado (${iv?.cornerDetail.fx.toFixed(1)} de ${iv?.cornerDetail.ref.toFixed(1)})`, failures)
  const ho = fx?.halfOutside
  check(!!ho && ho.detail.fx < 0.15 * ho.detail.ref && Math.abs(ho.edgeMean - ho.refBandMean) < 20 && ho.outsideMaxDiff <= 2, `região meio fora do quadro: parte visível borrada (${ho?.detail.fx.toFixed(1)} de ${ho?.detail.ref.toFixed(1)}), borda sem artefato (luma ${ho?.edgeMean.toFixed(1)} × ${ho?.refBandMean.toFixed(1)}), fora inalterado (${ho?.outsideMaxDiff})`, failures)
  const kf = fx?.keyframe
  check(!!kf && Math.abs(kf.centroidX - 0.5) <= 0.02 && kf.maskPixels > 10_000, `keyframe region.x 0,2→0,8 (1–3 s): centro de massa em 2 s = ${kf?.centroidX.toFixed(3)} (±0,02 de 0,5; em 1 s ${kf?.centroidX1s.toFixed(3)})`, failures)
  const tk = fx?.track
  const isTarja = (p: number[] | undefined): boolean => !!p && p[0] === 0x12 && p[1] === 0x34 && p[2] === 0x56
  check(isTarja(tk?.insideLayer) && tk!.outsideLayerDiff <= 2, `escopo track: só a camada logo abaixo recebe a tarja (${tk?.insideLayer}; vídeo fora da camada inalterado, dif. ${tk?.outsideLayerDiff})`, failures)
  const tg = fx?.trackGap
  check(!!tg && tg.maxDiff === 0, `escopo track sobre lacuna (faixa logo abaixo sem item): quadro inalterado (dif. máx. ${tg?.maxDiff})`, failures)
  check(isTarja(tg?.hiddenSkipped), `escopo track com faixa oculta no meio: pega a camada da faixa visível logo abaixo (${tg?.hiddenSkipped})`, failures)
  const ivf = fx?.invertFeather
  check(!!ivf && ivf.justOutsideDiff <= 1 && ivf.centerMaxDiff === 0, `invertido + feather (${ivf?.featherPx.toFixed(1)} px para dentro): logo fora da região = blur inteiro (dif. ${ivf?.justOutsideDiff} do invertido sem feather; ${ivf?.justOutsideVsRef} do original), miolo intocado (dif. ${ivf?.centerMaxDiff})`, failures)
  const ft = fx?.featherTail
  check(!!ft && ft.rectRing <= 2 && ft.ellipseRing <= 2 && ft.outsideMaxDiff === 0 && ft.changed.every((d) => d > 30), `feather sem corte no scissor: retângulo 30° e elipse excêntrica 25° com feather — borda da caixa = original (dif. ${ft?.rectRing} / ${ft?.ellipseRing}), fora = original (${ft?.outsideMaxDiff}), efeito aplicado dentro (dif. máx. ${ft?.changed})`, failures)
  check(fx?.realloc?.maxDiff === 0, `FBOs liberados após 120 quadros sem efeito e realocados: mesmo quadro (dif. ${fx?.realloc?.maxDiff})`, failures)
  const bn = fx?.bench
  console.log(`desempenho (${bn?.renderer}): sem efeito ${JSON.stringify(bn?.noFx)} ms; 3 blurs fortes ${JSON.stringify(bn?.fx3)} ms (quadro inteiro ${JSON.stringify(bn?.fx3Frame)})`)
  check(!!bn && !bn.error && bn.fx3.n > 0 && bn.fx3.median < 12, `desempenho: 1080p com 3 blurs fortes < 12 ms/quadro (compositor + GPU: mediana ${bn?.fx3.median} ms, p95 ${bn?.fx3.p95} ms) ${bn?.error ?? ''}`, failures)

  const wd = r.watchdog
  console.log(`watchdog: ${JSON.stringify(wd)}`)
  const wdBefore = wd?.before as Rgba | undefined
  const wdAfter = wd?.after as Rgba | undefined
  check(!!wd && !wd.error && (wd.renderedBeforeStall ?? 0) > 0 && wd.swapped === true && (wd.restartMs ?? Infinity) < 3500, `watchdog: worker travado tocando → reiniciado num canvas novo (${wd?.restartMs} ms, prazo 1,5 s) ${wd?.error ?? ''}`, failures)
  check(!!wd && (wd.renderedAfterRestart ?? 0) > 0 && wd.playing === true, `watchdog: a reprodução continua recebendo quadros do worker novo (${wd?.renderedAfterRestart})`, failures)
  check(isRed(wdBefore) && isRed(wdAfter), `watchdog: projeto restaurado — mesmo quadro em 1 s antes e depois (${wdBefore} → ${wdAfter})`, failures)
  check(settingsHash() === hashBefore, 'settings.json do usuário intocado', failures)

  writeFileSync(join(outDir, 'editor-render-report.json'), JSON.stringify({ result, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DE RENDER DO EDITOR PASSOU')
  return failures.length ? 1 : 0
}
