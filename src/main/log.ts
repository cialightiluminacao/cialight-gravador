import { app } from 'electron'
import electronLog from 'electron-log/main'
import { join } from 'path'

// Log em userData/logs/main.log com rotação; console só em dev.
electronLog.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
electronLog.transports.file.maxSize = 5 * 1024 * 1024
electronLog.transports.file.level = 'info'
electronLog.transports.console.level = app.isPackaged ? false : 'debug'
electronLog.initialize()

export const log = electronLog

export function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}
