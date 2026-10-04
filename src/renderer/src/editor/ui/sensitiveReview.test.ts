import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import type { Asset, MediaItem, Project, Track, Us } from '@shared/editor/project'
import type { SensitiveKind } from '@shared/editor/sensitive'
import type { Occurrence } from '@shared/editor/sensitiveScan'
import { sourceTimeUs } from '@shared/editor/sourceTime'
import { useSensitiveScan } from '../state/sensitiveScan'
import {
  ALL_KINDS,
  buildRows,
  checkedRows,
  clipSourceRange,
  formatSpan,
  hideRows,
  hideToast,
  OCR_LANG_HINT,
  ocrUnavailableHint,
  kindCounts,
  mergeRanges,
  parseCustomWords,
  planScan,
  SCAN_CONVERSION_PENDING,
  SCAN_COVERAGE_CHANGED,
  SCAN_MERGE_GAP_US,
  scanBlockedReason,
  scanCoverageChanged,
  thumbCrop,
  visibleRows,
  type ReviewRow
} from './sensitiveReview'

const S = 1_000_000
const file = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 120 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready', ...extra })
const vtrack = (id: string, items: MediaItem[], extra: Partial<Track> = {}): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items, ...extra })
const clip = (a: Asset, id: string, startUs: Us, durationUs: Us, extra: Partial<MediaItem> = {}): MediaItem => ({ ...createMediaItem(a, startUs, 'video'), id, durationUs, ...extra })
function project(assets: Asset[], tracks: Track[]): Project {
  const p = createEmptyProject('t', { fps: 30 })
  p.assets = assets
  p.tracks = tracks
  return p
}
function occ(id: string, kind: SensitiveKind, fromUs: Us, toUs: Us, extra: Partial<Occurrence> = {}): Occurrence {
  const samples = []
  for (let t = fromUs; t <= toUs; t += 500_000) samples.push({ tUs: t, box: { x: 0.3, y: 0.4, w: 0.12, h: 0.03 }, src: 'ocr' as const })
  return { id, kind, masked: '***.456.***-**', confidence: 'validated', samples, firstSeenUs: fromUs, lastSeenUs: toUs, startUs: Math.max(0, fromUs - 500_000), endUs: toUs + 500_000, sourceW: 1920, sourceH: 1080, ...extra }
}

describe('o que varrer', () => {
  const A = file('A'), B = file('B', { videoTrackIndex: 1, source: { type: 'session', sessionId: 's', stream: 'webcam' } })
  const img: Asset = { ...file('I'), kind: 'image', durationUs: null }
  it('trecho da fonte de cada clipe (velocidade, congelado)', () => {
    expect(clipSourceRange(clip(A, 'c', 0, 4 * S, { inUs: 2 * S }), A)).toEqual({ fromUs: 2 * S, toUs: 6 * S })
    expect(clipSourceRange(clip(A, 'c', 0, 4 * S, { inUs: 2 * S, speed: 2 }), A)).toEqual({ fromUs: 2 * S, toUs: 10 * S })
    expect(clipSourceRange(clip(A, 'c', 0, 4 * S, { freeze: { atUs: 7 * S } } as Partial<MediaItem>), A)).toEqual({ fromUs: 7 * S, toUs: 7 * S + 1 })
  })
  it('união por arquivo: trechos próximos se juntam, distantes ficam separados', () => {
    expect(mergeRanges([{ fromUs: 10 * S, toUs: 20 * S }, { fromUs: 0, toUs: 5 * S }, { fromUs: 15 * S, toUs: 25 * S }])).toEqual([{ fromUs: 0, toUs: 25 * S }])
    expect(mergeRanges([{ fromUs: 0, toUs: S }, { fromUs: S + SCAN_MERGE_GAP_US + 1, toUs: 100 * S }])).toHaveLength(2)
  })
  it('um pedido por arquivo, na ordem da timeline, com a faixa de vídeo (R23); desativados e áudio fora; imagem contada como não suportada', () => {
    const p = project([A, B, img], [
      vtrack('v1', [clip(B, 'b1', 0, 2 * S), clip(A, 'a1', 2 * S, 3 * S, { inUs: 50 * S }), clip(A, 'a2', 5 * S, 3 * S, { inUs: 10 * S }), clip(A, 'off', 8 * S, 3 * S, { inUs: 100 * S, enabled: false })]),
      vtrack('v2', [clip(img, 'i1', 0, 2 * S)])
    ])
    const plan = planScan(p)
    expect(plan.unsupported).toBe(1)
    expect(plan.jobs.map((j) => j.assetId)).toEqual(['B', 'A'])
    expect(plan.jobs[0]).toMatchObject({ videoStreamIndex: 1, clipIds: ['b1'] })
    expect(plan.jobs[1]).toMatchObject({ videoStreamIndex: 0, clipIds: ['a1', 'a2'], ranges: [{ fromUs: 10 * S, toUs: 13 * S }, { fromUs: 50 * S, toUs: 53 * S }] }) // 37 s de vão: duas varreduras
    // menu do clipe: só ele
    expect(planScan(p, 'a2').jobs).toEqual([{ assetId: 'A', videoStreamIndex: 0, clipIds: ['a2'], ranges: [{ fromUs: 10 * S, toUs: 13 * S }] }])
    expect(planScan(p, 'off').jobs).toEqual([])
  })
})

