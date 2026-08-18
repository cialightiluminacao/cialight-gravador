import { existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ReviewAssets } from '@shared/ipc'
import type { Session } from '@shared/types'
import { probeFile, probeKeyframes, runFfmpeg } from './ffmpegRunner'
import { log } from '../log'

// Assets da tela de Revisão: proxy (v0 copiado + áudio mixado, faststart) que o
// <video> consegue tocar/seekar; webcam.mp4 (v1 copiado); tira de miniaturas;
// forma de onda; keyframes (para o corte "rápido").

export function audioMixFilter(micIdx: number | null, sysIdx: number | null, inputIdx = 0): { filter: string | null; map: string[] } {
  if (micIdx !== null && sysIdx !== null) {
    return {
      filter: `[${inputIdx}:a:${micIdx}][${inputIdx}:a:${sysIdx}]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]`,
      map: ['-map', '[a]']
    }
  }
  if (micIdx !== null) return { filter: null, map: ['-map', `${inputIdx}:a:${micIdx}`] }
  if (sysIdx !== null) return { filter: null, map: ['-map', `${inputIdx}:a:${sysIdx}`] }
  return { filter: null, map: [] }
}

export async function buildReviewAssets(session: Session, dir: string, onProgress?: (pct: number) => void): Promise<ReviewAssets> {
  const rec = join(dir, session.files.rec)
  const probe = await probeFile(rec)
  const durationMs = session.durationMs ?? probe.durationMs
  const micIdx = session.tracks.mic ?? null
  const sysIdx = session.tracks.system ?? null
  const hasWebcam = session.tracks.webcam !== undefined && probe.streams.filter((s) => s.type === 'video').length > 1

  // 1) proxy
  const proxy = join(dir, 'preview.mp4')
  const mix = audioMixFilter(micIdx, sysIdx)
  const proxyArgs = ['-hide_banner', '-nostdin', '-y', '-i', rec, '-map', '0:v:0']
  if (mix.filter) proxyArgs.push('-filter_complex', mix.filter)
  proxyArgs.push(...mix.map)
  proxyArgs.push('-c:v', 'copy')
  if (mix.map.length) proxyArgs.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  proxyArgs.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', proxy)
  await runFfmpeg(proxyArgs, { label: 'proxy', onProgress: (p) => onProgress?.(Math.min(45, (p.outTimeUs / 1000 / Math.max(1, durationMs)) * 45)) })
  onProgress?.(45)

  // 2) webcam
  let webcam: string | null = null
  if (hasWebcam) {
    webcam = join(dir, 'webcam.mp4')
    await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', rec, '-map', '0:v:1', '-c:v', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', webcam], { label: 'webcam-proxy' })
  }
  onProgress?.(60)

  // 3) miniaturas (≈ 40 ao longo do vídeo, altura 90)
  const thumbsDir = join(dir, 'thumbs')
  mkdirSync(thumbsDir, { recursive: true })
  const every = Math.max(1, durationMs / 1000 / 40)
  try {
    await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', proxy, '-map', '0:v:0', '-vf', `fps=1/${every.toFixed(3)},scale=-2:90`, '-q:v', '4', '-f', 'image2', '-progress', 'pipe:1', '-nostats', join(thumbsDir, '%03d.jpg')], { label: 'thumbs' })
  } catch (e) {
    log.warn('miniaturas falharam', e)
  }
  const thumbs = existsSync(thumbsDir)
    ? readdirSync(thumbsDir)
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .map((f) => join(thumbsDir, f))
    : []
  onProgress?.(80)

  // 4) forma de onda
  let waveform: string | null = null
  if (mix.map.length) {
    waveform = join(dir, 'wave.png')
    try {
      await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', proxy, '-filter_complex', 'showwavespic=s=1600x120:colors=#8b90a0', '-frames:v', '1', '-progress', 'pipe:1', '-nostats', waveform], { label: 'waveform' })
    } catch (e) {
      log.warn('forma de onda falhou', e)
      waveform = null
    }
  }
  onProgress?.(90)

  // 5) keyframes
  const keyframesSec = await probeKeyframes(rec)
  onProgress?.(100)
  return { proxy, webcam, thumbs, waveform, keyframesSec, durationMs }
}
