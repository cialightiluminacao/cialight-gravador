// Baixa o build pinado do whisper.cpp (CPU, Windows x64) para resources/whisper/.
// - Tenta as URLs em ordem (espelho próprio primeiro, depois o upstream).
// - Confere o sha256 pinado em VERSION.json (se vazio, imprime o hash e falha).
// - Extrai só os arquivos de execução (whisper-cli.exe + DLLs), achatando a pasta Release/.
// - LICENSE do whisper.cpp não vem no zip: fica versionado em resources/whisper/LICENSE.
// - Idempotente: pula se resources/whisper/.stamp já for igual ao build (use --force para baixar de novo).
// Os modelos ggml NÃO são baixados aqui (são baixados pelo app, sob demanda).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'resources', 'whisper')
const meta = JSON.parse(readFileSync(join(dir, 'VERSION.json'), 'utf8'))
const stampFile = join(dir, '.stamp')
const stamp = `${meta.tag} ${meta.sha256}`
const force = process.argv.includes('--force')

if (!force && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp && existsSync(join(dir, 'whisper-cli.exe'))) {
  console.log(`whisper.cpp já presente (${meta.tag}); use --force para baixar de novo.`)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
const cacheZip = join(root, 'node_modules', '.cache', `whisper-${meta.tag}-${meta.zip}`)
mkdirSync(dirname(cacheZip), { recursive: true })
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

let buf
if (existsSync(cacheZip) && sha256(readFileSync(cacheZip)) === meta.sha256) {
  buf = readFileSync(cacheZip)
  console.log(`usando cache ${cacheZip}`)
} else {
  let lastErr
  for (const url of meta.urls) {
    try {
      console.log(`baixando ${url} ...`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const b = Buffer.from(await res.arrayBuffer())
      const got = sha256(b)
      if (!meta.sha256) {
        console.error(`sha256 não pinado. Calculado: ${got}\nPreencha "sha256" em resources/whisper/VERSION.json e rode de novo.`)
        process.exit(2)
      }
      if (got !== meta.sha256) throw new Error(`sha256 divergente (esperado ${meta.sha256}, obtido ${got})`)
      buf = b
      console.log(`ok: ${(buf.length / 1048576).toFixed(1)} MB, sha256 conferido`)
      break
    } catch (e) {
      lastErr = e
      console.warn(`falhou: ${e.message}`)
    }
  }
  if (!buf) { console.error('Nenhuma URL funcionou.', lastErr); process.exit(1) }
  writeFileSync(cacheZip, buf)
}

// `files`: nomes exatos ("Release/whisper-cli.exe") ou com curinga "*" no nome ("Release/ggml-cpu-*.dll")
const patterns = meta.files.map((f) => ({ f, re: new RegExp(`^${f.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`), hits: 0 }))
// limpa executáveis/DLLs de um build anterior (mantém VERSION.json e LICENSE versionados)
for (const name of readdirSync(dir)) if (/\.(exe|dll)$/i.test(name)) rmSync(join(dir, name), { force: true })
const zip = new AdmZip(buf)
let extracted = 0
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue
  const p = patterns.find((x) => x.re.test(entry.entryName))
  if (!p) continue
  writeFileSync(join(dir, basename(entry.entryName)), entry.getData())
  p.hits++
  extracted++
}
const missing = patterns.filter((p) => p.hits === 0).map((p) => p.f)
if (missing.length || extracted === 0) { console.error(`extraídos ${extracted} arquivos; faltando: ${missing.join(', ')}`); process.exit(4) }
if (!existsSync(join(dir, 'LICENSE'))) { console.error('resources/whisper/LICENSE ausente (deveria estar versionado)'); process.exit(4) }

// sanidade: o binário carrega e responde (--version sai com 0 e imprime a versão)
let ver = ''
try {
  ver = execFileSync(join(dir, 'whisper-cli.exe'), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  console.error(`whisper-cli.exe não executou (código ${e.status}). Falta o Visual C++ 2015–2022 x64 Redistributable?`)
  process.exit(5)
}
writeFileSync(stampFile, stamp)
console.log(`pronto: ${extracted} arquivos em resources/whisper (${meta.tag}) ${ver.trim().split(/\r?\n/).pop() ?? ''}`)
