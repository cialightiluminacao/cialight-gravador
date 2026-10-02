import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { toast } from 'sonner'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Asset, MediaItem, Project } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'
import { audioProcessIssues, startAudioProcessing, voiceProcessStatus } from './audioProcessing'

// Pedidos de pré-processamento do editor com o IPC falso: resultado aplicado, fonte trocada no meio (relink)
// descarta o resultado e pede de novo, cancelamento não é falha, falha vira estado de erro.

interface Call { assetId: string; resolve: (v: { key: string; fingerprint: string; rel: string }) => void; reject: (e: Error) => void }
const calls: Call[] = []
const S = 1_000_000

const asset = (path = 'C:/v/a.mp4'): Asset => ({
  id: 'a1', name: 'a1', kind: 'audio', source: { type: 'file', path, size: 1, mtimeMs: 1 }, durationUs: 10 * S,
  audio: { channels: 1, sampleRate: 48000, codec: 'aac' }, status: 'ready'
})

function project(): Project {
  const r = ops.addMediaFromAsset(ops.addAsset({ ...createEmptyProject('t'), id: 'p1' }, asset()), 'a1', 0)
  return ops.updateItem<MediaItem>(r.project, r.itemIds[0], (d) => { d.audio.denoise = true })
}

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
let stop: () => void = () => {}

beforeEach(() => {
  calls.length = 0
  vi.mocked(toast.error).mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      media: {
        processAudio: (_p: string, assetId: string) => new Promise((resolve, reject) => calls.push({ assetId, resolve, reject }))
      }
    }
  }
  st().close()
  st().open(project())
  stop = startAudioProcessing('p1')
})
afterEach(() => stop())

describe('audioProcessing', () => {
  it('pede o pendente uma vez; pronto, registra chave → impressão e para de pedir', async () => {
    expect(calls).toHaveLength(1)
    expect(st().audioJobs).toEqual({ 'a1~dn-sh': { percent: 0 } })
    calls[0].resolve({ key: 'dn-sh', fingerprint: 'f-1', rel: 'generated/a1.audio-dn-sh.f-1.m4a' })
    await flush()
    expect(st().project!.assets[0].processedAudio).toEqual({ 'dn-sh': 'f-1' })
    expect(st().audioJobs).toEqual({})
    expect(calls).toHaveLength(1)
  })

  it('fonte do asset trocada durante o processamento (relink): descarta o resultado e pede de novo', async () => {
    st().applyAssetPatch('a1', { source: { type: 'file', path: 'C:/v/b.mp4', size: 2, mtimeMs: 2 } })
    calls[0].resolve({ key: 'dn-sh', fingerprint: 'f-old', rel: 'x' })
    await flush()
    expect(st().project!.assets[0].processedAudio).toBeUndefined()
    expect(calls).toHaveLength(2)
    calls[1].resolve({ key: 'dn-sh', fingerprint: 'f-new', rel: 'y' })
    await flush()
    expect(st().project!.assets[0].processedAudio).toEqual({ 'dn-sh': 'f-new' })
  })

  it('cancelado (relink no main) não é falha: sem toast; pede de novo enquanto pendente', async () => {
    calls[0].reject(new Error('cancelado'))
    await flush()
    expect(toast.error).not.toHaveBeenCalled()
    expect(calls).toHaveLength(2)
  })

  it('falha: estado de erro com a mensagem, toast uma vez, sem repetir sozinho', async () => {
    calls[0].reject(new Error('ffmpeg quebrou'))
    await flush()
    expect(st().audioJobs['a1~dn-sh']).toEqual({ error: 'ffmpeg quebrou' })
    expect(toast.error).toHaveBeenCalledTimes(1)
    st().apply((p) => ops.addMarker(p, 1))
    await flush()
    expect(calls).toHaveLength(1)
  })
})

describe('voiceProcessStatus (inspetor)', () => {
  it('pronto > falha > processando > inativo (áudio desligado/faixa muda) > aguardando a mídia', () => {
    const base = { ready: false, job: undefined, active: true, assetReady: true }
    expect(voiceProcessStatus({ ...base, ready: true })).toBe('ready')
    expect(voiceProcessStatus({ ...base, job: { error: 'x' } })).toBe('error')
    expect(voiceProcessStatus({ ...base, job: { percent: 10 } })).toBe('processing')
    expect(voiceProcessStatus({ ...base, active: false })).toBe('inactive')
    expect(voiceProcessStatus({ ...base, active: false, assetReady: false })).toBe('inactive')
    expect(voiceProcessStatus({ ...base, assetReady: false })).toBe('waiting')
    expect(voiceProcessStatus(base)).toBe('processing') // pedido saindo
  })
})

describe('audioProcessIssues (diálogo de exportação)', () => {
  it('separa os trechos com o tratamento ainda processando dos que falharam, só no intervalo', async () => {
    const p = st().project!
    expect(audioProcessIssues(p, {}, 0, 10 * S)).toEqual({ pending: ['a1'], failed: [] })
    expect(audioProcessIssues(p, { 'a1~dn-sh': { error: 'x' } }, 0, 10 * S)).toEqual({ pending: [], failed: ['a1'] })
    expect(audioProcessIssues(p, {}, 20 * S, 30 * S)).toEqual({ pending: [], failed: [] })
    const done = ops.updateAsset(p, 'a1', { processedAudio: { 'dn-sh': 'f-1' } })
    expect(audioProcessIssues(done, {}, 0, 10 * S)).toEqual({ pending: [], failed: [] })
  })
})
