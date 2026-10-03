// Arquivos SRT no main: leitura com detecção de codificação (BOM UTF-8/UTF-16; sem BOM, UTF-8 se válido, senão
// Windows-1252 — o que o Bloco de Notas antigo e muitos sites gravam) e escrita em UTF-8 com BOM (players do Windows
// só acentuam direito com o BOM).
import { promises as fsp } from 'fs'
import { basename } from 'path'

/** Texto de um arquivo .srt em qualquer das codificações comuns. */
export function decodeSrtBytes(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3))
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2))
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16be(b.subarray(2))
  // UTF-16 sem BOM: texto latino tem um byte 0 em quase todo par (posição ímpar no LE, par no BE); o UTF-8 "válido"
  // cheio de NULs viraria só blocos ilegíveis
  const n = Math.min(b.length, 4096) >> 1
  if (n >= 4) {
    let even = 0, odd = 0
    for (let i = 0; i < n; i++) {
      if (b[2 * i] === 0) even++
      if (b[2 * i + 1] === 0) odd++
    }
    if (odd > n * 0.2 && even < n * 0.05) return new TextDecoder('utf-16le').decode(b.subarray(0, b.length - (b.length % 2)))
    if (even > n * 0.2 && odd < n * 0.05) return utf16be(b)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return new TextDecoder('windows-1252').decode(b)
  }
}

/** UTF-16 BE: troca os bytes e lê como LE (não depende do ICU). */
function utf16be(b: Uint8Array): string {
  const sw = new Uint8Array(b.length - (b.length % 2))
  for (let i = 0; i < sw.length; i += 2) {
    sw[i] = b[i + 1]
    sw[i + 1] = b[i]
  }
  return new TextDecoder('utf-16le').decode(sw)
}

/** Bytes do .srt: UTF-8 com BOM. */
export function encodeSrtFile(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
}

/**
 * Grava `<mesmo nome>.srt` ao lado do vídeo sem nunca sobrescrever (flag 'wx'): já existindo, devolve um aviso e não
 * toca no arquivo (a exportação com ".srt ao lado" já evita esse nome; isto é a última barreira).
 */
export async function writeSrtBesideFile(videoPath: string, text: string): Promise<{ path: string | null; warning?: string }> {
  const file = srtBesidePath(videoPath)
  try {
    await fsp.writeFile(file, encodeSrtFile(text), { flag: 'wx' })
    return { path: file }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return { path: null, warning: `Já existe “${basename(file)}” ao lado do vídeo: as legendas não foram gravadas para não sobrescrever esse arquivo.` }
  }
}

/** `<pasta>/<mesmo nome>.srt` ao lado do vídeo. */
export function srtBesidePath(videoPath: string): string {
  const slash = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'))
  const dot = videoPath.lastIndexOf('.')
  return `${dot > slash ? videoPath.slice(0, dot) : videoPath}.srt`
}
