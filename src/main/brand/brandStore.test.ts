import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BrandStore, brandDirFor } from './brandStore'
import type { BrandTemplate } from '@shared/editor/brand'
import { createTextItem, createMediaItem } from '@shared/editor/factory'
import type { Asset } from '@shared/editor/project'

// Store dos modelos de marca (main): brand-templates.json (versão 1, zod, gravação atômica) + brand-assets/<id>/.

const S = 1_000_000
const logo: Asset = { id: 'logo', name: 'logo.png', kind: 'image', source: { type: 'file', path: 'x', size: 1, mtimeMs: 1 }, durationUs: null, status: 'ready' }
function tpl(id: string, withAsset = true): BrandTemplate {
  const text = { ...createTextItem('title', 0), id: 'i1' }
  const media = { ...createMediaItem(logo, 0, 'video'), id: 'i2', durationUs: 3 * S }
  return {
    id, name: `Modelo ${id}`, kind: 'intro', createdAt: '2026-10-02T12:00:00.000Z', durationUs: 3 * S,
    tracks: [...(withAsset ? [{ items: [media] }] : []), { items: [text] }],
    assets: withAsset ? [{ id: 'logo', name: 'logo.png', kind: 'image', file: '1-logo.png' }] : []
  }
}

describe('brandDirFor', () => {
  it('uso normal: userData; teste/QA: pasta de teste (nunca o userData do app instalado)', () => {
    expect(brandDirFor({}, 'C:/UD', 'C:/repo')).toBe('C:/UD')
    expect(brandDirFor({ CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' }, 'C:/UD', 'C:/repo')).toBe(join('C:/repo', 'test-out', 'brand'))
    expect(brandDirFor({ CIALIGHT_TEST: 'editor-render' }, 'C:/UD', 'C:/repo')).toBe(join('C:/repo', 'test-out', 'brand'))
    expect(brandDirFor({ CIALIGHT_QA: 'x', CIALIGHT_BRAND_DIR: 'test-out/b2' }, 'C:/UD', 'C:/repo')).toBe(join('C:/repo', 'test-out', 'b2'))
  })
})

describe('BrandStore', () => {
  let dir: string
  let src: string
  let store: BrandStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cialight-brand-'))
    src = join(dir, 'origem')
    mkdirSync(src)
    writeFileSync(join(src, 'logo.png'), Buffer.from('PNGDATA'))
    store = new BrandStore(join(dir, 'ud'), { now: () => new Date('2026-10-02T13:14:15.000Z') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const file = (): string => join(dir, 'ud', 'brand-templates.json')

  it('sem arquivo: lista vazia, sem aviso e sem criar nada', () => {
    expect(store.list()).toEqual({ templates: [] })
    expect(existsSync(join(dir, 'ud'))).toBe(false)
  })

  it('salvar copia os arquivos para brand-assets/<id>/, grava versão 1 e lista; renomear; remover apaga a pasta', () => {
    const saved = store.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'logo.png') }])
    expect(saved.id).toBe('bt_a')
    expect(readFileSync(join(dir, 'ud', 'brand-assets', 'bt_a', '1-logo.png'), 'utf8')).toBe('PNGDATA')
    const disk = JSON.parse(readFileSync(file(), 'utf8'))
    expect(disk.version).toBe(1)
    expect(disk.templates.map((t: BrandTemplate) => t.id)).toEqual(['bt_a'])
    store.save(tpl('bt_b', false), [])
    expect(store.list().templates.map((t) => t.id)).toEqual(['bt_a', 'bt_b'])
    expect(store.assetPath('bt_a', 'logo')).toBe(join(dir, 'ud', 'brand-assets', 'bt_a', '1-logo.png'))
    expect(store.rename('bt_a', '  Abertura  ').name).toBe('Abertura')
    expect(store.list().templates[0].name).toBe('Abertura')
    expect(() => store.rename('bt_a', '   ')).toThrow(/nome/)
    store.remove('bt_a')
    expect(store.list().templates.map((t) => t.id)).toEqual(['bt_b'])
    expect(existsSync(join(dir, 'ud', 'brand-assets', 'bt_a'))).toBe(false)
    expect(() => store.remove('bt_a')).toThrow(/não encontrado/)
    // nada de temporário sobrando
    expect(readdirSync(join(dir, 'ud')).sort()).toEqual(['brand-assets', 'brand-templates.json'])
  })

  it('gravação atômica: escreve no .tmp e renomeia (um .tmp velho não atrapalha)', () => {
    mkdirSync(join(dir, 'ud'), { recursive: true })
    writeFileSync(`${file()}.tmp`, 'lixo de uma gravação interrompida')
    store.save(tpl('bt_a', false), [])
    expect(existsSync(`${file()}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file(), 'utf8')).templates).toHaveLength(1)
  })

  it('arquivo corrompido: renomeado para brand-templates.corrupt-<data>.json (nunca apagado), lista vazia com aviso', () => {
    mkdirSync(join(dir, 'ud'), { recursive: true })
    writeFileSync(file(), '{ "version": 1, "templates": [ { quebrado')
    const r = store.list()
    expect(r.templates).toEqual([])
    expect(r.warning).toMatch(/corrompido/)
    const corrupt = readdirSync(join(dir, 'ud')).filter((f) => f.startsWith('brand-templates.corrupt-'))
    expect(corrupt).toEqual(['brand-templates.corrupt-2026-10-02T13-14-15-000Z.json'])
    expect(readFileSync(join(dir, 'ud', corrupt[0]), 'utf8')).toContain('quebrado')
    expect(existsSync(file())).toBe(false)
    // schema inválido (versão desconhecida) também
    writeFileSync(file(), JSON.stringify({ version: 2, templates: [] }))
    expect(new BrandStore(join(dir, 'ud'), { now: () => new Date('2026-10-02T13:14:16.000Z') }).list().warning).toMatch(/corrompido/)
    expect(readdirSync(join(dir, 'ud')).filter((f) => f.startsWith('brand-templates.corrupt-'))).toHaveLength(2)
  })

  it('um modelo inválido (ex.: de uma versão mais nova): só ele sai, os outros ficam; o original é guardado antes de regravar', () => {
    store.save(tpl('bt_a', false), [])
    store.save(tpl('bt_c', false), [])
    const disk = JSON.parse(readFileSync(file(), 'utf8'))
    const future = { ...disk.templates[0], id: 'bt_b', kind: 'transicaoNova' } // valor de enum que este build não conhece
    disk.templates.splice(1, 0, future)
    const original = JSON.stringify(disk, null, 2)
    writeFileSync(file(), original)
    const r = store.list()
    expect(r.templates.map((t) => t.id)).toEqual(['bt_a', 'bt_c'])
    expect(r.warning).toMatch(/^1 modelo de marca não pôde ser lido e ficou de fora .*os outros continuam.*brand-templates\.corrupt-2026-10-02T13-14-15-000Z\.json/)
    // o original inteiro (com o modelo desconhecido) foi guardado; a lista foi regravada só com os válidos
    expect(readFileSync(join(dir, 'ud', 'brand-templates.corrupt-2026-10-02T13-14-15-000Z.json'), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(file(), 'utf8')).templates.map((t: BrandTemplate) => t.id)).toEqual(['bt_a', 'bt_c'])
    // a próxima leitura é limpa e editar continua funcionando
    expect(store.list()).toEqual({ templates: r.templates })
    store.rename('bt_c', 'C')
    expect(store.list().templates.map((t) => t.name)).toEqual(['Modelo bt_a', 'C'])
  })

  it('vários inválidos: contagem no aviso; todos inválidos: lista vazia, original guardado, arquivo continua válido', () => {
    store.save(tpl('bt_a', false), [])
    const disk = JSON.parse(readFileSync(file(), 'utf8'))
    writeFileSync(file(), JSON.stringify({ version: 1, templates: [{ id: '../fora' }, 42, disk.templates[0]] }))
    const r = store.list()
    expect(r.templates.map((t) => t.id)).toEqual(['bt_a'])
    expect(r.warning).toMatch(/^2 modelos de marca não puderam ser lidos e ficaram de fora/)
    writeFileSync(file(), JSON.stringify({ version: 1, templates: [{ nada: true }] }))
    const s2 = new BrandStore(join(dir, 'ud'), { now: () => new Date('2026-10-02T13:14:16.000Z') })
    expect(s2.list().templates).toEqual([])
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, templates: [] })
    const backups = readdirSync(join(dir, 'ud')).filter((f) => f.startsWith('brand-templates.corrupt-'))
    expect(backups).toHaveLength(2)
    expect(backups.map((b) => readFileSync(join(dir, 'ud', b), 'utf8')).some((t) => t.includes('"nada":true'))).toBe(true)
  })

  it('corrompido entre listar e salvar/renomear/excluir: lança com o aviso (não grava por cima calado)', () => {
    store.save(tpl('bt_a', false), [])
    writeFileSync(file(), 'quebrado')
    expect(() => store.save(tpl('bt_b', false), [])).toThrow(/corrompido/)
    writeFileSync(file(), 'quebrado')
    expect(() => store.rename('bt_a', 'X')).toThrow(/corrompido/)
    writeFileSync(file(), 'quebrado')
    expect(() => store.remove('bt_a')).toThrow(/corrompido/)
    expect(readdirSync(join(dir, 'ud')).filter((f) => f.startsWith('brand-templates.corrupt-')).length).toBeGreaterThanOrEqual(1)
    // depois do aviso, salvar começa uma lista nova
    store.save(tpl('bt_b', false), [])
    expect(store.list().templates.map((t) => t.id)).toEqual(['bt_b'])
  })

  it('excluir: a pasta sai por rename antes de mexer na lista; sobra .removing antiga é limpa', () => {
    store.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'logo.png') }])
    writeFileSync(join(dir, 'ud', 'brand-assets', 'bt_a.removing'), 'sobra de uma exclusão anterior')
    store.remove('bt_a')
    expect(store.list().templates).toEqual([])
    expect(readdirSync(join(dir, 'ud', 'brand-assets'))).toEqual([])
  })

  it('zod: modelo inválido, id repetido, arquivo faltando ou caminho inseguro → recusa sem deixar nada pela metade', () => {
    expect(() => store.save({ ...tpl('bt_a'), id: '../fora' }, [{ assetId: 'logo', path: join(src, 'logo.png') }])).toThrow(/inválido/)
    expect(() => store.save(tpl('bt_a'), [])).toThrow(/logo\.png/)
    expect(() => store.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'nao-existe.png') }])).toThrow(/Não foi possível copiar/)
    expect(existsSync(join(dir, 'ud', 'brand-assets', 'bt_a'))).toBe(false)
    expect(existsSync(join(dir, 'ud', 'brand-assets')) ? readdirSync(join(dir, 'ud', 'brand-assets')) : []).toEqual([])
    store.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'logo.png') }])
    expect(() => store.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'logo.png') }])).toThrow(/já existe/)
  })

  it('cópia falhando no 2º arquivo (o 1º já copiado): a pasta temporária sai, nada na lista', () => {
    const two = { ...tpl('bt_a'), durationUs: 4 * S }
    two.assets.push({ id: 'logo2', name: 'logo2.png', kind: 'image', file: '2-logo2.png' })
    two.tracks[0].items.push({ ...createMediaItem({ ...logo, id: 'logo2' }, 3 * S, 'video'), id: 'i3', durationUs: S })
    mkdirSync(join(src, 'pasta.png')) // stat passa, copiar falha
    expect(() => store.save(two, [{ assetId: 'logo', path: join(src, 'logo.png') }, { assetId: 'logo2', path: join(src, 'pasta.png') }])).toThrow(/Não foi possível copiar “logo2.png”/)
    expect(readdirSync(join(dir, 'ud', 'brand-assets'))).toEqual([])
    expect(store.list().templates).toEqual([])
  })

  it('limite de 500 MB por modelo (aqui 4 bytes)', () => {
    const small = new BrandStore(join(dir, 'ud'), { maxBytes: 4 })
    expect(() => small.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'logo.png') }])).toThrow(/limite/)
    expect(existsSync(join(dir, 'ud', 'brand-assets', 'bt_a'))).toBe(false)
  })

  it('falha ao gravar o JSON depois de copiar: a pasta copiada sai (nada fica pela metade)', () => {
    mkdirSync(file(), { recursive: true }) // o .json é uma pasta: rename falha
    expect(() => store.save(tpl('bt_a'), [{ assetId: 'logo', path: join(src, 'logo.png') }])).toThrow()
    expect(existsSync(join(dir, 'ud', 'brand-assets', 'bt_a'))).toBe(false)
  })
})
