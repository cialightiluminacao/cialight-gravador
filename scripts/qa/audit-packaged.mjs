// Inspect and exercise the unpacked distribution without opening the installed application or its profile.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { extractFile } from '@electron/asar'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const root = resolve(import.meta.dirname, '../..')
const output = join(root, 'test-out/product-audit')
const unpacked = join(root, 'release/win-unpacked'), resources = join(unpacked, 'resources')
mkdirSync(output, { recursive: true })
const report = { checks: [] }
const check = (name, passed, detail) => { report.checks.push({ name, passed, detail }); if (!passed) throw new Error(name) }
let client
try {
  const manifest = JSON.parse(extractFile(join(resources, 'app.asar'), 'package.json').toString())
  const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check('app.asar contains the expected application', manifest.name === expected.name && manifest.version === expected.version, manifest.version)
  const probe = execFileSync(join(resources, 'ffmpeg/ffprobe.exe'), ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]
  check('packaged ffprobe actually starts', probe.startsWith('ffprobe version '), probe)
  const ffmpeg = execFileSync(join(resources, 'ffmpeg/ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]
  check('packaged ffmpeg actually starts', ffmpeg.startsWith('ffmpeg version '), ffmpeg)
  check('packaged whisper executable exists', existsSync(join(resources, 'whisper/whisper-cli.exe')))
  check('connector notices accompany the bundle', existsSync(join(resources, 'agents/THIRD_PARTY_NOTICES.txt')))
  client = new Client({ name: 'cialight-packaged-audit', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: join(unpacked, 'CiaLight Gravador.exe'), args: [join(resources, 'agents/mcp.cjs'), '--connection', join(output, 'deliberately-absent-connection.json')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' })
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map(t => t.name)
  check('connector initializes through the packaged Electron embedded Node', ['cialight_status', 'cialight_projects', 'cialight_edit', 'cialight_preview', 'cialight_export'].every(t => tools.includes(t)), tools)
  const disconnected = await client.callTool({ name: 'cialight_status', arguments: {} })
  check('missing connection is handled without launching the GUI', disconnected.isError === true)
  report.success = true
} catch (error) { report.success = false; report.error = String(error); process.exitCode = 1 }
finally { await client?.close(); writeFileSync(join(output, 'packaged-smoke.json'), JSON.stringify(report, null, 2)) }
console.log(JSON.stringify(report, null, 2))
