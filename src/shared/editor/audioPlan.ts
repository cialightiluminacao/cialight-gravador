// Plano de áudio: segmentos com envelope de ganho em tempo absoluto de timeline. Puro.
import { evalAnim } from './anim'
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
}

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
export function planAudio(p: Project): AudioSegment[] {
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
      out.push({
        itemId: item.id, assetId: item.assetId, startUs: item.startUs, durationUs: dur, srcInUs: item.inUs,
        speed: item.speed, reverse: item.reverse, preservePitch: a.preservePitch,
        mode: audioMode(item.speed, item.reverse, a.preservePitch, a.keepFastAudio ?? false), gain
      })
    }
  }
  return out
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
