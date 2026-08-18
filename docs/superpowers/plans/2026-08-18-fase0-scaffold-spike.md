# CiaLight Gravador — Plano Fase 0: scaffold + spike técnico

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o projeto Electron pronto (build, testes, ffmpeg embutido, CI) e provar na máquina real as 7 suposições técnicas das quais o design depende, registrando os resultados em `docs/research/spike-results.md`.

**Architecture:** electron-vite (main/preload/renderer com 3 entradas HTML) + React 19 + Tailwind v4; o spike é um modo de execução (`CIALIGHT_SPIKE=1`) do próprio app que grava 15 s do monitor principal com loopback + microfone + webcam em 4 faixas fMP4 via mediabunny, testa proteção de janela, overlay transparente, atalho global e gesto de usuário; validação por ffprobe.

**Tech Stack:** Electron 43.x, electron-vite 5, React 19, TypeScript 5.7+, Tailwind v4, Radix, Zustand, mediabunny, vitest, electron-builder 26.15.7, electron-updater 6.8.9, ffmpeg BtbN n8.1.

## Global Constraints

- Windows 11 (Win10 22H2 melhor esforço). Node 24, npm 11.
- Electron **43.x** (não 44 até estável e testado). electron-builder **26.15.7** exato. electron-updater **6.8.9** exato.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` só se necessário (mediabunny roda no renderer sem Node).
- Nome do produto `CiaLight Gravador`; `appId com.cialight.gravador`; artefato `CiaLightGravador-Setup-${version}.${ext}` (ASCII).
- ffmpeg BtbN série **8.1** (não 9.x — NVENC falha na GTX 1060), pinado por URL + sha256; nunca versionado no git.
- Toda UI em português do Brasil.
- Nunca chamar `getUserMedia` de microfone na mesma chamada do `getDisplayMedia`.

---

### Task 1: Scaffold do projeto

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `.gitignore`, `.npmrc`, `README.md`
- Create: `src/main/index.ts`, `src/main/windows/recorderWindow.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`
- Create: `src/renderer/index.html`, `src/renderer/bar.html`, `src/renderer/overlay.html`, `src/renderer/src/main.tsx`, `src/renderer/src/bar.tsx`, `src/renderer/src/overlay.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Create: `src/shared/constants.ts`, `src/shared/version.test.ts`
- Create: `build/icon.ico` (placeholder gerado), `resources/.gitkeep`

**Interfaces:**
- Produces: script npm `dev`, `build`, `typecheck`, `test`, `dist:win`; alias `@` → `src/renderer/src`, `@shared` → `src/shared`; `window.api` (preload) vazio por enquanto (`{ ping(): Promise<'pong'> }`).

- [ ] **Step 1: package.json**

```json
{
  "name": "cialight-gravador",
  "version": "0.1.0",
  "description": "Gravador de tela da Cia Light: monitor/janela, webcam, áudio do sistema e microfone, anotações e exportação com presets.",
  "author": "Cia Light",
  "license": "MIT",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck:node": "tsc -p tsconfig.node.json --noEmit",
    "typecheck:web": "tsc -p tsconfig.web.json --noEmit",
    "typecheck": "npm run typecheck:node && npm run typecheck:web",
    "test": "vitest run",
    "test:watch": "vitest",
    "fetch:ffmpeg": "node scripts/fetch-ffmpeg.mjs",
    "spike": "cross-env CIALIGHT_SPIKE=1 electron-vite dev",
    "dist:win": "electron-vite build && electron-builder --win",
    "postversion": "git push --follow-tags"
  },
  "dependencies": {},
  "devDependencies": {
    "@radix-ui/react-dialog": "^1.1.6",
    "@radix-ui/react-select": "^2.1.6",
    "@radix-ui/react-slider": "^1.2.3",
    "@radix-ui/react-switch": "^1.1.3",
    "@radix-ui/react-tabs": "^1.1.3",
    "@radix-ui/react-tooltip": "^1.1.8",
    "@radix-ui/react-progress": "^1.1.2",
    "@tailwindcss/vite": "^4.3.0",
    "@types/node": "^24.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.0.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cross-env": "^7.0.3",
    "electron": "43.4.0",
    "electron-builder": "26.15.7",
    "electron-updater": "6.8.9",
    "electron-vite": "^5.0.0",
    "lucide-react": "^0.460.0",
    "mediabunny": "^1.0.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "sonner": "^2.0.0",
    "tailwind-merge": "^3.0.0",
    "tailwindcss": "^4.3.0",
    "tw-animate-css": "^1.2.0",
    "typescript": "^5.7.0",
    "vite": "^7.1.0",
    "vitest": "^3.0.0",
    "zod": "^3.24.0",
    "zustand": "^5.0.0"
  }
}
```
(Versões `^` serão resolvidas pelo `npm install`; conferir no lockfile as versões instaladas de mediabunny/electron e anotar no README. `electron-updater` é dependência de runtime → mover para `dependencies` na Task 1 mesmo: electron-builder empacota `dependencies`.)

