# CiaLight Gravador — Plano Fase 1: aplicativo completo (v1.0.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o CiaLight Gravador v1.0.0 conforme `docs/superpowers/specs/2026-08-18-cialight-gravador-design.md`: gravação de monitor/janela com webcam PiP, áudio do sistema + microfone, pausa, anotações, revisão com corte e presets, instalador NSIS com auto-update via GitHub Releases.

**Architecture:** Electron (main = orquestração/arquivos/ffmpeg/updater; renderer React = UI + engine de gravação com mediabunny + compositor + export composer em Worker). Faixas separadas em fMP4 + `session.json`; composição PiP/anotações só na exportação; ffmpeg embutido finaliza os presets. Ver spec §3–§9 e resultados do spike em `docs/research/spike-results.md` (todas as suposições confirmadas em 18/08/2026).

**Tech Stack:** Electron 43.4.0, electron-vite 5, React 19, TypeScript, Tailwind v4, Radix UI, Zustand, zod 4, mediabunny 1.55, vitest 4, electron-builder 26.15.7, electron-updater 6.8.9, electron-log 5, ffmpeg BtbN n8.1.2.

## Global Constraints

- Somente Windows; Windows 11 alvo (Win10 22H2 melhor esforço). Toda a UI e mensagens em **português do Brasil** com acentuação correta.
- `contextIsolation: true`, `nodeIntegration: false`; todo acesso a Node/Electron passa pelo preload tipado (`window.api`).
- Nunca pedir microfone na mesma chamada de `getDisplayMedia`. Áudio do sistema só via handler (`audio:'loopback'`) quando o toggle estiver ligado.
- Gravação sempre em fMP4 (`fastStart:'fragmented'`, `minimumFragmentDuration:1`), keyframe a cada 1 s, H.264 High (`avc`) por hardware `no-preference`; AAC com fallback Opus.
- 1440p exige nível ≥ 5.0 — validar por `VideoEncoder.isConfigSupported` antes de iniciar; se falhar, cair para 1080p com aviso.
- Todas as janelas do app recebem `setOpacity(1.0)` + `setContentProtection(true)` durante contagem/gravação quando `settings.protectWindows` estiver ligado (padrão ligado); páginas transparentes têm `html, body { background: transparent }`.
- Atalhos padrão: `Ctrl+Shift+F9` iniciar/parar · `F10` pausar/retomar · `F11` cancelar · `F12` mostrar/ocultar barra · `F8` reiniciar · `F5` anotar · `F6` seta · `F7` apagar tudo · `F1` mute mic · `F2` câmera. Sempre checar o retorno de `globalShortcut.register` e mostrar conflito na UI.
- Presets de exportação e comandos ffmpeg exatamente como spec §7.2 (WhatsApp: H.264 Main, `-bf 0`, ≤ 720p30, alvo ≤ 64 MB / e-mail ≤ 20 MB; Alta CRF 20; Máxima CRF 17; Edição posterior separado; Só cortar `-c copy`); MP4 final sempre com `-movflags +faststart` e `format=yuv420p`.
- Nome do produto `CiaLight Gravador`, `appId com.cialight.gravador`, artefato `CiaLightGravador-Setup-${version}.${ext}`, publish GitHub `cialightiluminacao/cialight-gravador` com `releaseType: "release"`. Sem assinatura de código.
- Pastas padrão: saída `%USERPROFILE%\Videos\CiaLight Gravador\`; brutos `…\CiaLight Gravador\Brutos\<sessionId>\`.
- Testes: vitest para lógica pura; scripts de integração em `scripts/`; nada é "pronto" sem rodar `npm run typecheck && npm test`.
- Commits pequenos e frequentes na `main` (repo local; push ao final de cada Track).

## Estrutura de arquivos (referência)

```
src/shared/
  types.ts            tipos de domínio (Session, Settings, CaptureSource, PipKeyframe, Stroke, ExportOptions, EncoderProbe…)
  schemas.ts          zod: SessionSchema, SettingsSchema (+ migrações), ExportOptionsSchema
  ipc.ts              nomes de canais + tipos de payload (IpcApi) usados por preload/main/renderer
  defaults.ts         DEFAULT_SETTINGS, DEFAULT_HOTKEYS, presets de qualidade
  mediaClock.ts       relógio de mídia (pausas)
  compositor/         pipMath.ts, strokes.ts, drawFrame.ts, index.ts (TS puro, sem DOM além de canvas ctx)
  presets/            presets.ts (definições), ffmpegArgs.ts (buildFfmpegArgs), sizeTarget.ts, sizeEstimate.ts
  hotkeys.ts          normalização/validação de aceleradores (ABNT2, lista negra)
  filenames.ts        nomes de arquivo/sessão (datas, sanitização, sufixo -2)
src/main/
  index.ts            bootstrap; modo spike; single-instance; tray; ciclo de vida
  ipc.ts              registra handlers (chama módulos)
  settings/settingsStore.ts
  session/sessionStore.ts   pastas, session.json, escrita de arquivos por handle, listagem, exclusão (lixeira), recuperação
  capture/sources.ts        desktopCapturer + screen → CaptureSource[]/DisplayInfo[]
  capture/displayMediaHandler.ts
  windows/recorderWindow.ts, barWindow.ts, overlayWindows.ts, protection.ts
  hotkeys/globalShortcuts.ts
  recording/state.ts        espelho do estado da gravação (para tray/bar/overlay/hotkeys), broadcast
  export/ffmpegPath.ts, ffmpegRunner.ts, encoderProbe.ts, exportJob.ts, reviewAssets.ts (proxy/thumbs/waveform)
  update/autoUpdater.ts
  tray.ts, log.ts
