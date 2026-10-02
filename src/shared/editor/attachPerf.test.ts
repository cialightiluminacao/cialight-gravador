import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachEffects } from './followTransform'
import { deleteRanges, updateItem, updateTrack } from './ops'
import { privacyWarnings } from './privacy'
import type { Anim, Asset, EffectItem, MediaItem, Project, Track } from './project'
import { reframeProject } from './reframe'
import { resolveFrame } from './resolve'
import { toDiskProject } from './schema'
import { applyKenBurns } from './zoom'

// Desempenho da manutenção das âncoras (maintainAttachments roda em toda edição): projeto de 1 h com um efeito ancorado
// num clipe com Ken Burns, cortado em 301 pedaços (como o corte de silêncios).
const S = 1_000_000
const H1 = 3600 * S
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: H1 + 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }

/**
 * Projeto de 1 h com Ken Burns no clipe e o blur vinculado; `anchored` = o blur ancorado ao clipe. `inverted`: também
 * um "Borrar tudo menos…" (invertido) vinculado, numa faixa acima — ancorado junto.
 */
function hourProject(anchored = true, inverted = false): Project {
  const p = createEmptyProject('perf')
  p.assets = [vid]
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', durationUs: H1, linkId: 'l1' } as MediaItem
  const fx = { ...createEffectItem('blur', 0, H1, { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }), id: 'fx', linkId: 'l1' } as EffectItem
  const track = (id: string, name: string, items: Track['items'], role?: 'effects'): Track => ({ id, kind: 'video', name, ...(role ? { role } : {}), muted: false, hidden: false, locked: false, volume: 1, items })
  p.tracks = [track('tv', 'Vídeo', [m]), track('tf', 'Efeitos', [fx], 'effects')]
  if (inverted) p.tracks.push(track('tg', 'Efeitos 2', [{ ...createEffectItem('blur', 0, H1, { x: 0.6, y: 0.5, w: 0.3, h: 0.3 }), id: 'fi', linkId: 'l1', invert: true } as EffectItem], 'effects'))
  const kb = applyKenBurns(p, 'm', 'br').project
  return anchored ? attachEffects(kb, 'm', inverted ? ['fx', 'fi'] : ['fx']) : kb
}
/** 300 silêncios de 1 s, um a cada 12 s. */
const silences = Array.from({ length: 300 }, (_, i) => ({ fromUs: (i * 12 + 6) * S, toUs: (i * 12 + 7) * S }))
/** Pior caso do corte de silêncios: 1200 trechos de 0,5 s, um a cada 3 s. */
const silences1200 = Array.from({ length: 1200 }, (_, i) => ({ fromUs: i * 3 * S + 1.5 * S, toUs: i * 3 * S + 2 * S }))
const ms = (f: () => void): number => {
  const t = performance.now()
  f()
  return performance.now() - t
}
/**
 * Custo da âncora sem depender da carga da máquina: `anchored` e `plain` (a mesma edição no mesmo projeto sem âncora)
 * medidos intercalados, depois de aquecer o JIT (`warm` chamadas de cada: com a máquina ocupada o JIT otimiza mais
 * tarde, e uma edição de ~1 ms medida a frio chegou a 14× a outra), e comparados pelo melhor de cada. O tempo
 * absoluto de um teste de desempenho no vitest (arquivos em paralelo, outros processos) varia ~25× com a carga — um
 * limite em ms dava falha intermitente (o corte de 1 h: ~40 ms sozinho, ~95 ms na suíte inteira contra o limite de
 * 200 ms); a razão entre as duas medidas no mesmo instante varia pouco (1,6–2,0).
 */
function overhead(anchored: () => void, plain: () => void, rounds: number, warm = 1): { anchored: number; plain: number; ratio: number } {
  for (let i = 0; i < warm; i++) {
    anchored()
    plain()
  }
  let a = Infinity, b = Infinity
  for (let i = 0; i < rounds; i++) {
    a = Math.min(a, ms(anchored))
    b = Math.min(b, ms(plain))
  }
  return { anchored: a, plain: b, ratio: a / b }
}

// projeto de 1 h montado e cortado várias vezes: com a máquina ocupada passa dos 5 s padrão do vitest
const PERF_TIMEOUT_MS = 30_000

