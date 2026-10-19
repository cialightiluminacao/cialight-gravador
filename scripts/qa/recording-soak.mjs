// Real RecordingEngine/encoder/writer, synthetic 1080p video and audio, isolated profile. No desktop/mic capture.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import electronPath from 'electron'
const root = resolve(import.meta.dirname, '../..'), seconds = Number(process.argv[2] ?? 1800)
const appRoot = resolve(process.env.CIALIGHT_SOAK_APP_ROOT ?? root)
if (!Number.isFinite(seconds) || seconds < 15 || seconds > 7200) throw new Error('Duration must be 15–7200 seconds')
const output = join(root, 'test-out/product-audit', `soak-${Date.now()}`), profile = appRoot === root ? join(output, 'profile') : join(appRoot, 'test-out', `soak-profile-${Date.now()}`), port = Number(process.env.CIALIGHT_SOAK_PORT ?? 9481)
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ devices: { cameraOn: false, micOn: false, systemAudioOn: false }, hotkeys: {} }))
const env = { ...process.env, CIALIGHT_TEST: 'editor-narration', CIALIGHT_QA: 'soak', CIALIGHT_QA_USER_DATA: profile, CIALIGHT_RAW_DIR: join(output, 'Brutos') }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electronPath, [appRoot, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore','ignore','pipe'] })
let stderr = '', ws, seq = 0
app.stderr.on('data', b => { stderr += b })
const pending = new Map(), report = { seconds, output, samples: [], errors: [] }
const sleep = ms => new Promise(r => setTimeout(r, ms))
function send(method, params={}) { return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'))},90000);pending.set(id,r=>{clearTimeout(timer);resolve(r)});ws.send(JSON.stringify({id,method,params}))}) }
async function evaluate(expression) { const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value }
function save() { writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2)) }
try {
  let page
  for(let i=0;i<100&&!page;i++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page'&&t.url.includes('index.html'))}catch{};if(!page)await sleep(300)}
  if(!page)throw new Error('Electron did not start: '+stderr.slice(-1000))
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r)
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}
  for(let i=0;i<100;i++){if(await evaluate('!!window.__qa?.controller.engine'))break;await sleep(200)}
  report.prepared = await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;canvas.style.cssText='position:fixed;bottom:0;right:0;width:320px;height:180px;z-index:99999';document.body.append(canvas);
    const ctx=canvas.getContext('2d');let n=0;const draw=()=>{ctx.fillStyle='#152438';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#ff4444';ctx.fillRect((n*7)%1800,400,120,120);ctx.fillStyle='white';ctx.font='60px sans-serif';ctx.fillText('Teste sintético '+n++,60,100)};draw();const timer=setInterval(draw,1000/30);
    const stream=canvas.captureStream(30),audio=new AudioContext({sampleRate:48000}),dest=audio.createMediaStreamDestination(),osc=audio.createOscillator(),gain=audio.createGain();gain.gain.value=.1;osc.frequency.value=440;osc.connect(gain).connect(dest);osc.start();await audio.resume();stream.addTrack(dest.stream.getAudioTracks()[0]);
    const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=async()=>stream;
    const list=await window.api.sources.list(),source=list.screens[0];if(!source)throw new Error('No display metadata');
    const engine=window.__qa.controller.engine;window.__soak={engine,errors:[],cleanup:async()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop());osc.stop();await audio.close();canvas.remove();navigator.mediaDevices.getDisplayMedia=original}};
    engine.on(e=>{if(e.type==='error')window.__soak.errors.push(e.message)});
    const prepared=await engine.prepare({source:{kind:'screen',id:source.id,name:'Teste sintético de duração',displayId:source.displayId},quality:'1080p',fps:30,countdownSec:0,webcam:null,mic:null,systemAudio:true,pipInitial:{tMs:0,x:.76,y:.62,w:.2,h:.3555555556,shape:'circle',visible:false}});
    const originalStart=engine.startMediabunny;
    if(${process.env.CIALIGHT_SOAK_FORCE_FALLBACK === '1'})engine.startMediabunny=async()=>{throw new Error('AUDIT: primary encoder start failure')};
    try {await engine.start()} finally {engine.startMediabunny=originalStart}
    window.__navigate('projects');return {video:prepared.video,audio:!!prepared.systemAudioTrack,startedAt:Date.now()}
  })()`)
  console.log(`SOAK START ${seconds}s ${output}`)
  await sleep(3000);await evaluate('window.__soak.engine.pause();true');await sleep(2000);await evaluate('window.__soak.engine.resume();true')
  let lastPrint=-1
  while(true){
    const state=await evaluate('({mediaMs:window.__soak.engine.mediaTimeMs(),errors:window.__soak.errors})')
    const heap=(await send('Runtime.getHeapUsage')).result
    const privateBytes=Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${app.pid}).PrivateMemorySize64`],{encoding:'utf8',windowsHide:true}).trim())
    report.samples.push({wall:Date.now(),...state,heapUsed:heap.usedSize,heapTotal:heap.totalSize,mainPrivateBytes:privateBytes});save()
    if(state.errors.length)throw new Error(state.errors.join('; '))
    const minute=Math.floor(state.mediaMs/60000);if(minute!==lastPrint){lastPrint=minute;console.log(`SOAK ${minute}min heap=${Math.round(heap.usedSize/1048576)}MB main=${Math.round(privateBytes/1048576)}MB`)}
    if(state.mediaMs>=seconds*1000)break
    await sleep(Math.min(30000,seconds*1000-state.mediaMs))
  }
  report.session=await evaluate('(async()=>{const s=await window.__soak.engine.stop();await window.__soak.cleanup();return s})()')
  const file=join(output,'Brutos',report.session.id,report.session.files.rec)
  report.file=file
  report.files=Object.values(report.session.files.fallback ?? {rec:report.session.files.rec}).map(name=>join(output,'Brutos',report.session.id,name))
  report.probes=report.files.map(path=>JSON.parse(execFileSync(join(root,'resources/ffmpeg/ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',path],{encoding:'utf8',maxBuffer:8*1024*1024,windowsHide:true})))
  report.probe=report.probes[0]
  const duration=Number(report.probe.format.duration)
  if(Math.abs(duration-seconds)>2||report.session.state!=='stopped'||report.session.pauses.length!==1)throw new Error('Duration/session/pause verification failed')
  if(!report.probe.streams.some(s=>s.codec_type==='video')||!report.probes.some(p=>p.streams.some(s=>s.codec_type==='audio')))throw new Error('Missing video/audio')
  if(process.env.CIALIGHT_SOAK_FORCE_FALLBACK==='1'&&report.session.engine!=='mediarecorder')throw new Error('Fallback was not exercised')
  console.log('SOAK decode all frames')
  for(const path of report.files)execFileSync(join(root,'resources/ffmpeg/ffmpeg.exe'),['-v','error','-xerror','-i',path,'-f','null','-'],{windowsHide:true,stdio:'pipe',timeout:300000,maxBuffer:8*1024*1024})
  report.decodedAllFrames=true;report.success=true;save();console.log('SOAK PASS '+output)
} catch(e){report.success=false;report.errors.push(String(e));save();console.error(String(e));process.exitCode=1}
finally{try{await evaluate('setTimeout(()=>window.api.app.quit(),100);true')}catch{};ws?.close();app.kill();writeFileSync(join(output,'stderr.log'),stderr)}
