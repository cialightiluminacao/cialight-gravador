// Relink automático (F7): procura no disco mídias importadas que sumiram do caminho gravado no projeto (pasta movida
// ou renomeada). Casamento exato: mesmo nome de arquivo (sem diferenciar maiúsculas) + mesmo tamanho em bytes — o
// mesmo critério do withMediaStatus (tamanho) — então o candidato é o próprio arquivo; o usuário confirma antes.
// Ordem da busca, por níveis (o mais próximo vence; o nível só termina depois de lido inteiro):
//   1. a pasta original (+ subpastas diretas);  2. as pastas irmãs dela (filhas da pasta-mãe);  3. a pasta-mãe;
//   4. as pastas onde estão os outros assets do projeto (moveram juntos) (+ subpastas);  5. extraRoots (+ subpastas).
// Dois arquivos diferentes no mesmo nível que casam → ambíguo, sem candidato (o usuário usa "Localizar").
// Para quando todos foram achados (ao fim de um nível). Nunca segue links simbólicos/junções (lstat), nunca desce mais
// de 1 nível abaixo de cada raiz, pula pastas ilegíveis em silêncio; limites de pastas lidas, entradas e tempo.
import { promises as nodeFs, type Dirent } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { Project } from '@shared/editor/project'
import type { RelinkCandidate } from '@shared/ipc'

export type { RelinkCandidate }

export interface RelinkMissing {
  assetId: string
  path: string
  size: number
  name: string
}

export interface RelinkOptions {
  /** Pastas onde estão hoje os outros assets (de arquivo) do projeto. */
  otherAssetDirs?: string[]
  extraRoots?: string[]
  maxDirs?: number
  maxEntries?: number
  timeoutMs?: number
}

export interface RelinkFs {
  readdir(dir: string, opts: { withFileTypes: true }): Promise<Dirent[]>
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number }>
}

const DEFAULT_FS: RelinkFs = { readdir: (d, o) => nodeFs.readdir(d, o), lstat: (p) => nodeFs.lstat(p) }

/** Pasta a ler; `descend`: também as subpastas diretas. */
interface Unit {
  dir: string
  descend: boolean
}

class StopSearch extends Error {}

const keyOf = (p: string): string => resolve(p).toLowerCase()

/**
 * Entrada da busca para o projeto `p` (status já conferidos no disco, withMediaStatus): mídias importadas 'missing',
 * as pastas dos outros assets de arquivo presentes e as `extraRoots` pedidas pelo renderer — aceitas só se forem a
 * pasta de um asset presente do próprio projeto (ex.: a do arquivo recém-localizado à mão); o resto é ignorado.
 */
export function relinkQuery(p: Project, extraRoots: string[] = []): { missing: RelinkMissing[]; otherAssetDirs: string[]; extraRoots: string[] } {
  const missing: RelinkMissing[] = []
  const present = new Map<string, string>()
  for (const a of p.assets) {
    if (a.source.type !== 'file') continue
    if (a.status === 'missing') missing.push({ assetId: a.id, path: a.source.path, size: a.source.size, name: a.name })
    else present.set(keyOf(dirname(a.source.path)), dirname(a.source.path))
  }
  const extras = extraRoots.filter((r) => typeof r === 'string' && present.has(keyOf(r)))
  return { missing, otherAssetDirs: [...present.values()], extraRoots: extras }
}

