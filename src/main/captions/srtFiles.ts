// Arquivos SRT no main: leitura com detecção de codificação (BOM UTF-8/UTF-16; sem BOM, UTF-8 se válido, senão
// Windows-1252 — o que o Bloco de Notas antigo e muitos sites gravam) e escrita em UTF-8 com BOM (players do Windows
// só acentuam direito com o BOM).

/** Texto de um arquivo .srt em qualquer das codificações comuns. */
export function decodeSrtBytes(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3))
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2))
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // UTF-16 BE: troca os bytes e lê como LE (não depende do ICU)
    const sw = new Uint8Array(b.length - 2 - (b.length % 2))
    for (let i = 0; i < sw.length; i += 2) {
      sw[i] = b[i + 3]
      sw[i + 1] = b[i + 2]
    }
    return new TextDecoder('utf-16le').decode(sw)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return new TextDecoder('windows-1252').decode(b)
  }
}

/** Bytes do .srt: UTF-8 com BOM. */
export function encodeSrtFile(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
}

/** `<pasta>/<mesmo nome>.srt` ao lado do vídeo. */
export function srtBesidePath(videoPath: string): string {
  const slash = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'))
  const dot = videoPath.lastIndexOf('.')
  return `${dot > slash ? videoPath.slice(0, dot) : videoPath}.srt`
}