src/preload/index.ts (+ index.d.ts)  window.api (IpcApi tipado)
src/renderer/src/
  app/App.tsx, store.ts (zustand), routes por estado
  engine/RecordingEngine.ts, encoderSupport.ts, fallbackRecorder.ts, sessionRecorder.ts (eventos → Session)
  export/exportComposer.worker.ts, exportComposer.ts (cliente do worker), reviewPlayer.ts
  screens/Prepare/*, Recording/*, Review/*, Settings/*, History/*
  components/ui/* (Button, Toggle, Select, Slider, Dialog, Tooltip, Progress, VuMeter, Kbd, EmptyState)
  bar/BarApp.tsx (bar.html), overlay/OverlayApp.tsx (overlay.html) — cada um com seu entry
  hooks/useDevices.ts, useSources.ts, useMediaPreview.ts, useVu.ts
```

---

## Track A — Fundamentos compartilhados (TS puro, com testes)

### Task A1: Tipos, schemas e defaults

**Files:** Create `src/shared/types.ts`, `src/shared/schemas.ts`, `src/shared/defaults.ts`, `src/shared/schemas.test.ts`

**Interfaces (produz):**
```ts
// types.ts
export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayInfo { id: string; label: string; bounds: Rect; workArea: Rect; scaleFactor: number; isPrimary: boolean; index: number }
export type SourceKind = 'screen' | 'window'
export interface CaptureSource { id: string; kind: SourceKind; name: string; displayId?: string; thumbnailDataUrl?: string; appIconDataUrl?: string }
export type PipShape = 'circle' | 'rounded'
export interface PipKeyframe { tMs: number; x: number; y: number; w: number; h: number; shape: PipShape; visible: boolean }
export type StrokeTool = 'pen' | 'line' | 'arrow'
export interface StrokePoint { x: number; y: number; tMs: number }
export interface Stroke { id: string; tMs: number; tool: StrokeTool; points: StrokePoint[]; color: string; width: number; erasedAtMs?: number }
export type Quality = '720p' | '1080p' | '1440p' | 'native'
export type Fps = 30 | 60
export type SessionState = 'recording' | 'stopped' | 'finalized' | 'aborted'
export interface Session {
  version: 1; id: string; createdAt: string; state: SessionState
  source: { kind: SourceKind; id: string; name: string; displayId?: string; bounds: Rect; scaleFactor: number }
  video: { width: number; height: number; fps: number; codec: string; bitrate: number }
  webcam?: { deviceId: string; label: string; width: number; height: number; mirrored: boolean }
  mic?: { deviceId: string; label: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }
  systemAudio: boolean
  tracks: { screen: 0; webcam?: 1; mic?: 0 | 1; system?: 0 | 1 }   // índices dentro de v:/a: no rec.mp4
  durationMs?: number
  pauses: { startMs: number; endMs: number }[]        // tempo real relativo ao início
  pip: PipKeyframe[]
  strokes: Stroke[]
  clearEvents: { tMs: number }[]
  markers: { tMs: number; label?: string }[]
  engine: 'webcodecs' | 'mediarecorder'
  files: { rec: string; proxy?: string; webcam?: string; thumbs?: string; waveform?: string }
  bytes?: number
}
export type HotkeyAction = 'toggleRecord' | 'pauseResume' | 'cancel' | 'toggleBar' | 'restart' | 'annotate' | 'arrow' | 'clearAnnotations' | 'muteMic' | 'toggleCamera'
export type MicMode = 'headset' | 'speakers'
export interface Settings {
  version: 1
  devices: { cameraId: string | null; micId: string | null; cameraOn: boolean; micOn: boolean; systemAudioOn: boolean; micMode: MicMode }
  quality: Quality; fps: Fps; countdownSec: 0 | 3 | 5; startSound: boolean
  pip: { x: number; y: number; w: number; h: number; shape: PipShape; mirrored: boolean }
  hotkeys: Record<HotkeyAction, string | null>
  outputDir: string | null; rawDir: string | null   // null = padrão
  protectWindows: boolean; clickHighlight: boolean
  annotations: { color: string; width: number; autoFadeSec: number | null }
  rawRetentionDays: number | null
  lastEncoderProbe: EncoderProbe | null
  lastSource: { kind: SourceKind; id: string; name: string } | null
}
export type HwEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_mf' | 'libx264'
export interface EncoderProbe { gpuKey: string; probedAt: string; available: HwEncoder[]; preferred: HwEncoder }
export type ExportPresetId = 'small' | 'high' | 'max' | 'separate' | 'cutOnly'
export type AudioMode = 'mix' | 'micOnly' | 'systemOnly' | 'separate'
export interface ExportOptions {
  presetId: ExportPresetId; trimStartMs: number; trimEndMs: number | null
  includeWebcam: boolean; includeAnnotations: boolean; audioMode: AudioMode; micOffsetMs: number
  targetSizeMB: 64 | 20 | null; reels: boolean; outputDir: string; fileName: string
  pipOverride: PipKeyframe[] | null
}
export interface RecordingConfig {
  source: { kind: SourceKind; id: string; name: string; displayId?: string }
  quality: Quality; fps: Fps; countdownSec: 0 | 3 | 5
  webcam: { deviceId: string; label: string; mirrored: boolean } | null
  mic: { deviceId: string; label: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } | null
  systemAudio: boolean
  pipInitial: PipKeyframe
}
export type RecorderPhase = 'idle' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'review'
export type RecorderCommand = 'toggleRecord' | 'pause' | 'resume' | 'pauseResume' | 'stop' | 'cancel' | 'restart' | 'toggleBar' | 'annotate' | 'arrow' | 'clearAnnotations' | 'muteMic' | 'toggleCamera' | 'cyclePip'
```
`schemas.ts`: `SessionSchema`, `SettingsSchema` (zod) com `parseSettings(raw: unknown): Settings` que aplica defaults e migração (`version` ausente → 1). `defaults.ts`: `DEFAULT_SETTINGS`, `DEFAULT_HOTKEYS` (spec), `QUALITY_PRESETS: Record<Quality,{width:number|null,height:number|null,bitrate:number}>` = 720p 6e6, 1080p 12e6, 1440p 20e6, native 12e6 (× 1.66 se fps 60), `WEBCAM_BITRATE = 5e6`, `AUDIO_BITRATE = 160e3`, `DEFAULT_PIP = {x:0.74,y:0.70,w:0.22,h:0.22*16/9? → usar h em fração da altura: 0.22*(16/9)/(16/9)=…}` → **definir PiP por largura fracional e proporção 1:1 para círculo e 16:9 para retangular**: `DEFAULT_PIP = { x: 0.76, y: 0.68, w: 0.20, h: 0.20 * (16/9) /* h em fração da altura p/ manter 1:1 em 16:9 */, shape:'circle', visible:true }`.

- [ ] Escrever `schemas.test.ts`: (1) `parseSettings({})` retorna defaults completos; (2) `parseSettings({hotkeys:{toggleRecord:'Ctrl+Shift+F9'}})` mantém demais atalhos padrão; (3) `SessionSchema.parse` aceita uma sessão mínima válida e rejeita `version: 2`. Rodar → falha (módulos inexistentes). Implementar. Rodar → passa. Commit `feat(shared): tipos, schemas e defaults`.

### Task A2: mediaClock, filenames, hotkeys

**Files:** Create `src/shared/mediaClock.ts` (+ `.test.ts`), `src/shared/filenames.ts` (+ `.test.ts`), `src/shared/hotkeys.ts` (+ `.test.ts`)

**Interfaces:**
```ts
export class MediaClock { start(nowMs: number): void; pause(nowMs: number): void; resume(nowMs: number): void; stop(nowMs: number): void
  mediaTimeMs(nowMs: number): number; get pauses(): {startMs:number; endMs:number}[]; get isPaused(): boolean; get startedAtMs(): number }
