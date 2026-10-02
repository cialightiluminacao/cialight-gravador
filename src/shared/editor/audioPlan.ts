// Plano de áudio: segmentos com envelope de ganho em tempo absoluto de timeline. Puro.
import { evalAnim } from './anim'
import { audioProcessKey, audioSourceKey, parseAudioProcessKey, type AudioProcessOpts } from './audioProcess'
import type { Project, Us } from './project'

export interface GainPoint { tUs: Us; gain: number } // linear entre pontos
/**
 * Como o mixer lê a fonte: 'copy' (1×), 'resample' (interpolação: o tom acompanha a velocidade), 'stretch'
 * (time-stretch com tom preservado) ou 'mute' (acelerado demais para soar).
 */
export type AudioMode = 'copy' | 'resample' | 'stretch' | 'mute'
export interface AudioSegment {
  itemId: string; assetId: string; startUs: Us; durationUs: Us; srcInUs: Us
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
}

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
        itemId: item.id, assetId: item.assetId, sourceKey: audioSourceKey(item.assetId, ready ? processKey : null), processKey, startUs: item.startUs, durationUs: dur, srcInUs: item.inUs,
        speed: item.speed, reverse: item.reverse, preservePitch: a.preservePitch, keepFastAudio: a.keepFastAudio ?? false,
        mode: audioMode(item.speed, item.reverse, a.preservePitch, a.keepFastAudio ?? false), gain
      })
    }
  }
  return out
}

/**
 * Comparar A/B: o plano a tocar (`bypass` = original) e o `alternate` — os segmentos do outro lado cuja fonte é
 * diferente. O worker mantém vivas (e aquecidas) as fontes dos dois, então segurar/soltar o botão não decodifica
 * do zero.
 */
export function abPlan(p: Project, bypass: boolean): { segments: AudioSegment[]; alternate: AudioSegment[] } {
  const segments = planAudio(p, { bypassProcessing: bypass })
  const other = planAudio(p, { bypassProcessing: !bypass })
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
