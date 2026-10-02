// Baixa os modelos pinados em resources/models/models.json para resources/models/<file>.
// - Tenta as URLs em ordem (espelho próprio primeiro, depois a origem).
// - Confere o sha256 pinado (se vazio, imprime o hash e falha); arquivo divergente nunca fica no lugar.
// - Idempotente: pula o modelo cujo arquivo já existe com o sha256 certo (use --force para baixar de novo).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'resources', 'models')
const meta = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))
const force = process.argv.includes('--force')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let failed = false
for (const m of meta.models) {
  const out = join(dir, ...m.file.split('/'))
  if (!force && existsSync(out) && sha256(readFileSync(out)) === m.sha256) {
    console.log(`${m.id}: já presente (${m.file}); use --force para baixar de novo.`)
    continue
  }
  let buf
  let lastErr
  for (const url of m.urls) {
    try {
      console.log(`${m.id}: baixando ${url} ...`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const b = Buffer.from(await res.arrayBuffer())
      const got = sha256(b)
      if (!m.sha256) {
        console.error(`${m.id}: sha256 não pinado. Calculado: ${got}\nPreencha "sha256" em resources/models/models.json e rode de novo.`)
        process.exit(2)
      }
      if (got !== m.sha256) throw new Error(`sha256 divergente (esperado ${m.sha256}, obtido ${got})`)
      buf = b
      break
    } catch (e) {
      lastErr = e
      console.warn(`${m.id}: falhou: ${e.message}`)
    }
  }
  if (!buf) {
    console.error(`${m.id}: nenhuma URL funcionou.`, lastErr)
    failed = true
    continue
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(`${out}.part`, buf)
  renameSync(`${out}.part`, out)
  console.log(`${m.id}: pronto (${(buf.length / 1024).toFixed(0)} KB) → resources/models/${m.file}`)
}
process.exit(failed ? 1 : 0)