export function sessionIdFor(date: Date): string          // '2026-08-18T14-32-05'
export function defaultOutputName(date: Date, ext = 'mp4'): string   // 'Gravação 2026-08-18 14-32.mp4'
export function sanitizeFileName(name: string): string     // remove \/:*?"<>| e trim
export function uniqueName(existing: Set<string>, name: string): string  // 'x.mp4' → 'x-2.mp4'
export function normalizeAccelerator(input: string): string | null      // 'ctrl+shift+f9' → 'CommandOrControl+Shift+F9'; inválido → null
export function hotkeyProblems(acc: string): string[]                    // avisos: 'Ctrl+Alt = AltGr no teclado ABNT2', 'Reservado pelo Windows (Win+…)', 'Conflita com Loom (Ctrl+Shift+L)' …
export function findDuplicateHotkeys(map: Record<string, string|null>): [string,string][]
```
- [ ] Testes: relógio com 2 pausas soma certo; `mediaTimeMs` durante pausa congela; `sessionIdFor` formata com zero à esquerda; `uniqueName` gera `-2`,`-3`; `normalizeAccelerator('Ctrl+Shift+F9')`; `hotkeyProblems('Ctrl+Alt+X')` contém aviso ABNT2; `hotkeyProblems('Super+G')` reservado; duplicados detectados. Implementar → passar → commit `feat(shared): mediaClock, filenames, hotkeys`.

### Task A3: Compositor (PiP + traços)

**Files:** Create `src/shared/compositor/pipMath.ts`, `strokes.ts`, `drawFrame.ts`, `index.ts`, `pipMath.test.ts`, `strokes.test.ts`

**Interfaces:**
```ts
export interface PipRect { x: number; y: number; w: number; h: number; shape: PipShape; visible: boolean }  // normalizado
export function pipRectAt(keyframes: PipKeyframe[], tMs: number, easeMs = 150): PipRect | null   // null se sem keyframes; interpola linear entre keyframes vizinhos limitado a easeMs após o keyframe seguinte (movimento "salta suave"); antes do 1º → 1º; depois do último → último
export function pipPixelRect(r: PipRect, W: number, H: number): { x:number; y:number; w:number; h:number; radius:number }  // círculo: lado = min(w*W, h*H); rounded: radius = 0.06*min(w,h)
export function clampPip(r: PipRect): PipRect   // mantém dentro de 0..1
export function visibleStrokesAt(strokes: Stroke[], clears: {tMs:number}[], tMs: number, autoFadeMs: number | null): { stroke: Stroke; points: StrokePoint[]; alpha: number }[]
  // regras: stroke visível se tMs >= stroke.tMs, não erasedAtMs <= tMs, não existe clear com stroke.tMs < clear.tMs <= tMs; pontos = os com pt.tMs <= tMs (desenho progressivo); alpha 1, ou fade linear nos últimos 500 ms se autoFadeMs
export interface FrameSources { screen: CanvasImageSource; cam?: CanvasImageSource | null; camMirrored?: boolean }
export function drawFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, W: number, H: number, src: FrameSources, session: Pick<Session,'pip'|'strokes'|'clearEvents'>, tMs: number, opts: { includeWebcam: boolean; includeAnnotations: boolean; autoFadeMs: number|null; pipOverride?: PipKeyframe[]|null }): void
  // 1) drawImage(screen, 0,0,W,H); 2) PiP: clip (arc ou roundRect), drawImage cover, sombra 0 4px 16px rgba(0,0,0,.35), borda 2px rgba(255,255,255,.85); 3) traços: lineCap/lineJoin round, largura = stroke.width * (W/1920), seta = linha + cabeça triangular (comprimento 4×width, ângulo 28°)
```
- [ ] Testes de `pipRectAt` (sem keyframes → null; antes/depois; interpolação a 50 % em t=kf.t+75 quando easeMs=150; visible=false), `clampPip`, `visibleStrokesAt` (progressivo, erased, clear, fade). `drawFrame` testado com um `ctx` fake que registra chamadas (`drawImage`, `arc`, `roundRect`, `stroke`) → verifica ordem e parâmetros básicos. Commit `feat(shared): compositor`.

### Task A4: Presets, argumentos ffmpeg, tamanho-alvo e estimativa

**Files:** Create `src/shared/presets/presets.ts`, `ffmpegArgs.ts`, `sizeTarget.ts`, `sizeEstimate.ts`, `ffmpegArgs.test.ts`, `sizeTarget.test.ts`, `sizeEstimate.test.ts`

**Interfaces:**
```ts
export interface PresetDef { id: ExportPresetId; title: string; subtitle: string; container: 'mp4'|'multi'; videoProfile: 'main'|'high'|null; maxHeight: number|null; maxFps: number|null; crf: number|null; hwCq: number|null; audioKbps: number; bFrames: number; gopSeconds: number; supportsTargetSize: boolean; supportsReels: boolean; copyVideo: boolean }
export const PRESETS: Record<ExportPresetId, PresetDef>
export interface FfmpegPlan { steps: { args: string[]; label: string; outFile: string; passLogPrefix?: string }[]; outputs: string[] }
export interface ArgsInput { preset: PresetDef; encoder: HwEncoder; inputVideo: string; inputAudio: string; hasWebcamTrack: boolean; micTrackIdx: number|null; systemTrackIdx: number|null; audioMode: AudioMode; micOffsetMs: number; trimStartMs: number; trimEndMs: number|null; durationMs: number; srcWidth: number; srcHeight: number; srcFps: number; reels: boolean; targetSizeMB: number|null; outDir: string; baseName: string; twoPassKbps?: number|null }
export function buildFfmpegArgs(i: ArgsInput): FfmpegPlan
  // regras exatas da spec §7.2; sempre '-hide_banner -nostdin -y -progress pipe:1 -nostats'; corte: '-ss S -to E' ANTES de '-i' (re-encode) ou '-c:v copy -avoid_negative_ts make_zero' (cutOnly); áudio: filtro amix/adelay conforme audioMode/micOffset; '-movflags +faststart'; separate: 4–6 steps (tela.mp4, webcam.mp4, mic.wav, sistema.wav, combinado.mkv)
