import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities, htmlNotesToText, notesToLines } from './releaseNotes'

describe('notesToLines (markdown/texto)', () => {
  it('reconhece títulos, itens e parágrafos e junta linhas em branco', () => {
    const md = '# Novidades\n\n\n- Exportação **mais rápida**\n* Corrige `crash` ao pausar\n1. Item numerado\n\nTexto solto [com link](https://x.y).\n\n'
    expect(notesToLines(md)).toEqual([
      { kind: 'heading', text: 'Novidades' },
      { kind: 'blank', text: '' },
      { kind: 'bullet', text: 'Exportação mais rápida' },
      { kind: 'bullet', text: 'Corrige crash ao pausar' },
      { kind: 'bullet', text: 'Item numerado' },
      { kind: 'blank', text: '' },
      { kind: 'paragraph', text: 'Texto solto com link.' }
    ])
  })
  it('aceita CRLF e texto sem marcação', () => {
    expect(notesToLines('Só um aviso.\r\nSegunda linha.')).toEqual([
      { kind: 'paragraph', text: 'Só um aviso.' },
      { kind: 'paragraph', text: 'Segunda linha.' }
    ])
    expect(notesToLines('')).toEqual([])
  })
})

describe('notesToLines (HTML do feed do GitHub)', () => {
  it('converte p/ul/li/h2 em linhas sem tags', () => {
    const html = '<h2>Correções</h2>\n<p>Esta versão traz:</p>\n<ul>\n<li>Gravação <strong>estável</strong> em 1440p</li>\n<li>Atalhos &amp; anotações &lt;melhores&gt;</li>\n</ul>\n<p>Obrigado!<br>Equipe Cia Light</p>'
    expect(notesToLines(html)).toEqual([
      { kind: 'heading', text: 'Correções' },
      { kind: 'paragraph', text: 'Esta versão traz:' },
      { kind: 'bullet', text: 'Gravação estável em 1440p' },
      { kind: 'bullet', text: 'Atalhos & anotações <melhores>' },
      { kind: 'paragraph', text: 'Obrigado!' },
      { kind: 'paragraph', text: 'Equipe Cia Light' }
    ])
  })
  it('ignora scripts, estilos e comentários', () => {
    const html = '<script>alert(1)</script><style>p{}</style><!-- x --><p>Ok</p>'
    expect(notesToLines(html)).toEqual([{ kind: 'paragraph', text: 'Ok' }])
  })
  it('lida com listas aninhadas e numeradas', () => {
    const html = '<ol><li>Um<ul><li>Sub</li></ul></li><li>Dois</li></ol>'
    expect(notesToLines(html).map((l) => `${l.kind}:${l.text}`)).toEqual(['bullet:Um', 'bullet:Sub', 'bullet:Dois'])
  })
  it('não trata texto com «<» solto como HTML', () => {
    expect(notesToLines('a < b e c > d')).toEqual([{ kind: 'paragraph', text: 'a < b e c > d' }])
  })
})

describe('utilitários', () => {
  it('decodeHtmlEntities cobre nomeadas, decimais e hex', () => {
    expect(decodeHtmlEntities('&amp;&nbsp;&#233;&#xE7;&mdash;&desconhecida;')).toBe('& éç—&desconhecida;')
  })
  it('htmlNotesToText devolve markdown simples', () => {
    expect(htmlNotesToText('<h3>T</h3><ul><li>a</li></ul>').replace(/\n+/g, '\n').trim()).toBe('# T\n- a')
  })
})
