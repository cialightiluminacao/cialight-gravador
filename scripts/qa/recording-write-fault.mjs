// Run against an isolated audit-ui --desktop --keep instance. Synthetic video only.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const output = resolve('test-out/product-audit/recording-write-fault'), port = process.env.CDP_PORT ?? '9478'
mkdirSync(output, { recursive: true })
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('index.html'))
if (!page) throw new Error('Audit window missing')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let seq = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
try {
  const result = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async()=>{
    if(!window.__qa||!document.title.includes('Auditoria visual isolada'))throw new Error('Not an isolated audit window');
    const {engine,startRecording}=window.__qa.controller,store=window.__qa.store,originalApi=engine.api,originalStart=engine.startMediabunny,originalDisplay=navigator.mediaDevices.getDisplayMedia;
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');let n=0;const timer=setInterval(()=>{ctx.fillStyle=n++%2?'#b31234':'#1234b3';ctx.fillRect(0,0,1280,720)},33),stream=canvas.captureStream(30),handles=new Set(),errors=[];
    let writes=0,phaseAtReview=null;
    const unsubscribe=store.subscribe(s=>{if(s.phase==='review')phaseAtReview=engine.phase});
    const off=engine.on(e=>{if(e.type==='error')errors.push(e.message)});
    try {
      navigator.mediaDevices.getDisplayMedia=async()=>stream;
      engine.api={...originalApi,session:{...originalApi.session,
        writeOpen:async(...a)=>{const h=await originalApi.session.writeOpen(...a);handles.add(h);return h},
        write:async(...a)=>{if(++writes>=3)throw new Error('AUDIT: simulated disk write failure');return originalApi.session.write(...a)},
        writeClose:async(h)=>{await originalApi.session.writeClose(h);handles.delete(h)}
      }};
      engine.startMediabunny=async()=>{throw new Error('AUDIT: primary encoder unavailable')};
      const source=(await window.api.sources.list()).screens[0];
      await startRecording({source:{kind:'screen',id:source.id,name:'Teste sintético de falha',displayId:source.displayId},quality:'1080p',fps:30,countdownSec:0,webcam:null,mic:null,systemAudio:false,pipInitial:{tMs:0,x:.76,y:.62,w:.2,h:.35,shape:'circle',visible:false}});
      window.__navigate('projects');
      for(let i=0;i<150&&store.getState().phase!=='review';i++)await new Promise(r=>setTimeout(r,100));
      const result={writes,errors,openHandles:handles.size,phase:store.getState().phase,enginePhase:engine.phase,phaseAtReview,trackState:stream.getVideoTracks()[0].readyState,sessionState:engine.session?.state};
      result.success=errors.length===1&&handles.size===0&&result.phase==='review'&&phaseAtReview==='stopped'&&result.trackState==='ended'&&result.sessionState==='stopped';return result;
    } finally {
      if(engine.phase==='recording'||engine.phase==='paused')await engine.stop();
      clearInterval(timer);stream.getTracks().forEach(t=>t.stop());unsubscribe();off();engine.api=originalApi;engine.startMediabunny=originalStart;navigator.mediaDevices.getDisplayMedia=originalDisplay;
    }
  })()` })
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails))
  const report = result.result?.result?.value
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report?.success) process.exitCode = 1
} finally { ws.close() }
