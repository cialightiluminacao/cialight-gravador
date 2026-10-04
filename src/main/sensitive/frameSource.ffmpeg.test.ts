// Regressão REAL (ffmpeg empacotado, sem OCR; ~1 s): o quadro k entregue pelo frameSource é o que o editor mostra em
// fromUs + k·passo — o último quadro da origem com pts ≤ esse instante, em tempo ABSOLUTO do arquivo (o do mediabunny,
// que o editor e a exportação usam). Fontes sintéticas com o número do quadro gravado no nível de cinza:
//  - mp4 cuja faixa v:0 começa tarde (0,067 s, como a tela do rec.mp4 do app) e v:1 em 0;
//  - .ts com start_time 1,4 s (o -ss do ffmpeg é relativo ao start_time; o mediabunny usa o pts absoluto).
// Sem o ffmpeg baixado (resources/ffmpeg não é versionado) o bloco é pulado.
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { sampleFrames, subFrames, type FrameStream, type RawFrame } from './frameSource'

const ROOT = resolve(__dirname, '../../..')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const OUT = join(ROOT, 'test-out', 'g3-frametime')
const MP4 = join(OUT, 'late-v0.mp4')
const TS = join(OUT, 'start14.ts')
const SIZE = 16
// nível de cinza do quadro N da origem: 20 + 3·N (a conversão gray→yuv420p erra ±1; o passo 3 separa os quadros)
const indexOf = (gray: number): number => Math.round((gray - 20) / 3)

const has = existsSync(FFMPEG) && existsSync(FFPROBE)

/** pts (µs, absolutos) dos quadros da faixa de vídeo `stream`. */
function framePtsUs(file: string, stream: number): number[] {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', `v:${stream}`, '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true })
  return out.split(/\r?\n/).map((l) => l.trim().replace(/,$/, '')).filter(Boolean).map((s) => Math.round(Number(s) * 1_000_000))
}

/** Índice do quadro que o editor mostra em t: o último com pts ≤ t (antes do primeiro: o primeiro). */
function shownAt(pts: number[], tUs: number): number {
  let i = 0
  while (i + 1 < pts.length && pts[i + 1] <= tUs) i++
  return i
}

const mean = (f: RawFrame): number => {
  let s = 0
  for (const v of f.data) s += v
  return s / f.data.length
}

async function collect(st: FrameStream): Promise<RawFrame[]> {
  const out: RawFrame[] = []
  for await (const f of st.frames) out.push(f)
  await st.done
  return out
}

/** Cada quadro entregue tem o conteúdo do quadro da origem visível no seu tUs (e os tUs seguem a grade). */
function expectAligned(frames: RawFrame[], pts: number[], fromUs: number, stepUs: number, count: number): void {
  expect(frames.map((f) => f.tUs)).toEqual(Array.from({ length: count }, (_, k) => Math.round(fromUs + k * stepUs)))
  const got = frames.map((f) => indexOf(mean(f)))
  const want = frames.map((f) => shownAt(pts, f.tUs))
  expect(got).toEqual(want)
}

describe.skipIf(!has)('frameSource com ffmpeg real: conteúdo do quadro k = origem em fromUs + k·passo', () => {
  let mp4Pts: number[] = []
  let tsPts: number[] = []
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
    const src = `color=black:s=${SIZE}x${SIZE}:r=30:d=3,format=gray,geq=lum='20+3*N'`
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-itsoffset', '0.0666667', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `color=gray:s=${SIZE}x${SIZE}:r=30:d=3.2`,
      '-map', '0:v', '-map', '1:v', '-c:v', 'libx264', '-qp', '0', '-bf', '0', '-pix_fmt', 'yuv420p', MP4], { windowsHide: true })
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-qp', '0', '-bf', '0', '-g', '15', '-pix_fmt', 'yuv420p', TS], { windowsHide: true })
    mp4Pts = framePtsUs(MP4, 0)
    tsPts = framePtsUs(TS, 0)
    // pré-condições da fonte: a v:0 do mp4 começa tarde; o .ts começa em 1,4 s
    expect(mp4Pts[0]).toBeGreaterThan(50_000)
    expect(tsPts[0]).toBeGreaterThan(1_000_000)
  }, 60_000)

  const sample = (file: string, fromUs: number, toUs: number, fps = 2): FrameStream =>
    sampleFrames({ ffmpeg: FFMPEG, file, fromUs, toUs, sourceW: SIZE, sourceH: SIZE, fps, upscale: 1 })
  const sub = (file: string, fromUs: number, toUs: number, fps = 10): FrameStream =>
    subFrames({ ffmpeg: FFMPEG, file, fromUs, toUs, w: 8, h: 8, fps })

  it('amostragem desde 0 numa faixa que começa em 0,067 s (rec.mp4 do app)', async () => {
    const f = await collect(sample(MP4, 0, 2_500_000))
    expectAligned(f, mp4Pts, 0, 500_000, 5)
  })

  it('amostragem com fromUs fora da grade de quadros (clipe aparado, inUs 33333)', async () => {
    expectAligned(await collect(sample(MP4, 33_333, 2_033_333)), mp4Pts, 33_333, 500_000, 4)
    expectAligned(await collect(sample(MP4, 1_050_000, 2_950_000)), mp4Pts, 1_050_000, 500_000, 4)
  })

  it('sub-quadros do refinamento (10 qps, [from, to] inclusivo) fora da grade', async () => {
    expectAligned(await collect(sub(MP4, 1_050_000, 1_950_000)), mp4Pts, 1_050_000, 100_000, 10)
    expectAligned(await collect(sub(MP4, 1_033_333, 1_433_333)), mp4Pts, 1_033_333, 100_000, 5)
  })

  it('faixa v:1 (webcam, começa em 0) continua no tempo dela', async () => {
    const st = sampleFrames({ ffmpeg: FFMPEG, file: MP4, fromUs: 1_000_000, toUs: 2_000_000, sourceW: SIZE, sourceH: SIZE, fps: 2, upscale: 1, stream: 1 })
    const f = await collect(st)
    expect(f.map((x) => x.tUs)).toEqual([1_000_000, 1_500_000])
  })

  it('.ts com start_time 1,4 s: os tempos são absolutos (os do mediabunny/editor)', async () => {
    expectAligned(await collect(sample(TS, 2_050_000, 3_950_000)), tsPts, 2_050_000, 500_000, 4)
    expectAligned(await collect(sub(TS, 1_433_333, 1_733_333)), tsPts, 1_433_333, 100_000, 4)
    // antes do primeiro quadro: o editor mostra o primeiro
    expectAligned(await collect(sample(TS, 0, 2_000_000)), tsPts, 0, 500_000, 4)
  })
})
