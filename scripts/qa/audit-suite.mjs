import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import electronPath from 'electron'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults.ts'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.env.CIALIGHT_AUDIT_OUTPUT ?? join(root, 'test-out/product-audit', String(Date.now())))
mkdirSync(output, { recursive: true })
const results = []
const uiSuites = ['editor-timeline', 'editor-effects', 'editor-f3-speed', 'editor-f3-voice', 'editor-f3-music', 'editor-f3-silence', 'editor-f3-narration', 'editor-f4-keyframes', 'editor-f4-zoom', 'editor-f4-follow', 'editor-f4-anim', 'editor-f4-reframe', 'editor-f5-text', 'editor-f5-captions', 'editor-f5-brand', 'editor-f7-export', 'editor-f7-relink', 'editor-g4-font', 'editor-g4-textkeys', 'editor-g4-queue', 'editor-e2e', 'editor-f2-e2e', 'editor-f3-e2e', 'editor-f4-e2e', 'editor-f5-e2e', 'editor-f6-e2e', 'editor-f7-e2e', 'editor-g2-captions', 'editor-g2-e2e', 'editor-g3-ui', 'editor-g3-privacy', 'editor-agents']
const integration = ['ffmpeg', 'ingest', 'editor-render', 'editor-export', 'editor-formats', 'models', 'transcribe']
const selected = process.argv.slice(2).includes('--ui') ? uiSuites : process.argv.slice(2)
const suites = [...integration.map(mode => ({ name: `integration-${mode}`, args: ['.'], integration: mode })), ...uiSuites.map(name => ({ name, args: ['--import', pathToFileURL(join(root, 'scripts/qa/audit-files.mjs')).href, join(root, `scripts/qa/${name}.mjs`)] }))].filter(s => !selected.length || selected.includes(s.name))
if (!suites.length || selected.some(name => !suites.some(s => s.name === name))) throw new Error('Suíte de auditoria desconhecida')
console.log(`AUDIT ${output} · ${suites.length} suites`)
for (const suite of suites) {
  const dir = join(output, suite.name), appdata = join(dir, 'appdata'), profile = join(appdata, 'cialight-gravador')
  mkdirSync(profile, { recursive: true })
  // Start with the current schema so normal first-run initialization is not mistaken for data corruption.
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS))
  const env = { ...process.env, APPDATA: appdata, CIALIGHT_QA_USER_DATA: profile, CIALIGHT_AUDIT_OUTPUT: dir, CIALIGHT_RAW_DIR: join(dir, 'Brutos'), CIALIGHT_WHISPER_MODELS_DIR: join(root, 'test-out/whisper-models') }
  delete env.ELECTRON_RUN_AS_NODE
  if (suite.integration) { env.CIALIGHT_TEST = suite.integration; env.CIALIGHT_QA = 'audit' }
  const start = Date.now()
  console.log(`START ${suite.name}`)
  const child = spawn(suite.integration ? electronPath : process.execPath, suite.args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', b => { stdout += b })
  child.stderr.on('data', b => { stderr += b })
  const timer = setTimeout(() => { timedOut = true; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { child.kill() } }, 12 * 60_000)
  const code = await new Promise(resolve => { child.on('error', e => { stderr += String(e); resolve(-1) }); child.on('exit', resolve) })
  clearTimeout(timer)
  writeFileSync(join(dir, 'stdout.log'), stdout)
  writeFileSync(join(dir, 'stderr.log'), stderr)
  if (suite.integration) {
    const report = join(root, 'test-out', `${suite.integration}-report.json`)
    if (existsSync(report)) copyFileSync(report, join(dir, 'report.json'))
  }
  const result = { name: suite.name, code, timedOut, durationS: Math.round((Date.now() - start) / 1000), passedAssertions: stdout.split(/\r?\n/).filter(l => /^\s*(?:✔|OK\b)/.test(l)).length, failedLines: stdout.split(/\r?\n/).filter(l => /^\s*(?:✘|FAIL\b)/.test(l)), log: join(dir, 'stdout.log') }
  results.push(result)
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`END ${suite.name} code=${code} ${result.durationS}s assertions=${result.passedAssertions} failures=${result.failedLines.length}`)
  if (code !== 0) console.log([...result.failedLines, ...stderr.split(/\r?\n/).slice(-10)].join('\n').slice(-2200))
}
console.log(`FINISHED ${results.filter(r => r.code === 0).length}/${results.length} · ${output}`)
process.exitCode = results.some(r => r.code !== 0) ? 1 : 0
