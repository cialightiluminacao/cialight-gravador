// Histórico de undo/redo puro e genérico (snapshots imutáveis).

export interface History<T> { past: T[]; present: T; future: T[] }

export function initHistory<T>(t: T): History<T> {
  return { past: [], present: t, future: [] }
}

/** Grava `next` como novo present. Ignora se for o mesmo objeto; limpa o futuro. */
export function commit<T>(h: History<T>, next: T, limit = 300): History<T> {
  if (next === h.present) return h
  const past = [...h.past, h.present]
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [] }
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
}
