/**
 * Utilitários puros de nomes de arquivo/pasta (Windows-safe).
 */

/** Tamanho máximo (em caracteres) de um nome de arquivo saneado. */
export const MAX_FILE_NAME_LENGTH = 120

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Id de sessão a partir de uma data local: `2026-08-18T14-32-05` (ordenável e válido como nome de pasta). */
export function sessionIdFor(date: Date): string {
  const y = date.getFullYear()
  const mo = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  const h = pad2(date.getHours())
  const mi = pad2(date.getMinutes())
  const s = pad2(date.getSeconds())
  return `${y}-${mo}-${d}T${h}-${mi}-${s}`
}

/** Nome padrão de saída: `Gravação 2026-08-18 14-32.mp4`. */
export function defaultOutputName(date: Date, ext = 'mp4'): string {
  const y = date.getFullYear()
  const mo = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  const h = pad2(date.getHours())
  const mi = pad2(date.getMinutes())
  const cleanExt = ext.replace(/^\.+/, '')
  return `Gravação ${y}-${mo}-${d} ${h}-${mi}${cleanExt ? `.${cleanExt}` : ''}`
}

/** Separa `nome.ext` em base e extensão (só a última; sem ponto inicial → sem extensão). */
function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.')
  if (i <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, i), ext: name.slice(i) }
}

/**
 * Sanea um nome de arquivo para o Windows: remove `\ / : * ? " < > |` e caracteres
 * de controle (colapsando antes qualquer espaço em branco — tab/quebra viram espaço),
 * remove pontos/espaços finais e limita
 * a `MAX_FILE_NAME_LENGTH` caracteres preservando a extensão.
 */
export function sanitizeFileName(name: string): string {
  let s = name
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/ +/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (s.length > MAX_FILE_NAME_LENGTH) {
    const { base, ext } = splitExt(s)
    const keepExt = ext.length <= 10 ? ext : ''
    s = base.slice(0, MAX_FILE_NAME_LENGTH - keepExt.length).replace(/[. ]+$/g, '') + keepExt
  }
  // nomes reservados do Windows (CON, PRN, AUX, NUL, COM1–9, LPT1–9), com ou sem extensão
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = `_${s}`
  return s
}

/**
 * Nome de arquivo a partir de um título (nome do projeto): `/`, `\` e `:` viram hífen em vez de sumir —
 * "Gravação 01/10/2026 21:06" → "Gravação 01-10-2026 21-06" (e não "Gravação 01102026 2106").
 */
export function fileNameFromTitle(title: string): string {
  return sanitizeFileName(title.replace(/[\\/:]/g, '-'))
}

/**
 * Garante nome único diante de `existing` (comparação sem diferenciar maiúsculas,
 * como o NTFS): `x.mp4` → `x-2.mp4`, `x-3.mp4`…
 */
export function uniqueName(existing: Set<string>, name: string): string {
  const taken = new Set<string>()
  for (const e of existing) taken.add(e.toLowerCase())
  if (!taken.has(name.toLowerCase())) return name
  const { base, ext } = splitExt(name)
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Nome livre no estilo do Explorer: `x.mp4` → `x (2).mp4`, `x (3).mp4`… enquanto `taken(nome)` for true.
 * Nunca sobrescreve em silêncio um arquivo existente.
 */
export function numberedName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const { base, ext } = splitExt(name)
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
}
