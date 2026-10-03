import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { BRAND_FILE_VERSION, BRAND_MAX_ASSET_BYTES, BRAND_NAME_MAX, BrandTemplateSchema, formatBrandMb as fmtMb, isSafeBrandFileName, isSafeBrandId, type BrandTemplate } from '@shared/editor/brand'

// Modelos de marca no main: <dir>/brand-templates.json (versão 1, validado com zod; gravação atômica tmp + rename,
// como settingsStore.persist) e os arquivos em <dir>/brand-assets/<id do modelo>/. NUNCA no settings.json. `dir` é o
// userData do app; em teste/QA, uma pasta de teste (brandDir.ts) — os modelos reais do usuário não são tocados.
// Arquivo corrompido (JSON ou envelope inválido): renomeado para brand-templates.corrupt-<data>.json (nunca apagado) e a
// lista começa vazia. Envelope válido com ALGUNS modelos inválidos (ex.: valor de uma versão mais nova do app, edição à
// mão): só esses saem, com aviso; o original é copiado para brand-templates.corrupt-<data>.json ANTES de regravar a
// lista com os modelos válidos — nada se perde.

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Pasta dos modelos: `userData` no uso normal. Em teste/QA (CIALIGHT_TEST/CIALIGHT_QA/CIALIGHT_SHOT) NUNCA o userData
 * (o app instalado o compartilha): CIALIGHT_BRAND_DIR, senão <CIALIGHT_RAW_DIR>/../brand (padrão test-out/brand).
 */
export function brandDirFor(env: Record<string, string | undefined>, userData: string, cwd: string = process.cwd()): string {
  if (env.CIALIGHT_BRAND_DIR) return resolve(cwd, env.CIALIGHT_BRAND_DIR)
  if (env.CIALIGHT_TEST || env.CIALIGHT_QA || env.CIALIGHT_SHOT) return resolve(cwd, env.CIALIGHT_RAW_DIR || 'test-out/raw', '..', 'brand')
  return userData
}

export interface BrandStoreOpts { now?: () => Date; maxBytes?: number }

export class BrandStore {
  private readonly now: () => Date
  private readonly maxBytes: number
  constructor(private readonly dir: string, opts: BrandStoreOpts = {}) {
    this.now = opts.now ?? (() => new Date())
    this.maxBytes = opts.maxBytes ?? BRAND_MAX_ASSET_BYTES
  }

  private get file(): string {
    return join(this.dir, 'brand-templates.json')
  }
  private assetsDir(id: string): string {
    if (!isSafeBrandId(id)) throw new Error(`id de modelo inválido: ${id}`)
    return join(this.dir, 'brand-assets', id)
  }

