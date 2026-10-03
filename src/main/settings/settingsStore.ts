import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { renameSyncRetry } from '../fs/renameRetry'
import { join, resolve } from 'path'
import { parseSettings } from '@shared/schemas'
import type { Settings } from '@shared/types'
import { log } from '../log'

// Configurações em userData/settings.json (escrita atômica: tmp + rename).
// Migrações são aplicadas em parseSettings (defaults + versão).

type Listener = (s: Settings) => void

let cached: Settings | null = null
const listeners = new Set<Listener>()

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): Settings {
  const file = settingsFile()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return parseSettings(raw)
    }
  } catch (e) {
    log.warn('settings.json inválido, usando padrões:', e)
  }
  return parseSettings({})
}

function persist(s: Settings): void {
  const file = settingsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
  renameSyncRetry(tmp, file)
}

export function getSettings(): Settings {
  if (!cached) cached = load()
  return cached
}

/** Merge raso por chave de 1º nível; objetos aninhados são substituídos inteiros pelo patch (o renderer envia o objeto completo). */
export function setSettings(patch: Partial<Settings>): Settings {
  const next = parseSettings({ ...getSettings(), ...patch })
  cached = next
  persist(next)
  for (const l of listeners) {
    try {
      l(next)
    } catch (e) {
      log.error('listener de settings falhou', e)
    }
  }
  return next
}

export function onSettingsChange(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function defaultOutputDir(): string {
  return join(app.getPath('videos'), 'CiaLight Gravador')
}

export function outputDir(): string {
  return getSettings().outputDir ?? defaultOutputDir()
}

export function rawDir(): string {
  // CIALIGHT_RAW_DIR: usado pelos testes de integração para não tocar na pasta real
  if (process.env.CIALIGHT_RAW_DIR) return resolve(process.env.CIALIGHT_RAW_DIR)
  return getSettings().rawDir ?? join(defaultOutputDir(), 'Brutos')
}
