/** Id único; usa crypto.randomUUID quando existe, senão Math.random em base36. */
export function newId(prefix = ''): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const id =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  return prefix + id
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Id de projeto: `p-2026-10-01t14-32-05-ab12` (data local + 4 chars base36).
 * Sempre minúsculo: com scheme 'standard' o host da URL vira lowercase.
 */
export function newProjectId(now: Date, random: () => number = Math.random): string {
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}t${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
  let rnd = ''
  while (rnd.length < 4) rnd += Math.floor(random() * 36).toString(36)
  return `p-${stamp}-${rnd}`
}
