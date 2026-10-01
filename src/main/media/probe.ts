import { execFile } from 'child_process'
import { extname } from 'path'
import type { AssetAudioInfo, AssetKind, AssetVideoInfo } from '@shared/editor/project'
import { ffprobePath } from '../export/ffmpegPath'
import { FfmpegError } from '../export/ffmpegRunner'

// Ingestão: ffprobe → MediaInfo. `parseFfprobe` é puro (testável com JSON de fixture);
// `probe` roda o ffprobe embutido e completa o GOP médio com `probeGopUs`.

export interface MediaInfo {
  durationUs: number | null
  kind: AssetKind
  /** width/height codificados (antes da rotação); `rotation` é o giro horário de exibição. */
  video?: Omit<AssetVideoInfo, 'decodable'>
  audio?: AssetAudioInfo
  vfr: boolean
  formatName: string
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'tif', 'tiff']

/** GOP assumido quando só há um keyframe nos primeiros 20 s. */
const SINGLE_KEYFRAME_GOP_US = 10_000_000
/** Diferença relativa entre r_frame_rate e avg_frame_rate acima da qual a mídia é tratada como VFR. */
const VFR_TOLERANCE = 0.02

type Json = Record<string, unknown>

function rate(r: unknown): number | null {
  if (typeof r !== 'string') return null
  const [a, b] = r.split('/').map(Number)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
  return a / b
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function secToUs(v: unknown): number | null {
  const n = num(v)
  return n === null || n < 0 ? null : Math.round(n * 1_000_000)
}

/** Giro horário de exibição: displaymatrix traz o anti-horário (−90 → 90); tags.rotate já é horário. */
function rotationOf(s: Json): 0 | 90 | 180 | 270 {
  let deg: number | null = null
  const side = Array.isArray(s.side_data_list) ? (s.side_data_list as Json[]) : []
  const dm = side.find((d) => d.side_data_type === 'Display Matrix' && num(d.rotation) !== null)
  if (dm) deg = -(num(dm.rotation) as number)
  else {
    const tag = num((s.tags as Json | undefined)?.rotate)
    if (tag !== null) deg = tag
  }
  if (deg === null) return 0
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360
  return r as 0 | 90 | 180 | 270
}

export function parseFfprobe(json: unknown, path: string): MediaInfo {
  const j = (json ?? {}) as { streams?: Json[]; format?: Json }
  const streams = j.streams ?? []
  const format = j.format ?? {}
  // capa embutida (mp3/m4a) é um stream de vídeo, mas não é vídeo
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition as Json | undefined)?.attached_pic)
  const a = streams.find((s) => s.codec_type === 'audio')
  if (!v && !a) throw new Error(`Nenhuma faixa de vídeo ou áudio em ${path}`)

  const ext = extname(path).slice(1).toLowerCase()
  const kind: AssetKind = IMAGE_EXTENSIONS.includes(ext) ? 'image' : v ? 'video' : 'audio'

  let video: MediaInfo['video']
  let vfr = false
  if (v) {
    const avg = rate(v.avg_frame_rate)
    const real = rate(v.r_frame_rate)
    const fps = avg ?? real ?? 0
    if (kind === 'video' && avg && real) vfr = Math.abs(real - avg) / avg > VFR_TOLERANCE
    video = {
      width: num(v.width) ?? 0,
      height: num(v.height) ?? 0,
      fps: kind === 'image' ? 0 : fps,
      codec: String(v.codec_name ?? ''),
      rotation: rotationOf(v),
      gopUs: 0 // preenchido por probe() via probeGopUs
    }
  }
  const audio: AssetAudioInfo | undefined =
    a && kind !== 'image' ? { channels: num(a.channels) ?? 0, sampleRate: num(a.sample_rate) ?? 0, codec: String(a.codec_name ?? '') } : undefined

  let durationUs: number | null = null
  if (kind !== 'image') {
    durationUs = secToUs(format.duration)
    if (durationUs === null) {
      const ds = streams.map((s) => secToUs(s.duration)).filter((d): d is number => d !== null)
      durationUs = ds.length ? Math.max(...ds) : null
    }
  }
  return { durationUs, kind, video, audio, vfr, formatName: String(format.format_name ?? '') }
}

/** Média dos intervalos entre keyframes (s → µs); 1 keyframe ou nenhum → 10 s. */
export function averageGopUs(keyTimesSec: number[]): number {
  if (keyTimesSec.length < 2) return SINGLE_KEYFRAME_GOP_US
  const span = keyTimesSec[keyTimesSec.length - 1] - keyTimesSec[0]
  const avg = Math.round((span / (keyTimesSec.length - 1)) * 1_000_000)
  return avg > 0 ? avg : SINGLE_KEYFRAME_GOP_US
}

function ffprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath(), args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new FfmpegError(`ffprobe falhou: ${String(stderr).trim() || err.message}`, String(stderr), -1))
      else resolve(stdout)
    })
  })
}

/** GOP médio dos primeiros 20 s da faixa de vídeo (só keyframes são lidos). */
export async function probeGopUs(path: string): Promise<number> {
  const out = await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-read_intervals', '%+20', '-of', 'csv=p=0', path])
  const times: number[] = []
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim().replace(/,$/, '')
    if (!t) continue
    const n = Number(t)
    if (Number.isFinite(n)) times.push(n)
  }
  times.sort((x, y) => x - y)
  return averageGopUs(times)
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  let json: unknown
  try {
    json = JSON.parse(out)
  } catch (e) {
    throw new Error(`ffprobe retornou JSON inválido para ${path}: ${String(e)}`)
  }
  const info = parseFfprobe(json, path)
  if (info.kind === 'video' && info.video) info.video.gopUs = await probeGopUs(path)
  return info
}
