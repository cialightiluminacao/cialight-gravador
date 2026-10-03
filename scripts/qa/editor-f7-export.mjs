// QA da exportação completa do editor (F7, Task 1) via CDP: Ctrl+E abre o diálogo, cada preset (com o motivo
// quando indisponível), "Personalizar" aberto, estado do HEVC (habilitado só com hardware), bloqueio de tamanho
// alvo pequeno demais, uma exportação pequena personalizada (640×360) e a tela de concluído (codec/resolução).
// Task 2: formatos GIF (exportado, I–O), Quadro (PNG) e Só áudio (MP3 exportado), o botão "Quadro" da barra e
// Ctrl+Shift+E (PNG direto na pasta, toast com "Abrir pasta", nome numerado).
// Task 4: fila — dois itens enfileirados ("Adicionar à fila"), painel "Exportações" durante e depois, resumo final,
// a confirmação de sair do editor com a fila ativa (contagem; sem sair) e "Cancelar todas".
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
    // o YouTube 1080p é o padrão: a tela dele é a f7-01
    if (id !== 'youtube1080') await shot(`f7-02-preset-${id}.png`)
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
    check('WhatsApp (sem ajustes): H.264 por compatibilidade, HEVC disponível avisando que personaliza', wa.disabled === false && /usa H\.264 \(compatibilidade\); escolher HEVC personaliza/.test(wa.note ?? ''), wa)
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

  // ---- F7 Task 2: formatos GIF / Quadro (PNG) / Só áudio ----
  // I–O de 2 s a 5 s (o diálogo abre no trecho) e o cursor em 3 s (o quadro do PNG)
  await ev(`const s = window.__qaEditor.store.getState(); s.setInOut(2000000, 5000000); s.setPlayhead(3000000); return 1`)
  await sleep(300)
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  const formats = await ev(`const g = ${DLG}.querySelector('[aria-label="Formato da exportação"]'); return g ? [...g.querySelectorAll('button')].map((b) => b.textContent.trim()) : null`)
  check('seletor de formato: Vídeo, GIF, Quadro (PNG), Só áudio', JSON.stringify(formats) === JSON.stringify(['Vídeo', 'GIF', 'Quadro (PNG)', 'Só áudio']), formats)

  // GIF
  await ev(`${clickText('GIF')}; return 1`)
  await sleep(300)
  text = await ev(dialogText)
  const gifEst = await ev(`return ${DLG}.querySelector('[data-export-estimate]')?.textContent ?? ''`)
  const gifName = await ev(`return ${DLG}.querySelector('[data-export-name]').value`)
  const widths = await ev(`const g = ${DLG}.querySelector('[aria-label="Largura do GIF"]'); return [...g.querySelectorAll('button')].map((b) => b.textContent.trim())`)
  check('GIF: título, larguras 320/480/640 (480 padrão), fps 12, estimativa aproximada, nome .gif, I–O', text.includes('Exportar GIF') && JSON.stringify(widths) === JSON.stringify(['320 px', '480 px', '640 px']) && /estimativa aproximada/.test(gifEst) && /GIF 480×270 · 12 fps/.test(gifEst) && gifName.endsWith('.gif') && /0:03/.test(gifEst), { gifEst, gifName, widths })
  await shot('f7-09-gif.png')
  await ev(`${exportBtn}.click(); return 1`)
  for (let i = 0; i < 600; i++) {
    text = await ev(dialogText)
    if (text.includes('GIF exportado') || text.includes('falhou')) break
    await sleep(100)
  }
  const gifInfo = await ev(`return ${DLG}.querySelector('[data-export-done-info]')?.textContent ?? ''`)
  check('GIF exportado: concluído "GIF · 480×270 · 12 fps · 36 quadros"', text.includes('GIF exportado') && gifInfo.includes('GIF · 480×270 · 12 fps · 36 quadros'), { gifInfo, text: text.slice(0, 300) })
  await shot('f7-10-gif-concluido.png')
  await ev(`${clickText('Fechar')}; return 1`)
  await sleep(400)

  // Quadro (PNG) no diálogo
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  await ev(`${clickText('Quadro (PNG)')}; return 1`)
  await sleep(300)
  text = await ev(dialogText)
  const pngName = await ev(`return ${DLG}.querySelector('[data-export-name]').value`)
  check('Quadro (PNG): título, posição do cursor 0:03.0, tamanho do projeto, sem intervalo, nome "<projeto> - 00m03s.png"', text.includes('Exportar quadro (PNG)') && /0:03.0/.test(text) && text.includes(`${canvas.width}×${canvas.height}`) && !text.includes('Intervalo') && / - 00m03s\.png$/.test(pngName), { pngName, text: text.slice(0, 400) })
  await shot('f7-11-quadro-png.png')

  // Só áudio
  await ev(`${clickText('Só áudio')}; return 1`)
  await sleep(300)
  text = await ev(dialogText)
  const audioEst = await ev(`return ${DLG}.querySelector('[data-export-estimate]')?.textContent ?? ''`)
  const audioName = await ev(`return ${DLG}.querySelector('[data-export-name]').value`)
  check('Só áudio: título, formato MP3 192 kbps padrão, 48 kHz estéreo, nome .mp3', text.includes('Exportar áudio') && /MP3 · 192 kbps · 48 kHz estéreo/.test(audioEst) && audioName.endsWith('.mp3') && !!(await ev(`return !!${DLG}.querySelector('[aria-label="Formato do áudio"]')`)), { audioEst, audioName })
  await shot('f7-12-so-audio.png')
  await ev(`${exportBtn}.click(); return 1`)
  for (let i = 0; i < 600; i++) {
    text = await ev(dialogText)
    if (text.includes('Áudio exportado') || text.includes('falhou')) break
    await sleep(100)
  }
  const audioInfo = await ev(`return ${DLG}.querySelector('[data-export-done-info]')?.textContent ?? ''`)
  check('Só áudio exportado: concluído "MP3 · 192 kbps · 48 kHz estéreo"', text.includes('Áudio exportado') && audioInfo.includes('MP3 · 192 kbps · 48 kHz estéreo'), { audioInfo, text: text.slice(0, 300) })
  await shot('f7-13-audio-concluido.png')
  // volta ao Vídeo para não deixar o próximo Ctrl+E em outro formato
  await ev(`${clickText('Fechar')}; return 1`)
  await sleep(400)

  // ação "Quadro" da barra superior e Ctrl+Shift+E: PNG direto na pasta, com toast "Abrir pasta"
  const before = readdirSync(OUT).filter((f) => f.endsWith('.png'))
  await ev(`document.querySelector('[data-export-frame]').click(); return 1`)
  let toastText = ''
  for (let i = 0; i < 100; i++) {
    toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
    if (/Quadro exportado/.test(toastText)) break
    await sleep(100)
  }
  check('botão "Quadro": toast "Quadro exportado" com "Abrir pasta"', /Quadro exportado: .* - 00m03s\.png/.test(toastText) && toastText.includes('Abrir pasta'), toastText)
  await sleep(700) // o toast termina de entrar
  await shot('f7-14-quadro-toast.png')
  await sleep(300)
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('E', 'KeyE', 69, 10)
  for (let i = 0; i < 100; i++) {
    if (readdirSync(OUT).filter((f) => f.endsWith('.png')).length >= before.length + 2) break
    await sleep(100)
  }
  const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png'))
  check('Ctrl+Shift+E exporta outro quadro (nome numerado, nunca sobrescreve)', pngs.length === before.length + 2 && pngs.some((f) => / - 00m03s \(2\)\.png$/.test(f)), pngs)
  const all = readdirSync(OUT)
  check('pasta do QA: .gif, .mp3 e os PNGs, sem .part', all.some((f) => f.endsWith('.gif')) && all.some((f) => f.endsWith('.mp3')) && all.every((f) => !f.endsWith('.part')), all)

  // ---- F7 Task 3: capítulos do YouTube a partir dos marcadores ----
  const total = await ev(`const s = window.__qaEditor.store.getState(); s.setInOut(null, null); return s.project.tracks.flatMap((t) => t.items).reduce((m, it) => Math.max(m, it.startUs + it.durationUs), 0)`)
  const mks = [
    { id: 'qa-m1', tUs: 0, label: 'Abertura', color: '#f59e0b' },
    { id: 'qa-m2', tUs: Math.round(total * 0.4 / 1e6) * 1e6, label: 'Demonstração', color: '#f59e0b' },
    { id: 'qa-m3', tUs: Math.round(total * 0.7 / 1e6) * 1e6, label: '', color: '#f59e0b' }
  ]
  await ev(`const s = window.__qaEditor.store.getState(); s.apply((p) => ({ ...p, markers: ${JSON.stringify(mks)} })); return 1`)
  const mmss = (us) => `${String(Math.floor(us / 6e7)).padStart(2, '0')}:${String(Math.floor(us / 1e6) % 60).padStart(2, '0')}`
  const expectedChapters = mks.map((m, i) => `${mmss(m.tUs)} ${m.label || `Capítulo ${i + 1}`}`).join('\n')
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  text = await ev(dialogText)
  await ev(`${clickText('Vídeo')}; return 1`)
  await sleep(300)
  await ev(`const t = ${DLG}.querySelector('[data-chapters-toggle]'); if (!t) throw new Error('sem seção de capítulos'); t.click(); return 1`)
  await sleep(300)
  const chText = await ev(`return ${DLG}.querySelector('[data-chapters-text]')?.value ?? null`)
  check('capítulos: texto gerado dos 3 marcadores (Capítulo 3 para o rótulo vazio)', chText === expectedChapters, { chText, expectedChapters })
  const chAria = await ev(`const t = ${DLG}.querySelector('[data-chapters-text]'); return [t?.getAttribute('aria-label'), t?.readOnly, ${DLG}.querySelector('[data-chapters-copy]')?.getAttribute('aria-label')]`)
  check('capítulos: textarea somente leitura com aria-label e botão Copiar rotulado', chAria[0]?.includes('Capítulos') && chAria[1] === true && chAria[2] === 'Copiar capítulos', chAria)
  await ev(`${DLG}.querySelector('[data-chapters]').scrollIntoView({ block: 'center' }); return 1`)
  await sleep(300)
  await shot('f7-15-capitulos.png')
  await ev(`window.focus(); ${DLG}.querySelector('[data-chapters-copy]').click(); return 1`)
  let clip = null
  for (let i = 0; i < 30; i++) {
    clip = await ev(`try { return (await navigator.clipboard.readText()).replace(/\\r\\n/g, '\\n') } catch (e) { return 'ERRO: ' + e.message }`) // o Windows normaliza para CRLF
    if (clip === expectedChapters) break
    await sleep(100)
  }
  toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
  check('Copiar: área de transferência com o texto exato e toast "Capítulos copiados"', clip === expectedChapters && toastText.includes('Capítulos copiados'), { clip, toastText })
  await key('Escape', 'Escape', 27)
  await sleep(400)
  // ação da barra superior
  await ev(`navigator.clipboard.writeText('x'); document.querySelector('[data-copy-chapters]').click(); return 1`)
  await sleep(500)
  clip = await ev(`try { return (await navigator.clipboard.readText()).replace(/\\r\\n/g, '\\n') } catch (e) { return 'ERRO: ' + e.message }`)
  check('barra superior "Capítulos": copia o mesmo texto (Tudo)', clip === expectedChapters, clip)
  // sem marcadores: toast orientando
  await ev(`const s = window.__qaEditor.store.getState(); s.apply((p) => ({ ...p, markers: [] })); document.querySelector('[data-copy-chapters]').click(); return 1`)
  await sleep(600)
  toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
  check('sem marcadores: toast "Adicione marcadores (M)…"', toastText.includes('Adicione marcadores (M) para gerar capítulos'), toastText)

  // ---- F7 Task 4: fila de exportações ----
  const PANEL = `document.querySelector('[data-export-queue-panel]')`
  const queueState = `return window.__qaEditor.queue.items.map((i) => i.state)`
  const openPanel = async () => {
    if (!(await ev(`return !!${PANEL}`))) await ev(`document.querySelector('[data-export-queue-button]').click(); return 1`)
    await sleep(400)
  }
  await ev(`window.__qaEditor.queue.clearFinished(); const s = window.__qaEditor.store.getState(); s.setInOut(2000000, 5000000); return 1`)
  await sleep(300)
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  // 1) vídeo YouTube 1080p, Tudo → "Adicionar à fila" (o diálogo continua aberto)
  await ev(`${clickText('Vídeo')}; return 1`)
  await sleep(200)
  await ev(`${DLG}.querySelector('[data-preset="youtube1080"]').click(); return 1`)
  await ev(`${clickText('Tudo')}; return 1`)
  await sleep(250)
  await ev(`${setInput('[data-export-name]', 'fila-video.mp4')}; return 1`)
  await sleep(150)
  await ev(`${DLG}.querySelector('[data-export-enqueue]').click(); return 1`)
  await sleep(300)
  toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
  check('"Adicionar à fila": toast "Adicionado à fila (posição 1)" e o diálogo continua aberto', toastText.includes('Adicionado à fila (posição 1)') && (await ev(dialogText)).includes('Exportar vídeo'), toastText)
  // 2) GIF do trecho I–O
  await ev(`${clickText('GIF')}; return 1`)
  await sleep(200)
  await ev(`${clickText('Entrada–Saída (I–O)')}; return 1`)
  await sleep(200)
  await ev(`${setInput('[data-export-name]', 'fila-gif.gif')}; return 1`)
  await sleep(150)
  await ev(`${DLG}.querySelector('[data-export-enqueue]').click(); return 1`)
  await sleep(300)
  toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
  check('GIF enfileirado: "Adicionado à fila (posição 2)"', toastText.includes('Adicionado à fila (posição 2)'), toastText)
  await key('Escape', 'Escape', 27)
  await sleep(400)
  check('o diálogo fecha com a fila rodando (o editor não fica bloqueado)', (await ev(`return !document.querySelector('[role="dialog"]:not([data-export-queue-panel])')`)) === true, null)
  const badge = await ev(`return document.querySelector('[data-export-queue-badge]')?.textContent ?? null`)
  check('barra superior: "Exportações" com o número de itens ativos', badge === '2' || badge === '1', badge)
  await openPanel()
  let panelText = ''
  for (let i = 0; i < 100; i++) {
    panelText = await ev(`return ${PANEL}?.textContent ?? ''`)
    if (/Exportando \d+%/.test(panelText)) break
    await sleep(100)
  }
  const labels4 = await ev(`return [...${PANEL}.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'))`)
  check('painel durante a fila: item exportando com %, o outro "Na fila", botões rotulados (cancelar/mover)', /Exportando \d+%/.test(panelText) && panelText.includes('Na fila') && labels4.some((l) => l.startsWith('Cancelar: fila-video.mp4')) && labels4.some((l) => l.startsWith('Mover para cima: fila-gif.gif')), { panelText: panelText.slice(0, 400), labels4 })
  check('rótulo do item: "<arquivo> · <preset> · <duração>"', /fila-video\.mp4 · YouTube 1080p · \d+:\d\d/.test(panelText) && /fila-gif\.gif · GIF 480×270, 12 fps · 0?0:03/.test(panelText), panelText.slice(0, 400))
  await shot('f7-16-fila-rodando.png')
  for (let i = 0; i < 1800; i++) {
    const states = await ev(queueState)
    if (states.every((s) => s !== 'pending' && s !== 'running')) break
    await sleep(100)
  }
  await sleep(500)
  panelText = await ev(`return ${PANEL}?.textContent ?? ''`)
  const states2 = await ev(queueState)
  check('fila concluída: 2 itens "Concluída", com copiar/abrir pasta', JSON.stringify(states2) === JSON.stringify(['done', 'done']) && (panelText.match(/Concluída/g) ?? []).length === 2 && (await ev(`return !!${PANEL}.querySelector('button[aria-label^="Abrir pasta: fila-gif.gif"]')`)), { states2, panelText: panelText.slice(0, 300) })
  toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
  check('toast final com o resumo "Fila de exportações: 2 concluídas"', toastText.includes('Fila de exportações: 2 concluídas'), toastText)
  await shot('f7-17-fila-concluida.png')
  const qfiles = readdirSync(OUT)
  check('arquivos da fila na pasta do QA, sem .part', qfiles.includes('fila-video.mp4') && qfiles.includes('fila-gif.gif') && qfiles.every((f) => !f.endsWith('.part')), qfiles)
  await ev(`[...${PANEL}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Limpar concluídas').click(); return 1`)
  await sleep(300)
  panelText = await ev(`return ${PANEL}?.textContent ?? ''`)
  check('"Limpar concluídas" esvazia a fila (o painel aberto mostra "Nada na fila")', (await ev(`return window.__qaEditor.queue.items.length === 0`)) === true && panelText.includes('Nada na fila'), panelText)
  await key('Escape', 'Escape', 27)
  await sleep(300)
  check('Esc fecha o painel e o botão "Exportações" some (fila vazia)', (await ev(`return !${PANEL} && !document.querySelector('[data-export-queue-button]')`)) === true, null)

  // 3) sair do editor com a fila ativa: confirmação com a contagem (sem sair: "Continuar exportando")
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  await ev(`${clickText('Vídeo')}; return 1`)
  await sleep(200)
  await ev(`${DLG}.querySelector('[data-preset="youtube1080"]').click(); return 1`)
  await ev(`${clickText('Tudo')}; return 1`)
  await sleep(200)
  await ev(`${setInput('[data-export-name]', 'fila-sair.mp4')}; return 1`)
  await sleep(150)
  await ev(`${DLG}.querySelector('[data-export-enqueue]').click(); return 1`)
  await sleep(150)
  await ev(`${DLG}.querySelector('[data-export-enqueue]').click(); return 1`)
  await sleep(150)
  // "Exportar" com a fila ocupada: entra na fila (posição 3), toast e o diálogo fecha
  await ev(`${exportBtn}.click(); return 1`)
  await sleep(400)
  toastText = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
  check('"Exportar" com a fila ocupada: "Adicionado à fila (posição 3)" e o diálogo fecha', toastText.includes('Adicionado à fila (posição 3)') && (await ev(`return !document.querySelector('[role="dialog"]')`)) === true, toastText)
  // Esc continua fechando diálogos depois do painel ter sido aberto/fechado
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  await key('Escape', 'Escape', 27)
  await sleep(400)
  check('Esc fecha o diálogo com a fila rodando (depois de o painel ter sido fechado)', (await ev(`return !document.querySelector('[role="dialog"]')`)) === true, null)
  await ev(`document.querySelector('button[aria-label="Voltar aos projetos"]').click(); return 1`)
  await sleep(500)
  // texto e estado da fila lidos juntos (o 1º item pode terminar enquanto o QA clica)
  const leave = await ev(`const q = window.__qaEditor.queue.items; return { text: document.querySelector('[data-queue-leave]')?.textContent ?? null, running: q.filter((i) => i.state === 'running').length, pending: q.filter((i) => i.state === 'pending').length }`)
  const expectLeave = `Há 1 exportação em andamento e ${leave.pending} na fila.`
  check(`voltar aos projetos com a fila ativa: "${expectLeave} Sair cancela todas (a fila não é salva)."`, !!leave.text && leave.running === 1 && leave.pending >= 1 && leave.text.includes(expectLeave) && leave.text.includes('Sair cancela todas (a fila não é salva).'), leave)
  await shot('f7-18-fila-sair-confirmacao.png')
  await ev(`[...document.querySelector('[data-queue-leave]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continuar exportando').click(); return 1`)
  await sleep(400)
  check('"Continuar exportando": continua no editor, fila intacta', (await ev(`return !!document.querySelector('[data-editor-topbar]') && window.__qaEditor.queue.active()`)) === true, null)
  // cancelar todas pelo painel: nada de parcial na pasta
  await openPanel()
  await ev(`[...${PANEL}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancelar todas').click(); return 1`)
  for (let i = 0; i < 100; i++) {
    if (!(await ev(`return window.__qaEditor.queue.active()`))) break
    await sleep(100)
  }
  await sleep(600)
  const states3 = await ev(queueState)
  const left = readdirSync(OUT)
  const doneCount = states3.filter((s) => s === 'done').length
  const sairFiles = left.filter((f) => f.startsWith('fila-sair'))
  check('"Cancelar todas": os que não terminaram cancelados (≥ 2), nenhum .part e nenhum parcial dos cancelados', states3.length === 3 && states3.every((s) => s === 'cancelled' || s === 'done') && states3.filter((s) => s === 'cancelled').length >= 2 && left.every((f) => !f.endsWith('.part')) && sairFiles.length === doneCount, { states3, left })
  await shot('f7-19-fila-cancelada.png')
  await key('Escape', 'Escape', 27)
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