describe('fonte da varredura = o que o editor decodifica (intermediário)', () => {
  it('asset com intermediário: o pedido marca `intermediate` e usa a faixa v:0 (a única do intermediário)', () => {
    const X = file('X', { intermediate: 'proxies/X.intermediate.mp4', videoTrackIndex: 1 })
    const p = project([X], [vtrack('v1', [clip(X, 'x1', 0, 2 * S)])])
    expect(planScan(p).jobs).toEqual([{ assetId: 'X', videoStreamIndex: 0, intermediate: true, clipIds: ['x1'], ranges: [{ fromUs: 0, toUs: 2 * S }] }])
  })
  it('conversão pendente (vídeo ou áudio não decodificável e sem intermediário): recusa com motivo', () => {
    const v = file('V', { video: { ...file('V').video!, decodable: false } })
    const a = file('U', { audio: { sampleRate: 48000, channels: 2, codec: 'ac-3', decodable: false } } as Partial<Asset>)
    expect(scanBlockedReason(v)).toBe(SCAN_CONVERSION_PENDING)
    expect(scanBlockedReason(a)).toBe(SCAN_CONVERSION_PENDING)
    expect(scanBlockedReason({ ...v, intermediate: 'proxies/V.intermediate.mp4' })).toBeNull()
    expect(scanBlockedReason(file('A'))).toBeNull()
    expect(SCAN_CONVERSION_PENDING).toMatch(/convers/)
  })
})

