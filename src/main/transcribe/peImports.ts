// DLLs importadas por executáveis/DLLs PE (Windows) e a checagem da pasta do whisper: todo import tem de estar na
// própria pasta ou ser DLL do Windows. Garante que o runtime do Visual C++ (MSVCP140, VCRUNTIME140, VCRUNTIME140_1,
// VCOMP140) foi copiado ao lado do whisper-cli.exe (Ruling R7) e que nenhuma DLL nova do zip ficou de fora.
// Sem dependências nem sintaxe só-TypeScript: também roda direto no Node (scripts/fetch-whisper.mjs importa este
// arquivo com a remoção de tipos nativa do Node 22.18+/23.6+).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Section { va: number; vsize: number; raw: number; rawSize: number }

/** Nomes das DLLs importadas (tabela de imports + imports com carga atrasada), na ordem do arquivo. */
export function peImports(buf: Buffer): string[] {
  if (buf.length < 0x40 || buf.toString('ascii', 0, 2) !== 'MZ') throw new Error('não é um arquivo PE (sem MZ)')
  const pe = buf.readUInt32LE(0x3c)
  if (buf.toString('binary', pe, pe + 4) !== 'PE\0\0') throw new Error('não é um arquivo PE (sem assinatura PE)')
  const coff = pe + 4
  const nSections = buf.readUInt16LE(coff + 2)
  const optSize = buf.readUInt16LE(coff + 16)
  const opt = coff + 20
  const magic = buf.readUInt16LE(opt)
  const dirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1
  if (dirs < 0) throw new Error(`cabeçalho opcional desconhecido (0x${magic.toString(16)})`)
  const nDirs = buf.readUInt32LE(dirs - 4)
  const sections: Section[] = []
  for (let i = 0, s = opt + optSize; i < nSections; i++, s += 40) {
    sections.push({ vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) })
  }
  const off = (rva: number): number => {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw
    throw new Error(`RVA 0x${rva.toString(16)} fora das seções`)
  }
  const cstr = (rva: number): string => {
    const o = off(rva)
    const end = buf.indexOf(0, o)
    return buf.toString('ascii', o, end < 0 ? buf.length : end)
  }
  const names: string[] = []
  const dir = (i: number): number => (i < nDirs ? buf.readUInt32LE(dirs + i * 8) : 0)
  const imp = dir(1)
  if (imp) {
    for (let d = off(imp); ; d += 20) {
      const nameRva = buf.readUInt32LE(d + 12)
      if (!nameRva) break
      names.push(cstr(nameRva))
    }
  }
  const delay = dir(13)
  if (delay) {
    for (let d = off(delay); ; d += 32) {
      const nameRva = buf.readUInt32LE(d + 4)
      if (!nameRva) break
      names.push(cstr(nameRva))
    }
  }
  return names
}

/** DLLs do próprio Windows (sempre presentes; nunca copiar). O runtime do Visual C++ NÃO está aqui. */
const SYSTEM_DLLS = new Set([
  'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'gdi32.dll', 'advapi32.dll', 'ole32.dll', 'oleaut32.dll',
  'shell32.dll', 'shlwapi.dll', 'ws2_32.dll', 'bcrypt.dll', 'crypt32.dll', 'secur32.dll', 'winmm.dll', 'version.dll',
  'comdlg32.dll', 'comctl32.dll', 'imm32.dll', 'setupapi.dll', 'cfgmgr32.dll', 'dbghelp.dll', 'psapi.dll', 'iphlpapi.dll',
  'userenv.dll', 'powrprof.dll', 'dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'dwmapi.dll', 'uxtheme.dll', 'msvcrt.dll', 'rpcrt4.dll',
  'normaliz.dll', 'wldap32.dll', 'mfplat.dll', 'mf.dll', 'mfreadwrite.dll', 'avrt.dll', 'opengl32.dll', 'vulkan-1.dll'
])

export function isWindowsSystemDll(name: string): boolean {
  const n = name.toLowerCase()
  return n.startsWith('api-ms-win-') || n.startsWith('ext-ms-') || SYSTEM_DLLS.has(n)
}

export interface ImportProblem { file: string; dll: string }

/** Confere todos os .exe/.dll da pasta: cada import está na pasta (sem caixa) ou é DLL do Windows. */
export function checkFolderImports(dir: string): { files: number; imports: Record<string, string[]>; missing: ImportProblem[] } {
  const entries = readdirSync(dir).filter((f) => /\.(exe|dll)$/i.test(f))
  const local = new Set(entries.map((f) => f.toLowerCase()))
  const imports: Record<string, string[]> = {}
  const missing: ImportProblem[] = []
  for (const f of entries) {
    const list = peImports(readFileSync(join(dir, f)))
    imports[f] = list
    for (const dll of list) if (!local.has(dll.toLowerCase()) && !isWindowsSystemDll(dll)) missing.push({ file: f, dll })
  }
  return { files: entries.length, imports, missing }
}
