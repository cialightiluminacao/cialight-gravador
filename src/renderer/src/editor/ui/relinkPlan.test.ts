import { describe, expect, it } from 'vitest'
import type { Asset } from '@shared/editor/project'
import { relinkApplyList, relinkRows, relinkSummary, setRowChecked, shortPath } from './relinkPlan'

const asset = (id: string, path: string, status: Asset['status'] = 'missing'): Asset =>
  ({ id, name: `${id}.mp4`, kind: 'video', durationUs: 1, status, source: { type: 'file', path, size: 1, mtimeMs: 0 } }) as Asset

describe('relinkRows', () => {
  it('junta nome e caminho antigo; todas marcadas; só mídias importadas ainda ausentes', () => {
    const assets = [asset('a', 'C:\\v\\a.mp4'), asset('b', 'C:\\v\\b.mp4', 'ready'), { ...asset('s', ''), source: { type: 'session', sessionId: 'x', stream: 'screen' } } as Asset]
    const rows = relinkRows(
      [
        { assetId: 'a', path: 'D:\\n\\a.mp4', confidence: 'exact' },
        { assetId: 'b', path: 'D:\\n\\b.mp4', confidence: 'exact' }, // já voltou (relink manual no meio)
        { assetId: 's', path: 'D:\\n\\s.mp4', confidence: 'exact' },
        { assetId: 'sumiu', path: 'D:\\n\\z.mp4', confidence: 'exact' }
      ],
      assets
    )
    expect(rows).toEqual([{ assetId: 'a', name: 'a.mp4', oldPath: 'C:\\v\\a.mp4', newPath: 'D:\\n\\a.mp4', checked: true }])
  })

  it('candidato repetido para o mesmo asset ou igual ao caminho antigo: fora', () => {
    const rows = relinkRows(
      [
        { assetId: 'a', path: 'D:\\a.mp4', confidence: 'exact' },
        { assetId: 'a', path: 'E:\\a.mp4', confidence: 'exact' },
        { assetId: 'c', path: 'C:\\v\\c.mp4', confidence: 'exact' }
      ],
      [asset('a', 'C:\\v\\a.mp4'), asset('c', 'C:\\v\\c.mp4')]
    )
    expect(rows.map((r) => r.newPath)).toEqual(['D:\\a.mp4'])
  })
})

describe('seleção → lista a aplicar', () => {
  it('desmarcadas ficam de fora, na ordem do diálogo', () => {
    const rows = relinkRows(
      ['a', 'b', 'c'].map((id) => ({ assetId: id, path: `D:\\${id}.mp4`, confidence: 'exact' as const })),
      ['a', 'b', 'c'].map((id) => asset(id, `C:\\${id}.mp4`))
    )
    const sel = setRowChecked(rows, 'b', false)
    expect(rows[1].checked).toBe(true) // imutável
    expect(relinkApplyList(sel)).toEqual([
      { assetId: 'a', newPath: 'D:\\a.mp4' },
      { assetId: 'c', newPath: 'D:\\c.mp4' }
    ])
    expect(relinkApplyList(setRowChecked(setRowChecked(sel, 'a', false), 'c', false))).toEqual([])
  })
})

describe('relinkSummary', () => {
  it('toast de sucesso no singular/plural e um erro por asset', () => {
    expect(relinkSummary([{ name: 'a.mp4' }])).toEqual({ success: '1 mídia reapontada', errors: [] })
    expect(relinkSummary([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toEqual({ success: '3 mídias reapontadas', errors: [] })
    expect(relinkSummary([{ name: 'a' }, { name: 'b.mp4', error: 'O arquivo escolhido não é do mesmo tipo da mídia original' }])).toEqual({
      success: '1 mídia reapontada',
      errors: ['Não foi possível reapontar “b.mp4”: O arquivo escolhido não é do mesmo tipo da mídia original']
    })
    expect(relinkSummary([])).toEqual({ success: null, errors: [] })
  })
})

describe('shortPath', () => {
  it('caminho longo: mantém o fim (pastas que mudaram + nome), cortando numa barra', () => {
    const p = 'C:\\Users\\Eduardo\\projetos\\_wt\\gravador\\test-out\\qa\\aulas\\originais\\aula-relink.mp4'
    expect(shortPath(p, 40)).toBe('…\\qa\\aulas\\originais\\aula-relink.mp4')
    expect(shortPath('C:\\a\\b.mp4', 40)).toBe('C:\\a\\b.mp4')
    expect(shortPath('/home/u/videos/aulas/x.mp4', 16)).toBe('…/aulas/x.mp4')
    expect(shortPath('x'.repeat(50), 10)).toBe('…' + 'x'.repeat(9))
  })
})