describe('trechos varridos × clipes de agora (aviso ao esconder)', () => {
  const A = file('A')
  const o = occ('s:o1', 'cpf', 12 * S, 13 * S)
  const scanOf = (p: Project, onlyClipId?: string) => {
    const j = planScan(p, onlyClipId).jobs[0]
    return { assetId: j.assetId, ...(onlyClipId ? { clipIds: j.clipIds } : {}), scanned: { ranges: j.ranges, clipIds: j.clipIds }, occurrences: [o] }
  }
  it('clipes iguais aos da busca: sem aviso', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S, { inUs: 10 * S })])])
    const rows = buildRows(p, [scanOf(p)])
    expect(rows[0].scanned).toEqual({ ranges: [{ fromUs: 10 * S, toUs: 20 * S }], clipIds: ['a1'] })
    expect(scanCoverageChanged(p, rows)).toBe(false)
    // clipe encurtado continua coberto
    const shorter = project([A], [vtrack('v1', [clip(A, 'a1', 0, 5 * S, { inUs: 12 * S })])])
    expect(scanCoverageChanged(shorter, rows)).toBe(false)
  })
  it('clipe alongado para fora do trecho varrido: avisa', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S, { inUs: 10 * S })])])
    const rows = buildRows(p, [scanOf(p)])
    const longer = project([A], [vtrack('v1', [clip(A, 'a1', 0, 15 * S, { inUs: 10 * S })])])
    expect(scanCoverageChanged(longer, rows)).toBe(true)
    // um clipe novo do mesmo arquivo, fora do trecho, também recebe efeitos: avisa
    const added = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S, { inUs: 10 * S }), clip(A, 'n', 10 * S, 5 * S, { inUs: 90 * S, enabled: false })])])
    expect(scanCoverageChanged(added, rows)).toBe(true)
  })
  it('busca pelo menu do clipe e o clipe varrido sumiu (dividido): avisa; o clipe-alvo é só o pedido', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S, { inUs: 10 * S }), clip(A, 'a2', 10 * S, 10 * S, { inUs: 60 * S })])])
    const rows = buildRows(p, [scanOf(p, 'a1')])
    expect(scanCoverageChanged(p, rows)).toBe(false) // a2 fora do trecho, mas não é alvo
    const split = project([A], [vtrack('v1', [clip(A, 'a1b', 0, 10 * S, { inUs: 10 * S }), clip(A, 'a2', 10 * S, 10 * S, { inUs: 60 * S })])])
    expect(scanCoverageChanged(split, rows)).toBe(true)
    expect(SCAN_COVERAGE_CHANGED).toBe('O clipe mudou desde a busca; procure de novo para cobrir o trecho novo.')
  })
  it('linhas sem registro do trecho varrido (antigas): sem aviso', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S, { inUs: 10 * S })])])
    expect(scanCoverageChanged(p, buildRows(p, [{ assetId: 'A', occurrences: [o] }]))).toBe(false)
  })
})

describe('palavras personalizadas', () => {
  it('linha ou vírgula, sem vazias/repetidas, espaços normalizados', () => {
    expect(parseCustomWords('Fulano Exemplo\n  ACME  Ltda , fulano exemplo,,\n\nProjeto X')).toEqual({ words: ['Fulano Exemplo', 'ACME Ltda', 'Projeto X'], dropped: 0, tooLong: 0 })
  })
  it('até 50, cada uma com até 100 caracteres', () => {
    const r = parseCustomWords([...Array.from({ length: 55 }, (_, i) => `termo ${i}`), 'x'.repeat(101)].join('\n'))
    expect(r.words).toHaveLength(50)
    expect(r.dropped).toBe(5)
    expect(r.tooLong).toBe(1)
  })
})

