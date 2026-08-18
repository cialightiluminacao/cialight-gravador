// Modo spike (CIALIGHT_SPIKE=1): prova as suposições técnicas do design na
// máquina real. Não faz parte do app final — só existe para a Fase 0.
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } from 'electron'
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync, appendFileSync } from 'fs'
import { join } from 'path'
import { execFile, spawn } from 'child_process'
import { loadPage } from '../windows/recorderWindow'
import { ffmpegPath, ffprobePath } from '../export/ffmpegPath'

const outDir = join(app.getAppPath(), 'spike-out')
const logFile = join(outDir, 'spike-log.txt')
let recorderWin: BrowserWindow | null = null
let overlayWin: BrowserWindow | null = null
let chosenSourceId: string | null = null
let wantAudio = false
const handles = new Map<number, number>()
let nextHandle = 1
const overlayEvents: string[] = []
const hotkeyEvents: string[] = []

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [main] ${msg}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}

function powershell(script: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (out += String(d)))
    p.on('close', (code) => resolve({ code, out }))
  })
}

// Clique físico via user32 (SetCursorPos + mouse_event) — testa hit-testing do SO.
async function osClick(x: number, y: number): Promise<void> {
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class U { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e); }
"@
[U]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 120; [U]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U]::mouse_event(4,0,0,0,[UIntPtr]::Zero); "clicked"`
  const r = await powershell(script)
  log(`osClick(${x},${y}) -> ${r.out.trim()}`)
}

// Toca um som pelo dispositivo de saída padrão a partir de OUTRO processo
// (o loopback com restrictOwnAudio exclui o próprio app).
function playSystemSound(): void {
  void powershell(`(New-Object Media.SoundPlayer "C:\\Windows\\Media\\Alarm01.wav").PlaySync(); "played"`).then((r) =>
    log(`playSystemSound -> ${r.out.trim()}`)
  )
}

async function testGlobalHotkeyWithNotepad(): Promise<void> {
  const before = hotkeyEvents.length
  const r = await powershell(`