export function estimateOutputMB(preset: PresetDef, durationMs: number, srcHeight: number, srcFps: number, measuredKbps?: number|null): number   // por tabela de kbps típicos por altura (720p:1500(small)/… ) — usar: small 1400 kbps@720p; high: 1080p30 9000, 1080p60 12000, 1440p 16000, 720p 5000; max: ×1.6; cutOnly: measuredKbps ?? 5000; + áudio
export function targetVideoKbps(targetMB: number, durationMs: number, audioKbps: number): number  // MB×8192×0.97/s − audio
export function planForTarget(targetMB: number, durationMs: number, audioKbps: number, srcHeight: number): { kbps: number; height: number; warn: 'document'|null }  // <700 kbps→480; <350 → warn 'document'
export function estimateLiveMB(bytesWritten: number, elapsedMs: number, totalMs?: number): { mbSoFar: number; kbps: number }
```
- [ ] Testes por snapshot inline (arrays esperados) para: small com libx264 e alvo 64 MB (2 passes), high com nvenc, max com qsv e reels, cutOnly, separate; audioMode micOnly/systemOnly/separate/mix; micOffset ±; `planForTarget` casos. Commit `feat(shared): presets e argumentos ffmpeg`.

### Task A5: Contrato IPC

**Files:** Create `src/shared/ipc.ts`

**Interfaces:** um único tipo `IpcApi` que preload implementa e main atende. Canais (invoke) `sources:list`, `capture:select`, `session:create|writeOpen|write|writeClose|save|get|list|delete|openFolder|revealFile|estimateFreeSpace`, `recording:setPhase|command`(renderer→main para bar/tray) , `overlay:show|hide|setMode|broadcastStrokes`, `bar:update`, `export:run|cancel|probeEncoders|reviewAssets|openOutput`, `settings:get|set|pickFolder`, `update:check|download|install|status`, `app:info|openExternal|copyText|quit|showWindow`, `hotkeys:apply|status`; eventos (main→renderer, `on*`): `recording:command`(RecorderCommand), `overlay:stroke`(Stroke parcial/final), `overlay:mode`, `bar:state`, `export:progress`, `update:status`, `hotkeys:status`, `devices:changed`.
```ts
export interface BarState { phase: RecorderPhase; elapsedMs: number; bytes: number; micMuted: boolean; camOn: boolean; hasCam: boolean; hasMic: boolean; annotating: boolean }
export interface ExportProgress { jobId: string; stage: 'compose'|'encode'|'pass1'|'pass2'|'assets'|'done'|'error'|'cancelled'; percent: number; message?: string; outputs?: string[]; error?: string }
export interface UpdateStatus { state: 'idle'|'checking'|'available'|'not-available'|'downloading'|'downloaded'|'error'; version?: string; notes?: string; percent?: number; error?: string }
export interface HotkeyStatus { action: HotkeyAction; accelerator: string|null; registered: boolean; problems: string[] }
export interface OverlayStrokeEvent { displayId: string; stroke: Stroke; final: boolean }
export interface ReviewAssets { proxy: string; webcam: string|null; thumbs: string[]; waveform: string|null; keyframesSec: number[] }
```
- [ ] Escrever `ipc.ts` com `IpcApi` completo (assinaturas com Promise) e `IPC = { … } as const` de nomes. Sem testes (tipos). Commit `feat(shared): contrato IPC`.

## Track B — Processo principal

### Task B1: settingsStore, log e sessionStore

**Files:** Create `src/main/log.ts`, `src/main/settings/settingsStore.ts`, `src/main/session/sessionStore.ts`, `src/main/session/sessionStore.test.ts` (usa pasta temp; roda em vitest com `electron` mockado via `vi.mock('electron', …)` fornecendo `app.getPath`)

**Interfaces:**
```ts
export const log = electronLog (arquivo em userData/logs/main.log, rotação 5 MB, console em dev)
export function getSettings(): Settings; export function setSettings(patch: Partial<Settings>): Settings; export function onSettingsChange(cb:(s:Settings)=>void): () => void; export function outputDir(): string; export function rawDir(): string
export class SessionStore {
  constructor(rawRoot: () => string)
  create(config: RecordingConfig, sessionId: string): { dir: string; session: Session }   // cria pasta, session.json inicial (state 'recording')
  openWrite(sessionId: string, name: string): number; write(handle: number, data: Uint8Array, position: number): void; closeWrite(handle: number): void
  save(session: Session): void          // escrita atômica (tmp + rename)
  get(id: string): Session | null; list(): SessionSummary[]   // {id, createdAt, durationMs, bytes, state, hasWebcam, thumb?}
  delete(id: string): Promise<void>     // shell.trashItem na pasta
  findUnfinished(): Session[]           // state==='recording' (para recuperação)
  freeSpaceMB(): Promise<number>        // fs.statfs do volume da rawDir
  cleanupOld(days: number): number
}
```
- [ ] Testes: create → pasta e json; write posicional em 2 posições e leitura confere; save atômico sobrescreve; list ordena por data desc; findUnfinished. Commit `feat(main): settings, log e sessionStore`.

### Task B2: fontes de captura e handler de getDisplayMedia

**Files:** Create `src/main/capture/sources.ts`, `src/main/capture/displayMediaHandler.ts`

**Interfaces:**
```ts
export async function listSources(): Promise<{ displays: DisplayInfo[]; screens: CaptureSource[]; windows: CaptureSource[] }>
  // desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{width:320,height:180}, fetchWindowIcons:true}); em erro (issue #51910) refaz com thumbnailSize {0,0}; filtra janelas do próprio app (BrowserWindow.getAllWindows() títulos/ids via getMediaSourceId()); screens ordenados por display index; label 'Monitor 1 (principal) — 1920×1080'
