import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = await build({ entryPoints: [join(root, 'scripts/agents/mcp.ts')], outfile: join(root, 'resources/agents/mcp.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, metafile: true })
const packages = new Map()
for (const input of Object.keys(output.metafile.inputs)) {
  if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
  let directory = dirname(resolve(input))
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (pkg.name) { packages.set(directory, pkg); break }
    }
    directory = dirname(directory)
  }
}
const notices = []
for (const [directory, pkg] of packages) {
  const licenses = readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(name))
  if (!licenses.length) throw new Error(`Licença não encontrada para o pacote empacotado ${pkg.name}`)
  notices.push(`${pkg.name} ${pkg.version}\n${licenses.map(name => readFileSync(join(directory, name), 'utf8')).join('\n')}`)
}
writeFileSync(join(root, 'resources/agents/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n' + '-'.repeat(80) + '\n\n'))
console.log('Conector MCP do CiaLight pronto.')