- [ ] **Step 2: electron.vite.config.ts** com 3 entradas

```ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          bar: resolve('src/renderer/bar.html'),
          overlay: resolve('src/renderer/overlay.html')
        }
      }
    }
  }
})
```

- [ ] **Step 3: tsconfigs** iguais ao CiaLight Quadrado (`tsconfig.node.json` inclui `src/main`, `src/preload`, `src/shared`, `electron.vite.config.ts`, `scripts/**/*.mts`; `tsconfig.web.json` inclui `src/renderer/src`, `src/preload/index.d.ts`, `src/shared`, lib DOM + `"types": ["vite/client"]`), `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
export default defineConfig({
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node' }
})
```

- [ ] **Step 4: main mínimo** — `src/main/index.ts` cria a janela do gravador via `createRecorderWindow()`; `src/main/windows/recorderWindow.ts`:

```ts
import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
export function createRecorderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 960, minHeight: 640, show: false,
    title: 'CiaLight Gravador', backgroundColor: '#0f1115', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: false }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html`)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}
```

- [ ] **Step 5: preload** expõe `window.api = { ping: () => ipcRenderer.invoke('ping') }` com `contextBridge`; main responde `ipcMain.handle('ping', () => 'pong')`. `index.d.ts` declara `interface Window { api: Api }`.

- [ ] **Step 6: renderer** — `App.tsx` mostra "CiaLight Gravador" + resultado do `ping`; `styles.css` com `@import "tailwindcss"; @import "tw-animate-css";` e tema escuro base (`--background:#0f1115` etc.). `bar.tsx`/`overlay.tsx` renderizam um `<div>` com o nome da janela.

- [ ] **Step 7: teste trivial** `src/shared/version.test.ts` que importa `APP_NAME` de `constants.ts` e verifica `'CiaLight Gravador'`. Rodar `npm test` → PASS. `npm run typecheck` → sem erros. `npm run dev` → janela abre e mostra `pong`.

- [ ] **Step 8: .gitignore** (`node_modules/ out/ release/ resources/ffmpeg/ *.log .env spike-out/`), README com comandos, `build/icon.ico` gerado (script `scripts/make-icon.mjs` desenha um "C" vermelho sobre fundo escuro em PNG 256 e converte com `png-to-ico` — ou usar um PNG e deixar o electron-builder converter; verificar). Commit: `chore: scaffold electron-vite + react + tailwind`.

### Task 2: ffmpeg embutido (download pinado)

**Files:**
- Create: `scripts/fetch-ffmpeg.mjs`, `resources/ffmpeg/VERSION.json` (versionado), `src/main/export/ffmpegPath.ts`, `src/main/export/ffmpegPath.test.ts`

**Interfaces:**
- Produces: `ffmpegPath(): string`, `ffprobePath(): string` (dev: `resources/ffmpeg/ffmpeg.exe`; prod: `process.resourcesPath/ffmpeg/ffmpeg.exe`), `runFfmpeg(args, {onProgress?, signal?}) : Promise<{code:number, stderrTail:string}>` (Task 3 usa só a path).

- [ ] **Step 1: VERSION.json**