export function selectCaptureSource(sourceId: string, systemAudio: boolean): void   // estado do handler
export function installDisplayMediaHandler(): void  // session.defaultSession.setDisplayMediaRequestHandler((req, cb) => …callback({video: src, audio: req.audioRequested && systemAudio ? 'loopback' : undefined}), {useSystemPicker:false}); se fonte sumiu → callback({}) e log
export function displayForSource(src: CaptureSource): DisplayInfo | null   // display_id → display; fallback por índice
```
- [ ] Sem teste unitário (depende do Electron); validado pela Task B7 (script de integração). Commit `feat(main): fontes e handler de captura`.

### Task B3: janelas (gravador, barra, overlays), proteção e estado da gravação

**Files:** Modify `src/main/windows/recorderWindow.ts`; Create `src/main/windows/barWindow.ts`, `src/main/windows/overlayWindows.ts`, `src/main/windows/protection.ts`, `src/main/recording/state.ts`

**Interfaces:**
```ts
// recorderWindow: createRecorderWindow(); getRecorderWindow(); showRecorder(); on close durante gravação → hide + tray balloon 'Gravando em segundo plano' (não destrói); ao sair (app.quit) se gravando → confirmar via dialog
// barWindow: showBar(display: DisplayInfo, state: BarState); hideBar(); updateBar(state: BarState); toggleBar(); posição lembrada em settings (por displayId); janela 440×60, frame:false, transparent:true, alwaysOnTop 'screen-saver', skipTaskbar, resizable:false, focusable:false (setFocusable(true) só enquanto o mouse está sobre? → simples: focusable:false e -webkit-app-region:drag na pílula) — carrega bar.html
// overlayWindows: showOverlays(displays: DisplayInfo[]); hideOverlays(); setOverlayMode(mode: 'idle'|'countdown'|'drawing'|'hidden', payload?: {count?: number; tool?: StrokeTool}); overlays enviam 'overlay:stroke' → main faz broadcast para o recorder ('overlay:stroke'); modo drawing → setIgnoreMouseEvents(false)+setFocusable(true)+focus(); idle → setIgnoreMouseEvents(true,{forward:true})+setFocusable(false); recria overlay em 'display-metrics-changed'
// protection: setProtection(on: boolean) → para todas as janelas do app: win.setOpacity(1); win.setContentProtection(on && settings.protectWindows)
// state.ts: setPhase(phase: RecorderPhase); getPhase(); onPhase(cb); broadcastCommand(cmd: RecorderCommand) → recorderWin.webContents.send('recording:command', cmd); updateBarState(BarState)
```
- [ ] Implementar; teste manual via `npm run dev` + botão temporário? Não: será exercitado pelas Tasks C/D. Commit `feat(main): janelas, proteção e estado`.

### Task B4: atalhos globais e bandeja

**Files:** Create `src/main/hotkeys/globalShortcuts.ts`, `src/main/tray.ts`, `build/tray.png`, `build/tray-rec.png` (gerados por `scripts/make-icons.mjs` a partir de SVG simples — círculo vermelho/cinza — usando `sharp`? não adicionar sharp; gerar PNGs 16/32 via `nativeImage.createFromDataURL` de um canvas… não há canvas no main. Solução: commitar PNGs gerados uma vez por script Node com a lib `pngjs` (devDependency) desenhando círculo por pixels)

**Interfaces:**
```ts
export function applyHotkeys(map: Record<HotkeyAction,string|null>): HotkeyStatus[]   // unregisterAll; para cada ação: normalizeAccelerator → register(acc, () => dispatch(action)); status registered=false se register()===false; problems via hotkeyProblems
export function dispatch(action: HotkeyAction): void  // mapeia para RecorderCommand e broadcastCommand; 'annotate' só faz efeito se phase recording/paused
export function createTray(): Tray  // menu: Mostrar gravador · Iniciar/Parar (Ctrl+Shift+F9) · Pausar/Retomar · — · Configurações · Verificar atualização · — · Sair; ícone muda com a phase; clique simples → showRecorder()
```
- [ ] Commit `feat(main): atalhos globais e bandeja`.

### Task B5: ffmpeg runner, probe de encoders, assets de revisão e job de exportação

**Files:** Create `src/main/export/ffmpegRunner.ts`, `encoderProbe.ts`, `reviewAssets.ts`, `exportJob.ts`, `ffmpegRunner.test.ts` (parse de progresso), `encoderProbe.test.ts` (ordem por vendor com execFile mockado)

**Interfaces:**
```ts
export interface RunResult { code: number; stderrTail: string; cancelled: boolean }
export function runFfmpeg(args: string[], opts: { onProgress?: (p: {outTimeUs: number; frame?: number; speed?: string}) => void; signal?: AbortSignal; cwd?: string }): Promise<RunResult>  // spawn ffmpegPath(); parse linhas 'out_time_us=' 'frame=' 'speed=' de stdout; guarda últimas 40 linhas de stderr; cancel → kill('SIGKILL') (taskkill /T no Windows: usar child.kill() + tree via 'taskkill /pid /T /F')
export function probeFile(file: string): Promise<{ durationMs: number; streams: {index:number; type:'video'|'audio'; codec:string; width?:number; height?:number; fps?:number; channels?:number}[]; keyframesSec?: number[] }>  // ffprobe -show_streams -show_format; keyframes só sob demanda (probeKeyframes)
export function probeKeyframes(file: string): Promise<number[]>   // ffprobe -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv
export function gpuVendorOrder(gpuInfo: {vendor: string}[]): HwEncoder[]  // NVIDIA: nvenc,qsv,mf,libx264; Intel: qsv,mf,nvenc,libx264; AMD/outros: mf,qsv,nvenc,libx264
export async function probeEncoders(force?: boolean): Promise<EncoderProbe>  // cache em settings.lastEncoderProbe por gpuKey (app.getGPUInfo('basic') vendorIds+driver); teste 'ffmpeg -f lavfi -i color=gray:s=256x256:r=30 -frames:v 8 -c:v X -f null -' com timeout 15 s
export async function buildReviewAssets(session: Session, dir: string, onProgress?: (pct:number)=>void): Promise<ReviewAssets>  // preview.mp4: '-i rec.mp4 -map 0:v:0 -c:v copy' + áudio mixado (amix normalize=0 + alimiter) AAC 128k, '-movflags +faststart'; webcam.mp4: '-map 0:v:1 -c copy -movflags +faststart' se houver; thumbs: fps=1/max(1,dur/40) escala -2:90 → thumbs/%03d.jpg; waveform: showwavespic=s=1600x120:colors=#8b90a0 → wave.png; keyframesSec via probeKeyframes(rec.mp4)
export interface ExportRequest { sessionId: string; options: ExportOptions; composedFile: string | null }  // composedFile = vídeo já composto pelo renderer (ou null)
export function startExportJob(req: ExportRequest, emit: (p: ExportProgress) => void): { jobId: string; cancel: () => void }
  // fluxo: probe → encoder (settings.lastEncoderProbe ?? probeEncoders()) → buildFfmpegArgs (inputVideo = composed ?? rec.mp4, inputAudio = rec.mp4) → se targetSizeMB: estima; se estimativa > alvo → planForTarget → twoPassKbps → steps pass1/pass2 → executa steps sequencialmente com progresso agregado → uniqueName no destino → emit done {outputs}
```
- [ ] Testes: parser de progresso; `gpuVendorOrder`; `buildReviewAssets` args (mock runFfmpeg). Script `scripts/test-ffmpeg.mjs` (integração real, Task B7). Commit `feat(main): ffmpeg runner, probe, assets de revisão e job de exportação`.

### Task B6: auto-update

**Files:** Create `src/main/update/autoUpdater.ts`

**Interfaces:**
```ts
export function initAutoUpdater(opts: { isRecording: () => boolean; onStatus: (s: UpdateStatus) => void }): { check(manual?: boolean): Promise<void>; download(): Promise<void>; install(): void }
// electron-updater: autoUpdater.autoDownload=false; autoInstallOnAppQuit=true; logger=log; eventos → UpdateStatus; check 10 s após ready e a cada 60 min (pula se isRecording()); em dev: se existir dev-app-update.yml e env CIALIGHT_UPDATE_TEST=1, forceDevUpdateConfig=true; install(): se isRecording() → status error 'Termine a gravação antes de atualizar' senão quitAndInstall(true,true); ao 'update-downloaded' → Notification nativa 'CiaLight Gravador X.Y.Z pronto para instalar' (clique → showRecorder)
```
- [ ] Commit `feat(main): auto-update via GitHub Releases`.

### Task B7: ipc.ts (registro), bootstrap e scripts de integração

**Files:** Create `src/main/ipc.ts`; Modify `src/main/index.ts` (single instance lock, `installDisplayMediaHandler`, `createTray`, `applyHotkeys(getSettings().hotkeys)`, `initAutoUpdater`, recuperação: se `sessionStore.findUnfinished()` → envia `recording:recover` com ids ao renderer quando pronto; `app.on('before-quit')` → se gravando pergunta; `powerMonitor.on('shutdown')` → salvar sessão); Modify `src/preload/index.ts` (implementar `IpcApi` completo — remover API do spike ou manter sob `api.spike` só quando `CIALIGHT_SPIKE`); Create `scripts/test-ffmpeg.mjs` (usa `spike-out/rec.mp4` ou gera um sintético com `-f lavfi testsrc2` + `anullsrc` 4 faixas de 12 s; roda `probeEncoders`, exporta cada preset via `startExportJob` importado de `out/main` — como o main é bundle Electron, o script roda o Electron em modo teste: `CIALIGHT_TEST=ffmpeg` → main executa a bateria e sai com código; valida com ffprobe: codec, profile, `movflags` (procura 'moov' antes de 'mdat' lendo os primeiros bytes), duração ≈ trim, tamanho ≤ alvo), Create `scripts/test-capture.mjs` (`CIALIGHT_TEST=capture` → grava 8 s do monitor principal com loopback+mic+câmera se houver, via o mesmo engine da UI (janela do gravador oculta), valida com ffprobe → código de saída).

- [ ] `package.json`: `"test:ffmpeg": "electron-vite build && cross-env CIALIGHT_TEST=ffmpeg electron ."`, `"test:capture": "electron-vite build && cross-env CIALIGHT_TEST=capture electron ."`. Rodar ambos → PASS. Commit `feat(main): IPC, bootstrap e testes de integração`.

## Track C — Engine de gravação (renderer)

### Task C1: suporte a encoders e engine mediabunny

**Files:** Create `src/renderer/src/engine/encoderSupport.ts`, `src/renderer/src/engine/RecordingEngine.ts`, `src/renderer/src/engine/sessionRecorder.ts`, `src/renderer/src/engine/fallbackRecorder.ts`, `src/renderer/src/engine/sessionRecorder.test.ts`

**Interfaces:**
```ts
export async function pickVideoConfig(quality: Quality, fps: Fps, srcW: number, srcH: number): Promise<{ width: number; height: number; fps: number; bitrate: number; fullCodecString: string; hardware: boolean; downgraded: boolean }>
  // dimensões alvo (native = src); nível: ≤1080p60 'avc1.640028'(4.0)/'avc1.64002A'(4.2 p/ 1080p60), 1440p → 'avc1.640032'(5.0), 4K → 'avc1.640033'; isConfigSupported prefer-hardware → hardware; se unsupported → tenta no-preference; se ainda unsupported e quality 1440p → downgrade 1080p (downgraded=true)
