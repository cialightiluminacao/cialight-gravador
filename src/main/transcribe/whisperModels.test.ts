import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { WHISPER_MODELS, downloadModel, modelStatus, whisperModelsDir, type WhisperModelSpec } from './whisperModels'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whisper-models-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const body = Buffer.alloc(300_000, 7)
const sha = createHash('sha256').update(body).digest('hex')

/** Servidor local: /ok (corpo certo), /bad (sha errado), /404, /slow (manda aos poucos e não termina). */
async function server(): Promise<{ url: (p: string) => string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = []
  const srv: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-length': body.length })
      res.end(body)
    } else if (req.url === '/bad') {
      const b = Buffer.from(body)
      b[10] = 1
      res.writeHead(200, { 'content-length': b.length })
      res.end(b)
    } else if (req.url === '/slow') {
      res.writeHead(200, { 'content-length': body.length })
      res.write(body.subarray(0, 100_000))
      // nunca termina: o cancelamento tem de interromper
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as AddressInfo).port
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    hits,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections()
        srv.close(() => r())
      })
  }
}

const spec = (urls: string[]): WhisperModelSpec => ({ id: 'base', label: 'Base', file: 'ggml-base.bin', sizeBytes: body.length, sha256: sha, urls })
const plenty = async (): Promise<number> => 1e12

