// Plano de áudio: segmentos com envelope de ganho em tempo absoluto de timeline. Puro.
import { evalAnim } from './anim'
import { audioProcessKey, audioSourceKey, parseAudioProcessKey, type AudioProcessOpts } from './audioProcess'
import type { AudioMix, Project, Us } from './project'
import type { SpeechInterval } from './speech'

export interface GainPoint { tUs: Us; gain: number } // linear entre pontos
/**
 * Como o mixer lê a fonte: 'copy' (1×), 'resample' (interpolação: o tom acompanha a velocidade), 'stretch'
 * (time-stretch com tom preservado) ou 'mute' (acelerado demais para soar).
 */
export type AudioMode = 'copy' | 'resample' | 'stretch' | 'mute'
export interface AudioSegment {
  itemId: string; assetId: string
  /** Faixa do item (medidores de nível por faixa). */
  trackId: string
  startUs: Us; durationUs: Us; srcInUs: Us
  speed: number; reverse: boolean; preservePitch: boolean; mode: AudioMode; gain: GainPoint[]
  /** "Manter áudio acelerado" do item: acima de 4× continua soando (também no shuttle). */
  keepFastAudio: boolean
  /**
   * Fonte de PCM que o mixer lê (audioProcess.audioSourceKey): o original (assetId) ou a versão pré-processada
   * (assetId~chave) quando o item pede redução de ruído/normalização e o arquivo gerado está pronto.
   */
  sourceKey: string
  /** Chave do pré-processamento pedido pelo item (null = nenhum); pedida e ainda não pronta = "processando". */
  processKey: string | null
}

export interface PlanAudioOpts {
  /** Comparar A/B: lê o original mesmo com o processado pronto. */
  bypassProcessing?: boolean
  /**
   * Ducking: intervalos de fala (tempo da FONTE, speechFromFile) por assetId, carregados por quem chama (o audio
   * worker lê os cache/<id>.speech.json pelo protocolo — o mesmo no preview e na exportação). Asset sem entrada = sem
   * dados: aquele item de voz não abaixa a música. Ausente = sem ducking.
   */
  speech?: Readonly<Record<string, readonly SpeechInterval[]>>
}

/** Padrões da mixagem do projeto (Project.audioMix ausente). */
export const AUDIO_MIX_DEFAULTS: AudioMix = { enabled: true, duckingDb: -12, attackMs: 250, releaseMs: 400, holdMs: 300 }
export const audioMixOf = (p: Project): AudioMix => ({ ...AUDIO_MIX_DEFAULTS, ...p.audioMix })
/** Rampas de ducking nunca menores que isto (degrau = clique). */
const MIN_RAMP_US = 10_000

/** O item pede pré-processamento que ainda não está pronto (o mixer toca o original enquanto isso). */
export const audioProcessPending = (s: AudioSegment): boolean => s.processKey !== null && s.sourceKey === s.assetId

/** Acima disso, com tom preservado, o áudio fica mudo (salvo "Manter áudio acelerado"). */
export const MAX_STRETCH_SPEED = 4

/**
 * 1× copia; com preservePitch acima de 4× silencia salvo keepFastAudio (também em reverso); sem preservePitch
 * reamostra; com preservePitch estica até 4× (e em câmera lenta). Reverso fora de 1× reamostra (o stretch só
 * anda para a frente).
 */
export function audioMode(speed: number, reverse: boolean, preservePitch: boolean, keepFastAudio: boolean): AudioMode {
  if (speed === 1) return 'copy'
  if (preservePitch && speed > MAX_STRETCH_SPEED && !keepFastAudio) return 'mute'
  if (!preservePitch || reverse) return 'resample'
  return 'stretch'
}