$p = Start-Process "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/k title JANELA_TESTE_HOTKEY" -PassThru; Start-Sleep -Milliseconds 1500
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); }'
$sb = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText([W]::GetForegroundWindow(), $sb, 256); "foreground=" + $sb.ToString()
[System.Windows.Forms.SendKeys]::SendWait('^+{F9}'); Start-Sleep -Milliseconds 800
Stop-Process -Id $p.Id -Force; "sent"`)
  log(`hotkey via Notepad: ${r.out.trim()} — eventos antes=${before} depois=${hotkeyEvents.length}`)
}

function createOverlay(display: Electron.Display): BrowserWindow {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  loadPage(win, 'overlay.html?spike=1')
  win.once('ready-to-show', () => win.showInactive())
  return win
}

export async function runSpike(): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(logFile, '')
  log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`)
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  log(`displays: ${JSON.stringify(displays.map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor, primary: d.id === primary.id })))}`)

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      log(`displayMedia request: videoRequested=${request.videoRequested} audioRequested=${request.audioRequested} chosen=${chosenSourceId} wantAudio=${wantAudio}`)
      void desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        const src = sources.find((s) => s.id === chosenSourceId) ?? sources.find((s) => s.id.startsWith('screen:'))
        if (!src) {
          log('nenhuma fonte encontrada')
          callback({})
          return
        }
        callback({ video: src, audio: request.audioRequested && wantAudio ? 'loopback' : undefined })
      })
    },
    { useSystemPicker: false }
  )

  ipcMain.on('spike:log', (_e, msg: string) => {
    const line = `[${new Date().toISOString()}] [renderer] ${msg}`
    console.log(line)
    appendFileSync(logFile, line + '\n')
  })
  ipcMain.handle('spike:getSources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
    return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id, hasThumb: !s.thumbnail.isEmpty() }))
  })
  ipcMain.handle('spike:chooseSource', (_e, id: string, audio: boolean) => {
    chosenSourceId = id
    wantAudio = audio
  })
  ipcMain.handle('spike:openWrite', (_e, name: string) => {
    const fd = openSync(join(outDir, name), 'w')
    const h = nextHandle++
    handles.set(h, fd)
    return h
  })
  ipcMain.handle('spike:write', (_e, h: number, data: Uint8Array, position: number) => {
    const fd = handles.get(h)
    if (fd === undefined) throw new Error('handle inválido')
    writeSync(fd, data, 0, data.byteLength, position)
  })
  ipcMain.handle('spike:closeWrite', (_e, h: number) => {
    const fd = handles.get(h)
    if (fd !== undefined) closeSync(fd)
    handles.delete(h)
  })
  ipcMain.handle('spike:captureThumb', async (_e, name: string) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: primary.size.width, height: primary.size.height } })
    const src = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
    const file = join(outDir, name)
    writeFileSync(file, src.thumbnail.toPNG())
    log(`thumb ${name} de ${src.name} (${src.display_id}) salva`)
    return file
  })
  ipcMain.handle('spike:protect', (_e, on: boolean) => {
    for (const w of [recorderWin, overlayWin]) {
      if (!w) continue
      w.setOpacity(1.0)
      w.setContentProtection(on)
    }
    log(`setContentProtection(${on})`)
  })
  ipcMain.handle('spike:overlayInteractive', (_e, on: boolean) => {
    if (!overlayWin) return
    if (on) {
      overlayWin.setIgnoreMouseEvents(false)
      overlayWin.setFocusable(true)
      overlayWin.focus()
    } else {
      overlayWin.setIgnoreMouseEvents(true, { forward: true })
      overlayWin.setFocusable(false)
    }
    log(`overlay interactive=${on}`)
  })
  ipcMain.on('spike:overlayReport', (_e, msg: string) => {
    overlayEvents.push(msg)
    log(`overlay event: ${msg}`)
  })
  ipcMain.handle('spike:cpu', () => {
    const metrics = app.getAppMetrics().map((m) => ({ type: m.type, name: m.name, cpu: Number(m.cpu.percentCPUUsage.toFixed(1)), memMB: Math.round(m.memory.workingSetSize / 1024) }))
    return metrics
  })
  ipcMain.handle('spike:osClickOverlay', async () => {
    // quadrado vermelho da overlay: centro do display principal deslocado p/ direita-cima
    const x = primary.bounds.x + Math.round(primary.bounds.width * 0.78)
    const y = primary.bounds.y + Math.round(primary.bounds.height * 0.28)
    await osClick(x, y)
  })
  ipcMain.handle('spike:playSound', () => playSystemSound())
  ipcMain.handle('spike:testHotkeyNotepad', () => testGlobalHotkeyWithNotepad())
  ipcMain.handle('spike:requestGestureStart', () => {
    log('executeJavaScript(__spikeStart, userGesture=true)')
    return recorderWin?.webContents.executeJavaScript('window.__spikeStart && window.__spikeStart("gesture-exec")', true)
  })
  ipcMain.handle('spike:done', async (_e, report: unknown) => {
    const full = { report, overlayEvents, hotkeyEvents, probe: await probe(join(outDir, 'rec.mp4')), audio: await audioLevels(join(outDir, 'rec.mp4')) }
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(full, null, 2))
    log('report.json escrito')
    void shell.openPath(outDir)
    return full
  })

  const ok = globalShortcut.register('CommandOrControl+Shift+F9', () => {
    hotkeyEvents.push(new Date().toISOString())
    log('globalShortcut Ctrl+Shift+F9 disparado')
    recorderWin?.webContents.send('spike:hotkey')
  })
  log(`globalShortcut.register -> ${ok}`)

  overlayWin = createOverlay(primary)
  recorderWin = new BrowserWindow({
    x: primary.bounds.x + 40,
    y: primary.bounds.y + 40,
    width: 900,
    height: 640,
    title: 'SPIKE CiaLight Gravador',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: false }
  })
  loadPage(recorderWin, `spike.html?fps=${process.env.CIALIGHT_SPIKE_FPS ?? '30'}&secs=${process.env.CIALIGHT_SPIKE_SECS ?? '15'}`)
  recorderWin.on('closed', () => {
    overlayWin?.destroy()
    app.quit()
  })
}

function probe(file: string): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ error: String(err), stderr })
      else {
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          resolve({ error: String(e), stdout })
        }
      }
    })
  })
}

// mean/max volume por faixa de áudio (a0 mic, a1 sistema)
async function audioLevels(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const idx of [0, 1]) {
    out[`a${idx}`] = await new Promise<string>((resolve) => {
      execFile(ffmpegPath(), ['-hide_banner', '-i', file, '-map', `0:a:${idx}?`, '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 10 * 1024 * 1024 }, (_err, _stdout, stderr) => {
        const m = String(stderr).match(/mean_volume: ([-\d.]+) dB[\s\S]*?max_volume: ([-\d.]+) dB/)
        resolve(m ? `mean ${m[1]} dB, max ${m[2]} dB` : `sem medição: ${String(stderr).split('\n').slice(-3).join(' | ')}`)
      })
    })
  }
  return out
}
