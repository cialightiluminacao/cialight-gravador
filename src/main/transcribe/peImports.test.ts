import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkFolderImports, isWindowsSystemDll, peImports } from './peImports'

/** PE32+ mínimo: 1 seção (RVA 0x1000 ↔ arquivo 0x200), imports em 0x1000, delay-load em 0x1080, nomes em 0x1100+. */
function fakePe(imports: string[], delayed: string[] = []): Buffer {
  const b = Buffer.alloc(0x600)
  b.write('MZ', 0, 'ascii')
  b.writeUInt32LE(0x40, 0x3c)
  b.write('PE\0\0', 0x40, 'binary')
  const coff = 0x44
  b.writeUInt16LE(0x8664, coff)
  b.writeUInt16LE(1, coff + 2)
  b.writeUInt16LE(0xf0, coff + 16)
  const opt = coff + 20
  b.writeUInt16LE(0x20b, opt)
  b.writeUInt32LE(16, opt + 108)
  b.writeUInt32LE(0x1000, opt + 112 + 8) // diretório 1: imports
  if (delayed.length) b.writeUInt32LE(0x1080, opt + 112 + 13 * 8) // diretório 13: delay-load
  const sec = opt + 0xf0
  b.writeUInt32LE(0x400, sec + 8)
  b.writeUInt32LE(0x1000, sec + 12)
  b.writeUInt32LE(0x400, sec + 16)
  b.writeUInt32LE(0x200, sec + 20)
  const rvaToOff = (rva: number): number => rva - 0x1000 + 0x200
  let nameRva = 0x1100
  const putName = (n: string): number => {
    const r = nameRva
    b.write(`${n}\0`, rvaToOff(r), 'ascii')
    nameRva += n.length + 1
    return r
  }
  imports.forEach((n, i) => b.writeUInt32LE(putName(n), rvaToOff(0x1000) + i * 20 + 12))
  delayed.forEach((n, i) => {
    b.writeUInt32LE(1, rvaToOff(0x1080) + i * 32)
    b.writeUInt32LE(putName(n), rvaToOff(0x1080) + i * 32 + 4)
  })
  return b
}

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('peImports', () => {
  it('lê a tabela de imports e a de carga atrasada', () => {
    expect(peImports(fakePe(['KERNEL32.dll', 'whisper.dll'], ['VCOMP140.DLL']))).toEqual(['KERNEL32.dll', 'whisper.dll', 'VCOMP140.DLL'])
    expect(peImports(fakePe([]))).toEqual([])
  })
  it('arquivo que não é PE → erro', () => {
    expect(() => peImports(Buffer.from('não sou um exe, mas tenho tamanho suficiente para o cabeçalho DOS......'))).toThrow(/não é um arquivo PE/)
  })
  it('DLLs do Windows: api-ms-win-*, ext-ms-*, kernel32…; runtime do Visual C++ não', () => {
    for (const n of ['api-ms-win-crt-heap-l1-1-0.dll', 'ext-ms-win-foo.dll', 'KERNEL32.dll', 'ADVAPI32.dll', 'ws2_32.dll', 'bcrypt.dll', 'ntdll.dll']) expect(isWindowsSystemDll(n)).toBe(true)
    for (const n of ['MSVCP140.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'VCOMP140.DLL', 'ggml.dll']) expect(isWindowsSystemDll(n)).toBe(false)
  })
})

describe('checkFolderImports', () => {
  it('import ausente da pasta e fora do Windows é apontado; presente (sem caixa) ou do sistema passa', () => {
    dir = mkdtempSync(join(tmpdir(), 'pe-imports-'))
    writeFileSync(join(dir, 'app.exe'), fakePe(['KERNEL32.dll', 'Lib.DLL', 'MSVCP140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'], ['VCOMP140.DLL']))
    writeFileSync(join(dir, 'lib.dll'), fakePe(['KERNEL32.dll']))
    writeFileSync(join(dir, 'LEIA.txt'), 'ignorado')
    const r = checkFolderImports(dir)
    expect(r.files).toBe(2)
    expect(r.missing).toEqual([{ file: 'app.exe', dll: 'MSVCP140.dll' }, { file: 'app.exe', dll: 'VCOMP140.DLL' }])
    writeFileSync(join(dir, 'msvcp140.dll'), fakePe(['KERNEL32.dll']))
    writeFileSync(join(dir, 'vcomp140.dll'), fakePe(['KERNEL32.dll']))
    expect(checkFolderImports(dir).missing).toEqual([])
  })
})