describe('desempenho das âncoras', () => {
  it('corte de silêncios (deleteRanges, 300 trechos) num projeto de 1 h com efeito ancorado: até 3× o corte sem âncora (sozinho ≈ 40 ms; teto 2 s)', () => {
    const p = hourProject()
    const plain = hourProject(false)
    const cut = deleteRanges(p, silences)
    const fxs = cut.tracks[1].items as EffectItem[]
    expect(fxs).toHaveLength(301)
    // cada pedaço ancorado no pedaço do clipe que ele cruza, com a caixa de reserva
    const media = new Set(cut.tracks[0].items.map((i) => i.id))
    expect(fxs.every((f) => f.attach && media.has(f.attach.mediaItemId) && f.attach.fallback)).toBe(true)
    expect(new Set(fxs.map((f) => f.attach!.mediaItemId)).size).toBe(301)
    const t = overhead(() => deleteRanges(p, silences), () => deleteRanges(plain, silences), 5)
    // manter as âncoras não muda a ordem do custo (quadrático nos pedaços daria dezenas de ×)
    expect(t.ratio).toBeLessThan(3)
    // teto de catástrofe (sob carga pesada o corte inteiro chegou a ~1 s)
    expect(t.anchored).toBeLessThan(2000)
  }, PERF_TIMEOUT_MS)
  it('301 pedaços ancorados + edição trivial (renomear faixa): no máximo 5× a mesma edição sem âncora, sem trocar nenhum efeito', () => {
    const cut = deleteRanges(hourProject(), silences)
    const cutPlain = deleteRanges(hourProject(false), silences)
    let n = 0
    const t = overhead(() => updateTrack(cut, 'tv', { name: `Vídeo ${++n}` }), () => updateTrack(cutPlain, 'tv', { name: `Vídeo ${++n}` }), 15, 50)
    // a edição trivial não recalcula nem troca nenhum efeito
    const q = updateTrack(cut, 'tv', { name: 'X' })
    expect(q.tracks[1].items.every((it, i) => it === cut.tracks[1].items[i])).toBe(true)
    // sozinho: ~0,65 ms × ~0,5 ms sem âncora
    expect(t.ratio).toBeLessThan(5)
    expect(t.anchored).toBeLessThan(200)
  }, PERF_TIMEOUT_MS)
})

/** Melhor de `n` medidas (a carga da suíte em paralelo varia muito; a primeira chamada aquece o JIT e os índices). */
const best = (n: number, f: () => void): number => {
  let b = Infinity
  for (let i = 0; i < n; i++) b = Math.min(b, ms(f))
  return b
}