  /** Nome livre para guardar o original (brand-templates.corrupt-<data>[-n].json). */
  private corruptTarget(): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    let target = join(this.dir, `brand-templates.corrupt-${stamp}.json`)
    for (let n = 2; existsSync(target); n++) target = join(this.dir, `brand-templates.corrupt-${stamp}-${n}.json`)
    return target
  }

  /**
   * Modelos gravados. Arquivo corrompido → renomeado e `warning` (a lista começa vazia). Modelos inválidos num arquivo
   * válido → só eles saem, com `warning`; o original é copiado antes de a lista ser regravada sem eles.
   */
  list(): { templates: BrandTemplate[]; warning?: string } {
    if (!existsSync(this.file)) return { templates: [] }
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (e) {
      throw new Error(`Não foi possível ler os modelos de marca: ${errText(e)}`)
    }
    let entries: unknown[] | null = null
    try {
      const doc = JSON.parse(raw) as { version?: unknown; templates?: unknown }
      if (doc && doc.version === BRAND_FILE_VERSION && Array.isArray(doc.templates)) entries = doc.templates
    } catch {
      entries = null
    }
    if (!entries) {
      const target = this.corruptTarget()
      renameSync(this.file, target)
      return { templates: [], warning: `O arquivo de modelos de marca estava corrompido e foi guardado como ${basename(target)}; a lista de modelos começou vazia.` }
    }
    const templates: BrandTemplate[] = []
    let skipped = 0
    for (const e of entries) {
      const r = BrandTemplateSchema.safeParse(e)
      if (r.success) templates.push(r.data)
      else skipped++
    }
    if (!skipped) return { templates }
    const target = this.corruptTarget()
    copyFileSync(this.file, target) // o original inteiro fica guardado antes de regravar
    this.persist(templates)
    const n = skipped === 1 ? '1 modelo de marca não pôde ser lido e ficou' : `${skipped} modelos de marca não puderam ser lidos e ficaram`
    return { templates, warning: `${n} de fora (talvez de outra versão do app); os outros continuam. O arquivo original foi guardado como ${basename(target)}.` }
  }

  /**
   * Lista para quem vai mexer nela (get/save/rename/remove): se o arquivo estava corrompido (acabou de ser renomeado),
   * lança com o aviso — nunca grava por cima da lista que o usuário via sem dizer nada.
   */
  private current(): BrandTemplate[] {
    const r = this.list()
    if (r.warning) throw new Error(r.warning)
    return r.templates
  }

  get(id: string): BrandTemplate {
    const t = this.current().find((x) => x.id === id)
    if (!t) throw new Error('Modelo não encontrado (talvez tenha sido excluído)')
    return t
  }

  /** Caminho do arquivo do asset `assetId` do modelo (para copiar para um projeto). */
  assetPath(templateId: string, assetId: string): string {
    const a = this.get(templateId).assets.find((x) => x.id === assetId)
    if (!a || !isSafeBrandFileName(a.file)) throw new Error('Arquivo do modelo não encontrado')
    return join(this.assetsDir(templateId), a.file)
  }

  private persist(templates: BrandTemplate[]): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: BRAND_FILE_VERSION, templates }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * Grava o modelo copiando `files` (asset do modelo → arquivo de origem) para brand-assets/<id>/. Cópia numa pasta
   * temporária renomeada no fim; qualquer falha (cópia, limite, gravação do JSON) não deixa nada pela metade.
   */
  save(template: BrandTemplate, files: readonly { assetId: string; path: string }[]): BrandTemplate {
    const parsed = BrandTemplateSchema.safeParse(template)
    if (!parsed.success) throw new Error(`Modelo inválido: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const t = parsed.data
    const templates = this.current()
    if (templates.some((x) => x.id === t.id)) throw new Error(`O modelo ${t.id} já existe`)
    const sources = t.assets.map((a) => {
      const f = files.find((x) => x.assetId === a.id)
      if (!f) throw new Error(`Falta o arquivo “${a.name}” do modelo`)
      return { a, path: f.path }
    })
    let total = 0
    for (const s of sources) {
      try {
        total += statSync(s.path).size
      } catch (e) {
        throw new Error(`Não foi possível copiar “${s.a.name}”: ${errText(e)}`)
      }
    }
    if (total > this.maxBytes) throw new Error(`Os arquivos do modelo somam ${fmtMb(total)}; o limite é ${fmtMb(this.maxBytes)} por modelo.`)
    const final = this.assetsDir(t.id)
    if (sources.length) {
      if (existsSync(final)) rmSync(final, { recursive: true, force: true }) // sobra de um modelo apagado sem a pasta
      const staging = `${final}.part`
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      try {
        for (const s of sources) {
          try {
            copyFileSync(s.path, join(staging, s.a.file))
          } catch (e) {
            throw new Error(`Não foi possível copiar “${s.a.name}”: ${errText(e)}`)
          }
        }
        renameSync(staging, final)
      } catch (e) {
        rmSync(staging, { recursive: true, force: true })
        throw e
      }
    }
    try {
      this.persist([...templates, t])
    } catch (e) {
      rmSync(final, { recursive: true, force: true })
      rmSync(`${this.file}.tmp`, { recursive: true, force: true })
      throw new Error(`Não foi possível gravar o modelo: ${errText(e)}`)
    }
    return t
  }

  rename(id: string, name: string): BrandTemplate {
    const clean = name.trim().slice(0, BRAND_NAME_MAX)
    if (!clean) throw new Error('Dê um nome ao modelo')
    const templates = this.current()
    const i = templates.findIndex((x) => x.id === id)
    if (i < 0) throw new Error('Modelo não encontrado (talvez tenha sido excluído)')
    const next = { ...templates[i], name: clean }
    this.persist(templates.map((x, j) => (j === i ? next : x)))
    return next
  }

  /** Tira o modelo da lista e apaga a pasta dos arquivos dele (projetos que o usaram têm cópia própria). */
  remove(id: string): void {
    const templates = this.current()
    if (!templates.some((x) => x.id === id)) throw new Error('Modelo não encontrado (talvez tenha sido excluído)')
    // a pasta sai do caminho primeiro (rename atômico; em uso → erro e nada muda), depois a lista; apagar a pasta
    // renomeada é o último passo (se falhar, é só sobra de disco, limpa no próximo remove/save do mesmo id)
    const dir = this.assetsDir(id)
    const trash = `${dir}.removing`
    rmSync(trash, { recursive: true, force: true })
    if (existsSync(dir)) {
      try {
        renameSync(dir, trash)
      } catch (e) {
        throw new Error(`Não foi possível excluir os arquivos do modelo (estão em uso?): ${errText(e)}`)
      }
    }
    try {
      this.persist(templates.filter((x) => x.id !== id))
    } catch (e) {
      if (existsSync(trash)) renameSync(trash, dir)
      throw e
    }
    try {
      rmSync(trash, { recursive: true, force: true })
    } catch {
      // sobra de disco; o modelo já saiu da lista
    }
  }
}
