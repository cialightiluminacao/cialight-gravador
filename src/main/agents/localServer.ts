import { createServer, type Server, type Socket } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentTools, type AgentRequest, type AgentReply } from '@shared/agentProtocol'

const LIMIT = 8 * 1024 * 1024
export interface LocalAgentOptions {
  connectionFile: string
  execute: (r: AgentRequest) => Promise<unknown>
  onActivity?: (tool: string) => void
}
/** Authenticated named pipe, no TCP listener; a single writer serializes all editor requests. */
export class LocalAgentServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private queue: Promise<unknown> = Promise.resolve()
  private token = ''
  constructor(private readonly opts: LocalAgentOptions) {}

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomBytes(32).toString('hex')
    const pipe = `\\\\.\\pipe\\cialight-agent-${randomBytes(16).toString('hex')}`
    const server = createServer(socket => {
      if (this.sockets.size >= 8) { socket.end(JSON.stringify({ error: 'Há muitos pedidos em andamento; aguarde e consulte o estado.' }) + '\n', () => socket.destroy()); return }
      this.sockets.add(socket)
      socket.setEncoding('utf8')
      socket.setTimeout(130_000, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('close', () => this.sockets.delete(socket))
      let buffer = '', accepted = false
      socket.on('data', chunk => {
        if (accepted) return
        buffer += chunk
        if (Buffer.byteLength(buffer) > LIMIT) { socket.destroy(); return }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        accepted = true
        let request: AgentRequest
        try {
          const raw = JSON.parse(buffer.slice(0, newline))
          const hash = (s: string): Buffer => createHash('sha256').update(s).digest()
          if (typeof raw.token !== 'string' || !timingSafeEqual(hash(raw.token), hash(this.token))) throw new Error('Conexão não autorizada')
          if (typeof raw.id !== 'string' || raw.id.length > 160 || !Object.hasOwn(agentTools, raw.tool)) throw new Error('Comando inválido')
          const tool = raw.tool as AgentRequest['tool']
          request = { id: raw.id, tool, args: agentTools[tool].schema.parse(raw.args) }
        } catch {
          socket.end(JSON.stringify({ error: 'Conexão ou pedido inválido' }) + '\n', () => socket.destroy())
          return
        }
        const work = async (): Promise<void> => {
          if (socket.destroyed || !this.server) return
          let reply: AgentReply
          try {
            this.opts.onActivity?.(request.tool)
            reply = { id: request.id, result: await this.opts.execute(request) }
          } catch (e) { reply = { id: request.id, error: e instanceof Error ? e.message : String(e) } }
          if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n', () => socket.destroy())
        }
        this.queue = this.queue.then(work, work)
      })
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(pipe, () => { server.removeListener('error', reject); resolve() })
      })
      server.on('error', () => { this.stop() })
      mkdirSync(dirname(this.opts.connectionFile), { recursive: true })
      const temporary = `${this.opts.connectionFile}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, pipe, token: this.token, pid: process.pid }), { mode: 0o600 })
      renameSync(temporary, this.opts.connectionFile)
    } catch (e) { this.stop(); throw e }
  }

  stop(): void {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    server?.close()
    // Never delete another running instance's discovery file.
    try {
      if (JSON.parse(readFileSync(this.opts.connectionFile, 'utf8')).token === this.token) rmSync(this.opts.connectionFile, { force: true })
    } catch { /* already removed */ }
    this.token = ''
  }
}
