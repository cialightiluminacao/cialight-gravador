// Test-runner-only redirection: keep existing QA screenshots intact during a full audit.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve, relative, isAbsolute, join, dirname } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = process.env.CIALIGHT_AUDIT_OUTPUT
if (!output) throw new Error('CIALIGHT_AUDIT_OUTPUT is required')
const inside = relative(join(root, 'test-out'), resolve(output))
if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Audit output must stay inside test-out/')
const original = { write: fs.writeFileSync, read: fs.readFileSync, exists: fs.existsSync, mkdir: fs.mkdirSync }
const redirect = path => {
  if (typeof path !== 'string') return path
  const rel = relative(join(root, 'docs', 'qa'), resolve(path))
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? join(output, 'screenshots', rel) : path
}
fs.writeFileSync = function(path, ...args) { const target = redirect(path); if (target !== path) original.mkdir(dirname(target), { recursive: true }); return original.write(target, ...args) }
fs.readFileSync = function(path, ...args) { const target = redirect(path); return original.read(target !== path && original.exists(target) ? target : path, ...args) }
fs.existsSync = function(path) { const target = redirect(path); return original.exists(target !== path && original.exists(target) ? target : path) }
syncBuiltinESMExports()