/** Itens de mídia com áudio habilitado em faixas não mudas cujo asset tem áudio (imagens e freeze ficam de fora). Itens mudos pela velocidade entram com mode 'mute'. */
export function planAudio(p: Project, opts: PlanAudioOpts = {}): AudioSegment[] {
  const out: AudioSegment[] = []
  for (const track of p.tracks) {
    if (track.muted) continue
    for (const item of track.items) {
      if (item.type !== 'media' || item.enabled === false || !item.audio.enabled || item.freeze) continue
      const asset = p.assets.find((a) => a.id === item.assetId)
      if (!asset || asset.kind === 'image' || !asset.audio) continue
      const a = item.audio
      const dur = item.durationUs
      const fin = Math.min(a.fadeInUs, dur)
      const fout = Math.min(a.fadeOutUs, dur)
      const times = new Set<number>([0, dur])
      if (fin > 0) times.add(fin)
      if (fout > 0) times.add(dur - fout)
      for (const k of a.volume.keys ?? []) if (k.tUs > 0 && k.tUs < dur) times.add(k.tUs)
      const gain = [...times].sort((x, y) => x - y).map((local): GainPoint => {
        let g = track.volume * evalAnim(a.volume, local)
        if (fin > 0 && local < fin) g *= local / fin
        if (fout > 0 && dur - local < fout) g *= (dur - local) / fout
        return { tUs: item.startUs + local, gain: Math.max(0, g) }
      })
      const processKey = audioProcessKey({ denoise: a.denoise, normalize: a.normalize })
      const ready = processKey !== null && !opts.bypassProcessing && !!asset.processedAudio?.[processKey]
      out.push({
        itemId: item.id, assetId: item.assetId, trackId: track.id, sourceKey: audioSourceKey(item.assetId, ready ? processKey : null), processKey, startUs: item.startUs, durationUs: dur, srcInUs: item.inUs,
        speed: item.speed, reverse: item.reverse, preservePitch: a.preservePitch, keepFastAudio: a.keepFastAudio ?? false,
        mode: audioMode(item.speed, item.reverse, a.preservePitch, a.keepFastAudio ?? false), gain
      })
    }
  }
  return opts.speech ? applyDucking(p, out, opts.speech) : out
}

/** Segmentos de voz que soam (faixa `voice`, não mudos pela velocidade): a fonte da fala do ducking. */
function voiceSegments(p: Project, segs: AudioSegment[]): AudioSegment[] {
  const voice = new Set(p.tracks.filter((t) => t.role === 'voice').map((t) => t.id))
  return segs.filter((s) => voice.has(s.trackId) && s.mode !== 'mute')
}

/**
 * Assets de voz cuja fala o ducking precisa (ducking ligado, alguma música no plano, voz audível com speech.json):
 * o que o audio worker carrega antes de montar o plano.
 */
export function voiceAssetIds(p: Project): string[] {
  if (!audioMixOf(p).enabled) return []
  const segs = planAudio(p)
  const music = new Set(p.tracks.filter((t) => t.role === 'music').map((t) => t.id))
  if (!segs.some((s) => music.has(s.trackId))) return []
  const out = new Set<string>()
  for (const s of voiceSegments(p, segs)) if (p.assets.find((a) => a.id === s.assetId)?.speech) out.add(s.assetId)
  return [...out]
}

/**
 * Fala da fonte → timeline para um segmento: a fonte é lida em srcIn + local·speed (reverso: srcIn + (dur − local)·speed,
 * a mesma conta do mixer), então local = (src − srcIn)/speed (reverso: dur − …). Preso ao trecho do item (trim).
 */
export function speechOnTimeline(seg: Pick<AudioSegment, 'startUs' | 'durationUs' | 'srcInUs' | 'speed' | 'reverse'>, speech: readonly SpeechInterval[]): SpeechInterval[] {
  const out: SpeechInterval[] = []
  const dur = seg.durationUs
  for (const iv of speech) {
    const a = (iv.fromUs - seg.srcInUs) / seg.speed
    const b = (iv.toUs - seg.srcInUs) / seg.speed
    const l0 = Math.max(0, seg.reverse ? dur - b : a)
    const l1 = Math.min(dur, seg.reverse ? dur - a : b)
    if (l1 > l0) out.push({ fromUs: seg.startUs + Math.round(l0), toUs: seg.startUs + Math.round(l1) })
  }
  return out
}

