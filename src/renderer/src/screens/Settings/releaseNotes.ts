// Notas de release → linhas simples para exibir na aba Atualização.
// O electron-updater entrega as notas cruas: com provider GitHub vêm do feed atom
// (HTML: <p>, <ul><li>, <h2>…); em outros casos, markdown/texto. Aqui tudo vira
// uma lista de linhas tipadas (título, item, parágrafo, em branco), sem tags.

export type NoteLine = { kind: 'heading' | 'bullet' | 'paragraph' | 'blank'; text: string }

const HTML_TAG_RE = /<[a-z][\s\S]*>/i

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©'
}

/** Decodifica entidades HTML comuns (nomeadas, decimais e hexadecimais). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const b = body.toLowerCase()
    if (b.startsWith('#x')) {
      const code = Number.parseInt(b.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (b.startsWith('#')) {
      const code = Number.parseInt(b.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[b] ?? whole
  })
}

/** Converte HTML de notas em texto «markdown-like» (# título, - item, parágrafos por linha). */
export function htmlNotesToText(html: string): string {
  let s = html.replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<h[1-6]\b[^>]*>/gi, '\n# ')
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<(p|div|ul|ol|blockquote|pre|table|tr|section|article|details|summary)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|div|ul|ol|li|h[1-6]|blockquote|pre|table|tr|section|article|details|summary)\s*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(s)
}

/** Remove marcação inline de markdown que não renderizamos (negrito, código, links). */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/**
 * Quebra notas (HTML ou markdown/texto) em linhas tipadas. Em markdown, linhas em branco
 * consecutivas viram uma só; em HTML elas são só ruído da marcação e são descartadas.
 */
export function notesToLines(raw: string): NoteLine[] {
  const isHtml = HTML_TAG_RE.test(raw)
  const text = isHtml ? htmlNotesToText(raw) : raw
  const out: NoteLine[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim()
    if (!t) {
      if (!isHtml && out.length && out[out.length - 1].kind !== 'blank') out.push({ kind: 'blank', text: '' })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(t)
    if (heading) {
      out.push({ kind: 'heading', text: stripInlineMarkdown(heading[1]) })
      continue
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(t)
    if (bullet) {
      out.push({ kind: 'bullet', text: stripInlineMarkdown(bullet[1]) })
      continue
    }
    out.push({ kind: 'paragraph', text: stripInlineMarkdown(t) })
  }
  while (out.length && out[out.length - 1].kind === 'blank') out.pop()
  return out
}
