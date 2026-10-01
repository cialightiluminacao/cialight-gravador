// Gravação (Session v1) → Project do editor. Pura: mantém PiP da webcam (com movimentos),
// anotações, áudio de microfone/sistema e marcadores editáveis. Paridade com pipRectAt (v1).
import type { PipKeyframe, Session } from '../types'
import { PIP_EASE_MS } from '../compositor/pipMath'
import { defaultAudio, defaultVisual } from './factory'
import { MIN_ITEM_US } from './project'
import type { Anim, Asset, Keyframe, MediaItem, Project, SessionStream, Track, TrackKind, Us, VisualProps } from './project'
import { msToUs, secToUs } from './time'

// Webcam sem dimensões registradas na sessão: assume 1280×720.
const FALLBACK_WEBCAM = { width: 1280, height: 720 }

function sessionAsset(session: Session, projectId: string, stream: SessionStream, name: string, durationUs: Us): Asset {
  const base = { id: `${projectId}-${stream}`, name, source: { type: 'session' as const, sessionId: session.id, stream }, durationUs, status: 'ready' as const }
  if (stream === 'mic' || stream === 'system') {
    // Canais/taxa reais só são conhecidos ao decodificar; valores típicos do rec.mp4 (AAC 48 kHz).
    // rec.mp4 tem uma faixa de áudio por fonte: session.tracks diz qual (a:N).
    return { ...base, kind: 'audio', audio: { channels: 2, sampleRate: 48000, codec: 'aac' }, audioTrackIndex: session.tracks[stream] ?? 0 }
  }
  const dims = stream === 'screen'
    ? { width: session.video.width, height: session.video.height, codec: session.video.codec }
    : { width: session.webcam?.width || FALLBACK_WEBCAM.width, height: session.webcam?.height || FALLBACK_WEBCAM.height, codec: '' }
  return {
    ...base,
    kind: 'video',
    video: { ...dims, fps: session.video.fps, rotation: 0, decodable: true, gopUs: secToUs(1) },
    // rec.mp4 tem tela (v:0) e webcam (v:1): session.tracks diz qual
    videoTrackIndex: session.tracks[stream] ?? 0
  }
}

/**
 * Keys de uma grandeza animada a partir dos keyframes da PiP, com a semântica de pipRectAt:
 * após cada keyframe i>0 o valor vai linearmente do anterior ao novo em 150 ms.
 * Key em tMs com o valor anterior (ease 'linear' inicia a rampa) e key em tMs+150 ms com o novo
 * (ease 'hold' segura até o próximo keyframe). Em evalAnim o ease é o do key de partida do
 * intervalo, por isso a rampa fica no key de tMs e o hold no key de tMs+150.
 * Rampa interrompida por um keyframe seguinte é cortada 1 µs antes dele, no valor interpolado
 * (a v1 salta para o valor do keyframe vigente).
 */
function rampKeys(times: Us[], values: number[], totalUs: Us): Keyframe<number>[] {
  const ease = msToUs(PIP_EASE_MS)
  const keys: Keyframe<number>[] = []
  const push = (tUs: Us, value: number, e: Keyframe<number>['ease']): void => {
    if (tUs > totalUs || tUs < 0) return
    if (keys.length && tUs <= keys[keys.length - 1].tUs) return
    keys.push({ tUs, value, ease: e })
  }
  for (let i = 1; i < times.length; i++) {
    const t = times[i]
    const end = t + ease
    const next = i + 1 < times.length ? times[i + 1] : Infinity
    push(t, values[i - 1], 'linear')
    if (end <= next - 1) push(end, values[i], 'hold')
    else {
      const p = (next - 1 - t) / ease
      push(next - 1, values[i - 1] + (values[i] - values[i - 1]) * p, 'hold')
    }
  }
  return keys
}

function anim(times: Us[], values: number[], totalUs: Us): Anim<number> {
  const keys = rampKeys(times, values, totalUs)
  return keys.length ? { value: values[0], keys } : { value: values[0] }
}

/** Retira keyframes com tMs repetido (fica o último), mantendo a ordem por tempo. */
function normalizePip(pip: PipKeyframe[]): PipKeyframe[] {
  const sorted = pip.slice().sort((a, b) => a.tMs - b.tMs)
  return sorted.filter((k, i) => i === sorted.length - 1 || sorted[i + 1].tMs !== k.tMs)
}

function webcamVisual(session: Session, pipRaw: PipKeyframe[], totalUs: Us): VisualProps {
  const pip = normalizePip(pipRaw)
  const W = session.video.width, H = session.video.height
  const sw = session.webcam?.width || FALLBACK_WEBCAM.width
  const sh = session.webcam?.height || FALLBACK_WEBCAM.height
  const first = pip[0]
  // Aspecto alvo da 1ª PiP; PiPs com outro aspecto depois dela não são representadas (limitação).
  const A = (first.w * W) / (first.h * H)
  const S = sw / sh
  const crop = { l: 0, t: 0, r: 0, b: 0 }
  if (S > A) crop.l = crop.r = (1 - A / S) / 2
  else if (S < A) crop.t = crop.b = (1 - S / A) / 2
  // contain: A ≥ W/H → largura do quadro (scale = w); senão altura (scale = h).
  const byWidth = A >= W / H
  const times = pip.map((k) => msToUs(k.tMs))
  const v = defaultVisual()
  const opacityKeys: Keyframe<number>[] = []
  if (pip.some((k) => k.visible !== first.visible)) {
    // visible não interpola: troca seca no keyframe (hold).
    let last: boolean | null = null
    pip.forEach((k, i) => {
      if (k.visible === last || times[i] > totalUs) return
      opacityKeys.push({ tUs: times[i], value: k.visible ? 1 : 0, ease: 'hold' })
      last = k.visible
    })
  }
  return {
    ...v,
    transform: {
      ...v.transform,
      x: anim(times, pip.map((k) => k.x + k.w / 2), totalUs),
      y: anim(times, pip.map((k) => k.y + k.h / 2), totalUs),
      scale: anim(times, pip.map((k) => (byWidth ? k.w : k.h)), totalUs),
      opacity: opacityKeys.length ? { value: first.visible ? 1 : 0, keys: opacityKeys } : { value: first.visible ? 1 : 0 }
    },
    crop,
    fit: 'contain',
    shape: first.shape === 'circle' ? 'circle' : 'rounded',
    mirror: session.webcam?.mirrored ?? false
  }
}

