import { describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentServer } from './localServer'

function request(pipe: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'))
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { resolve(JSON.parse(buffer)); socket.end() } })
  })
}
describe('local agent connection', () => {
  it('authenticates, validates and serializes requests, cleans discovery on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cialight-agents-')), file = join(dir, 'connection.json')
    const order: string[] = []
    const server = new LocalAgentServer({ connectionFile: file, execute: async r => {
      order.push(`start-${r.id}`)
      await new Promise(resolve => setTimeout(resolve, 15))
      order.push(`end-${r.id}`)
      return { ok: true }
    } })
    try {
      await server.start()
      const { pipe, token } = JSON.parse(readFileSync(file, 'utf8'))
      expect((await request(pipe, { id: 'bad', token: 'wrong', tool: 'cialight_status', args: {} })).error).toBeTruthy()
      expect((await request(pipe, { id: 'bad', token, tool: 'cialight_edit', args: {} })).error).toBeTruthy()
      const replies = await Promise.all(['1', '2'].map(id => request(pipe, { id, token, tool: 'cialight_status', args: {} })))
      expect(replies.every(r => (r.result as { ok: boolean }).ok)).toBe(true)
      expect(order[1]).toBe(order[0].replace('start', 'end'))
      expect(order[3]).toBe(order[2].replace('start', 'end'))
      for (let i = 0; i < 30; i++) {
        expect((await request(pipe, { id: `repeat-${i}`, token, tool: 'cialight_status', args: {} })).result).toEqual({ ok: true })
      }
      server.stop()
      expect(existsSync(file)).toBe(false)
    } finally { server.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})