/**
 * Envelope de ducking (ganho linear em tempo de timeline) a partir dos intervalos de fala já na timeline. Regiões =
 * fala + holdMs depois do fim; pausa menor que o hold (fala seguinte começando antes do fim do hold) emenda as regiões,
 * sem "bombear". Cada região abaixa a `duckingDb` numa rampa de attackMs que TERMINA no início da fala (o plano
 * conhece o futuro: a fala já começa com a música abaixada) e volta a 1 numa rampa de releaseMs depois do hold.
 * Regiões vizinhas cujas rampas se cruzam (pausa entre hold e hold + ataque) valem pelo máximo do abaixamento, sem
 * degrau. Primeiro e último pontos têm ganho 1; vazio = sem fala.
 */
export function duckEnvelope(speech: readonly SpeechInterval[], mix: AudioMix): GainPoint[] {
  const A = Math.max(MIN_RAMP_US, Math.round(mix.attackMs * 1000))
  const R = Math.max(MIN_RAMP_US, Math.round(mix.releaseMs * 1000))
  const H = Math.max(0, Math.round(mix.holdMs * 1000))
  const duck = Math.pow(10, Math.min(0, mix.duckingDb) / 20)
  const sorted = speech.filter((s) => s.toUs > s.fromUs).sort((x, y) => x.fromUs - y.fromUs)
  // regiões [a, e]: abaixadas por inteiro (fala + hold)
  const regions: { a: Us; e: Us }[] = []
  for (const s of sorted) {
    const last = regions[regions.length - 1]
    if (last && s.fromUs <= last.e) last.e = Math.max(last.e, s.toUs + H)
    else regions.push({ a: s.fromUs, e: s.toUs + H })
  }
  if (!regions.length) return []
  // abaixamento 0–1 de uma região (trapézio)
  const trap = (r: { a: Us; e: Us }, t: Us): number => {
    if (t <= r.a - A || t >= r.e + R) return 0
    if (t < r.a) return (t - (r.a - A)) / A
    if (t <= r.e) return 1
    return 1 - (t - r.e) / R
  }
  const times: Us[] = []
  regions.forEach((r, i) => {
    times.push(r.a - A, r.a, r.e, r.e + R)
    const n = regions[i + 1]
    // soltura desta × ataque da seguinte: o cruzamento vira um ponto (o máximo dos dois é um "V" raso)
    if (n && n.a - A < r.e + R) {
      const s = n.a - A
      const x = Math.round((A * R + A * r.e + s * R) / (A + R))
      if (x > r.e && x < n.a) times.push(x)
    }
  })
  times.sort((x, y) => x - y)
  const out: GainPoint[] = []
  let k = 0
  for (const t of times) {
    if (out.length && out[out.length - 1].tUs === t) continue
    while (k < regions.length && regions[k].e + R <= t) k++ // regiões já soltas por inteiro antes de t
    let d = 0
    for (let j = Math.max(0, k - 1); j < regions.length && regions[j].a - A < t; j++) d = Math.max(d, trap(regions[j], t))
    out.push({ tUs: t, gain: d === 0 ? 1 : 1 - d * (1 - duck) })
  }
  return out
}

/** Ganho de uma lista de pontos no instante t (preso às pontas). */
function gainOf(points: GainPoint[], t: Us): number {
  if (!points.length) return 1
  if (t <= points[0].tUs) return points[0].gain
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].tUs) {
      const a = points[i - 1], b = points[i]
      return b.tUs === a.tUs ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.tUs)) / (b.tUs - a.tUs)
    }
  }
  return points[points.length - 1].gain
}

/** Envelope de ducking nas faixas de música pela fala das faixas de voz (puro: a fala chega como dado). */
function applyDucking(p: Project, segs: AudioSegment[], speech: Readonly<Record<string, readonly SpeechInterval[]>>): AudioSegment[] {
  const mix = audioMixOf(p)
  if (!mix.enabled) return segs
  const env = duckEnvelope(voiceSegments(p, segs).flatMap((s) => speechOnTimeline(s, speech[s.assetId] ?? [])), mix)
  if (!env.length) return segs
  const music = new Set(p.tracks.filter((t) => t.role === 'music').map((t) => t.id))
  return segs.map((s) => {
    const end = s.startUs + s.durationUs
    if (!music.has(s.trackId) || env[0].tUs >= end || env[env.length - 1].tUs <= s.startUs) return s
    const times = [...new Set([...s.gain.map((g) => g.tUs), ...env.map((g) => g.tUs), s.startUs, end])].filter((t) => t >= s.startUs && t <= end).sort((x, y) => x - y)
    return { ...s, gain: times.map((t) => ({ tUs: t, gain: gainOf(s.gain, t) * gainOf(env, t) })) }
  })
}

