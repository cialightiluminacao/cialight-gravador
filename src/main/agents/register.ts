import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { AGENT_IPC, type AgentConnectionStatus, type AgentReply, type AgentRequest } from '@shared/agentProtocol'
import { getRecorderWindow } from '../windows/recorderWindow'
import { isRecordingActive } from '../recording/state'
import { LocalAgentServer } from './localServer'

export function registerAgents(): void {
  const dir = join(app.getPath('userData'), 'agents')
  const connectionFile = join(dir, 'connection.json')
  const preferencesFile = join(dir, 'preferences.json')
  const script = app.isPackaged ? join(process.resourcesPath, 'agents', 'mcp.cjs') : join(app.getAppPath(), 'resources', 'agents', 'mcp.cjs')
  const pending = new Map<string, { senderId: number; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let enabled = false, lastActivity: string | null = null, lastAction: string | null = null
  const server = new LocalAgentServer({ connectionFile, onActivity: tool => { lastActivity = new Date().toISOString(); lastAction = tool }, execute: request => {
    if (isRecordingActive()) throw new Error('Aguarde o fim da gravação para usar o agente')
    const win = getRecorderWindow()
    if (!win || win.isDestroyed() || win.webContents.isLoading()) throw new Error('Abra a janela do CiaLight Gravador e tente novamente')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id)
        reject(new Error('O editor não respondeu a tempo. Consulte o estado antes de repetir uma edição.'))
      }, 120_000)
      pending.set(request.id, { senderId: win.webContents.id, resolve, reject, timer })
      win.webContents.send(AGENT_IPC.request, request satisfies AgentRequest)
    })
  } })
  const assertRecorder = (senderId: number): void => {
    if (getRecorderWindow()?.webContents.id !== senderId) throw new Error('Janela não autorizada')
  }
  const status = (): AgentConnectionStatus => {
    const args = [script, '--connection', connectionFile]
    const command = process.execPath
    const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`
    return { enabled, connected: enabled && !!lastActivity, lastActivity, lastAction,
      config: { mcpServers: { cialight: { command, args, env: { ELECTRON_RUN_AS_NODE: '1' } } } },
      codexCommand: `codex mcp add cialight --env ELECTRON_RUN_AS_NODE=1 -- ${[command, ...args].map(quote).join(' ')}` }
  }
  const setEnabled = async (value: boolean): Promise<AgentConnectionStatus> => {
    if (value && !existsSync(script)) throw new Error('O conector de agentes não foi incluído neste build. Gere o aplicativo novamente.')
    if (value) await server.start()
    else {
      server.stop()
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Conexão com agentes desativada')) }
      pending.clear()
      lastActivity = null; lastAction = null
    }
    enabled = value
    mkdirSync(dir, { recursive: true })
    writeFileSync(preferencesFile, JSON.stringify({ enabled }))
    return status()
  }
  ipcMain.handle(AGENT_IPC.status, e => { assertRecorder(e.sender.id); return status() })
  ipcMain.handle(AGENT_IPC.enable, (e, value: unknown) => {
    assertRecorder(e.sender.id)
    if (typeof value !== 'boolean') throw new Error('Valor inválido')
    return setEnabled(value)
  })
  ipcMain.on(AGENT_IPC.reply, (e, reply: AgentReply) => {
    if (!reply || typeof reply.id !== 'string') return
    const p = pending.get(reply.id)
    if (!p || p.senderId !== e.sender.id) return
    pending.delete(reply.id); clearTimeout(p.timer)
    if (reply.error) p.reject(new Error(String(reply.error)))
    else p.resolve(reply.result)
  })
  app.on('will-quit', () => { server.stop(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Aplicativo encerrado')) }; pending.clear() })
  try {
    if (JSON.parse(readFileSync(preferencesFile, 'utf8')).enabled === true) void setEnabled(true).catch(() => { enabled = false })
  } catch { /* disabled until the user enables it */ }
}
