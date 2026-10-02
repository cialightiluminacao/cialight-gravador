import { closeSync, openSync, readSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { CURSOR_FILE, parseCursorTrack, type CursorTrackV1 } from '@shared/cursor'

// Leitura da trilha do cursor de uma gravação (<sessão>/cursor.json, F6) para o editor. Nunca lança: arquivo
// ausente, ilegível ou inválido = sem trilha (gravações antigas, modo janela sem o módulo nativo).
// Uma trilha de 1 h tem ~13 MB: a validação completa (JSON.parse + zod) só acontece na leitura assíncrona pedida
// pelo editor (IPC); o flag `asset.cursor` (ingestão, abrir o projeto, criar da gravação) só confere o cabeçalho.

/** Trilha validada da pasta da gravação, ou null (leitura assíncrona; a validação completa roda aqui). */
export async function readSessionCursorTrack(sessionDir: string): Promise<CursorTrackV1 | null> {
  try {
    return parseCursorTrack(JSON.parse(await readFile(join(sessionDir, CURSOR_FILE), 'utf8')))
  } catch {
    return null
  }
}

/** Começo de um cursor.json v1 (o gravador escreve `{"version":1,...` — JSON.stringify mantém a ordem das chaves). */
const HEADER_V1 = /^\s*\{\s*"version"\s*:\s*1\s*[,}]/
const HEADER_BYTES = 64

/**
 * Valor de `asset.cursor` para o asset da tela da gravação: CURSOR_FILE se o cursor.json existe e começa como uma
 * trilha v1; senão null. Barato (lê só o cabeçalho, síncrono no main). Um corpo inválido com cabeçalho certo deixa o
 * flag, e a leitura completa (readSessionCursorTrack) devolve null — o editor trata como "sem dados".
 */
export function sessionCursorRef(sessionDir: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(join(sessionDir, CURSOR_FILE), 'r')
    const buf = Buffer.alloc(HEADER_BYTES)
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0)
    return HEADER_V1.test(buf.subarray(0, n).toString('utf8')) ? CURSOR_FILE : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* melhor esforço */
      }
    }
  }
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