describe('lista de revisão', () => {
  const A = file('A')
  it('linhas na ordem da timeline; o playhead vai ao 1º instante visível (avanço, velocidade, reverso); ocorrência fora dos clipes não entra', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S, { inUs: 20 * S }), clip(A, 'a2', 10 * S, 5 * S, { inUs: 40 * S, speed: 2 }), clip(A, 'r', 15 * S, 4 * S, { inUs: 60 * S, reverse: true })])])
    const rows = buildRows(p, [{ assetId: 'A', occurrences: [occ('s:o1', 'cpf', 44 * S, 46 * S), occ('s:o2', 'email', 25 * S, 27 * S), occ('s:o3', 'phone', 35 * S, 36 * S), occ('s:o4', 'card', 61 * S, 62 * S)] }])
    expect(rows.map((r) => r.id)).toEqual(['s:o2', 's:o1', 's:o4'])
    const [e, c, r] = rows
    expect(e).toMatchObject({ clipId: 'a1', atUs: 5 * S, clips: 1 })
    expect(c).toMatchObject({ clipId: 'a2', atUs: 12 * S })
    // reverso: aparece primeiro no último quadro visto
    expect(r.clipId).toBe('r')
    const src = sourceTimeUs(p.tracks[0].items[2] as MediaItem, A, r.atUs)
    expect(src).toBeGreaterThanOrEqual(61 * S)
    expect(src).toBeLessThanOrEqual(62 * S + 500_000)
    for (const row of rows) {
      expect(row.fromUs).toBeLessThanOrEqual(row.atUs)
      expect(row.toUs).toBeGreaterThan(row.atUs)
      expect(row.box.w).toBeGreaterThan(0)
    }
    expect(formatSpan(e.fromUs, e.toUs, 30)).toMatch(/^00:0\d:\d\d – 00:0\d:\d\d$/)
  })
  it('a mesma fonte em 2 clipes: uma linha, conta os clipes; com clipIds (menu) só o clipe pedido', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S), clip(A, 'a2', 10 * S, 10 * S)])])
    const o = occ('s:o1', 'cpf', 2 * S, 3 * S)
    expect(buildRows(p, [{ assetId: 'A', occurrences: [o] }])[0]).toMatchObject({ clipId: 'a1', clips: 2, atUs: 2 * S })
    expect(buildRows(p, [{ assetId: 'A', clipIds: ['a2'], occurrences: [o] }])[0]).toMatchObject({ clipId: 'a2', clips: 1, atUs: 12 * S, clipIds: ['a2'] })
  })
  it('filtros por tipo, ignoradas e seleção (todas marcadas por padrão)', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 100 * S)])])
    const rows = buildRows(p, [{ assetId: 'A', occurrences: [occ('o1', 'cpf', S, 2 * S), occ('o2', 'email', 3 * S, 4 * S), occ('o3', 'cpf', 5 * S, 6 * S), occ('o4', 'custom', 7 * S, 8 * S)] }])
    expect(kindCounts(rows)).toEqual([{ kind: 'cpf', label: 'CPF', n: 2 }, { kind: 'email', label: 'E-mail', n: 1 }, { kind: 'custom', label: 'Termo personalizado', n: 1 }])
    const none = new Set<string>()
    expect(visibleRows(rows, null, none)).toHaveLength(4)
    expect(visibleRows(rows, new Set<SensitiveKind>(['cpf', 'custom']), none).map((r) => r.id)).toEqual(['o1', 'o3', 'o4'])
    expect(visibleRows(rows, new Set(), new Set(['o1'])).map((r) => r.id)).toEqual(['o2', 'o3', 'o4'])
    expect(checkedRows(rows, new Set(['o2'])).map((r) => r.id)).toEqual(['o1', 'o3', 'o4'])
  })
  it('desempenho: alternar o filtro com 300 linhas < 16 ms', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 120 * S)])])
    const kinds = ALL_KINDS
    const occs = Array.from({ length: 300 }, (_, i) => occ(`o${i}`, kinds[i % kinds.length], (i % 200) * 500_000 + S, (i % 200) * 500_000 + 2 * S))
    const rows = buildRows(p, [{ assetId: 'A', occurrences: occs }])
    expect(rows).toHaveLength(300)
    const ignored = new Set(['o3', 'o9'])
    const unchecked = new Set(['o4'])
    let worst = 0
    for (let k = 0; k < 40; k++) {
      const f = new Set<SensitiveKind>(k % 2 ? [kinds[k % kinds.length]] : [])
      const t0 = performance.now()
      const shown = visibleRows(rows, f, ignored)
      kindCounts(visibleRows(rows, null, ignored))
      checkedRows(shown, unchecked)
      worst = Math.max(worst, performance.now() - t0)
    }
    expect(worst).toBeLessThan(16)
  })
})

