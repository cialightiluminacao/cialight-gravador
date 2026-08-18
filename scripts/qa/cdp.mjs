// Utilitário de QA: fala com o Electron via CDP (--remote-debugging-port=9333).
// uso: node test-out/qa/cdp.mjs eval "<js>"   |   node test-out/qa/cdp.mjs shot out.png
import { writeFileSync } from 'fs'
const port = process.env.CDP_PORT ?? '9333'
const [cmd, arg] = process.argv.slice(2)
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!page) { console.error('janela não encontrada', targets.map((t) => t.url)); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })) })
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true, timeout: 600000 })
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 2))
} else if (cmd === 'viewport') {
  const [w, h] = arg.split('x').map(Number)
  const r = await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  console.log('viewport', w, h, JSON.stringify(r.error ?? 'ok'))
} else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(arg, Buffer.from(r.result.data, 'base64'))
  console.log('ok', arg)
}
ws.close()
