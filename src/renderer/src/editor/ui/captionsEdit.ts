// Lógica pura da aba Legendas: tempos digitados (mm:ss,mmm), onde nasce a próxima legenda e o resumo dos avisos da
// importação de SRT.
import { MIN_ITEM_US, type Item, type Us } from '@shared/editor/project'
import { parseCueTime } from '@shared/editor/srt'

/**
 * Confirmar um tempo digitado na lista: igual → nada; ilegível → recusar com a mensagem; senão, o novo intervalo
 * (o outro lado fica onde está). A validação de sobreposição é do setCaptionTimes.
 */
export function planTimeEdit(item: Pick<Item, 'startUs' | 'durationUs'>, field: 'start' | 'end', typed: string): { kind: 'same' } | { kind: 'invalid'; message: string } | { kind: 'change'; startUs: Us; endUs: Us } {
  const us = parseCueTime(typed)
  if (us === null) return { kind: 'invalid', message: `Tempo inválido: “${typed.trim()}”. Use mm:ss,mmm (ex.: 01:02,500).` }
  const s = item.startUs, e = item.startUs + item.durationUs
  // compara no ms (o campo mostra ms; µs abaixo disso não mudam nada)
  if (Math.round(us / 1000) === Math.round((field === 'start' ? s : e) / 1000)) return { kind: 'same' }
  const startUs = field === 'start' ? us : s
  const endUs = field === 'end' ? us : e
  if (endUs - startUs < MIN_ITEM_US) return { kind: 'invalid', message: field === 'start' ? 'O início precisa ser antes do fim da legenda.' : 'O fim precisa ser depois do início da legenda.' }
  return { kind: 'change', startUs, endUs }
}

/**
 * Onde nasce a próxima legenda (Enter na última): no playhead, ou logo depois do fim da última legenda se o playhead
 * ainda estiver dentro dela ou antes do fim dela.
 */
export function nextCaptionAt(playheadUs: Us, last: Pick<Item, 'startUs' | 'durationUs'> | null): Us {
  if (!last) return playheadUs
  return Math.max(playheadUs, last.startUs + last.durationUs)
}

/** Resumo dos avisos para o toast: até `max` avisos e "… e mais N". */
export function warningsSummary(warnings: readonly string[], max = 3): string {
  if (!warnings.length) return ''
  const head = warnings.slice(0, max).join('\n')
  const rest = warnings.length - max
  return rest > 0 ? `${head}\n… e mais ${rest} ${rest === 1 ? 'aviso' : 'avisos'}` : head
}
