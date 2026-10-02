import { readFileSync } from 'fs'
import { join } from 'path'
import { CURSOR_FILE, parseCursorTrack, type CursorTrackV1 } from '@shared/cursor'

// Leitura da trilha do cursor de uma gravação (<sessão>/cursor.json, F6) para o editor. Nunca lança: arquivo
// ausente, ilegível ou inválido = sem trilha (gravações antigas, modo janela sem o módulo nativo).

/** Trilha validada da pasta da gravação, ou null. */
export function readSessionCursorTrack(sessionDir: string): CursorTrackV1 | null {
  try {
    return parseCursorTrack(JSON.parse(readFileSync(join(sessionDir, CURSOR_FILE), 'utf8')))
  } catch {
    return null
  }
}

/** Valor de `asset.cursor` para o asset da tela da gravação: CURSOR_FILE se a trilha existe e é válida; senão null. */
export function sessionCursorRef(sessionDir: string): string | null {
  return readSessionCursorTrack(sessionDir) ? CURSOR_FILE : null
}

/**
 * Pasta da gravação para ler o cursor.json: só ids aceitos por `dirOf` (SessionStore.dirOf recusa separadores) e
 * nunca '.'/'..' (que o padrão dele aceita) — nenhum caminho arbitrário vindo do renderer. null = id inválido.
 */
export function sessionDirFor(dirOf: (sessionId: string) => string, sessionId: unknown): string | null {
  if (typeof sessionId !== 'string' || /^\.*$/.test(sessionId)) return null
  try {
    return dirOf(sessionId)
  } catch {
    return null
  }
}