// Revisão final da F4 (I-2): reenquadrar, privacidade e gravação em projetos de 1 h. Antes: attachedMedia varria o
// projeto a cada amostra, as buscas por id do reenquadrar também, e a privacidade era efeitos × clipes — 1200 cortes
// com efeito normal + invertido ancorados levavam ~35 s para reenquadrar, e o autosave recalculava as caixas do disco
// de todos os ancorados a cada 1 s. Sozinho (esta máquina): 300 cortes ~0,5 s; 1200 cortes ~1,3–3 s; disco sem
// mudança ~2 ms (mesmos objetos) e ~10 ms (projeto parseado de novo, como no processo principal).
describe('desempenho F4 em projetos de 1 h (reenquadrar, privacidade, gravação, quadro)', () => {
  it('reenquadrar 9:16 um projeto de 1 h (300 cortes, Ken Burns, blur ancorado, ponto de foco): ≤ 1,5 s', () => {
    const p = deleteRanges(hourProject(), silences)
    expect(p.tracks[1].items).toHaveLength(301)
    const focus = { [p.tracks[0].items[10].id]: [{ localUs: 0, x: 0.7, y: 0.5 }] }
    expect(best(2, () => reframeProject(p, '9:16', { mode: 'cover', focus }))).toBeLessThanOrEqual(1500)
  }, PERF_TIMEOUT_MS * 2)

  it('pior caso: 1200 cortes com blur normal + invertido ancorados (2400 efeitos): reenquadrar ≤ 8 s; privacidade de 1 h ≤ 150 ms', () => {
    const p = deleteRanges(hourProject(true, true), silences1200)
    expect(p.tracks[1].items).toHaveLength(1201)
    expect(p.tracks[2].items).toHaveLength(1201)
    let r: ReturnType<typeof reframeProject> | null = null
    expect(ms(() => (r = reframeProject(p, '9:16', { mode: 'cover' })))).toBeLessThanOrEqual(8000)
    expect(r!.project.canvas.width).toBe(1080)
    expect(best(3, () => privacyWarnings(p, 0, H1))).toBeLessThanOrEqual(150)
  }, PERF_TIMEOUT_MS * 2)

  it('toDiskProject sem mudança (2400 ancorados): ≤ 20 ms nos mesmos objetos e no projeto parseado de novo (IPC); a mudança refaz o que mudou', () => {
    const p = deleteRanges(hourProject(true, true), silences1200)
    const cold = JSON.stringify(toDiskProject(p))
    expect(best(3, () => toDiskProject(p))).toBeLessThanOrEqual(20)
    // o processo principal recebe o projeto pelo IPC e o parseia de novo: objetos novos, mesmo conteúdo
    const clones = [0, 1, 2].map(() => structuredClone(p))
    let i = 0
    expect(best(3, () => toDiskProject(clones[i++]))).toBeLessThanOrEqual(20)
    expect(JSON.stringify(toDiskProject(clones[0]))).toBe(cold)
    // mudança no clipe de uma âncora: a caixa é refeita — igual ao cálculo sem cache (outro id de projeto)
    const piece = p.tracks[0].items[5] as MediaItem
    const moved = updateItem<MediaItem>(p, piece.id, (d) => {
      d.visual!.transform.x = { value: 0.3 }
    })
    const warm = toDiskProject(moved) as Project
    const fresh = toDiskProject({ ...moved, id: 'p_sem_cache' }) as Project
    expect(JSON.stringify({ ...warm, id: 'p_sem_cache' })).toBe(JSON.stringify(fresh))
    expect(JSON.stringify(warm)).not.toBe(cold)
  }, PERF_TIMEOUT_MS * 2)

  it('resolveFrame com 50 itens × 13 propriedades animadas (curva bezier, presets pop/desfoque): ≤ 0,5 ms por quadro', () => {
    const p = createEmptyProject('quadro')
    p.assets = [vid]
    const D = 10 * S
    const anim = (a: number, b: number): Anim<number> => ({ value: a, keys: [{ tUs: 0, value: a, ease: { bezier: [0.3, 1.6, 0.6, 1] } }, { tUs: D / 2, value: b, ease: 'inOut' }, { tUs: D, value: a, ease: 'linear' }] })
    p.tracks = Array.from({ length: 50 }, (_, i): Track => {
      const m = { ...createMediaItem(vid, 0, 'video'), id: `m${i}`, durationUs: D } as MediaItem
      m.visual = {
        ...m.visual!,
        transform: { x: anim(0.2, 0.8), y: anim(0.3, 0.7), scale: anim(0.3, 0.5), rotation: anim(0, 30), opacity: anim(1, 0.6) },
        crop: { l: anim(0, 0.1), t: anim(0, 0.1), r: anim(0, 0.1), b: anim(0, 0.1) },
        adjust: { brightness: anim(0, 0.2), contrast: anim(0, 0.2), saturation: anim(0, 0.2) },
        shape: 'rounded',
        radius: anim(0, 40),
        animIn: { preset: i % 2 ? 'pop' : 'blur', durationUs: S, ease: 'out' },
        animOut: { preset: i % 2 ? 'blur' : 'pop', durationUs: S }
      }
      return { id: `t${i}`, kind: 'video', name: `V${i}`, muted: false, hidden: false, locked: false, volume: 1, items: [m] }
    })
    expect(resolveFrame(p, 0.5 * S)).toHaveLength(50)
    const FRAMES = 300
    const frames = (): void => {
      for (let k = 0; k < FRAMES; k++) resolveFrame(p, Math.round((k * D) / FRAMES))
    }
    frames()
    // sozinho ~0,03 ms por quadro
    expect(best(5, frames) / FRAMES).toBeLessThanOrEqual(0.5)
  })
})
