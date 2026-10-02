import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseProject } from '@shared/editor/schema'
import { projectDurationUs, updateAsset } from '@shared/editor/ops'
import { sessionRefs } from '@shared/editor/fromSession'
import type { Asset, Project } from '@shared/editor/project'
import type { ProjectSummary } from '@shared/ipc'
import type { SessionStore } from '../session/sessionStore'
import { derivedComplete } from '../media/proxyPolicy'
import { isAudioProcessKey, isSourceFingerprint, processedAudioRel, sourceFingerprint } from '@shared/editor/audioProcess'

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
  /** O rec.mp4 da gravação existe? (assets de sessão: sem ele → 'missing'). Ausente = não confere. */
  sessionMediaExists?: (sessionId: string) => boolean
  /** Caminho do rec.mp4 da gravação (impressão digital da fonte dos assets de sessão). Ausente = não confere. */
  sessionMediaFile?: (sessionId: string) => string
}

export type AssetVariant = 'original' | 'proxy' | 'intermediate'

const SUBDIRS = ['proxies', 'cache', 'generated', 'versions']
const MAX_VERSIONS = 20
const VERSION_MIN_INTERVAL_MS = 60_000

function reappeared(a: Asset): Asset['status'] {
  if (derivedComplete(a)) return 'ready'
  return a.error ? 'error' : 'processing'
}

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

  /** Cria a pasta e o project.json; lança se o projeto já existe (nunca sobrescreve). */
  create(p: Project): void {
    const dir = this.dirOf(p.id)
    if (existsSync(join(dir, 'project.json'))) throw new Error(`Projeto ${p.id} já existe`)
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

  /**
   * Confere no disco os assets de arquivo importado: ausente ou com tamanho diferente → 'missing'.
   * 'missing' que voltou com o mesmo tamanho: 'ready' com derivados completos; senão 'error' se havia
   * erro registrado, ou 'processing' (o editor reenfileira). Assets de gravação: sem o rec.mp4 (gravação
   * apagada/na lixeira) → 'missing'; de volta → 'ready'. Devolve a mesma referência se nada mudou.
   */
  withMediaStatus(p: Project): Project {
    let changed = false
    const sessionExists = this.deps.sessionMediaExists
    const withStatus = (a: Asset): Asset => {
      if (a.source.type === 'session') {
        if (!sessionExists) return a
        const present = sessionExists(a.source.sessionId)
        const status: Asset['status'] = !present ? 'missing' : a.status === 'missing' ? 'ready' : a.status
        if (status === a.status) return a
        changed = true
        return { ...a, status }
      }
      if (a.source.type !== 'file') return a
      let present = false
      try {
        present = statSync(a.source.path).size === a.source.size
      } catch {
        present = false
      }
      const status: Asset['status'] = !present ? 'missing' : a.status === 'missing' ? reappeared(a) : a.status
      if (status === a.status) return a
      changed = true
      return { ...a, status }
    }
    // áudio pré-processado é cache: chave sem arquivo (projeto aberto em outro PC) ou de parâmetros antigos sai da
    // lista, e o editor reprocessa se o item ainda pede
    const withProcessed = (a: Asset): Asset => {
      if (!a.processedAudio) return a
      const current = this.sourceFingerprintOf(p, a)
      const entries = Object.entries(a.processedAudio)
      const keep = entries.filter(([k, fp]) => isAudioProcessKey(k) && isSourceFingerprint(fp) && (current === null || fp === current) && existsSync(this.filePath(p.id, processedAudioRel(a.id, k, fp))))
      if (keep.length === entries.length) return a
      changed = true
      const { processedAudio: _, ...rest } = a
      return keep.length ? { ...rest, processedAudio: Object.fromEntries(keep) } : rest
    }
    const assets = p.assets.map((a) => withProcessed(withStatus(a)))
    return changed ? { ...p, assets } : p
  }

  private remember(p: Project): Project {
    this.cache.set(p.id.toLowerCase(), p)
    return p
  }

  /**
   * Acrescenta (ou substitui pelo id) assets só no cache em memória, sem gravar: assets recém-importados
   * ficam resolvíveis pelo protocolo media/ e por media.enqueue antes do próximo save do renderer.
   */
  cacheAssets(id: string, assets: Asset[]): void {
    const p = this.cached(id)
    const ids = new Set(assets.map((a) => a.id))
    this.cache.set(p.id.toLowerCase(), { ...p, assets: [...p.assets.filter((a) => !ids.has(a.id)), ...assets] })
  }

  /**
   * Aplica o resultado da ingestão direto no disco (sem editor com o projeto aberto): parte do
   * project.json, acrescenta assets que só existem no cache (importados e ainda não salvos), aplica o
   * patch e salva (o save atualiza o cache). Lança se o asset não existe em nenhum dos dois.
   */
  applyAssetPatch(id: string, assetId: string, patch: Partial<Asset>, nowIso: string): void {
    const memo = this.cache.get(id.toLowerCase())
    const disk = this.load(id)
    const onDisk = new Set(disk.assets.map((a) => a.id))
    const extra = (memo?.assets ?? []).filter((a) => !onDisk.has(a.id))
    const merged = extra.length ? { ...disk, assets: [...disk.assets, ...extra] } : disk
    this.save({ ...updateAsset(merged, assetId, patch), updatedAt: nowIso })
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

  /**
   * Gravação → projetos que dependem dela (ver sessionRefs), lendo todos os project.json (e o projeto em
   * memória, que pode ter assets ainda não salvos). Pastas que não são projeto válido são ignoradas.
   */
  sessionUsage(): Map<string, { id: string; name: string }[]> {
    const out = new Map<string, { id: string; name: string }[]>()
    const add = (p: Project): void => {
      for (const s of sessionRefs(p)) {
        const list = out.get(s) ?? []
        if (!list.some((x) => x.id === p.id)) list.push({ id: p.id, name: p.name })
        out.set(s, list)
      }
    }
    const root = this.root()
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        try {
          if (!statSync(join(root, name)).isDirectory()) continue
          add(this.load(name))
        } catch {
          // pasta que não é projeto válido: ignora
        }
      }
    }
    for (const p of this.cache.values()) add(p)
    return out
  }

  /** Pastas de projeto existentes (manutenção: limpeza de temporários). */
  projectDirs(): string[] {
    const root = this.root()
    if (!existsSync(root)) return []
    const out: string[] = []
    for (const name of readdirSync(root)) {
      try {
        if (/^[\w.-]+$/.test(name) && statSync(join(root, name)).isDirectory()) out.push(join(root, name))
      } catch {
        // ignora
      }
    }
    return out
  }

  async remove(id: string): Promise<void> {
    const dir = this.dirOf(id)
    this.cache.delete(id.toLowerCase())
    if (!existsSync(dir)) return
    await this.deps.trash(dir)
  }

  /**
   * Versão de áudio pré-processada (generated/<asset>.audio-<chave>.<impressão>.m4a). Resolve pela chave e impressão
   * (validadas) sem exigir que `processedAudio` do projeto em memória já as liste: o renderer pode ainda não ter salvo.
   */
  processedAudioPath(p: Project, assetId: string, key: string, fingerprint: string): string {
    if (!p.assets.some((x) => x.id === assetId)) throw new Error(`asset não encontrado: ${assetId}`)
    if (!isAudioProcessKey(key)) throw new Error(`chave de áudio processado inválida: ${key}`)
    if (!isSourceFingerprint(fingerprint)) throw new Error(`impressão da fonte inválida: ${fingerprint}`)
    return this.filePath(p.id, processedAudioRel(assetId, key, fingerprint))
  }

  /**
   * Impressão digital (tamanho + mtime) do arquivo de origem do asset — o importado, o rec.mp4 da gravação ou o
   * gerado —, a mesma que a fila usa ao processar; null se não dá para ler (ausente) ou conferir.
   */
  sourceFingerprintOf(p: Project, a: Asset): string | null {
    const src = a.source
    if (src.type === 'session' && !this.deps.sessionMediaFile) return null
    try {
      const path = src.type === 'file' ? src.path : src.type === 'generated' ? this.filePath(p.id, src.file) : this.deps.sessionMediaFile!(src.sessionId)
      const st = statSync(path)
      return sourceFingerprint(st.size, st.mtimeMs)
    } catch {
      return null
    }
  }

  /**
   * Apaga as versões de áudio processadas do asset em generated/ (relink: o arquivo de origem mudou). Cada arquivo
   * na sua tentativa: um que falhe (em uso, sem permissão) só vira aviso e não impede os outros. Devolve quantos saíram.
   */
  removeProcessedAudio(id: string, assetId: string): number {
    const gen = join(this.dirOf(id), 'generated')
    if (!existsSync(gen)) return 0
    let removed = 0
    for (const f of readdirSync(gen)) {
      if (!f.startsWith(`${assetId}.audio-`)) continue
      try {
        rmSync(join(gen, f), { force: true })
        removed++
      } catch (e) {
        this.deps.log?.warn(`não foi possível apagar o áudio processado ${f} de ${id}`, e)
      }
    }
    return removed
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
