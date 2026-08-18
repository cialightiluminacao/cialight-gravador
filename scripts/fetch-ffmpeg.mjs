// Baixa o build pinado do ffmpeg (BtbN, série 8.1) para resources/ffmpeg/.
// - Tenta as URLs em ordem (espelho próprio primeiro, depois BtbN).
// - Confere o sha256 pinado em VERSION.json (se vazio, imprime o hash e falha).
// - Extrai só ffmpeg.exe, ffprobe.exe e LICENSE.txt (achatando bin/).
// - Idempotente: pula se resources/ffmpeg/.stamp já for igual ao build.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'resources', 'ffmpeg')
const meta = JSON.parse(readFileSync(join(dir, 'VERSION.json'), 'utf8'))
const stampFile = join(dir, '.stamp')
const force = process.argv.includes('--force')

if (!force && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === meta.build && existsSync(join(dir, 'ffmpeg.exe'))) {
  console.log(`ffmpeg já presente (${meta.build}); use --force para baixar de novo.`)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
const cacheZip = join(root, 'node_modules', '.cache', `${meta.build}.zip`)
mkdirSync(dirname(cacheZip), { recursive: true })

let buf
if (existsSync(cacheZip)) {
  buf = readFileSync(cacheZip)
  console.log(`usando cache ${cacheZip}`)
} else {
  let lastErr
  for (const url of meta.urls) {
    try {
      console.log(`baixando ${url} ...`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      buf = Buffer.from(await res.arrayBuffer())
      console.log(`ok: ${(buf.length / 1048576).toFixed(1)} MB`)
      break
    } catch (e) {
      lastErr = e
      console.warn(`falhou: ${e.message}`)
    }
  }
  if (!buf) { console.error('Nenhuma URL funcionou.', lastErr); process.exit(1) }
  writeFileSync(cacheZip, buf)
}

const sha = createHash('sha256').update(buf).digest('hex')
if (!meta.sha256) {
  console.error(`sha256 não pinado. Calculado: ${sha}\nPreencha "sha256" em resources/ffmpeg/VERSION.json e rode de novo.`)
  process.exit(2)
}
if (sha !== meta.sha256) {
  console.error(`sha256 divergente!\n esperado ${meta.sha256}\n obtido   ${sha}`)
  rmSync(cacheZip, { force: true })
  process.exit(3)
}

const zip = new AdmZip(buf)
// `files` aceita caminhos exatos ("LICENSE.txt") ou prefixos com curinga ("bin/*" = tudo dentro de bin/)
const exact = new Set(meta.files.filter((f) => !f.endsWith('/*')))
const prefixes = meta.files.filter((f) => f.endsWith('/*')).map((f) => f.slice(0, -1))
let extracted = 0
const seenExact = new Set()
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue
  // entradas vêm como "<build>/bin/ffmpeg.exe"
  const rel = entry.entryName.split('/').slice(1).join('/')
  const byPrefix = prefixes.some((p) => rel.startsWith(p) && !rel.slice(p.length).includes('/'))
  if (exact.has(rel) || byPrefix) {
    writeFileSync(join(dir, basename(rel)), entry.getData())
    extracted++
    if (exact.has(rel)) seenExact.add(rel)
  }
}
if (seenExact.size !== exact.size || extracted === 0) { console.error(`extraídos ${extracted} arquivos; faltando: ${[...exact].filter((f) => !seenExact.has(f)).join(', ')}`); process.exit(4) }
if (!existsSync(join(dir, 'ffmpeg.exe')) || !existsSync(join(dir, 'ffprobe.exe'))) { console.error('ffmpeg.exe/ffprobe.exe não encontrados no zip'); process.exit(4) }

const ver = execFileSync(join(dir, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8' }).split('\n')[0]
if (!ver.includes(`ffmpeg version n${meta.series}`)) { console.error(`versão inesperada: ${ver}`); process.exit(5) }
writeFileSync(stampFile, meta.build)
console.log(`pronto: ${ver}`)
