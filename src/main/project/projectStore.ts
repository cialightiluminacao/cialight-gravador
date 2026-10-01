import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseProject } from '@shared/editor/schema'
import { projectDurationUs } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import type { ProjectSummary } from '@shared/ipc'
import type { SessionStore } from '../session/sessionStore'

// Projetos do editor: uma pasta por projeto em <projectsRoot>/<projectId>/ com project.json
// (escrita atômica), versions/NNN.json (histórico de segurança), proxies/, cache/, generated/.
// Mídia importada nunca é copiada nem apagada: remover um projeto só envia a pasta dele à lixeira.

export type { ProjectSummary }

export interface ProjectStoreDeps {
  projectsRoot: () => string
  trash: (path: string) => Promise<void>
  log?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
  /** Relógio injetável (testes). */
  now?: () => number
}

export type AssetVariant = 'original' | 'proxy' | 'intermediate'

const SUBDIRS = ['proxies', 'cache', 'generated', 'versions']
const MAX_VERSIONS = 20
const VERSION_MIN_INTERVAL_MS = 60_000

export class ProjectStore {
  // Cache em memória do último project.json carregado/salvo, chave = id minúsculo
  // (o host da URL do protocolo chega em lowercase).
  private cache = new Map<string, Project>()

  constructor(private deps: ProjectStoreDeps) {}

  root(): string {
    return this.deps.projectsRoot()
  }

  dirOf(id: string): string {
    if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error(`projectId inválido: ${id}`)
    return join(this.root(), id)
  }

  /** Arquivo dentro da pasta do projeto: até 2 níveis (proxies/x.mp4, cache/strip.jpg); nunca '..'. */
  filePath(id: string, rel: string): string {
    const parts = rel.split(/[\\/]/).filter(Boolean)
    if (parts.length === 0 || parts.length > 2 || parts.some((p) => p === '.' || p === '..' || !/^[\w.\- ()]+$/.test(p))) throw new Error(`caminho inválido: ${rel}`)
    return join(this.dirOf(id), ...parts)
  }

  create(p: Project): void {
    const dir = this.dirOf(p.id)
    mkdirSync(dir, { recursive: true })
    for (const s of SUBDIRS) mkdirSync(join(dir, s), { recursive: true })
    this.save(p)
  }

  save(p: Project): void {
    const dir = this.dirOf(p.id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'project.json')
    const tmp = `${file}.tmp`
    const json = JSON.stringify(p, null, 2)
    writeFileSync(tmp, json, 'utf8')
    renameSync(tmp, file)
    this.cache.set(p.id.toLowerCase(), p)
    try {
      this.rotateVersions(dir, json)
    } catch (e) {
      this.deps.log?.warn(`falha ao gravar versão de ${p.id}`, e)
    }
  }

  private rotateVersions(dir: string, json: string): void {
    const vdir = join(dir, 'versions')
    mkdirSync(vdir, { recursive: true })
    const names = readdirSync(vdir).filter((n) => /^\d+\.json$/.test(n)).sort()
    const now = (this.deps.now ?? Date.now)()
    if (names.length) {
      const last = names[names.length - 1]
      if (now - statSync(join(vdir, last)).mtimeMs < VERSION_MIN_INTERVAL_MS) return
    }
    const next = names.length ? parseInt(names[names.length - 1], 10) + 1 : 1
    const name = `${String(next).padStart(3, '0')}.json`
    const tmp = join(vdir, `${name}.tmp`)
    writeFileSync(tmp, json, 'utf8')
    renameSync(tmp, join(vdir, name))
    names.push(name)
    while (names.length > MAX_VERSIONS) unlinkSync(join(vdir, names.shift()!))
  }

  load(id: string): Project {
    const dir = this.dirOf(id)
    let firstError: unknown
    try {
      return this.remember(parseProject(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))))
    } catch (e) {
      firstError = e
    }
    const vdir = join(dir, 'versions')
    if (existsSync(vdir)) {
      const names = readdirSync(vdir).filter((n) => /^\d+\.json$/.test(n)).sort().reverse()
      for (const n of names) {
        try {
          const p = parseProject(JSON.parse(readFileSync(join(vdir, n), 'utf8')))
          this.deps.log?.warn(`project.json inválido em ${id}; recuperado de versions/${n}`, firstError)
          return this.remember(p)
        } catch {
          // tenta a próxima mais antiga
        }
      }
    }
    throw new Error(`Projeto ${id} ilegível e sem versão recuperável: ${String(firstError)}`)
  }

  private remember(p: Project): Project {
    this.cache.set(p.id.toLowerCase(), p)
    return p
  }

  /** Projeto da memória (último load/save); senão carrega do disco. `id` pode vir em minúsculo. */
  cached(id: string): Project {
    return this.cache.get(id.toLowerCase()) ?? this.load(id)
  }

  list(): ProjectSummary[] {
    const root = this.root()
    if (!existsSync(root)) return []
    const out: ProjectSummary[] = []
    for (const name of readdirSync(root)) {
      try {
        if (!statSync(join(root, name)).isDirectory()) continue
        const p = this.load(name)
        const thumb = join(this.dirOf(name), 'cache', 'thumb.jpg')
        out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, durationUs: projectDurationUs(p), thumb: existsSync(thumb) ? thumb : undefined, originSessionId: p.originSessionId })
      } catch {
        // pasta que não é projeto válido: ignora
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return out
  }

  async remove(id: string): Promise<void> {
    const dir = this.dirOf(id)
    this.cache.delete(id.toLowerCase())
    if (!existsSync(dir)) return
    await this.deps.trash(dir)
  }

  assetPath(p: Project, assetId: string, variant: AssetVariant, sessionsStore: SessionStore): string {
    const a = p.assets.find((x) => x.id === assetId)
    if (!a) throw new Error(`asset não encontrado: ${assetId}`)
    if (variant === 'proxy') {
      if (!a.proxy) throw new Error(`asset sem proxy: ${assetId}`)
      return this.filePath(p.id, a.proxy)
    }
    if (variant === 'intermediate') {
      if (!a.intermediate) throw new Error(`asset sem intermediário: ${assetId}`)
      return this.filePath(p.id, a.intermediate)
    }
    switch (a.source.type) {
      case 'file':
        return a.source.path
      case 'session':
        return sessionsStore.filePath(a.source.sessionId, 'rec.mp4')
      case 'generated':
        return this.filePath(p.id, a.source.file)
    }
  }
}
