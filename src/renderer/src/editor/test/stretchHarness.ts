import type { MediaItem, Project, Track } from '@shared/editor/project'
import { channel, dominantHz, rmsOf, seamRatio } from '@shared/audio/pcmAnalysis'
import { AudioClient } from '../engine/audio/AudioClient'
import { mediaUrlsFor } from '../engine/mediaUrls'

// Time-stretch real (CIALIGHT_TEST=editor-render): o audio worker de verdade (mediabunny + mixer + WASM do
// signalsmith) toca uma senoide de 440 Hz em velocidades com tom preservado, em blocos de 100 ms como o
// PlaybackController. O main valida (editorTestMode.ts).

export const STRETCH_PROJECT_ID = 'p-editor-stretch-test'
const SR = 48000
const BLOCK = 4800
const SRC_IN_US = 1_000_000
const SRC_US = 3_000_000 // trecho da fonte tocado em cada velocidade

export interface StretchRow { speed: number; hz: number; seam: number; rms: number; durationUs: number; audibleUs: number; errors: string[] }
export interface StretchReport { rows?: StretchRow[]; perf?: { tracks: number; audioS: number; coldMs: number; warmMs: number; coldX: number; warmX: number; cpuBefore: number; cpuAfter: number }; error?: string }

/** Um item de áudio da senoide em `speed` a partir de 1 s da fonte, no início da timeline. */
function withSpeeds(base: Project, speeds: number[], srcUs: number): Project {
  const proto = base.tracks[0]
  const item0 = proto.items[0] as MediaItem
  const tracks: Track[] = speeds.map((speed, i) => ({
    ...proto,
    id: `t_s${i}`,
    items: [{ ...item0, id: `i_s${i}`, inUs: SRC_IN_US, speed, durationUs: Math.round(srcUs / speed), audio: { ...item0.audio, preservePitch: true } }]
  }))
  return { ...base, tracks }
}

/** Renderiza [0, toUs) em blocos consecutivos pelo worker. */
async function renderAll(audio: AudioClient, toUs: number): Promise<Float32Array> {
  const frames = Math.round((toUs * SR) / 1e6)
  const out = new Float32Array(frames * 2)
  for (let f = 0; f < frames; f += BLOCK) {
    const b = await audio.render(Math.round((f * 1e6) / SR), Math.min(BLOCK, frames - f))
    if (!b) throw new Error(`bloco ${f} sem resposta`)
    out.set(b.pcm, f * 2)
  }
  return out
}

export async function stretchCheck(): Promise<StretchReport> {
  try {
    const base = await window.api.project.load(STRETCH_PROJECT_ID)
    // desempenho primeiro, com a CPU ainda descansada (ver cpuProbe)
    const perf = await measurePerf(base)
    const rows: StretchRow[] = []
    for (const speed of [0.5, 1.5, 2, 4]) {
      const p = withSpeeds(base, [speed], SRC_US)
      const audio = new AudioClient()
      const errors: string[] = []
      audio.onError((m) => errors.push(m))
      try {
        audio.setProject(p, mediaUrlsFor(p, 'preview'), false)
        const durationUs = (p.tracks[0].items[0] as MediaItem).durationUs
        // 3 blocos além do fim: o som tem de parar no fim do item
        const x = channel(await renderAll(audio, durationUs + 300_000), 0)
        const itemFrames = Math.round((durationUs * SR) / 1e6)
        const seams: number[] = []
        for (let f = BLOCK; f < itemFrames - BLOCK; f += BLOCK) seams.push(f)
        let last = 0
        for (let i = x.length - 1; i >= 0; i--) {
          if (Math.abs(x[i]) > 0.01) {
            last = i + 1
            break
          }
        }
        rows.push({
          speed,
          hz: dominantHz(x, Math.round(itemFrames / 2 - SR / 4), SR / 2, 200, 1000),
          seam: +seamRatio(x, seams, BLOCK, itemFrames - BLOCK).toFixed(2),
          rms: +rmsOf(x, BLOCK, itemFrames - BLOCK).toFixed(3),
          durationUs,
          audibleUs: Math.round((last * 1e6) / SR),
          errors
        })
      } finally {
        audio.dispose()
      }
    }
    return { rows, perf }
  } catch (e) {
    return { error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
  }
}

/**
 * Iterações de um laço fixo de JS por ms: referência da CPU no momento da medida. Nesta máquina a CPU cai ~10×
 * depois de ~2 s de carga contínua (laço puro no Node: 7000 → 600 iterações/s), então a medida de desempenho
 * leva junto a referência antes/depois para separar lentidão do código de estrangulamento da máquina.
 */
function cpuProbe(): number {
  let n = 0
  let x = 0
  const t = performance.now()
  while (performance.now() - t < 20) {
    for (let i = 0; i < 1000; i++) x += Math.sqrt(i + n)
    n++
  }
  return x > 0 ? Math.round(n / 20) : 0
}

/** 4 faixas esticadas ao mesmo tempo (0,5×/1,5×/2×/4×): 1ª passada (decodifica) e 2ª (cache quente), em tempo de áudio por tempo de relógio. */
async function measurePerf(base: Project): Promise<StretchReport['perf']> {
  const p = withSpeeds(base, [0.5, 1.5, 2, 4], 8_000_000)
  const audioS = 2
  const audio = new AudioClient()
  try {
    audio.setProject(p, mediaUrlsFor(p, 'preview'), false)
    const t0 = performance.now()
    await renderAll(audio, audioS * 1e6)
    const coldMs = performance.now() - t0
    const cpuBefore = cpuProbe()
    const t1 = performance.now()
    await renderAll(audio, audioS * 1e6)
    const warmMs = performance.now() - t1
    const cpuAfter = cpuProbe()
    return { tracks: 4, audioS, coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), coldX: +((audioS * 1000) / coldMs).toFixed(1), warmX: +((audioS * 1000) / warmMs).toFixed(1), cpuBefore, cpuAfter }
  } finally {
    audio.dispose()
  }
}