describe('aplicação', () => {
  const A = file('A'), B = file('B')
  it('um projeto novo com os efeitos de todos os arquivos; menu do clipe → só nele; toast com contagens', () => {
    const p = project([A, B], [vtrack('v1', [clip(A, 'a1', 0, 10 * S), clip(B, 'b1', 10 * S, 10 * S), clip(A, 'a2', 20 * S, 10 * S)])])
    const rows = buildRows(p, [{ assetId: 'A', occurrences: [occ('x:o1', 'cpf', 2 * S, 3 * S)] }, { assetId: 'B', occurrences: [occ('y:o1', 'email', 2 * S, 3 * S)] }])
    const o = hideRows(p, rows, 'blur')
    expect(o.project).not.toBe(p)
    // CPF em a1 e a2 (mesma fonte), e-mail em b1
    expect(o.itemIds).toHaveLength(3)
    expect(o.notHidden).toBe(0)
    expect(o.notHiddenIds.size).toBe(0)
    expect(hideToast(o)).toEqual({ title: '2 dados escondidos (3 efeitos criados)' })
    const fx = o.project.tracks.flatMap((t) => t.items).filter((i) => i.type === 'effect')
    expect(fx.map((f) => f.type === 'effect' && f.attach?.mediaItemId).sort()).toEqual(['a1', 'a2', 'b1'])
    expect(fx.every((f) => f.type === 'effect' && f.effect === 'blur')).toBe(true)
    // menu do clipe a2
    const only = buildRows(p, [{ assetId: 'A', clipIds: ['a2'], occurrences: [occ('z:o1', 'cpf', 2 * S, 3 * S)] }])
    const o2 = hideRows(p, only, 'solid')
    expect(o2.itemIds).toHaveLength(1)
    const f2 = o2.project.tracks.flatMap((t) => t.items).find((i) => i.id === o2.itemIds[0])
    expect(f2?.type === 'effect' && f2.attach?.mediaItemId).toBe('a2')
    expect(f2?.type === 'effect' && f2.effect).toBe('solid')
  })
  it('faixa bloqueada: pulado e avisado (nunca silêncio)', () => {
    const p = project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S)], { locked: true })])
    const rows = buildRows(p, [{ assetId: 'A', occurrences: [occ('x:o1', 'cpf', 2 * S, 3 * S), occ('x:o2', 'cpf', 5 * S, 6 * S)] }])
    const o = hideRows(p, rows, 'blur')
    expect(o.itemIds).toHaveLength(0)
    expect(o.notHidden).toBe(2)
    expect([...o.notHiddenIds].sort()).toEqual(['x:o1', 'x:o2'])
    expect(hideToast(o)).toEqual({ title: '0 dados escondidos (0 efeitos criados)', description: '2 não puderam ser escondidos (faixa bloqueada)' })
    expect(hideToast({ requested: 3, notHidden: 1, itemIds: ['e1', 'e2'], skipped: [{ occurrenceId: 'a', reason: 'locked' }] })).toEqual({ title: '2 dados escondidos (2 efeitos criados)', description: '1 não pôde ser escondido (faixa bloqueada)' })
  })
  it('aviso diz o motivo real de cada pulo (fora dos clipes × faixa bloqueada)', () => {
    const notIn = { requested: 2, notHidden: 1, itemIds: ['e1'], skipped: [{ occurrenceId: 'a', reason: 'notInClip' as const }] }
    expect(hideToast(notIn).description).toBe('1 não pôde ser escondido (o trecho não aparece em nenhum clipe da linha do tempo)')
    expect(hideToast(notIn).description).not.toMatch(/bloqueada/)
    // ocorrência com os dois motivos conta como bloqueada (é o que o usuário pode resolver); as partes somam o total
    const mixed = {
      requested: 5, notHidden: 3, itemIds: ['e1', 'e2'],
      skipped: [{ occurrenceId: 'a', reason: 'locked' as const }, { occurrenceId: 'b', reason: 'notInClip' as const }, { occurrenceId: 'c', reason: 'notInClip' as const }, { occurrenceId: 'a', reason: 'notInClip' as const }]
    }
    expect(hideToast(mixed).description).toBe('3 não puderam ser escondidos (1 em faixa bloqueada; 2 não aparecem em nenhum clipe da linha do tempo)')
    // ponta a ponta: asset sem clipe → notInClip
    const p = project([A], [vtrack('v1', [])])
    const o = hideRows(p, buildRows(project([A], [vtrack('v1', [clip(A, 'a1', 0, 10 * S)])]), [{ assetId: 'A', occurrences: [occ('x:o1', 'cpf', 2 * S, 3 * S)] }]), 'blur')
    expect(o.skipped.map((s) => s.reason)).toEqual(['notInClip'])
    expect(hideToast(o).description).toMatch(/não aparece em nenhum clipe/)
  })
  it('dica do OCR indisponível conforme o motivo (idioma só quando falta idioma)', () => {
    expect(ocrUnavailableHint('noLanguage')).toBe(OCR_LANG_HINT)
    for (const r of ['powershell', 'stopped', undefined] as const) expect(ocrUnavailableHint(r)).not.toBe(OCR_LANG_HINT)
    expect(ocrUnavailableHint('powershell')).toMatch(/PowerShell do Windows pode estar bloqueado/)
    expect(ocrUnavailableHint('stopped')).toMatch(/Tente de novo/)
  })
})

