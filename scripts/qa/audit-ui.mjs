import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import electronPath from 'electron'
const root = resolve(import.meta.dirname, '../..')
const appRoot = resolve(process.env.CIALIGHT_AUDIT_APP_ROOT ?? root)
const output = resolve(process.env.CIALIGHT_AUDIT_UI_OUTPUT ?? join(root, 'test-out/product-audit/visual-01'))
const profile = appRoot === root ? join(output, 'profile') : join(appRoot, 'test-out', 'ui-profile-' + Date.now()), port = 9478
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ devices: { cameraOn: false, micOn: false, systemAudioOn: false }, hotkeys: {} }))
const environment = { ...process.env, CIALIGHT_TEST: 'editor-narration', CIALIGHT_QA: 'editor-fixture', CIALIGHT_QA_USER_DATA: profile, CIALIGHT_RAW_DIR: join(output, 'Brutos'), CIALIGHT_WHISPER_MODELS_DIR: join(root, 'test-out/whisper-models') }
delete environment.ELECTRON_RUN_AS_NODE
const app = spawn(electronPath, [appRoot, `--remote-debugging-port=${port}`], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = '', ws, seq = 0
app.stderr.on('data', b => { stderr += b })
const pending = new Map(), errors = [], observations = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn) { for (let i = 0; i < 90; i++) { const r = await fn(); if (r) return r; await sleep(300) }; throw new Error('UI timeout') }
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, 30000); pending.set(id, r => { clearTimeout(timer); resolve(r) }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value }
async function capture(name, width, height) {
  await sleep(180)
  const controls = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][data-state="open"]');
    const base = dialog || document;
    const rect = e => { const r = e.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height} };
    return [...base.querySelectorAll('button,input,textarea,select,[role="button"],[role="tab"],[role="combobox"],[role="switch"],[role="slider"]')].filter(e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && r.bottom>0 && r.top<innerHeight; }).map(e => {
      const r=rect(e), label=e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(' ').map(id=>document.getElementById(id)?.textContent || '').join(' ').trim() || [...(e.labels || [])].map(l=>l.textContent).join(' ').trim() || e.innerText?.trim() || e.getAttribute('title') || '';
      const x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)), y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)), hit=document.elementFromPoint(x,y);
      return {tag:e.tagName,role:e.getAttribute('role'),label:label.slice(0,180),disabled:!!e.disabled,tabIndex:e.tabIndex,rect:r,offViewport:r.left<-.5||r.right>innerWidth+.5||r.top<-.5||r.bottom>innerHeight+.5,blockedAtCenter:!e.disabled&&hit&&!e.contains(hit)&&!hit.contains(e),outer:e.outerHTML.slice(0,260)};
    });
  })()`)
  // Native source thumbnails may contain the user's desktop. Keep layout evidence without exposing its pixels.
  if (name.startsWith('prepare')) await evaluate(`(()=>{const s=document.createElement('style');s.id='audit-source-mask';s.textContent='img,video,canvas{filter:blur(24px)!important}';document.head.append(s);return true})()`)
  let screenshot
  try { screenshot = await send('Page.captureScreenshot', { format: 'png' }) }
  finally { if (name.startsWith('prepare')) await evaluate(`document.getElementById('audit-source-mask')?.remove();true`) }
  const file = `${name}-${width}x${height}.png`
  writeFileSync(join(output, file), Buffer.from(screenshot.result.data, 'base64'))
  observations.push({ name, width, height, file, controls, issues: controls.filter(c => !c.label || c.offViewport || c.blockedAtCenter) })
  writeFileSync(join(output, 'observations.json'), JSON.stringify(observations, null, 2))
  console.log(`${name} ${width}x${height}: ${controls.length} controles; ${observations.at(-1).issues.length} sinais para revisão`)
}
async function navigate(target) { await evaluate(`window.__navigate(${JSON.stringify(target)}); true`); await sleep(220) }
async function click(selector, label) {
  const point = await evaluate(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${label === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(label)}`}); if(!e) throw new Error('Controle ausente'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
try {
  const page = await until(async () => { if (app.exitCode !== null) throw new Error(stderr); try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('index.html')) } catch { return false } })
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r })
  ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }; if (m.method === 'Runtime.exceptionThrown' || m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m) }
  await send('Runtime.enable'); await send('Log.enable')
  await until(() => evaluate('!!window.__navigate && !!window.api'))
  await evaluate(`document.title='CiaLight — Auditoria visual isolada'`)
  const deviceFailure = await evaluate(`(async()=>{
    const original=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices), errors=[];
    const onError=e=>{errors.push(String(e.reason));e.preventDefault()};
    window.addEventListener('unhandledrejection',onError);
    try {
      navigator.mediaDevices.enumerateDevices=async()=>{throw new Error('AUDIT: dispositivo indisponível')};
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      await new Promise(r=>setTimeout(r,500));
      return {unhandled:errors,message:document.body.innerText.includes('Não foi possível consultar câmeras e microfones')};
    } finally {navigator.mediaDevices.enumerateDevices=original;window.removeEventListener('unhandledrejection',onError)}
  })()`)
  writeFileSync(join(output, 'device-failure.json'), JSON.stringify(deviceFailure, null, 2))
  if (deviceFailure.unhandled.length || !deviceFailure.message) throw new Error('Falha de dispositivos não tratada')
  // A falha foi verificada; recarrega os dispositivos e fecha seu toast antes da matriz visual.
  await evaluate(`navigator.mediaDevices.dispatchEvent(new Event('devicechange'));document.querySelector('[data-sonner-toast] [data-close-button]')?.click();true`)
  await sleep(500)
  const pathLayout = []
  await navigate('settings:geral')
  const originalOutputDir = await evaluate('window.__qa.store.getState().settings.outputDir')
  try {
    for (const width of [960, 1180]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false })
      for (const [name, path] of [['long-leaf', 'C:/' + 'PastaMuitoComprida'.repeat(10)], ['long-parent', 'C:/' + 'PastaPai/'.repeat(20) + 'Videos']]) {
        await evaluate(`window.__qa.store.getState().setSettings({...window.__qa.store.getState().settings,outputDir:${JSON.stringify(path)}});true`)
        await sleep(100)
        const layout = await evaluate(`(()=>{const e=[...document.querySelectorAll('span[title]')].find(e=>e.title===${JSON.stringify(path)});if(!e)throw new Error('Campo de pasta ausente');e.scrollIntoView({block:'center'});const r=e.lastElementChild.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();return {leafRight:r.right,leafLeft:r.left,boxRight:b.right,boxLeft:b.left,viewport:innerWidth,overflow:r.right>b.right+.5||r.left<b.left-.5,fullPathInTitle:e.title===${JSON.stringify(path)}}})()`)
        pathLayout.push({ width, name, ...layout })
        if (layout.overflow || !layout.fullPathInTitle) throw new Error(`Campo de pasta ultrapassa os limites: ${name} ${width}`)
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(output, `path-${name}-${width}.png`), Buffer.from(shot.result.data, 'base64'))
      }
    }
  } finally {
    await evaluate(`window.__qa.store.getState().setSettings({...window.__qa.store.getState().settings,outputDir:${JSON.stringify(originalOutputDir)}});true`)
    writeFileSync(join(output, 'path-layout.json'), JSON.stringify(pathLayout, null, 2))
  }
  for (const [width, height] of process.argv.includes('--desktop') ? [] : process.argv.includes('--smoke') ? [[960,640]] : [[960,640],[1180,760],[1366,768],[1920,1080]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    for (const page of ['prepare','projects','history','settings:geral','settings:dispositivos','settings:atalhos','settings:anotacoes','settings:avancado','settings:atualizacao']) {
      await navigate(page)
      if (page === 'prepare') await until(()=>evaluate(`!!window.__qa?.store.getState().sources?.screens.length&&!window.__qa.store.getState().sourcesLoading`))
      await capture(page.replace(':','-'), width, height)
      if (page === 'settings:atualizacao') {
        const links = await evaluate(`[...document.querySelectorAll('button')].filter(e=>['Repositório','Versões','Relatar problema'].includes(e.innerText.trim())).map(e=>{const r=e.getBoundingClientRect();return {label:e.innerText.trim(),left:r.left,right:r.right,viewport:innerWidth,visible:r.left>=0&&r.right<=innerWidth}})`)
        writeFileSync(join(output, `about-links-${width}.json`), JSON.stringify(links, null, 2))
        if (links.length !== 3 || links.some(e => !e.visible)) throw new Error('Links da aba Sobre fora da janela')
      }
    }
    const projects = await evaluate('window.api.project.list()')
    if (!projects.length) throw new Error('Fixture ausente')
    await navigate(`editor:${projects[0].id}`)
    await until(() => evaluate('!!window.__qaEditor?.store.getState().project'))
    await until(() => evaluate('window.__qaEditor.store.getState().project.assets.every(a=>a.status==="ready")'))
    await capture('editor', width, height)
    if (width === 960) {
      const before = await evaluate(`(()=>{const s=window.__qaEditor.store.getState(),a=s.project.assets.find(a=>a.source.type==='file');if(!a)throw new Error('Fixture importada ausente');s.applyAssetPatch(a.id,{status:'error',error:'AUDIT: falha transitória de leitura'});return {id:a.id,name:a.name,count:s.project.assets.length}})()`)
      const retryLabel = 'Tentar novamente ' + before.name
      const point = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(retryLabel)});if(!e)throw new Error('Botão tentar novamente ausente');const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
      await until(()=>evaluate(`window.__qaEditor.store.getState().project.assets.find(a=>a.id===${JSON.stringify(before.id)})?.status==='ready'`))
      const after=await evaluate(`(()=>{const p=window.__qaEditor.store.getState().project;return {count:p.assets.length,status:p.assets.find(a=>a.id===${JSON.stringify(before.id)})?.status}})()`)
      writeFileSync(join(output,'retry-media.json'),JSON.stringify({before,after},null,2))
      if(after.count!==before.count)throw new Error('Nova tentativa duplicou mídia')
    }
    for (const tab of ['Mídia','Áudio','Gravações','Efeitos','Texto','Transições','Legendas','Modelos']) {
      await click('[aria-label="Biblioteca de mídia"] [role="tab"]', tab)
      await until(() => evaluate(`!![...document.querySelectorAll('[aria-label="Biblioteca de mídia"] [role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(tab)}&&e.getAttribute('aria-selected')==='true')`))
      await capture(`library-${tab.normalize('NFD').replace(/[\u0300-\u036f]/g,'')}`, width, height)
    }
    await click('[data-editor-topbar] button', 'Exportar')
    await until(() => evaluate(`!!document.querySelector('[role="dialog"]')`))
    await capture('export-dialog', width, height)
    await evaluate(`(()=>{for(const e of document.querySelector('[role="dialog"]').querySelectorAll('*'))if(/auto|scroll/.test(getComputedStyle(e).overflowY))e.scrollTop=e.scrollHeight;return true})()`)
    await capture('export-dialog-bottom', width, height)
    await click('[role="dialog"] button[aria-label="Fechar"]')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  writeFileSync(join(output, 'errors.json'), JSON.stringify(errors, null, 2))
  console.log(`UI FINISHED ${observations.length} estados · ${output}`)
  if (process.argv.includes('--keep')) { await send('Emulation.clearDeviceMetricsOverride'); await navigate('projects'); console.log(`KEEP PID=${app.pid} PORT=${port}`); await new Promise(resolve => app.on('exit', resolve)) }
} finally { ws?.close(); app.kill(); writeFileSync(join(output, 'stderr.log'), stderr) }
