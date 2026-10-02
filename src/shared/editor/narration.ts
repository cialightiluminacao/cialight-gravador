import { createMediaItem } from './factory'
import { addAsset, EditError, insertItems, voiceTrackFor } from './ops'
import { MIN_ITEM_US } from './project'
import type { Asset, Project, Us } from './project'

// Narração gravada direto na timeline (puro): onde o item entra e em que faixa.
//
// A captura (AudioWorklet) roda no MESMO AudioContext da reprodução, então o sample que entrou no grafo no instante
// `c` do contexto foi captado em c − latênciaDeEntrada; nesse momento o alto-falante tocava o que o grafo produziu
// latênciaDeSaída antes, e o relógio da reprodução (PlaybackController.clockUs) diz que isso é
//   us0 + (c − entrada − t0 − saída)·1e6
// — o instante da timeline que a pessoa via/ouvia quando falou.

/** Relógio da reprodução no início da gravação: timeline em `us0` no bloco 0 agendado em `t0S` (tempo do contexto). */
export interface NarrationClock { us0: Us; t0S: number; outputLatencyS: number }

/**
 * Início do item e corte do começo do arquivo. `firstSampleS`: instante do contexto em que o 1º sample gravado entrou
 * no grafo. O que foi captado antes de a timeline começar a andar (o quadro ainda parado em us0) fica no arquivo e é
 * pulado pelo inUs (dá para recuperar puxando a borda). Sem relógio (nada a tocar: playhead no fim): no playhead.
 */
export function narrationPlacement(o: { playheadUs: Us; clock: NarrationClock | null; firstSampleS: number; inputLatencyS: number }): { startUs: Us; inUs: Us } {
  if (!o.clock) return { startUs: Math.round(o.playheadUs), inUs: 0 }
  const { us0, t0S, outputLatencyS } = o.clock
  const at = us0 + Math.round((o.firstSampleS - o.inputLatencyS - t0S - outputLatencyS) * 1e6)
  return at >= us0 ? { startUs: at, inUs: 0 } : { startUs: us0, inUs: us0 - at }
}

/**
 * Acrescenta o asset da narração e o item na faixa "Narração" (papel Voz; reusa uma livre no trecho, senão cria
 * "Narração N"), num passo só. O corte do início nunca deixa o item menor que um quadro.
 */
export function placeNarration(p: Project, asset: Asset, at: { startUs: Us; inUs: Us }): { project: Project; itemId: string; trackId: string } {
  const dur = asset.durationUs
  if (dur === null || dur < MIN_ITEM_US) throw new EditError('invalid', 'A narração gravada é curta demais (ou ilegível) para entrar na linha do tempo.')
  const inUs = Math.max(0, Math.min(Math.round(at.inUs), dur - MIN_ITEM_US))
  const startUs = Math.max(0, Math.round(at.startUs))
  const item = { ...createMediaItem(asset, startUs, 'audio'), inUs, durationUs: dur - inUs }
  const withAsset = addAsset(p, asset)
  const { project, trackId } = voiceTrackFor(withAsset, startUs, startUs + item.durationUs, { name: 'Narração', named: true })
  return { project: insertItems(project, trackId, [item], 'overwrite'), itemId: item.id, trackId }
}

/** "generated/narracao-3.m4a" → "Narração 3" (nome do asset na biblioteca). */
export function narrationAssetName(rel: string): string {
  const m = /narracao-(\d+)\.[a-z0-9]+$/.exec(rel)
  return m ? `Narração ${m[1]}` : 'Narração'
}

/**
 * Processamento que o navegador manteve ligado no microfone da narração (pedido todo desligado) → texto do aviso, ou
 * null se está tudo desligado.
 */
export function micProcessingWarning(p: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } | null): string | null {
  if (!p) return null
  const on = [p.noiseSuppression && 'redução de ruído', p.autoGainControl && 'ganho automático', p.echoCancellation && 'cancelamento de eco'].filter((x): x is string => !!x)
  if (!on.length) return null
  const list = on.length === 1 ? on[0] : `${on.slice(0, -1).join(', ')} e ${on[on.length - 1]}`
  return `O sistema manteve ${list} neste microfone; a narração pode sair abafada ou com volume variando. Feche outros programas que estejam usando o microfone e grave de novo.`
}