```json
{
  "series": "8.1",
  "build": "ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1",
  "urls": [
    "https://github.com/cialightiluminacao/cialight-gravador/releases/download/deps-ffmpeg-n8.1.2/ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-18-15-03/ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1.zip"
  ],
  "sha256": "<preencher após o primeiro download>",
  "files": ["bin/ffmpeg.exe", "bin/ffprobe.exe", "LICENSE.txt"]
}
```

- [ ] **Step 2: fetch-ffmpeg.mjs** — baixa (tenta URLs em ordem, `fetch` com redirect), confere sha256 (se `sha256` estiver vazio, imprime o hash calculado e falha pedindo para pinar), extrai com `adm-zip` (devDependency) apenas os `files` para `resources/ffmpeg/` (achatando `bin/`), roda `ffmpeg -version` e checa que a primeira linha contém `ffmpeg version n8.1`. Idempotente (pula se `resources/ffmpeg/.stamp` == build).
- [ ] **Step 3: rodar** `npm run fetch:ffmpeg` duas vezes (1ª obtém hash → pinar; 2ª valida). Verificar `resources/ffmpeg/ffmpeg.exe -encoders | findstr /i "h264_nvenc h264_qsv h264_mf libx264"` lista os 4.
- [ ] **Step 4: ffmpegPath.ts + teste** (teste unitário com `app.isPackaged` mockado). Commit `feat: ffmpeg embutido pinado (BtbN n8.1)`.

### Task 3: Modo spike (`CIALIGHT_SPIKE=1`)

**Files:**
- Create: `src/main/spike/spikeMain.ts`, `src/renderer/spike.html`, `src/renderer/src/spike/spike.tsx`, `src/renderer/src/spike/recordSpike.ts`, `scripts/validate-spike.mjs`
- Modify: `src/main/index.ts` (se `process.env.CIALIGHT_SPIKE` → `runSpike()`), `electron.vite.config.ts` (entrada `spike`), `src/preload/index.ts` (API do spike)

**Interfaces:**
- Preload (spike): `api.spike.getSources()`, `api.spike.chooseSource(id, {audio:boolean})`, `api.spike.openWrite(name)`, `api.spike.write(handle, data:Uint8Array, position:number)`, `api.spike.closeWrite(handle)`, `api.spike.log(msg)`, `api.spike.captureThumb(name)`, `api.spike.protect(on)`, `api.spike.done(report)`; evento `api.spike.onHotkey(cb)`.

- [ ] **Step 1: spikeMain.ts** cria (a) janela "recorder" 900×600 no display secundário se houver, com painel de status; (b) janela overlay transparente click-through cobrindo o display principal com um quadrado vermelho semi-transparente de 200×200 no centro e texto "OVERLAY"; (c) `globalShortcut.register('CommandOrControl+Shift+F9', …)` → envia `spike:hotkey` para o renderer; (d) `session.defaultSession.setDisplayMediaRequestHandler((req, cb) => cb({ video: chosen, audio: chosen && req.audioRequested && wantAudio ? 'loopback' : undefined }))`; (e) IPC de escrita: `fs.openSync(path,'w')` + `fs.writeSync(fd, data, 0, data.length, position)`; (f) `captureThumb`: `desktopCapturer.getSources({types:['screen'], thumbnailSize:{width:1280,height:720}})` → salva PNG do display principal em `spike-out/`; (g) `protect(on)`: `win.setOpacity(1); win.setContentProtection(on)` na janela recorder E na overlay.

