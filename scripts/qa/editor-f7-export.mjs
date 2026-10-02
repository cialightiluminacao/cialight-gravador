// QA da exportação completa do editor (F7, Task 1) via CDP: Ctrl+E abre o diálogo, cada preset (com o motivo
// quando indisponível), "Personalizar" aberto, estado do HEVC (habilitado só com hardware), bloqueio de tamanho
// alvo pequeno demais, uma exportação pequena personalizada (640×360) e a tela de concluído (codec/resolução).
// Teclas e cliques são sintéticos (CDP Input.dispatchKeyEvent / element.click), nunca entrada do SO.
//
// uso (depois de `npm run build`, sob o lock):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f7-export.mjs
// Screenshots em docs/qa/editor-f7/. Saída em test-out/qa-f7-export (window.__qaEditor.exportDir).
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9335'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f7')
const OUT = join(ROOT, 'test-out', 'qa-f7-export')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const hash = (b) => (b ? createHash('sha1').update(b).digest('hex') : null)

mkdirSync(SHOTS, { recursive: true })
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null
let seq = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

async function connect() {
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => (ws.onopen = r))
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
          }
        }
        return
      }
    } catch {
      // app ainda subindo
    }
    await sleep(1000)
  }
  throw new Error('janela do app não apareceu no CDP')
}