/**
 * Comparar A/B: o plano a tocar (`bypass` = original) e o `alternate` — os segmentos do outro lado cuja fonte é
 * diferente. O worker mantém vivas (e aquecidas) as fontes dos dois, então segurar/soltar o botão não decodifica
 * do zero.
 */
export function abPlan(p: Project, bypass: boolean, speech?: PlanAudioOpts['speech']): { segments: AudioSegment[]; alternate: AudioSegment[] } {
  const segments = planAudio(p, { bypassProcessing: bypass, speech })
  const other = planAudio(p, { bypassProcessing: !bypass, speech })
  return { segments, alternate: other.filter((s, i) => s.sourceKey !== segments[i]?.sourceKey) }
}

/**
 * Pré-processamentos que o plano pede e ainda não estão prontos, um por (asset, chave), só de assets prontos: o
 * editor os pede ao main (media.processAudio) — inclusive ao abrir o projeto em outro PC sem o cache.
 */
export function pendingAudioProcessing(p: Project): { assetId: string; key: string; opts: AudioProcessOpts }[] {
  const out = new Map<string, { assetId: string; key: string; opts: AudioProcessOpts }>()
  for (const s of planAudio(p)) {
    if (!audioProcessPending(s) || s.processKey === null) continue
    const id = audioSourceKey(s.assetId, s.processKey)
    if (out.has(id) || p.assets.find((a) => a.id === s.assetId)?.status !== 'ready') continue
    out.set(id, { assetId: s.assetId, key: s.processKey, opts: parseAudioProcessKey(s.processKey)! })
  }
  return [...out.values()]
}

/** Shuttle (J/K/L) com som: até 2× para frente. Acima disso ou para trás o preview fica mudo. */
export const SHUTTLE_AUDIO_MAX_RATE = 2

/**
 * Segmentos para tocar a timeline a `rate`× (0 < rate ≤ 2) no preview: o tempo do shuttle é t/rate, então início,
 * duração e envelope são divididos por rate e a velocidade multiplicada (cada instante lê a mesma fonte). O som
 * fica esticado com o tom da fonte (stretch); acima de 4× efetivos fica mudo, salvo keepFastAudio ("Manter áudio
 * acima de 4×"); reverso reamostra (como no plano normal); mudo continua mudo. rate 1: os mesmos.
 */
export function shuttleSegments(segs: AudioSegment[], rate: number): AudioSegment[] {
  if (!(rate > 0 && rate <= SHUTTLE_AUDIO_MAX_RATE)) throw new Error(`shuttle sem áudio a ${rate}×`)
  if (rate === 1) return segs
  const t = (us: Us): Us => Math.round(us / rate)
  return segs.map((s) => {
    const speed = s.speed * rate
    let mode: AudioMode
    if (s.mode === 'mute') mode = 'mute'
    else if (speed > MAX_STRETCH_SPEED && !s.keepFastAudio) mode = 'mute'
    else if (s.reverse) mode = 'resample'
    else mode = 'stretch'
    const startUs = t(s.startUs)
    return { ...s, startUs, durationUs: t(s.startUs + s.durationUs) - startUs, speed, mode, gain: s.gain.map((g) => ({ tUs: t(g.tUs), gain: g.gain })) }
  })
}

/** Ganho linear no instante tUs; 0 fora do segmento. */
export function gainAt(seg: AudioSegment, tUs: Us): number {
  if (tUs < seg.startUs || tUs > seg.startUs + seg.durationUs) return 0
  const g = seg.gain
  if (g.length === 0) return 1
  if (tUs <= g[0].tUs) return g[0].gain
  for (let i = 1; i < g.length; i++) {
    if (tUs <= g[i].tUs) {
      const a = g[i - 1], b = g[i]
      return b.tUs === a.tUs ? b.gain : a.gain + ((b.gain - a.gain) * (tUs - a.tUs)) / (b.tUs - a.tUs)
    }
  }
  return g[g.length - 1].gain
}
