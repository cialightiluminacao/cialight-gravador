import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const directories = process.argv.slice(2)
if (!directories.length) throw new Error('Informe os diretórios das rodadas na ordem de execução')
const latest = new Map(), history = []
for (const directory of directories) {
  const file = resolve(directory, 'results.json')
  const results = JSON.parse(readFileSync(file, 'utf8'))
  for (const result of results) { const row = { ...result, run: relative(root, directory).replaceAll('\\', '/') }; latest.set(row.name, row); history.push(row) }
}
const rows = [...latest.values()], passed = rows.filter(r => r.code === 0 && !r.timedOut)
const output = join(root, 'test-out/product-audit')
mkdirSync(output, { recursive: true })
const summary = { generatedAt: new Date().toISOString(), suitesExecuted: rows.length, passed: passed.length, failed: rows.length - passed.length, passedAssertions: rows.reduce((n, r) => n + r.passedAssertions, 0), latest: rows, history }
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(join(output, 'summary.md'), `# Resultados da auditoria\n\n${passed.length}/${rows.length} suítes aprovadas na última execução de cada uma; ${summary.passedAssertions} verificações aprovadas registradas nos logs (não são contagem de botões ou funções). Histórico completo em summary.json.\n\nEste relatório cobre somente as suítes fornecidas. Não certifica todos os 125 cenários manuais, hardware externo, instalação ou atualização publicada.\n\n| Suíte | Resultado | Verificações aprovadas | Duração (s) | Rodada |\n|---|---|---:|---:|---|\n${rows.map(r => `| ${r.name} | ${r.code === 0 && !r.timedOut ? 'PASSOU' : r.timedOut ? 'TEMPO EXCEDIDO' : 'FALHOU'} | ${r.passedAssertions} | ${r.durationS} | ${r.run} |`).join('\n')}\n\n${rows.filter(r => r.code !== 0).map(r => `## ${r.name}\n\n${r.failedLines.length ? r.failedLines.join('\n\n') : 'Consultar stdout.log e stderr.log da rodada; a falha pode ser do roteiro antes da execução do produto.'}`).join('\n\n')}\n`)
console.log(JSON.stringify({ suites: rows.length, passed: passed.length, failed: summary.failed, passedAssertions: summary.passedAssertions }))
