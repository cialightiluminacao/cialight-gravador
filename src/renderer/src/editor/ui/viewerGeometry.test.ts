import { describe, expect, it } from 'vitest'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { addAsset, insertItems } from '@shared/editor/ops'
import type { Asset, Project } from '@shared/editor/project'
import { cornerScale, hitTest, itemBoxes, rotateAngle, snapCenter } from './viewerGeometry'

const asset = (id: string, w: number, h: number): Asset => ({ id, name: id, kind: 'video', source: { type: 'generated', file: `${id}.mp4` }, durationUs: 5_000_000, status: 'ready', video: { width: w, height: h, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 } })

function project(): Project {
  let p = createEmptyProject('t') // 1920×1080, faixas: vídeo 1, áudio 1
  p = addAsset(addAsset(p, asset('full', 1920, 1080)), asset('pip', 640, 640))
  p = insertItems(p, p.tracks[0].id, [createMediaItem(p.assets[0], 0, 'video')], 'overwrite')
  const pip = createMediaItem(p.assets[1], 0, 'video')
  const v = pip.visual!
  const top = { id: 't_top', kind: 'video' as const, name: 'Vídeo 2', muted: false, hidden: false, locked: false, volume: 1, items: [] }
  p = { ...p, tracks: [...p.tracks, top] }
  return insertItems(p, 't_top', [{ ...pip, id: 'i_pip', visual: { ...v, transform: { ...v.transform, x: { value: 0.8 }, y: { value: 0.75 }, scale: { value: 0.25 } } } }], 'overwrite')
}

describe('viewerGeometry', () => {
  it('caixas das camadas de mídia em pixels do canvas (fundo → topo)', () => {
    const boxes = itemBoxes(project(), 1_000_000)
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toMatchObject({ cx: 960, cy: 540, w: 1920, h: 1080, rotation: 0 })
    // 640² contido em 1080 de altura → 1080², ×0,25 = 270
    expect(boxes[1]).toMatchObject({ itemId: 'i_pip', cx: 1536, cy: 810, rotation: 0 })
    expect(boxes[1].w).toBeCloseTo(270)
    expect(boxes[1].h).toBeCloseTo(270)
  })

  it('hitTest devolve o item mais ao topo sob o ponto, considerando rotação', () => {
    const boxes = itemBoxes(project(), 1_000_000)
    expect(hitTest(boxes, 1536, 810)).toBe('i_pip')
    expect(hitTest(boxes, 100, 100)).toBe(boxes[0].itemId)
    expect(hitTest(boxes, -10, 100)).toBeNull()
    const rotated = [{ ...boxes[1], rotation: 45 }]
    // canto do quadrado sem rotação (fora do losango girado)
    expect(hitTest(rotated, 1536 + 130, 810 + 130)).toBeNull()
    expect(hitTest(rotated, 1536 + 180, 810)).toBe('i_pip')
  })

  it('snapCenter gruda no centro a ±1 %', () => {
    expect(snapCenter(0.505)).toEqual({ value: 0.5, snapped: true })
    expect(snapCenter(0.489)).toEqual({ value: 0.489, snapped: false })
  })

  it('cornerScale: Shift mantém o centro; sem Shift o canto oposto fica parado', () => {
    const box = { itemId: 'x', cx: 100, cy: 100, w: 100, h: 50, rotation: 0 }
    // canto inferior direito (150,125) → (200,150): diagonal a partir do canto oposto (50,75) ×1,5
    const keep = cornerScale(box, 'br', { x: 200, y: 150 }, false)
    expect(keep.factor).toBeCloseTo(1.5)
    expect(keep.cx).toBeCloseTo(125) // canto oposto fixo → centro no meio da nova diagonal
    expect(keep.cy).toBeCloseTo(112.5)
    // a partir do centro (100,100): (50,25) → (100,50) = ×2
    const center = cornerScale(box, 'br', { x: 200, y: 150 }, true)
    expect(center.factor).toBeCloseTo(2)
    expect(center.cx).toBe(100)
    expect(center.cy).toBe(100)
  })

  it('rotateAngle: ângulo desde o início do arrasto, Shift em passos de 15°', () => {
    const c = { x: 0, y: 0 }
    expect(rotateAngle(c, { x: 0, y: -10 }, { x: 10, y: 0 }, 10, false)).toBeCloseTo(100)
    expect(rotateAngle(c, { x: 0, y: -10 }, { x: 10, y: 1 }, 0, true)).toBe(90)
  })
})
