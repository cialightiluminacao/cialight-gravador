import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { OcrHelper, OcrUnavailableError } from './ocrHelper'

const FAKE = join(__dirname, '__fixtures__', 'fakeOcrHelper.mjs')
const start = (mode: string, extra: { frameTimeoutMs?: number } = {}): Promise<OcrHelper> =>
  OcrHelper.start({ script: '', command: process.execPath, args: [FAKE, mode], readyTimeoutMs: 10_000, ...extra })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

describe('OcrHelper (helper falso com o mesmo protocolo)', () => {
  it('partida lê lang/maxDim; quadros vão inteiros e as respostas casam pelo id, em ordem', async () => {
    const h = await start('ok')
    expect(h.lang).toBe('en-US')
    expect(h.maxDim).toBe(10000)
    const a = new Uint8Array(300 * 200).fill(1)
    const b = new Uint8Array(64 * 64).fill(2)
    const [ra, rb] = await Promise.all([h.recognize(a, 300, 200), h.recognize(b, 64, 64)])
    expect(ra[0].w[1][0]).toBe(String(300 * 200))
    expect(rb[0].w[1][0]).toBe(String(64 * 64 * 2))
    const pid = h.pid!
    await h.close()
    expect(await waitGone(pid, 2000)).toBe(true)
  })
  it('ready:false → OcrUnavailableError com mensagem pt-BR e o motivo', async () => {
    const e = await start('notready').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(OcrUnavailableError)
    expect((e as OcrUnavailableError).code).toBe('ocrUnavailable')
    expect((e as Error).message).toMatch(/reconhecimento de texto do Windows não está disponível/)
    expect((e as Error).message).toMatch(/xx-XX/)
  })
  it('executável inexistente → OcrUnavailableError', async () => {
    const e = await OcrHelper.start({ script: '', command: join(__dirname, 'nao-existe.exe'), args: [], readyTimeoutMs: 5000 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(OcrUnavailableError)
  })
  it('quadro travado: tempo esgotado mata SÓ o PID iniciado e vira ocrUnavailable', async () => {
    const h = await start('hang', { frameTimeoutMs: 300 })
    const pid = h.pid!
    const e = await h.recognize(new Uint8Array(16), 4, 4).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(OcrUnavailableError)
    expect(await waitGone(pid, 2000)).toBe(true)
    // depois da falha, novos pedidos falham na hora
    await expect(h.recognize(new Uint8Array(16), 4, 4)).rejects.toBeInstanceOf(OcrUnavailableError)
  })
  it('resposta que não é JSON → ocrUnavailable (helper morto)', async () => {
    const h = await start('garbage')
    const pid = h.pid!
    await expect(h.recognize(new Uint8Array(16), 4, 4)).rejects.toBeInstanceOf(OcrUnavailableError)
    expect(await waitGone(pid, 2000)).toBe(true)
  })
  it('close: quit; se não sair em 2 s, mata o PID', async () => {
    const h = await start('ignorequit')
    const pid = h.pid!
    const t0 = Date.now()
    await h.close(400)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350)
    expect(await waitGone(pid, 2000)).toBe(true)
  })
  it('tamanho do quadro que não confere é recusado sem tocar no helper', async () => {
    const h = await start('ok')
    await expect(h.recognize(new Uint8Array(10), 4, 4)).rejects.toThrow(/não confere/)
    expect((await h.recognize(new Uint8Array(16), 4, 4))[0].w[1][0]).toBe('0')
    await h.close()
  })
})
