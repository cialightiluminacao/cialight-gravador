import ts from 'typescript'
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.argv[2] ?? join(root, 'test-out/product-audit/catalog'))
mkdirSync(output, { recursive: true })
const files = []
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (/\.tsx?$/.test(path)) files.push(path) } }
walk(join(root, 'src'))
const controls = [], functions = []
for (const file of files) {
  if (/\.(test|spec)\./.test(file) || file.includes('__fixtures__')) continue
  const source = readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const line = node => tree.getLineAndCharacterOfPosition(node.getStart()).line + 1
  function visit(node) {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)) {
      const owner = node.name?.getText(tree) ?? (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(tree) : undefined)
      functions.push({ file: relative(root, file).replaceAll('\\', '/'), line: line(node), name: owner ?? '(anônima)', kind: ts.SyntaxKind[node.kind], exported: node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false, validation: 'inventariada; execução individual ainda não vinculada' })
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree)
      const attributes = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(tree), a.initializer?.getText(tree) ?? 'true']))
      const isControl = /^(a|button|input|select|textarea|Button|Toggle|Switch|Slider|Select|TabsTrigger|Segmented|HotkeyRecorder|PathField|.*MenuItem|.*Trigger)$/.test(tag) || /\.(Item|RadioItem|CheckboxItem)$/.test(tag) || Object.keys(attributes).some(key => /^(onClick|onDoubleClick|onPointerDown|onKeyDown|onChange|onInput|onSelect|onSubmit|onValueChange|onCheckedChange|onDrop)$/.test(key))
      if (isControl) {
        const parent = ts.isJsxElement(node.parent) ? node.parent : node
        const label = attributes['aria-label'] ?? attributes.title ?? parent.getText(tree).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)
        controls.push({ id: `control-${controls.length + 1}`, file: relative(root, file).replaceAll('\\', '/'), line: line(node), tag, label, handlers: Object.fromEntries(Object.entries(attributes).filter(([k]) => /^on[A-Z]/.test(k)).map(([k, v]) => [k, v.slice(0, 400)])), attributes: Object.fromEntries(Object.entries(attributes).filter(([k]) => /^(aria-|role$|disabled$|type$|data-)/.test(k))), validation: 'inventariado; execução individual ainda não vinculada' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}
const checklist = readFileSync(join(root, 'docs/qa-checklist.md'), 'utf8')
let section = '', index = 0
const scenarios = checklist.split(/\r?\n/).flatMap(line => { if (line.startsWith('## ')) section = line.slice(3); if (/^- \[[ x]\]/.test(line)) return [{ id: `scenario-${++index}`, section, description: line.replace(/^- \[[ x]\] /, ''), validation: 'não revalidado nesta auditoria' }]; return [] })
writeFileSync(join(output, 'controls.json'), JSON.stringify(controls, null, 2))
writeFileSync(join(output, 'functions.json'), JSON.stringify(functions, null, 2))
writeFileSync(join(output, 'scenarios.json'), JSON.stringify(scenarios, null, 2))
const counts = Object.fromEntries([...new Set(controls.map(c => c.file))].map(file => [file, controls.filter(c => c.file === file).length]))
writeFileSync(join(output, 'inventory.md'), `# Inventário de auditoria\n\n${controls.length} controles JSX em ${Object.keys(counts).length} arquivos; ${functions.length} funções, métodos e callbacks; ${scenarios.length} cenários de aceitação.\n\nEste inventário não é evidência de execução. Componentes dinâmicos podem produzir várias instâncias e estados; controles nativos do Windows não estão incluídos na contagem de JSX; a presença no inventário não comprova cobertura.\n\n| Arquivo | Controles |\n|---|---:|\n${Object.entries(counts).map(([f, n]) => `| ${f} | ${n} |`).join('\n')}\n`)
console.log(JSON.stringify({ output, controls: controls.length, functions: functions.length, scenarios: scenarios.length, files: Object.keys(counts).length }))
