import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import type { Asset, Project } from '@shared/editor/project'
import { aspectIdOf, canvasForAspect, firstMediaSize } from './aspects'

const withMedia = (p: Project, w: number, h: number, rotation: 0 | 90 = 0): Project => ({
  ...p,
  assets: [
    { id: 'aud', name: 'a', kind: 'audio', source: { type: 'generated', file: 'a' }, durationUs: 1, status: 'ready' },
    { id: 'v', name: 'v', kind: 'video', source: { type: 'generated', file: 'v' }, durationUs: 1, status: 'ready', video: { width: w, height: h, fps: 30, codec: 'avc1', rotation, decodable: true, gopUs: 1 } }
  ] as Asset[]
})

describe('proporções do projeto', () => {
  it('mantém o lado menor e gera dimensões pares', () => {
    const p = createEmptyProject('x') // 1920×1080
    expect(canvasForAspect(p, '9:16')).toEqual({ width: 1080, height: 1920 })
    expect(canvasForAspect(p, '1:1')).toEqual({ width: 1080, height: 1080 })
    expect(canvasForAspect(p, '4:5')).toEqual({ width: 1080, height: 1350 })
    expect(canvasForAspect(p, '4:3')).toEqual({ width: 1440, height: 1080 })
    expect(canvasForAspect({ ...p, canvas: { ...p.canvas, width: 1080, height: 1920 } }, '16:9')).toEqual({ width: 1920, height: 1080 })
  })
  it('original = 1ª mídia visual (com rotação)', () => {
    const p = withMedia(createEmptyProject('x'), 1280, 1024)
    expect(firstMediaSize(p)).toEqual({ width: 1280, height: 1024 })
    expect(canvasForAspect(p, 'original')).toEqual({ width: 1280, height: 1024 })
    expect(firstMediaSize(withMedia(createEmptyProject('x'), 1920, 1080, 90))).toEqual({ width: 1080, height: 1920 })
    expect(firstMediaSize(createEmptyProject('x'))).toBeNull()
  })
  it('identifica a proporção atual', () => {
    const p = createEmptyProject('x')
    expect(aspectIdOf(p)).toBe('16:9')
    expect(aspectIdOf({ ...p, canvas: { ...p.canvas, width: 1080, height: 1350 } })).toBe('4:5')
    const odd = withMedia({ ...p, canvas: { ...p.canvas, width: 1280, height: 1024 } }, 1280, 1024)
    expect(aspectIdOf(odd)).toBe('original')
    expect(aspectIdOf({ ...p, canvas: { ...p.canvas, width: 1000, height: 300 } })).toBe('custom')
  })
})