export type EngineEvent = { type:'phase'; phase: RecorderPhase } | { type:'bytes'; bytes:number; elapsedMs:number } | { type:'warning'; message:string } | { type:'error'; message:string } | { type:'fallback' } | { type:'level'; mic:number; system:number }
export class RecordingEngine extends EventTarget {
  constructor(api: IpcApi)
  async prepare(config: RecordingConfig): Promise<{ screen: MediaStream; cam: MediaStream|null; mic: MediaStream|null; video: {width:number;height:number;fps:number} }>  // abre streams (getDisplayMedia com constraints por pickVideoConfig; cam; mic separado), cria session via api.session.create, NÃO inicia encoders — usado durante a contagem
  async start(): Promise<void>       // cria Output mediabunny (StreamTarget → api.session.write), fontes, addTracks, output.start(); MediaClock.start; sessionRecorder.begin
  pause(): void; resume(): void      // source.pause()/resume() em todas; MediaClock; session.pauses
  setMicMuted(m: boolean): void; setCameraOn(on: boolean): void   // track.enabled
  addPipKeyframe(k: Omit<PipKeyframe,'tMs'>): void; addStroke(s: Omit<Stroke,'tMs'>): void; updateStroke(s: Stroke): void; clearStrokes(): void; addMarker(): void
  mediaTimeMs(): number
  async stop(): Promise<Session>     // finalize, close write, stop tracks, session.state='stopped', durationMs, save → Session
  async cancel(): Promise<void>      // finalize best-effort, api.session.delete
  get session(): Session; get streams()
}
// sessionRecorder.ts: classe pura SessionRecorder(session: Session, clock: MediaClock) com os métodos addPipKeyframe/addStroke/updateStroke/clearStrokes/addMarker/recordPause/toJSON e autosave (throttle 5 s) via callback
// fallbackRecorder.ts: FallbackRecorder(streams, api, sessionId) → MediaRecorder por stream ('video/mp4;codecs=avc1.42E01E,mp4a.40.2' ou 'video/webm;codecs=vp9,opus' se não suportado), timeslice 1000, escreve rec-fallback-<track>.mp4 sequencialmente; usado se erros fatais das fontes mediabunny (errorPromise) antes de 3 s ou se pickVideoConfig falhar; session.engine='mediarecorder'; no stop grava files.rec = 'rec-fallback-screen.mp4' e demais em files (extensão do Session.files p/ fallback: {webcamFile?, micFile?, systemFile?}) → o export usa remux ffmpeg (-i cada arquivo → rec.mp4 com 4 faixas -c copy) antes de tudo (função `normalizeFallbackSession` no exportJob)
```
- [ ] Testes de `sessionRecorder` (keyframes com tMs do relógio, pausas registradas, clear, autosave throttle com timers fake). Engine validado por `test:capture` (Task B7) — rodar agora que o engine existe: `npm run test:capture` → PASS (4 faixas, durações). Commit `feat(engine): gravação mediabunny com fallback`.

## Track D — UI do gravador

### Task D1: base de UI (tema, componentes, store, App shell)

**Files:** Create `src/renderer/src/components/ui/{Button,IconButton,Toggle,Select,Slider,Dialog,Tooltip,Progress,Kbd,VuMeter,EmptyState,Badge,Segmented}.tsx`, `src/renderer/src/lib/cn.ts`, `src/renderer/src/app/store.ts`, `src/renderer/src/app/App.tsx`, `src/renderer/src/app/Titlebar.tsx`; Modify `styles.css` (tokens do tema, scrollbars, focus ring), `main.tsx`.

**Interfaces:** `useAppStore` (zustand): `screen: 'prepare'|'recording'|'review'|'settings'|'history'`, `settings`, `sources`, `devices`, `config` (RecordingConfig em edição), `engine` (instância), `session` (em revisão), `phase`, `barState`, `updateStatus`, `hotkeyStatus`, actions. Componentes Radix estilizados no tema escuro (spec §8). `App` renderiza `Titlebar` (logo, nome, botões Histórico/Configurações, chip de update) + tela atual + `Toaster` (sonner). Usar a skill `frontend-design` ao implementar telas: visual "estúdio" escuro, acentos vermelho-coral, tipografia Inter, ícones lucide, sem aparência genérica.
- [ ] Commit `feat(ui): base de componentes, tema e shell`.

### Task D2: tela Preparar

**Files:** Create `src/renderer/src/screens/Prepare/{PrepareScreen,SourcePicker,SourceCard,DevicePanel,QualityPicker,PreviewStage,PipOverlay}.tsx`, `src/renderer/src/hooks/{useSources,useDevices,useVu,useCameraPreview}.ts`

Comportamento (spec §4.1 e §8): SourcePicker (abas Monitores | Janelas, cards com miniatura/nome/ícone, busca, refresh a cada 2 s enquanto visível, seleciona `settings.lastSource` se ainda existir, senão monitor principal); dica para "aba do navegador" (tooltip: "Arraste a aba para uma janela própria e selecione essa janela"); PreviewStage 16:9 com a miniatura da fonte (atualizada a 1 fps via `sources:list` só da fonte selecionada — adicionar `sources:thumbnail(id)` ao IPC) e `PipOverlay` arrastável/redimensionável (react pointer events; mantém proporção 1:1 no círculo e 16:9 no retângulo; alças; botão de forma; espelho) escrevendo em `config.pipInitial` e `settings.pip`; DevicePanel: câmera (Select + preview `<video>` circular + Toggle), microfone (Select + `VuMeter` via `useVu(stream)` AnalyserNode + Toggle + Segmented "Headset | Caixas de som" → echoCancellation), áudio do sistema (Toggle), QualityPicker (Segmented 720p/1080p/1440p/Nativa · 30/60 fps · contagem 0/3/5), botão **Gravar** (grande, `Kbd Ctrl+Shift+F9`); pré-checagens antes de gravar (`session:estimateFreeSpace` ≥ 2048 MB; dispositivos presentes; se `pickVideoConfig` degradou → toast); erros de permissão (`NotAllowedError`) → Dialog com botão "Abrir configurações de privacidade" (`app:openExternal('ms-settings:privacy-webcam')`).
- [ ] Commit `feat(ui): tela Preparar`.

### Task D3: fluxo Gravando (recorder + barra + overlay)

**Files:** Create `src/renderer/src/screens/Recording/{RecordingScreen,LivePreview,LiveControls,Timer}.tsx`, `src/renderer/src/app/recordingController.ts`, `src/renderer/src/bar/BarApp.tsx` (+ `bar.tsx` entry), `src/renderer/src/overlay/{OverlayApp,Countdown,DrawSurface,RecBorder}.tsx` (+ `overlay.tsx` entry)

Comportamento (spec §4.2, §3.2, §8):
- `recordingController.start()`: `api.capture.select(source, systemAudio)`; `engine.prepare(config)`; `api.recording.setPhase('countdown')` (main: proteção ON, overlays show no display da fonte com `Countdown` N…1 e som opcional; barra ainda oculta); ao terminar contagem: `engine.start()`, `setPhase('recording')` (main: barra aparece no display gravado, borda "gravando", tray vermelho). Se contagem = 0, direto.
- `RecordingScreen`: `LivePreview` = `<video>` da tela (`srcObject`) + `<video>` da câmera com máscara CSS + `PipOverlay` (mesmo componente do Preparar, agora emitindo `engine.addPipKeyframe`) + traços espelhados (canvas usando `visibleStrokesAt` a 30 fps enquanto há traços); `LiveControls`: Timer grande, estimativa de tamanho (`estimateLiveMB`), VUs, botões Pausar/Retomar (F10), Parar (F9), Cancelar (F11, Dialog), Anotar (F5), Mute mic (F1), Câmera (F2), forma/espelho da PiP.
- Comandos vindos de main (`recording:command`) → controller (toggleRecord/pause/resume/stop/cancel/restart/muteMic/toggleCamera/cyclePip/annotate/arrow/clearAnnotations). `restart` = cancel + start com mesma config.
- Estado para a barra: controller envia `bar:update` a cada 500 ms com `BarState`.
- `BarApp`: pílula translúcida arrastável (`-webkit-app-region: drag`, botões `no-drag`): ● timer · Pausar/Retomar · Parar · mic · câmera · anotar · PiP (cicla 4 cantos × 3 tamanhos: `cyclePip`) · mostrar gravador; tooltips com atalhos; envia `recording:command`.
- `OverlayApp`: modo `countdown` (número gigante, sem fundo, com fade); `idle` (só `RecBorder` 3 px vermelho, pulsa amarelo em paused; toast pequeno "Pausado"/"Gravando"); `drawing` (cursor crosshair, paleta mínima no canto superior: cor R/G/B/Y, espessura, ferramenta, "E apaga", "Esc sai"; `DrawSurface` canvas full-screen: pointerdown/move/up → Stroke em coordenadas normalizadas (clientX/width, clientY/height) com pontos `tMs` recebidos do main? → **o relógio de mídia vive no recorder**; a overlay carimba `performance.now()` e o main repassa; o recorder converte para tMs de mídia usando a diferença de relógio (`t_media = clock.mediaTimeMs(now)`; latência de IPC < 20 ms aceitável). Ferramentas: arrasto = caneta; Shift = linha; Ctrl+Shift = seta; teclas R/G/B/Y; `[`/`]`; Ctrl+Z (envia `overlay:undo` → recorder marca `erasedAtMs`); E (clear); Esc (sai do modo). Traços persistem desenhados na overlay até clear/undo/auto-fade (settings) — a overlay mantém sua cópia local para renderizar; o recorder é a fonte de verdade para o session.json.
- Parar: `engine.stop()` → `setPhase('stopping')` (proteção OFF, overlays/barra somem, tray normal) → `api.export.reviewAssets(sessionId)` em background → tela Revisão.
- [ ] Testar manualmente com `npm run dev`: gravar 20 s com pausa, mute, anotações, PiP movida; abrir `rec.mp4` no player; conferir `session.json`. Commit `feat(ui): gravação, barra flutuante e overlay de anotações`.

### Task D4: exportação — compositor no Worker + tela Revisão + Histórico

**Files:** Create `src/renderer/src/export/exportComposer.worker.ts`, `src/renderer/src/export/exportComposer.ts`, `src/renderer/src/screens/Review/{ReviewScreen,ReviewPlayer,Timeline,TrimHandles,PresetCards,ExportOptionsPanel,ExportProgress,ExportDone}.tsx`, `src/renderer/src/screens/History/HistoryScreen.tsx`, `src/renderer/src/export/exportComposer.test.ts` (lógica de CFR/loop de frames com sinks fake)

**Interfaces:**
```ts
// exportComposer.ts (cliente)
export async function composeSession(args: { sessionId: string; recPath: string; session: Session; options: ExportOptions; fps: number; width: number; height: number; onProgress: (pct: number) => void; signal: AbortSignal }): Promise<string /* caminho composed.mp4 */>
// worker: mediabunny Input(new FilePathTarget? não — no renderer usar `BlobSource`(File) via api que devolve um File handle? → usar `UrlSource`? → simples e robusto: main expõe 'session:readFile' streaming? → escolha: worker recebe um `FileSystemFileHandle`? Não disponível.
// DECISÃO: o renderer lê o rec.mp4 via fetch de URL customizada `cialight-file://<sessionId>/rec.mp4` registrada no main com protocol.handle (streaming, suporta Range) → mediabunny `UrlSource`. Registrar `protocol.registerSchemesAsPrivileged([{scheme:'cialight-file', privileges:{stream:true, supportFetchAPI:true, bypassCSP:true}}])` antes do ready. O mesmo protocolo serve o `<video>` da revisão (preview.mp4/webcam.mp4) e as miniaturas.
// Loop: VideoSampleSink(v0) e (v1); para t em [trimStart, trimEnd) a passo 1/fps: pega o último sample de tela com timestamp ≤ t (mantém último), idem cam; drawFrame no OffscreenCanvas(W,H); VideoFrame(canvas,{timestamp:t_us, duration}); encoder (mediabunny Output composed.mp4 fMP4 com CanvasSource? → usar `VideoSampleSource` com `VideoSample` a partir do canvas: `new VideoSample(canvas,{timestamp,duration})` e `source.add(sample)`), bitrate 20e6, keyFrameInterval 2, latencyMode 'quality', hardware no-preference; backpressure: `await source.add()` (mediabunny já aplica); progresso por t; escrita via StreamTarget → api.session.write (composed.mp4 na pasta da sessão)
```
Tela Revisão (spec §4.3): `ReviewPlayer` (`<video src="cialight-file://…/preview.mp4">` + `<video>` webcam sincronizado por `currentTime` a cada `timeupdate`/rAF + canvas overlay com `drawFrame` — usar `includeWebcam/includeAnnotations/pipOverride` das opções → **paridade com export**), `Timeline` (thumbs, waveform, playhead, alças de corte com atalhos I/O, marcadores), `PresetCards` (5 presets, estimativa `estimateOutputMB` com kbps medido da sessão), `ExportOptionsPanel` (incluir webcam, PiP editável — arrastar no player quando pausado gera `pipOverride` = keyframe único; anotações; áudio mix/só mic/só sistema/separado(só preset separado); offset do mic; alvo 64/20 MB (small); Reels (high); nome; pasta), `ExportProgress` (composição → encode, cancelar), `ExportDone` (Abrir pasta, Copiar arquivo (`app:copyFile` → clipboard `writeBuffer('FileNameW')`? Windows: `clipboard.writeBuffer('FileNameW', …)` funciona no Electron para copiar arquivo — implementar `app:copyFilePath` que copia CF_HDROP via `clipboard.writeBuffer('FileNameW', Buffer.from(path+'\0','ucs2'))`), Reexportar, Nova gravação, Excluir bruto). Histórico: lista `session:list` (miniatura = thumbs/001.jpg), abrir na Revisão / excluir / abrir pasta; recuperação: ao receber `recording:recover` → Dialog "Encontrei uma gravação interrompida (data, duração aprox.) — Recuperar / Excluir".
- [ ] `test:ffmpeg` continua verde; teste manual: exportar cada preset de uma sessão real com webcam + traços; conferir tamanho e reprodução; `Só cortar`; `separado`. Commit `feat(ui): revisão, exportação e histórico`.

### Task D5: Configurações e Sobre/Atualização

**Files:** Create `src/renderer/src/screens/Settings/{SettingsScreen,GeneralTab,DevicesTab,HotkeysTab,HotkeyRecorder,AnnotationsTab,AdvancedTab,UpdateTab}.tsx`, `src/renderer/src/app/UpdateBanner.tsx`

Comportamento (spec §8): abas; `HotkeyRecorder` (campo que captura combinação via keydown, normaliza, mostra `hotkeyProblems`, conflito de duplicados, `hotkeys:apply` → status `registered`); Avançado: proteção da UI (toggle + explicação RustDesk/RDP), encoder detectado + "Testar de novo" (`export:probeEncoders(force)`), pasta de brutos/saída (`settings:pickFolder`), retenção, "Abrir pasta de logs"; Atualização: versão atual, "Verificar agora", status/progresso, notas, licenças (FFmpeg GPL — link para fonte e LICENSE.txt embutido; Electron; mediabunny; Radix; lucide). `UpdateBanner` no topo do App: "Nova versão X.Y.Z disponível — Baixar (N MB)" → progresso → "Reiniciar e atualizar" (desabilitado durante gravação com tooltip).
- [ ] Commit `feat(ui): configurações, atualização e sobre`.

## Track E — Empacotamento, CI e release

### Task E1: electron-builder, ícones, ffmpeg no pacote, README de instalação

**Files:** Modify `package.json` (bloco `build`), Create `build/icon.ico` (+ `build/icon.png` 256/512 e `build/tray*.png` via `scripts/make-icons.mjs` — desenhar logotipo simples: círculo vermelho-coral com "C" branco; usar `pngjs` + `png-to-ico`), `docs/instalacao.md`, `README.md` (atualizar), `.github/workflows/ci.yml`, `.github/workflows/release.yml`

`build`: `appId`, `productName`, `directories {output:'release', buildResources:'build'}`, `asar:true`, `files:['!docs/**','!scripts/**','!src/**','!build/**','!spike-out/**','!*.md']`, `extraResources:[{from:'resources/ffmpeg', to:'ffmpeg', filter:['ffmpeg.exe','ffprobe.exe','LICENSE.txt']}]`, `win:{target:[{target:'nsis',arch:['x64']}], artifactName:'CiaLightGravador-Setup-${version}.${ext}', icon:'build/icon.ico'}`, `nsis:{oneClick:true, perMachine:false, createDesktopShortcut:true, createStartMenuShortcut:true, shortcutName:'CiaLight Gravador', deleteAppDataOnUninstall:false}`, `publish:[{provider:'github', owner:'cialightiluminacao', repo:'cialight-gravador', releaseType:'release'}]`. Avaliar build `shared` do BtbN se o instalador passar de ~180 MB (ffmpeg+ffprobe estáticos ≈ 2×144 MB; alternativa: remover ffprobe do pacote e usar mediabunny para probe — decidir pelo tamanho medido).
- [ ] `npm run dist:win` → `release/CiaLightGravador-Setup-0.1.0.exe` + `.blockmap` + `latest.yml`; instalar nesta máquina; abrir; gravar 10 s; exportar; verificar `%LOCALAPPDATA%\Programs\CiaLight Gravador`. Commit `build: empacotamento NSIS + CI`.

### Task E2: repositório GitHub, releases e teste de auto-update

- [ ] `gh repo create cialightiluminacao/cialight-gravador --public --source . --push`; criar release `deps-ffmpeg-n8.1.2` com o zip do BtbN como asset (`gh release create deps-ffmpeg-n8.1.2 <zip> --title "Dependência: ffmpeg n8.1.2 (BtbN)" --notes "Espelho do build pinado"`); confirmar `ci.yml` verde.
- [ ] `npm version 1.0.0 -m "release: v%s"` → tag → `release.yml` publica; baixar o instalador da release, instalar em cima, abrir → verificar que não há update. Depois `npm version patch` (1.0.1, mudança visível: texto do Sobre) → o app 1.0.0 instalado deve mostrar banner, baixar e instalar (`quitAndInstall`), abrir 1.0.1. Registrar evidências (screenshots) em `docs/qa/2026-08-XX-release-1.0.md`.
- [ ] Atualizar memória do projeto (arquivo em `~/.claude/projects/.../memory/project_cialight_gravador.md`).

## Self-review (feito ao escrever)
- Cobertura da spec: §3 (A5,B3,B7,D1), §4.1 (D2), §4.2 (C1,D3), §4.3 (B5,D4), §4.4 (B1,B7,D4), §5 (A1), §6 (C1), §7 (A3,A4,B5,D4), §8 (D1–D5), §9 (B6,E1,E2), §10 (B1,B5,C1,D2,D3), §11 (testes em cada task + B7), §12 (ordem A→B→C→D→E).
- Consistência de nomes: `pipRectAt`, `visibleStrokesAt`, `drawFrame`, `buildFfmpegArgs`, `estimateOutputMB`, `planForTarget`, `estimateLiveMB`, `RecordingEngine.{prepare,start,pause,resume,stop,cancel,addPipKeyframe,addStroke,clearStrokes}`, `startExportJob`, `buildReviewAssets`, `probeEncoders`, `applyHotkeys`, `setProtection`, `setPhase`, `BarState`, `ExportProgress`, `UpdateStatus` — usados com os mesmos nomes nas tasks seguintes.