function sessionTotalUs(session: Session): Us {
  if (session.durationMs == null || !Number.isFinite(session.durationMs) || session.durationMs <= 0) {
    throw new Error('Sessão sem duração: não é possível criar o projeto')
  }
  return Math.max(msToUs(session.durationMs), MIN_ITEM_US)
}

const STREAM_NAMES: Record<SessionStream, string> = { screen: 'Tela', webcam: 'Webcam', mic: 'Microfone', system: 'Áudio do sistema' }

/**
 * Assets de uma gravação (tela + webcam/microfone/sistema quando gravados), com id `<idPrefix>-<fonte>`.
 * `label` (opcional) prefixa os nomes ("Gravação 18/08 — Tela"); sem ele, só o nome da fonte.
 */
export function sessionAssets(session: Session, idPrefix: string, label?: string): Asset[] {
  const total = sessionTotalUs(session)
  const streams: SessionStream[] = ['screen']
  if (session.webcam && session.tracks.webcam !== undefined) streams.push('webcam')
  if (session.tracks.mic !== undefined) streams.push('mic')
  if (session.tracks.system !== undefined) streams.push('system')
  return streams.map((s) => sessionAsset(session, idPrefix, s, label ? `${label} — ${STREAM_NAMES[s]}` : STREAM_NAMES[s], total))
}

/** annotationsAutoFadeMs: sumiço automático das anotações (settings.annotations.autoFadeSec·1000 da v1) ou null. */
export function projectFromSession(session: Session, opts: { projectId: string; name: string; now: string; annotationsAutoFadeMs?: number | null }): Project {
  const { projectId } = opts
  const total = sessionTotalUs(session)
  const linkId = `${projectId}-link`
  const assets = sessionAssets(session, projectId)
  const hasWebcam = assets.some((a) => a.id === `${projectId}-webcam`)
  const hasMic = assets.some((a) => a.id === `${projectId}-mic`)
  const hasSystem = assets.some((a) => a.id === `${projectId}-system`)

  const mediaItem = (stream: SessionStream, kind: TrackKind, visual?: VisualProps, link?: string): MediaItem => ({
    id: `${projectId}-${stream}-item`, type: 'media', assetId: `${projectId}-${stream}`, name: STREAM_NAMES[stream],
    startUs: 0, durationUs: total, inUs: 0, speed: 1, reverse: false,
    audio: defaultAudio(),
    ...(kind === 'video' ? { visual: visual ?? defaultVisual() } : {}),
    ...(link ? { linkId: link } : {})
  })
  const track = (id: string, kind: TrackKind, name: string, items: Track['items'], role?: Track['role']): Track => ({
    id: `${projectId}-t-${id}`, kind, name, muted: false, hidden: false, locked: false, volume: 1, ...(role ? { role } : {}), items
  })

  const tracks: Track[] = [track('screen', 'video', STREAM_NAMES.screen, [mediaItem('screen', 'video', undefined, linkId)])]
  // Sem keyframes de PiP a v1 não desenha a webcam: não há onde posicioná-la, então não cria a faixa.
  if (hasWebcam && session.pip.length > 0) {
    tracks.push(track('webcam', 'video', STREAM_NAMES.webcam, [mediaItem('webcam', 'video', webcamVisual(session, session.pip, total))]))
  }
  if (session.strokes.length > 0) {
    tracks.push(track('annotations', 'video', 'Anotações', [
      { id: `${projectId}-annotations-item`, type: 'annotations', name: 'Anotações', sessionId: session.id, inUs: 0, startUs: 0, durationUs: total, autoFadeMs: opts.annotationsAutoFadeMs ?? null }
    ]))
  }
  if (hasMic) tracks.push(track('mic', 'audio', STREAM_NAMES.mic, [mediaItem('mic', 'audio', undefined, linkId)], 'voice'))
  if (hasSystem) tracks.push(track('system', 'audio', STREAM_NAMES.system, [mediaItem('system', 'audio', undefined, linkId)], 'sfx'))

  return {
    version: 1,
    id: projectId,
    name: opts.name,
    createdAt: opts.now,
    updatedAt: opts.now,
    canvas: {
      width: Math.max(1, Math.round(session.video.width)),
      height: Math.max(1, Math.round(session.video.height)),
      fps: Math.max(1, Math.round(session.video.fps)),
      background: '#000000'
    },
    assets,
    tracks,
    markers: session.markers.map((m, i) => ({ id: `${projectId}-m${i + 1}`, tUs: msToUs(m.tMs), label: m.label?.trim() || `Marcador ${i + 1}`, color: '#ff4d4f' })),
    originSessionId: session.id
  }
}