describe('miniatura', () => {
  it('recorte na proporção da miniatura, com folga, dentro do quadro', () => {
    const c = thumbCrop({ x: 0.3, y: 0.4, w: 0.12, h: 0.03 }, 1920, 1080, 160 / 60)
    expect(c.w / c.h).toBeCloseTo(160 / 60, 1)
    expect(c.x).toBeLessThanOrEqual(0.3 * 1920)
    expect(c.x + c.w).toBeGreaterThanOrEqual(0.42 * 1920)
    const edge = thumbCrop({ x: 0.95, y: 0.97, w: 0.05, h: 0.03 }, 1920, 1080, 160 / 60)
    expect(edge.x + edge.w).toBeLessThanOrEqual(1920)
    expect(edge.y + edge.h).toBeLessThanOrEqual(1080)
  })
})

describe('privacidade do diálogo', () => {
  it('fechar apaga termos, resultados, miniaturas e o contorno da memória', () => {
    const s = useSensitiveScan.getState()
    s.openDialog('a1')
    const row = { id: 'x:o1' } as ReviewRow
    useSensitiveScan.getState().patch({ wordsText: 'Fulano Exemplo', rows: [row], thumbs: { 'x:o1': 'data:image/png;base64,AAAA' }, unchecked: new Set(['x:o1']), ignored: new Set(['x:o2']), hover: { itemId: 'a1', tUs: 1, box: { x: 0, y: 0, w: 1, h: 1 } }, step: 'review', style: 'solid' })
    useSensitiveScan.getState().close()
    const c = useSensitiveScan.getState()
    expect(c.open).toBe(false)
    expect(c.clipId).toBeNull()
    expect(c.wordsText).toBe('')
    expect(c.rows).toEqual([])
    expect(c.thumbs).toEqual({})
    expect(c.unchecked.size + c.ignored.size).toBe(0)
    expect(c.hover).toBeNull()
    expect(c.step).toBe('setup')
    expect(c.style).toBe('blur')
    // reabrir começa do zero (todos os tipos marcados)
    c.openDialog(null)
    expect(useSensitiveScan.getState().kinds).toEqual(ALL_KINDS)
    expect(useSensitiveScan.getState().wordsText).toBe('')
    useSensitiveScan.getState().close()
  })
  it('o caminho do diálogo não grava nada: sem localStorage/sessionStorage/IndexedDB, configurações, arquivos ou log', () => {
    const files = ['ui/sensitiveReview.ts', 'ui/sensitiveFlow.ts', 'ui/sensitiveThumbs.ts', 'ui/SensitiveDialog.tsx', 'ui/viewer/SensitiveOutline.tsx', 'state/sensitiveScan.ts']
    for (const f of files) {
      // sem os comentários (que explicam justamente o que NÃO se faz)
      const src = readFileSync(join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB|api\.settings|setSettings|console\.|writeFile|saveText|\.save\(/)
    }
  })
})
