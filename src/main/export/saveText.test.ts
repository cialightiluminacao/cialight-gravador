import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveTextFile, toCrlf } from './saveText'

describe('saveTextFile', () => {
  it('converte para CRLF, sem BOM, e devolve o caminho', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'savetext-'))
    try {
      const file = join(dir, 'c.txt')
      const showSave = vi.fn(async (_o: { filters: { extensions: string[] }[] }) => ({ canceled: false, filePath: file }))
      expect(await saveTextFile({ showSave }, 'X.txt', '00:00 A\n01:00 Introdução\r\n02:00 C')).toBe(file)
      const buf = readFileSync(file)
      expect(buf[0]).not.toBe(0xef)
      expect(buf.toString('utf8')).toBe('00:00 A\r\n01:00 Introdução\r\n02:00 C')
      expect(showSave.mock.calls[0][0].filters[0].extensions).toEqual(['txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('cancelado: null e nada gravado', async () => {
    const writeFile = vi.fn()
    expect(await saveTextFile({ showSave: async () => ({ canceled: true }), writeFile }, 'a.txt', 'x')).toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
  })
  it('erro de gravação propaga', async () => {
    const deps = { showSave: async () => ({ canceled: false, filePath: 'Z:/nope/a.txt' }), writeFile: async () => { throw new Error('EACCES') } }
    await expect(saveTextFile(deps, 'a.txt', 'x')).rejects.toThrow('EACCES')
  })
  it('toCrlf não duplica', () => {
    expect(toCrlf('a\r\nb\nc\rd')).toBe('a\r\nb\r\nc\r\nd')
  })
})
