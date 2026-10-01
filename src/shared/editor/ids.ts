/** Id único; usa crypto.randomUUID quando existe, senão Math.random em base36. */
export function newId(prefix = ''): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const id =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  return prefix + id
}
