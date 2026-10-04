// Baixa o build pinado do whisper.cpp (CPU, Windows x64) para resources/whisper/.
// - Tenta as URLs em ordem (espelho próprio primeiro, depois o upstream).
// - Confere o sha256 pinado em VERSION.json (se vazio, imprime o hash e falha).
// - Extrai só os arquivos de execução (whisper-cli.exe + DLLs), achatando a pasta Release/.
// - LICENSE do whisper.cpp não vem no zip: fica versionado em resources/whisper/LICENSE.
// - Runtime do Visual C++ (MSVCP140, VCRUNTIME140, VCRUNTIME140_1, VCOMP140 — importados pelo whisper-cli.exe e pelas
//   DLLs do ggml, ausentes do zip e do Electron) é copiado ao lado, do %SystemRoot%\System32 desta máquina de build
//   (falha se faltar algum); versões no console e em resources/whisper/runtime.json (gerado, não versionado).
// - Confere a tabela de imports de cada .exe/.dll (src/main/transcribe/peImports.ts): todo import está na pasta ou é
//   DLL do Windows. O test:models repete a checagem no app (dev e empacotado).
// - Idempotente: pula se resources/whisper/.stamp já for igual ao build E todo padrão de `files` + o runtime tiverem
//   arquivo na pasta (use --force para baixar de novo).
// Os modelos ggml NÃO são baixados aqui (são baixados pelo app, sob demanda).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'resources', 'whisper')
const meta = JSON.parse(readFileSync(join(dir, 'VERSION.json'), 'utf8'))
const stampFile = join(dir, '.stamp')
/** Runtime do Visual C++ copiado app-local (Ruling R7). */
const RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']
const stamp = `${meta.tag} ${meta.sha256} vcrt:${RUNTIME_DLLS.join(',')}`
const force = process.argv.includes('--force')

// `files`: nomes exatos ("Release/whisper-cli.exe") ou com curinga "*" no nome ("Release/ggml-cpu-*.dll")
const globRe = (glob) => new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, (c) => '\\' + c).replace(/\*/g, '[^/]*') + '$')
const patterns = meta.files.map((f) => ({ f, re: globRe(f), name: globRe(basename(f)), hits: 0 }))

/**
 * .stamp = 1ª linha com o build; demais linhas = arquivos extraídos. Completo = carimbo igual, todo padrão de `files`
 * com arquivo na pasta (pelo nome achatado), cada arquivo extraído listado ainda presente (uma variante ggml-cpu-*.dll
 * apagada não passa) e o runtime do VC++ lá.
 */
function complete() {
  if (!existsSync(dir) || !existsSync(stampFile)) return false
  const [head, ...listed] = readFileSync(stampFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (head !== stamp || !listed.length) return false
  const names = readdirSync(dir)
  const lower = new Set(names.map((n) => n.toLowerCase()))
  const filesOk = patterns.every((p) => names.some((n) => p.name.test(n)))
  return filesOk && listed.every((n) => lower.has(n.toLowerCase())) && RUNTIME_DLLS.every((d) => lower.has(d))
}

/** Imports PE: todo .exe/.dll importa só DLLs da pasta ou do Windows. Node sem remoção de tipos: avisa (o test:models confere). */
async function checkImports() {
  let mod
  // o aviso MODULE_TYPELESS_PACKAGE_JSON (arquivo .ts com import/export num pacote sem "type") é esperado aqui
  const emitWarning = process.emitWarning
  process.emitWarning = () => {}
  try {
    mod = await import(pathToFileURL(join(root, 'src', 'main', 'transcribe', 'peImports.ts')).href)
  } catch (e) {
    console.warn(`aviso: checagem de imports PE pulada (este Node não carrega .ts: ${e.message}); o test:models confere.`)
    return
  } finally {
    process.emitWarning = emitWarning
  }
  const r = mod.checkFolderImports(dir)
  if (r.missing.length) {
    console.error(`DLLs importadas que não estão em resources/whisper nem são do Windows:\n${r.missing.map((m) => ` - ${m.file} → ${m.dll}`).join('\n')}`)
    process.exit(6)
  }
  console.log(`imports PE ok: ${r.files} arquivos; todo import está na pasta ou é DLL do Windows`)
}

if (!force && complete()) {
  await checkImports()
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

// limpa executáveis/DLLs de um build anterior (mantém VERSION.json e LICENSE versionados)
rmSync(stampFile, { force: true })
for (const name of readdirSync(dir)) if (/\.(exe|dll)$/i.test(name)) rmSync(join(dir, name), { force: true })
const zip = new AdmZip(buf)
let extracted = 0
const extractedNames = []
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue
  const p = patterns.find((x) => x.re.test(entry.entryName))
  if (!p) continue
  writeFileSync(join(dir, basename(entry.entryName)), entry.getData())
  p.hits++
  extracted++
  extractedNames.push(basename(entry.entryName))
}
const missing = patterns.filter((p) => p.hits === 0).map((p) => p.f)
if (missing.length || extracted === 0) { console.error(`extraídos ${extracted} arquivos; faltando: ${missing.join(', ')}`); process.exit(4) }
if (!existsSync(join(dir, 'LICENSE'))) { console.error('resources/whisper/LICENSE ausente (deveria estar versionado)'); process.exit(4) }

// runtime do Visual C++ desta máquina de build, ao lado do .exe (o Windows procura primeiro na pasta do executável)
const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const absent = RUNTIME_DLLS.filter((d) => !existsSync(join(sys32, d)))
if (absent.length) {
  console.error(`runtime do Visual C++ ausente nesta máquina de build (${sys32}): ${absent.join(', ')}.\nInstale o "Microsoft Visual C++ Redistributable 2015–2022 (x64)" e rode de novo.`)
  process.exit(7)
}
for (const d of RUNTIME_DLLS) copyFileSync(join(sys32, d), join(dir, d))
const versions = {}
try {
  const list = RUNTIME_DLLS.map((d) => `'${join(dir, d)}'`).join(',')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Item -LiteralPath ${list} | ForEach-Object { $_.Name + '|' + $_.VersionInfo.FileVersion }`], { encoding: 'utf8', windowsHide: true })
  for (const line of out.split(/\r?\n/)) {
    const [n, v] = line.split('|')
    if (n && v) versions[n.trim().toLowerCase()] = v.trim()
  }
} catch (e) {
  console.warn(`aviso: não foi possível ler as versões do runtime: ${e.message}`)
}
const runtime = RUNTIME_DLLS.map((d) => ({ file: d, version: versions[d] ?? null, bytes: statSync(join(dir, d)).size, sha256: sha256(readFileSync(join(dir, d))) }))
writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ source: sys32, copiedAt: new Date().toISOString(), files: runtime }, null, 2))
for (const r of runtime) console.log(`runtime VC++: ${r.file} ${r.version ?? '(versão desconhecida)'} (${r.bytes} bytes)`)
await checkImports()

// sanidade: o binário carrega e responde (--version sai com 0 e imprime a versão)
let ver = ''
try {
  ver = execFileSync(join(dir, 'whisper-cli.exe'), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  console.error(`whisper-cli.exe não executou (código ${e.status}).`)
  process.exit(5)
}
writeFileSync(stampFile, [stamp, ...extractedNames].join('\n') + '\n')
console.log(`pronto: ${extracted} arquivos + ${RUNTIME_DLLS.length} do runtime VC++ em resources/whisper (${meta.tag}) ${ver.trim().split(/\r?\n/).pop() ?? ''}`)
