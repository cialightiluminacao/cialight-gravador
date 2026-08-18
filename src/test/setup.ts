// Mock global do Electron para testes unitários de módulos do main (vitest roda em Node puro).
import { vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => {
  const userData = join(tmpdir(), 'cialight-gravador-tests')
  const app = {
    isPackaged: false,
    getPath: (name: string) => (name === 'userData' ? userData : name === 'videos' ? join(tmpdir(), 'cialight-videos') : tmpdir()),
    getAppPath: () => process.cwd(),
    getGPUInfo: async () => ({ gpuDevice: [] }),
    getVersion: () => '0.0.0-test',
    on: () => app,
    whenReady: () => Promise.resolve()
  }
  return {
    app,
    BrowserWindow: { getAllWindows: () => [] },
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 0 }) },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    session: { defaultSession: { setDisplayMediaRequestHandler: () => {} } },
    desktopCapturer: { getSources: async () => [] },
    shell: { trashItem: async () => {}, openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Notification: class {},
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) }
  }
})

vi.mock('electron-log/main', () => {
  const noop = (): void => {}
  const logger = { info: noop, warn: noop, error: noop, debug: noop, verbose: noop, silly: noop, transports: { file: {}, console: {} }, initialize: noop }
  return { default: logger }
})