async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 docs/qa/editor-f7/${name}`)
}
// tecla sintética pelo CDP (modifiers: 2 = Ctrl)
async function key(k, code, vk, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

const DLG = `document.querySelector('[role="dialog"]')`
const dialogText = `return ${DLG}?.textContent ?? ''`
const exportBtn = `[...${DLG}.querySelectorAll('button')].find((b) => b.hasAttribute('data-export-start'))`
// valor num campo controlado pelo React (setter nativo + input) e confirma (blur)
const setInput = (sel, value) => `{
  const el = ${DLG}.querySelector(${JSON.stringify(sel)})
  if (!el) throw new Error('campo não encontrado: ' + ${JSON.stringify(sel)})
  el.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
}`
const clickText = (text) => `{
  const el = [...${DLG}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
  if (!el) throw new Error('não achei o botão ' + ${JSON.stringify(text)})
  el.click()
}`

const PRESETS = ['whatsapp', 'youtube1080', 'youtube4k', 'reels', 'feed11', 'feed45', 'original', 'intermediate']

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; return 1`)
  const canvas = await ev(`return window.__qaEditor.store.getState().project.canvas`)
  console.log(`fixture: ${canvas.width}×${canvas.height} @ ${canvas.fps} fps`)
  await sleep(800)

  // ---- Ctrl+E abre o diálogo ----
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  let text = await ev(dialogText)
  check('Ctrl+E abre o diálogo de exportação', text.includes('Exportar vídeo'), text.slice(0, 200))
  const labels = ['WhatsApp (até 64 MB)', 'YouTube 1080p', 'YouTube 4K', 'Instagram Reels/Stories (9:16)', 'Instagram Feed 1:1', 'Instagram Feed 4:5', 'Original (máxima)', 'Edição (intermediário)']
  check('8 presets listados', labels.every((l) => text.includes(l)), text.slice(0, 400))
  check('estimativa "≈ N MB · W×H · fps · H.264"', /≈ [\d.,]+ (MB|GB) · \d+×\d+ · [\d,]+ fps · H\.264/.test(text), text)
  await shot('f7-01-presets.png')

  // ---- cada preset: disponível (estimativa) ou desativado com o motivo ----
  for (const id of PRESETS) {
    const st = await ev(`const b = ${DLG}.querySelector('[data-preset="${id}"]'); return { disabled: b.disabled, title: b.title, text: b.textContent }`)
    if (st.disabled) {
      check(`preset ${id}: indisponível com o motivo (${st.title})`, !!st.title && /use /.test(st.title), st)
      continue
    }
    await ev(`${DLG}.querySelector('[data-preset="${id}"]').click(); return 1`)
    await sleep(250)
    const est = await ev(`return ${DLG}.querySelector('[data-export-estimate]')?.textContent ?? ''`)
    const checked = await ev(`return ${DLG}.querySelector('[data-preset="${id}"]').getAttribute('aria-checked')`)
    check(`preset ${id}: selecionado, estimativa ${est.split('·').slice(0, 4).join('·')}`, checked === 'true' && /≈/.test(est), { checked, est })
    await shot(`f7-02-preset-${id}.png`)
  }

  // ---- Personalizar aberto ----
  await ev(`${DLG}.querySelector('[data-preset="youtube1080"]').click(); return 1`)
  await sleep(150)
  await ev(`${DLG}.querySelector('[data-export-customize]').click(); return 1`)
  await sleep(300)
  const panel = await ev(`const p = ${DLG}.querySelector('[data-export-custom-panel]'); return p ? { text: p.textContent, labels: [...p.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')) } : null`)
  check('Personalizar mostra resolução, fps, qualidade e codec (com rótulos acessíveis)', !!panel && ['Largura (pixels)', 'Altura (pixels)', 'Quadros por segundo', 'Tipo de qualidade', 'Codec de vídeo'].every((l) => panel.labels.includes(l)), panel)
  await shot('f7-03-personalizar.png')

  // ---- HEVC: habilitado só com hardware ----
  let hevc = null
  for (let i = 0; i < 30; i++) {
    hevc = await ev(`const b = [...${DLG}.querySelectorAll('[data-export-custom-panel] button')].find((x) => x.textContent.trim() === 'HEVC'); const note = ${DLG}.querySelector('[data-hevc-note]')?.textContent ?? null; return { disabled: b?.disabled ?? null, note }`)
    if (hevc.note !== 'Verificando o suporte a HEVC…') break
    await sleep(300)
  }
  console.log(`HEVC no diálogo: ${JSON.stringify(hevc)}`)
  if (hevc.disabled) {
    check('HEVC desativado com o motivo (sem hardware)', hevc.note === 'HEVC não suportado neste computador', hevc)
    await shot('f7-04-hevc-desativado.png')
  } else {
    await ev(`[...${DLG}.querySelectorAll('[data-export-custom-panel] button')].find((x) => x.textContent.trim() === 'HEVC').click(); return 1`)
    await sleep(300)
    text = await ev(dialogText)
    check('HEVC habilitado (hardware): escolhido → estimativa diz HEVC e vira "Personalizado"', /· HEVC/.test(await ev(`return ${DLG}.querySelector('[data-export-estimate]').textContent`)) && text.includes('Personalizado'), text.slice(0, 300))
    await shot('f7-04-hevc-habilitado.png')
    // no WhatsApp (só H.264) o HEVC fica desativado com o motivo
    await ev(`${DLG}.querySelector('[data-preset="whatsapp"]').click(); return 1`)
    await sleep(300)
    const wa = await ev(`const b = [...${DLG}.querySelectorAll('[data-export-custom-panel] button')].find((x) => x.textContent.trim() === 'HEVC'); return { disabled: b?.disabled, note: ${DLG}.querySelector('[data-hevc-note]')?.textContent }`)
    check('WhatsApp: HEVC desativado (preset só H.264)', wa.disabled === true && /usa só H\.264/.test(wa.note ?? ''), wa)
    await shot('f7-04b-hevc-whatsapp.png')
  }

  // ---- bloqueio: tamanho alvo pequeno demais ----
  await ev(`${DLG}.querySelector('[data-preset="youtube1080"]').click(); return 1`)
  await sleep(150)
  await ev(`${clickText('Tamanho alvo (MB)')}; return 1`)
  await sleep(150)
  await ev(`${setInput('input[aria-label="Tamanho alvo em MB"]', '0.01')}; return 1`)
  await sleep(250)
  const blocker = await ev(`return ${DLG}.querySelector('[data-export-blocker]')?.textContent ?? null`)
  const disabled = await ev(`return ${exportBtn}.disabled`)
  check('tamanho alvo pequeno demais: bloqueio com o motivo e Exportar desativado', /é pouco para/.test(blocker ?? '') && disabled === true, { blocker, disabled })
  await shot('f7-05-bloqueio.png')

  // ---- exportação pequena personalizada: WhatsApp → 640×360 ----
  await ev(`${DLG}.querySelector('[data-preset="whatsapp"]').click(); return 1`)
  await sleep(150)
  await ev(`${setInput('input[aria-label="Largura (pixels)"]', '640')}; return 1`)
  await sleep(250)
  const h = await ev(`return ${DLG}.querySelector('input[aria-label="Altura (pixels)"]').value`)
  text = await ev(dialogText)
  const expectH = String(Math.max(2, Math.round((640 * canvas.height) / canvas.width / 2) * 2))
  check(`largura 640 → altura ${expectH} (proporção do projeto) e rótulo "Personalizado"`, h === expectH && text.includes('Personalizado'), { h, text: text.slice(0, 200) })
  await shot('f7-06-personalizado-640.png')
  await ev(`${exportBtn}.click(); return 1`)
  let sawProgress = false
  for (let i = 0; i < 1200; i++) {
    text = await ev(dialogText)
    if (!sawProgress && /\d+%/.test(text)) {
      sawProgress = true
      await shot('f7-07-progresso.png')
    }
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(100)
  }
  const info = await ev(`return ${DLG}.querySelector('[data-export-done-info]')?.textContent ?? ''`)
  check('concluído mostra codec usado e resolução (MP4 · H.264 · 640×N)', text.includes('Vídeo exportado') && info.includes(`MP4 · H.264 · 640×${expectH}`), { info, text: text.slice(0, 300) })
  await shot('f7-08-concluido.png')
  const files = readdirSync(OUT)
  check('arquivo final na pasta do QA, sem .part', files.length === 1 && files[0].endsWith('.mp4'), files)

  // ---- Esc fecha (fora de uma exportação) ----
  await key('Escape', 'Escape', 27)
  await sleep(400)
  check('Esc fecha o diálogo', (await ev(`return !${DLG}`)) === true, null)
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
} finally {
  try {
    ws?.close()
  } catch {
    // ignorar
  }
  try {
    execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // já saiu
  }
  await sleep(500)
  const now = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
  if (hash(now) !== hash(settingsBefore)) {
    if (settingsBefore) writeFileSync(SETTINGS, settingsBefore)
    else if (now) rmSync(SETTINGS)
    console.log(`settings.json restaurado (hash ${hash(now)} → ${hash(settingsBefore)})`)
  } else console.log(`settings.json intocado (hash ${hash(settingsBefore)})`)
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
