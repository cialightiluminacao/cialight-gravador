import { promises as fsp } from 'fs'

export interface SaveTextDeps {
  /** dialog.showSaveDialog (injetado nos testes). */
  showSave: (opts: { defaultPath?: string; title: string; filters: { name: string; extensions: string[] }[] }) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile?: (path: string, data: string) => Promise<void>
}

/** Texto em UTF-8 sem BOM, com CRLF (o Bloco de Notas antigo só quebra linha assim). */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n')
}

/** "Salvar como" de um .txt: devolve o caminho gravado, ou null se o usuário cancelou. Erro de gravação propaga. */
export async function saveTextFile(deps: SaveTextDeps, defaultPath: string, text: string): Promise<string | null> {
  const r = await deps.showSave({ defaultPath: defaultPath || undefined, title: 'Salvar capítulos', filters: [{ name: 'Texto', extensions: ['txt'] }] })
  if (r.canceled || !r.filePath) return null
  const write = deps.writeFile ?? ((p: string, d: string) => fsp.writeFile(p, d, 'utf8'))
  await write(r.filePath, toCrlf(text))
  return r.filePath
}
