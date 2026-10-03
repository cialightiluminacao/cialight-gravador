// Histórico de undo/redo puro e genérico (snapshots imutáveis).

/**
 * Metadados opcionais de UI de uma transição (ex.: marcas Entrada/Saída/playhead), fora do projeto e nunca gravados em disco.
 * `pastMeta[i]` descreve a transição past[i] → (past[i+1] ou present); `futureMeta[j]` descreve present → future[0] (j=0) etc.
 * Ausentes = nenhuma entrada tem metadado (comportamento original).
 */
export interface HistoryMeta<M> { before: M; after: M }

export interface History<T, M = unknown> {
  past: T[]
  present: T
  future: T[]
  pastMeta?: (HistoryMeta<M> | undefined)[]
  futureMeta?: (HistoryMeta<M> | undefined)[]
}

export function initHistory<T, M = unknown>(t: T): History<T, M> {
  return { past: [], present: t, future: [] }
}

/** Grava `next` como novo present. Ignora se for o mesmo objeto; limpa o futuro. `meta` (opcional) fica na mesma entrada. */
export function commit<T, M = unknown>(h: History<T, M>, next: T, limit = 300, meta?: HistoryMeta<M>): History<T, M> {
  if (next === h.present) return h
  const past = [...h.past, h.present]
  const trim = Math.max(0, past.length - limit)
  const out: History<T, M> = { past: trim ? past.slice(trim) : past, present: next, future: [] }
  if (meta || h.pastMeta) {
    const pm = [...padMeta(h.pastMeta, h.past.length), meta]
    out.pastMeta = trim ? pm.slice(trim) : pm
  }
  return out
}

function padMeta<M>(m: (HistoryMeta<M> | undefined)[] | undefined, n: number): (HistoryMeta<M> | undefined)[] {
  const a = m ? m.slice(0, n) : []
  while (a.length < n) a.push(undefined)
  return a
}

/** Metadado da entrada que o próximo undo desfaz (undefined se não houver). */
export function undoMeta<T, M>(h: History<T, M>): HistoryMeta<M> | undefined {
  return h.past.length ? h.pastMeta?.[h.past.length - 1] : undefined
}

/** Metadado da entrada que o próximo redo refaz (undefined se não houver). */
export function redoMeta<T, M>(h: History<T, M>): HistoryMeta<M> | undefined {
  return h.future.length ? h.futureMeta?.[0] : undefined
}

export function undo<T, M = unknown>(h: History<T, M>): History<T, M> {
  if (h.past.length === 0) return h
  const out: History<T, M> = { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
  if (h.pastMeta || h.futureMeta) {
    out.pastMeta = padMeta(h.pastMeta, h.past.length).slice(0, -1)
    out.futureMeta = [undoMeta(h), ...padMeta(h.futureMeta, h.future.length)]
  }
  return out
}

export function redo<T, M = unknown>(h: History<T, M>): History<T, M> {
  if (h.future.length === 0) return h
  const out: History<T, M> = { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
  if (h.pastMeta || h.futureMeta) {
    out.pastMeta = [...padMeta(h.pastMeta, h.past.length), redoMeta(h)]
    out.futureMeta = padMeta(h.futureMeta, h.future.length).slice(1)
  }
  return out
}
