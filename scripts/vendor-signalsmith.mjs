// Vendoriza o WASM do signalsmith-stretch (MIT) em src/renderer/src/editor/engine/audio/signalsmithWasm.ts.
// O pacote npm só publica a fábrica de AudioWorkletNode (glue emscripten minificado + WASM em base64).
// Aqui extraímos só o binário WASM e o mapa de nomes minificados (imports a..d, exports e..y) para um módulo
// nosso; o carregador (stretch.ts) instancia o WASM direto, sem o glue — funciona em Worker, na página e no
// Node (vitest). Rodar de novo ao atualizar o pacote: `node scripts/vendor-signalsmith.mjs`.
// Falha alto se o formato do arquivo publicado mudar (nada é gerado pela metade).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'node_modules', 'signalsmith-stretch')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const src = readFileSync(join(pkgDir, 'SignalsmithStretch.mjs'), 'utf8')
const outFile = join(root, 'src', 'renderer', 'src', 'editor', 'engine', 'audio', 'signalsmithWasm.ts')

function fail(msg) {
  console.error(`vendor-signalsmith: ${msg} (formato do SignalsmithStretch.mjs ${pkg.version} mudou?)`)
  process.exit(1)
}

const b64 = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/.exec(src)?.[1]
if (!b64) fail('WASM em base64 não encontrado')
const wasm = Buffer.from(b64, 'base64')
if (wasm.readUInt32LE(0) !== 0x6d736100) fail('o base64 não é um módulo WASM')

// imports: var wasmImports={d:__abort_js,c:__emscripten_memcpy_js,b:_emscripten_resize_heap,a:_random_get}
const impSrc = /var wasmImports=\{([^}]*)\}/.exec(src)?.[1]
if (!impSrc) fail('wasmImports não encontrado')
const impByFn = Object.fromEntries(impSrc.split(',').map((kv) => kv.split(':').reverse()))
const imports = { abort: impByFn.__abort_js, memcpy: impByFn.__emscripten_memcpy_js, resizeHeap: impByFn._emscripten_resize_heap, randomGet: impByFn._random_get }
if (Object.values(imports).some((v) => !v) || Object.keys(impByFn).length !== 4) fail(`imports inesperados: ${impSrc}`)

// exports: Module["_setBuffers"]=(a0,a1)=>(_setBuffers=Module["_setBuffers"]=wasmExports["h"])(a0,a1)
const exportsMap = {}
for (const m of src.matchAll(/Module\["_(\w+)"\]=wasmExports\["(\w+)"\]/g)) exportsMap[m[1]] = m[2]
exportsMap.memory = /wasmMemory=wasmExports\["(\w+)"\]/.exec(src)?.[1]
exportsMap.ctors = /addOnInit\(wasmExports\["(\w+)"\]\)/.exec(src)?.[1]
const needed = ['memory', 'ctors', 'main', 'presetDefault', 'presetCheaper', 'inputLatency', 'outputLatency', 'setBuffers', 'reset', 'seek', 'process', 'flush']
const missing = needed.filter((k) => !exportsMap[k])
if (missing.length) fail(`exports não encontrados: ${missing.join(', ')}`)
const exportsPicked = Object.fromEntries(needed.map((k) => [k, exportsMap[k]]))

// confere que o binário exporta/importa exatamente esses nomes
const mod = new WebAssembly.Module(wasm)
const wasmExports = new Set(WebAssembly.Module.exports(mod).map((e) => e.name))
const wasmImports = new Set(WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`))
for (const [k, v] of Object.entries(exportsPicked)) if (!wasmExports.has(v)) fail(`export ${k}="${v}" ausente no WASM`)
for (const [k, v] of Object.entries(imports)) if (!wasmImports.has(`a.${v}`)) fail(`import ${k}="a.${v}" ausente no WASM`)
if (wasmImports.size !== 4) fail(`o WASM importa ${[...wasmImports].join(', ')}`)

const sha = createHash('sha256').update(wasm).digest('hex')
const out = `// GERADO por scripts/vendor-signalsmith.mjs — não editar à mão.
// signalsmith-stretch ${pkg.version} (https://github.com/Signalsmith-Audio/signalsmith-stretch), Licença: MIT,
// Copyright (c) Geraint Luff / Signalsmith Audio. Só o binário WASM e o mapa dos nomes minificados do glue
// emscripten publicado; o carregador é nosso (stretch.ts).
export const SIGNALSMITH_VERSION = '${pkg.version}'
export const SIGNALSMITH_WASM_SHA256 = '${sha}'
/** Nomes das funções importadas pelo WASM (módulo "a"). */
export const SIGNALSMITH_IMPORTS = ${JSON.stringify(imports)} as const
/** Nomes minificados dos exports do WASM. */
export const SIGNALSMITH_EXPORTS = ${JSON.stringify(exportsPicked)} as const
export const SIGNALSMITH_WASM_BASE64 =
  '${b64}'
`
writeFileSync(outFile, out)
console.log(`ok: ${outFile} (${wasm.length} bytes de WASM, sha256 ${sha})`)