- [ ] **Step 2: recordSpike.ts** (renderer), sequência automática com log em tela e em `spike-out/spike-log.txt`:
  1. `T0` listar fontes; escolher `screen` do display principal.
  2. **Teste A (gesto)**: sem clique, chamar `getDisplayMedia` imediatamente ao carregar → registrar sucesso ou `InvalidStateError` (transient activation). Se falhar, repetir a partir de um clique de botão e a partir do atalho global (main → `webContents.executeJavaScript('window.__spikeStart()', true)`) e registrar qual funciona.
  3. `getDisplayMedia({video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}, audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, restrictOwnAudio:true}})` → registrar `getVideoTracks()[0].getSettings()` e `getAudioTracks()[0]?.getSettings()` (EC/NS/AGC devem ser false; existência da faixa de áudio = loopback OK).
  4. `getUserMedia({video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}})` (câmera) e `getUserMedia({audio:{echoCancellation:false}})` (mic) — separados.
  5. `protect(true)`, esperar 500 ms, `captureThumb('protected.png')`; depois `protect(false)`, `captureThumb('unprotected.png')`; voltar `protect(true)`.
  6. mediabunny: `Output({format:new Mp4OutputFormat({fastStart:'fragmented', minimumFragmentDuration:1}), target:new StreamTarget(writable)})` onde `writable.write(chunk)` → `api.spike.write(h, chunk.data, chunk.position)`; fontes: `MediaStreamVideoTrackSource(screenTrack,{codec:'avc', bitrate:12e6, latencyMode:'realtime', keyFrameInterval:1, hardwareAcceleration:'no-preference', onEncoderConfig: log})`, idem webcam `bitrate:5e6`, `MediaStreamAudioTrackSource(mic,{codec:'aac', bitrate:160e3})`, idem sistema; `addVideoTrack(src,{frameRate:30})`, `addAudioTrack`; `await output.start()`.
  7. t=5 s `pause()` em todas; t=8 s `resume()`; t=15 s parar: `await output.finalize()`; `closeWrite`; parar tracks.
  8. Enquanto grava: a cada 1 s registrar `bytesWritten`, `performance.now()`; ao final, `errorPromise` de cada fonte.
  9. `api.spike.done(report)` → main roda `scripts/validate-spike.mjs` (ffprobe JSON: nº de streams, codec/profile, width/height, `duration` de cada faixa, `nb_frames`, `r_frame_rate`) e grava `spike-out/report.json`; abre a pasta.

- [ ] **Step 3: critérios de aceite** (registrar em `docs/research/spike-results.md`):
  - A: `getDisplayMedia` sem gesto funciona? Se não, `executeJavaScript(..., true)` funciona?
  - B: `protected.png` **não** mostra a janela recorder nem a overlay (inspecionar visualmente e por diferença de pixels na região das janelas); `unprotected.png` mostra.
  - C: `rec.mp4` tem 4 faixas (2 avc1 + 2 mp4a), duração ≈ 12 s (15 − 3 de pausa) ±0,3 s em todas as faixas; reproduz no Windows Media Player e no Chrome.
  - D: encoder de vídeo usado (via `onEncoderConfig`/`chrome://media-internals`): hardware? CPU do processo renderer/GPU durante a gravação (Gerenciador de Tarefas / `process.getCPUUsage()` no renderer a cada 1 s) < 35 % de um core em 1080p30.
  - E: overlay transparente aparece corretamente na tela (não preta), cliques passam por ela; após `setIgnoreMouseEvents(false)` recebe `pointerdown`.
  - F: atalho `Ctrl+Shift+F9` dispara com o Notepad em foco.
  - G: áudio do sistema audível na faixa a1 (tocar um som de teste com `new Audio()` no próprio app? — não: `restrictOwnAudio` remove; tocar um vídeo do YouTube no navegador durante o spike) e mic na a0.
- [ ] **Step 4: rodar** `npm run spike`, colar resultados e imagens em `docs/research/spike-results.md`, decisões derivadas (ex.: se HW encoder ausente → ajustar bitrate/preset; se proteção falhar → plano B). Commit `test(spike): resultados da validação técnica`.

### Task 4: CI mínima

**Files:**
- Create: `.github/workflows/ci.yml` (push/PR: `npm ci`, `npm run typecheck`, `npm test`), `.github/workflows/release.yml` (tag `v*`: `npm ci`, `npm run fetch:ffmpeg`, typecheck, test, `npx electron-builder --win --publish always`, `permissions: contents: write`, `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`).
- Modify: `package.json` (`build` do electron-builder: appId, productName, win/nsis, extraResources ffmpeg, publish github `releaseType: release`, `files`).

- [ ] Criar repositório público `cialightiluminacao/cialight-gravador` (`gh repo create --public --source . --push`), criar release `deps-ffmpeg-n8.1.2` com o zip do BtbN como asset (espelho), commit e push. Verificar que `ci.yml` passa.