export async function findRelinkCandidates(missing: RelinkMissing[], opts: RelinkOptions = {}, fs: RelinkFs = DEFAULT_FS): Promise<RelinkCandidate[]> {
  const { maxDirs = 400, maxEntries = 20000, timeoutMs = 3000 } = opts
  const deadline = Date.now() + timeoutMs
  // nome em minúsculas → assets ainda sem resultado com esse nome
  const pending = new Map<string, RelinkMissing[]>()
  for (const m of missing) {
    const k = basename(m.path).toLowerCase()
    pending.set(k, [...(pending.get(k) ?? []), m])
  }
  const found = new Map<string, string>()
  // achados ou ambíguos: fora dos níveis seguintes
  const done = new Set<string>()
  let left = missing.length
  // pasta já lida → subpastas dela (os arquivos já foram comparados com todos os pendentes de então, que incluem os de
  // agora: reler não acharia nada novo; descer nela de novo, como raiz de outro nível, usa a lista guardada)
  const visited = new Map<string, string[]>()
  let dirs = 0
  let entries = 0

  /** Entradas de `dir` (null: ilegível, link, ou não é pasta). Estoura StopSearch nos limites. */
  const list = async (dir: string): Promise<Dirent[] | null> => {
    const remaining = deadline - Date.now()
    if (dirs >= maxDirs || remaining <= 0) throw new StopSearch()
    dirs++
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), remaining)
    })
    try {
      const r = await Promise.race([
        (async () => {
          const st = await fs.lstat(dir)
          if (!st.isDirectory() || st.isSymbolicLink()) return null
          return fs.readdir(dir, { withFileTypes: true })
        })().catch(() => null),
        timeout
      ])
      if (r === 'timeout') throw new StopSearch()
      if (r) {
        entries += r.length
        if (entries > maxEntries) throw new StopSearch()
      }
      return r
    } finally {
      clearTimeout(timer)
    }
  }

  /** Lê uma pasta: arquivos que casam entram em `hits`; devolve as subpastas (sem links). */
  const scan = async (dir: string, hits: Map<string, Set<string>>): Promise<string[]> => {
    const k = keyOf(dir)
    const seen = visited.get(k)
    if (seen) return seen
    const subdirs: string[] = []
    visited.set(k, subdirs)
    const list0 = await list(dir)
    if (!list0) return subdirs
    for (const d of list0) {
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) {
        subdirs.push(join(dir, d.name))
        continue
      }
      if (!d.isFile()) continue
      const want = pending.get(d.name.toLowerCase())
      if (!want) continue
      const full = join(dir, d.name)
      let st: Awaited<ReturnType<RelinkFs['lstat']>>
      try {
        st = await fs.lstat(full)
      } catch {
        continue
      }
      if (!st.isFile() || st.isSymbolicLink()) continue
      for (const m of want) {
        if (st.size !== m.size || keyOf(full) === keyOf(m.path)) continue
        const set = hits.get(m.assetId) ?? new Set<string>()
        set.add(full)
        hits.set(m.assetId, set)
      }
    }
    return subdirs
  }

  /** Fecha um nível: 1 arquivo → candidato; 2+ → ambíguo (sai da busca sem candidato). */
  const settle = (hits: Map<string, Set<string>>): void => {
    for (const [assetId, paths] of hits) {
      if (done.has(assetId)) continue
      done.add(assetId)
      if (paths.size === 1) found.set(assetId, [...paths][0])
      for (const [name, list1] of pending) {
        const rest = list1.filter((m) => m.assetId !== assetId)
        if (rest.length === list1.length) continue
        left -= list1.length - rest.length
        if (rest.length) pending.set(name, rest)
        else pending.delete(name)
      }
    }
  }

  const runLevel = async (units: Unit[]): Promise<void> => {
    const hits = new Map<string, Set<string>>()
    try {
      for (const u of units) {
        const subs = await scan(u.dir, hits)
        if (u.descend) for (const s of subs) await scan(s, hits)
      }
    } finally {
      // nível interrompido por limite: o que já casou vale (o usuário confirma cada um)
      settle(hits)
    }
  }

  const unique = (ds: string[]): string[] => [...new Map(ds.map((d) => [keyOf(d), d])).values()]
  const origDirs = unique(missing.map((m) => dirname(m.path)))
  const parents = unique(origDirs.map((d) => dirname(d)))
  // arquivos da própria pasta-mãe: lidos junto com a listagem das irmãs (uma leitura), mas valem só no nível 3
  const parentHits = new Map<string, Set<string>>()

  try {
    // 1. pasta original (+ subpastas)
    await runLevel(origDirs.map((dir) => ({ dir, descend: true })))
    if (left > 0) {
      // 2. irmãs: filhas diretas de cada pasta-mãe
      const siblings: Unit[] = []
      try {
        for (const p of parents) for (const s of await scan(p, parentHits)) siblings.push({ dir: s, descend: false })
      } finally {
        await runLevel(siblings).finally(() => settle(parentHits)) // 3. a pasta-mãe (depois das irmãs)
      }
    }
    // 4. pastas dos outros assets; 5. raízes extras (+ subpastas)
    if (left > 0) await runLevel(unique(opts.otherAssetDirs ?? []).map((dir) => ({ dir, descend: true })))
    if (left > 0) await runLevel(unique(opts.extraRoots ?? []).map((dir) => ({ dir, descend: true })))
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e
  }
  return missing.filter((m) => found.has(m.assetId)).map((m) => ({ assetId: m.assetId, path: found.get(m.assetId)!, confidence: 'exact' as const }))
}