describe('catálogo', () => {
  it('base e small com tamanho, sha256 e URLs (espelho primeiro, depois Hugging Face no commit pinado)', () => {
    expect(WHISPER_MODELS.base).toMatchObject({ label: 'Base', file: 'ggml-base.bin', sizeBytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' })
    expect(WHISPER_MODELS.small).toMatchObject({ label: 'Preciso', file: 'ggml-small.bin', sizeBytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' })
    expect(WHISPER_MODELS.small.urls).toEqual([
      'https://github.com/cialightiluminacao/cialight-gravador/releases/download/deps-whisper-v1.9.4/ggml-small.bin',
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin'
    ])
  })

  it('pasta: CIALIGHT_WHISPER_MODELS_DIR (testes) senão userData/models/whisper', () => {
    const prev = process.env.CIALIGHT_WHISPER_MODELS_DIR
    try {
      process.env.CIALIGHT_WHISPER_MODELS_DIR = 'test-out/x'
      expect(whisperModelsDir()).toBe(join(process.cwd(), 'test-out', 'x'))
      delete process.env.CIALIGHT_WHISPER_MODELS_DIR
      expect(whisperModelsDir()).toBe(join(tmpdir(), 'cialight-gravador-tests', 'models', 'whisper'))
    } finally {
      if (prev === undefined) delete process.env.CIALIGHT_WHISPER_MODELS_DIR
      else process.env.CIALIGHT_WHISPER_MODELS_DIR = prev
    }
  })
})

describe('modelStatus', () => {
  it('presente só com o tamanho exato E o carimbo .ok com o sha256', () => {
    const s = spec([])
    const st = (): boolean => modelStatus(dir, { base: s }).find((m) => m.id === 'base')!.present
    expect(st()).toBe(false)
    writeFileSync(join(dir, s.file), body)
    expect(st()).toBe(false) // sem carimbo (download não verificado)
    writeFileSync(join(dir, `${s.file}.ok`), sha)
    expect(st()).toBe(true)
    writeFileSync(join(dir, `${s.file}.ok`), 'outro')
    expect(st()).toBe(false)
    writeFileSync(join(dir, `${s.file}.ok`), sha)
    writeFileSync(join(dir, s.file), body.subarray(1))
    expect(st()).toBe(false) // tamanho diferente
    expect(modelStatus(dir, { base: s })[0]).toMatchObject({ id: 'base', label: 'Base', sizeBytes: body.length })
  })
})

describe('downloadModel', () => {
  it('baixa, confere tamanho + sha256, renomeia e grava o carimbo; progresso com total', async () => {
    const srv = await server()
    try {
      const prog: { receivedBytes: number; totalBytes: number }[] = []
      await downloadModel('base', (p) => prog.push(p), undefined, { dir, catalog: { base: spec([srv.url('/ok')]) }, freeBytes: plenty })
      expect(readFileSync(join(dir, 'ggml-base.bin')).equals(body)).toBe(true)
      expect(readFileSync(join(dir, 'ggml-base.bin.ok'), 'utf8').trim()).toBe(sha)
      expect(existsSync(join(dir, 'ggml-base.bin.part'))).toBe(false)
      expect(prog.at(-1)).toEqual({ receivedBytes: body.length, totalBytes: body.length })
      expect(modelStatus(dir, { base: spec([]) })[0].present).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it('espelho falha (404) → usa a segunda URL', async () => {
    const srv = await server()
    try {
      await downloadModel('base', () => {}, undefined, { dir, catalog: { base: spec([srv.url('/404'), srv.url('/ok')]) }, freeBytes: plenty })
      expect(srv.hits).toEqual(['/404', '/ok'])
      expect(existsSync(join(dir, 'ggml-base.bin'))).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it('sha256 divergente nas duas URLs → erro pt-BR, sem arquivo final nem .part', async () => {
    const srv = await server()
    try {
      await expect(downloadModel('base', () => {}, undefined, { dir, catalog: { base: spec([srv.url('/bad'), srv.url('/bad')]) }, freeBytes: plenty })).rejects.toThrow(/^Não foi possível baixar o modelo: .*sha256/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      await srv.close()
    }
  })

  it('cancelar no meio → "Download cancelado", .part apagado, segunda URL não tentada', async () => {
    const srv = await server()
    try {
      const ac = new AbortController()
      const p = downloadModel('base', (pr) => { if (pr.receivedBytes >= 50_000) ac.abort() }, ac.signal, { dir, catalog: { base: spec([srv.url('/slow'), srv.url('/ok')]) }, freeBytes: plenty })
      await expect(p).rejects.toThrow('Download cancelado')
      expect(readdirSync(dir)).toEqual([])
      expect(srv.hits).toEqual(['/slow'])
    } finally {
      await srv.close()
    }
  })

  it('já cancelado antes de começar → "Download cancelado" sem rede', async () => {
    const ac = new AbortController()
    ac.abort()
    let called = false
    await expect(downloadModel('base', () => {}, ac.signal, { dir, catalog: { base: spec(['http://x']) }, freeBytes: plenty, fetch: (async () => { called = true; throw new Error('x') }) as typeof fetch })).rejects.toThrow('Download cancelado')
    expect(called).toBe(false)
  })

  it('espaço insuficiente (< tamanho + 100 MB) → erro pt-BR com o tamanho necessário, sem rede', async () => {
    let called = false
    await expect(
      downloadModel('base', () => {}, undefined, { dir, catalog: { base: spec(['http://x']) }, freeBytes: async () => 50 * 1048576, fetch: (async () => { called = true; throw new Error('x') }) as typeof fetch })
    ).rejects.toThrow(/Espaço insuficiente.*101 MB/)
    expect(called).toBe(false)
  })

  it('modelo desconhecido → erro', async () => {
    await expect(downloadModel('tiny' as 'base', () => {}, undefined, { dir, freeBytes: plenty })).rejects.toThrow(/desconhecido/)
  })

  it('cria a pasta se não existir', async () => {
    const srv = await server()
    try {
      const sub = join(dir, 'a', 'b')
      await downloadModel('base', () => {}, undefined, { dir: sub, catalog: { base: spec([srv.url('/ok')]) }, freeBytes: plenty })
      expect(existsSync(join(sub, 'ggml-base.bin.ok'))).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it('arquivo maior que o esperado → falha sem gravar', async () => {
    const srv = await server()
    try {
      const s = { ...spec([srv.url('/ok')]), sizeBytes: 1000 }
      await expect(downloadModel('base', () => {}, undefined, { dir, catalog: { base: s }, freeBytes: plenty })).rejects.toThrow(/Não foi possível baixar o modelo/)
      mkdirSync(dir, { recursive: true })
      expect(readdirSync(dir)).toEqual([])
    } finally {
      await srv.close()
    }
  })
})
