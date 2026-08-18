import { existsSync } from 'fs'
import { join } from 'path'
import type { Session } from '@shared/types'
import { runFfmpeg } from './ffmpegRunner'
import { log } from '../log'

// Sessões gravadas pelo fallback (MediaRecorder por faixa) chegam como vários
// arquivos. Antes de revisar/exportar, remuxamos tudo em rec.mp4 com a mesma
// ordem de faixas do caminho principal (v0 tela, v1 webcam, a0 mic, a1 sistema)
// para o restante do pipeline não precisar de casos especiais.

export async function normalizeFallbackSession(session: Session, dir: string): Promise<Session> {
  const fb = session.files.fallback
  if (!fb) return session
  const rec = join(dir, 'rec.mp4')
  if (existsSync(rec) && session.files.rec === 'rec.mp4' && session.tracks.screen === 0 && !fb) return session
  const inputs: string[] = [join(dir, fb.screen)]
  const maps: string[] = ['-map', '0:v:0']
  const tracks: Session['tracks'] = { screen: 0 }
  let vIdx = 1
  let aIdx = 0
  if (fb.webcam && existsSync(join(dir, fb.webcam))) {
    inputs.push(join(dir, fb.webcam))
    maps.push('-map', `${inputs.length - 1}:v:0`)
    tracks.webcam = 1
    vIdx++
  }
  if (fb.mic && existsSync(join(dir, fb.mic))) {
    inputs.push(join(dir, fb.mic))
    maps.push('-map', `${inputs.length - 1}:a:0`)
    tracks.mic = aIdx as 0 | 1
    aIdx++
  }
  if (fb.system && existsSync(join(dir, fb.system))) {
    inputs.push(join(dir, fb.system))
    maps.push('-map', `${inputs.length - 1}:a:0`)
    tracks.system = aIdx as 0 | 1
    aIdx++
  }
  void vIdx
  const args = ['-hide_banner', '-nostdin', '-y']
  for (const i of inputs) args.push('-i', i)
  args.push(...maps, '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', rec)
  log.info(`remux do fallback para rec.mp4 (${inputs.length} arquivos)`)
  await runFfmpeg(args, { label: 'fallback-remux' })
  return { ...session, tracks, files: { ...session.files, rec: 'rec.mp4', fallback: undefined } }
}
