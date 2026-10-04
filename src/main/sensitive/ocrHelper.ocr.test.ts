// Protocolo do helper REAL (resources/ocr/ocr-winrt.ps1, Windows PowerShell 5.1 + Windows.Media.Ocr): endurecimento
// pedido na revisão do spike. Fora do `npm test` (npm run test:sensitive).
import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { OcrHelper } from './ocrHelper'

const ROOT = resolve(__dirname, '../../..')
const SCRIPT = join(ROOT, 'resources', 'ocr', 'ocr-winrt.ps1')

function spawnHelper(lang?: string): { child: ChildProcess; lines: string[]; next: () => Promise<string>; exit: Promise<number | null> } {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...(lang ? ['-Lang', lang] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines: string[] = []
  const waiters: ((l: string) => void)[] = []
  let buf = ''
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      const w = waiters.shift()
      if (w) w(l)
      else lines.push(l)
    }
  })
  child.stdin!.on('error', () => {})
  const next = (): Promise<string> => (lines.length ? Promise.resolve(lines.shift()!) : new Promise((r) => waiters.push(r)))
  const exit = new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
  return { child, lines, next, exit }
}

describe('helper de OCR real (protocolo)', () => {
  it('é UTF-8 com BOM (o PowerShell 5.1 lê acentos como ANSI sem ele)', () => {
    const b = readFileSync(SCRIPT)
    expect([b[0], b[1], b[2]]).toEqual([0xef, 0xbb, 0xbf])
  })
  it('partida informa idioma e maxDim; cabeçalho inválido / len errado → erro e continua; quadro bom → linhas', async () => {
    const h = spawnHelper()
    const ready = JSON.parse(await h.next())
    expect(ready.ready).toBe(true)
    expect(['en-US', 'pt-BR']).toContain(ready.lang) // ordem: en-US → pt-BR → perfil
    expect(ready.maxDim).toBeGreaterThanOrEqual(2048)
    h.child.stdin!.write('isto não é json\n')
    expect(JSON.parse(await h.next())).toMatchObject({ id: null, ok: false })
    // len ≠ w*h: os bytes são descartados e o helper segue sincronizado
    h.child.stdin!.write('{"id":7,"w":10,"h":10,"fmt":"gray8","len":99}\n')
    h.child.stdin!.write(Buffer.alloc(99))
    expect(JSON.parse(await h.next())).toMatchObject({ id: 7, ok: false })
    h.child.stdin!.write('{"id":8,"w":0,"h":10,"fmt":"gray8","len":0}\n')
    expect(JSON.parse(await h.next())).toMatchObject({ id: 8, ok: false })
    h.child.stdin!.write('{"id":9,"w":10,"h":10,"fmt":"rgb24","len":100}\n')
    h.child.stdin!.write(Buffer.alloc(100))
    expect(JSON.parse(await h.next())).toMatchObject({ id: 9, ok: false })
    // id não numérico nunca é ecoado cru
    h.child.stdin!.write('{"id":"x\\"y","w":10,"h":10,"fmt":"gray8","len":100}\n')
    h.child.stdin!.write(Buffer.alloc(100, 255))
    const r = JSON.parse(await h.next())
    expect(r.id).toBeNull()
    expect(r.ok).toBe(true)
    h.child.stdin!.write('{"cmd":"quit"}\n')
    expect(await h.exit).toBe(0)
  })
  it('fim do stdin entre pedidos: sai com 0 (sem órfão se o main cair)', async () => {
    const h = spawnHelper()
    await h.next()
    h.child.stdin!.end()
    expect(await h.exit).toBe(0)
  })
  it('quadro truncado: linha de erro e sai com código ≠ 0', async () => {
    const h = spawnHelper()
    await h.next()
    h.child.stdin!.write('{"id":3,"w":100,"h":100,"fmt":"gray8","len":10000}\n')
    h.child.stdin!.end(Buffer.alloc(500))
    expect(JSON.parse(await h.next())).toMatchObject({ id: 3, ok: false, error: 'entrada truncada' })
    expect(await h.exit).toBe(3)
  })
  it('idioma inexistente → ready:false com motivo em pt-BR e OcrHelper.start rejeita', async () => {
    const h = spawnHelper('xx-XX')
    const j = JSON.parse(await h.next())
    expect(j.ready).toBe(false)
    expect(j.error).toMatch(/não instalado/)
    expect(await h.exit).toBe(2)
    await expect(OcrHelper.start({ script: SCRIPT, lang: 'xx-XX' })).rejects.toMatchObject({ code: 'ocrUnavailable' })
  })
})
