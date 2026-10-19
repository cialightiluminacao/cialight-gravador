import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcApi } from '@shared/ipc'
import { FallbackRecorder } from './fallbackRecorder'

class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = () => true
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor() { FakeRecorder.instances.push(this) }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.onstop?.() }
}

afterEach(() => { vi.unstubAllGlobals(); FakeRecorder.instances = [] })

function setup() {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('MediaStream', class {})
  const write = vi.fn().mockResolvedValue(undefined)
  const writeOpen = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
  const writeClose = vi.fn().mockResolvedValue(undefined)
  const screen = { getVideoTracks: () => [] } as unknown as MediaStream
  const mic = { getAudioTracks: () => [] } as unknown as MediaStream
  const api = { session: { write, writeOpen, writeClose } } as unknown as IpcApi
  const onError = vi.fn(), onBytes = vi.fn()
  const recorder = new FallbackRecorder(api, 's', { screen, cam: null, mic, sys: null }, onBytes, onError)
  return { recorder, write, writeClose, writeOpen, onError, onBytes }
}

describe('FallbackRecorder: falhas de escrita', () => {
  it('fecha todos os arquivos mesmo quando uma faixa não pode ser gravada', async () => {
    const { recorder, write, writeClose } = setup()
    await recorder.start()
    write.mockRejectedValueOnce(new Error('Disk full'))
    FakeRecorder.instances[0].ondataavailable?.({ data: new Blob(['video']) })
    await expect(recorder.stop()).rejects.toThrow('Disk full')
    expect(writeClose.mock.calls.map(c => c[0])).toEqual([1, 2])
  })

  it('fecha os arquivos já abertos se a abertura de uma faixa posterior falha', async () => {
    const { recorder, writeClose, writeOpen } = setup()
    writeOpen.mockReset().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('Cannot open audio'))
    await expect(recorder.start()).rejects.toThrow('Cannot open audio')
    expect(writeClose).toHaveBeenCalledWith(1)
  })

  it('informa a primeira falha sem rejeição sem tratamento enquanto ainda está gravando', async () => {
    const { recorder, write, onError } = setup()
    await recorder.start()
    write.mockRejectedValue(new Error('Disk disconnected'))
    FakeRecorder.instances[0].ondataavailable?.({ data: new Blob(['video']) })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    FakeRecorder.instances[0].ondataavailable?.({ data: new Blob(['more']) })
    await expect(recorder.stop()).rejects.toThrow('Disk disconnected')
    expect(write).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('aguarda e grava os blocos em ordem antes de fechar cada arquivo', async () => {
    const { recorder, write, writeClose, onBytes, onError } = setup()
    await recorder.start()
    FakeRecorder.instances[0].ondataavailable?.({ data: new Blob(['abc']) })
    FakeRecorder.instances[0].ondataavailable?.({ data: new Blob(['de']) })
    await recorder.stop()
    expect(write.mock.calls.map(c => ({ handle: c[0], size: c[1].byteLength, position: c[2] }))).toEqual([
      { handle: 1, size: 3, position: 0 }, { handle: 1, size: 2, position: 3 }
    ])
    expect(onBytes).toHaveBeenLastCalledWith(5)
    expect(onError).not.toHaveBeenCalled()
    expect(writeClose.mock.calls.map(c => c[0])).toEqual([1, 2])
  })
})
