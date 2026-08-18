# Guia de UI e APIs do renderer — CiaLight Gravador

Leia antes de implementar qualquer tela. Tudo em **português do Brasil** (com acentos), sem placeholders.

## Direção visual ("sala de controle")
- Tema escuro grafite: fundo `bg` #0b0d12 (com vinheta/grão via classe `app-bg`, já aplicada no shell), superfícies `surface` #141823 → `surface-2` #1b202d → `surface-3` #232937, bordas hairline `border` / `border-strong`.
- Texto `fg` #eceae4 (quente), `fg-2`, `muted` #8a8f9e, `muted-2`.
- **Um** acento quente: `accent` #ff4d4f (coral) para gravar/primário; `ok` #3ddc97, `warn` #f5b301, `info` #7aa2ff, `danger`.
- Fontes: `Manrope Variable` (UI, `font-sans`, já padrão no body) e `Azeret Mono Variable` para números/timer/atalhos (classes `font-mono tnum`). **Não** use Inter/Roboto/Arial.
- Cartões: classe `card` (gradiente sutil no topo, borda, sombra, raio 14 px). Seções com título em caps pequenas: `<Section title="…">`.
- Motion: entradas com `rise-in` (+ `rise-in-1..4` para escalonar), botão de gravar com `rec-pulse` quando gravando, transições curtas (150 ms). Nada de animação gratuita.
- Composição: layouts assimétricos e generosos; o preview 16:9 é o protagonista; controles em "pílulas" e cartões; ícones `lucide-react` (h-4 w-4 na maioria; 3.5 em botões sm).
- Densidade: telas cabem em 1180×760 sem rolagem principal (rolagem só em listas). Estados vazios com `<EmptyState>` e ação sugerida. Toda ação principal mostra o atalho (`<Kbd>`/`Tip shortcut=`).

## Cores no Tailwind (v4, tokens já mapeados)
`bg-bg bg-bg-2 bg-surface bg-surface-2 bg-surface-3 border-border border-border-strong text-fg text-fg-2 text-muted text-muted-2 bg-accent text-accent text-accent-2 bg-ok text-ok bg-warn text-warn bg-info text-info bg-danger text-danger` (+ opacidades `bg-accent/15` etc.).

## Componentes prontos (`@/components/ui`)
- `Button` (`variant`: primary | secondary | ghost | outline | danger | success; `size`: sm | md | lg | xl).
- `primitives.tsx`: `Toggle`, `Tip` (tooltip; `shortcut` mostra Kbd), `Kbd`, `Progress` (`tone`), `Slider`, `Segmented` (grupo de opções), `Select` (`options: {value,label,hint?}`), `Dialog`/`DialogContent` (`title, description, footer, hideClose`), `Tabs/TabsList/TabsTrigger/TabsContent`, `Badge` (`tone`), `EmptyState`, `VuMeter` (`level` 0–1), `RecDot`, `Section`.
- Utilitários: `cn` (`@/lib/cn`), `formatClock(ms)`, `formatTimecode(ms)`, `formatMB`, `formatBytes`, `formatDate` (`@/lib/format`).
- Toasts: `import { toast } from 'sonner'` (já montado no App).

## Estado e controle
- `useAppStore` (`@/app/store`): `screen`, `settings`, `settingsLoaded`, `appInfo`, `sources` (`{displays, screens, windows}`), `sourcesLoading`, `selectedSource`, `devices` (`{cameras, mics, ready}`), `pipDraft` (PipKeyframe), `phase`, `live` (`{elapsedMs, bytes, micMuted, camOn, annotating, micLevel, systemLevel}`), `warnings`, `reviewSession`, `hotkeyStatus`, `updateStatus`, `recoverable`; ações `setScreen`, `goBack`, `setSettings`, `setSelectedSource`, `setPipDraft`, `setReviewSession`…
- Persistir configurações: `await window.api.settings.set(patch)` (o main devolve o objeto completo e emite `settings:changed`, que o App já aplica no store). Para preview otimista, chame também `setSettings` local.
- `buildRecordingConfig(state)` monta a `RecordingConfig`.
- Controller (`@/app/recordingController`): `startRecording(config)`, `pauseRecording()`, `resumeRecording()`, `stopRecording()`, `cancelRecording()`, `restartRecording()`, `toggleMic()`, `toggleCamera()`, `setPip(k)`, `cyclePip()`, `toggleAnnotate(tool)`, `setAnnotating(on, tool)`, `clearAnnotations()`, `isAnnotating()`, `engine` (RecordingEngine: `prepared.screen/cam/mic` streams, `mediaTimeMs()`, `visibleStrokes()`, `currentPip`, `session`).
- Hooks: `useSources(active)`, `refreshSources()`, `useDevices()`, `refreshDevices()`, `useVu(stream)`, `useCameraPreview(deviceId, enabled)`, `useMicPreview(deviceId, enabled, echoCancellation)`.
- IPC: `window.api` tipado por `IpcApi` (`src/shared/ipc.ts`). Arquivos da sessão são servidos por `window.api.session.fileUrl(sessionId, 'preview.mp4')` (protocolo `cialight-file://` com Range — use em `<video src>` e `<img src>`; para thumbs use `fileUrl(id, 'thumbs/001.jpg')`).
- Lógica pura compartilhada: `@shared/compositor` (`pipRectAt`, `pipPixelRect`, `clampPip`, `visibleStrokesAt`, `drawFrame`), `@shared/presets/*` (`PRESETS`, `PRESET_ORDER`, `estimateOutputMB`, `planForTarget`, `needsTwoPass`, `estimateLiveMB`), `@shared/hotkeys` (`normalizeAccelerator`, `hotkeyProblems`, `formatAcceleratorLabel`, `findDuplicateHotkeys`), `@shared/defaults` (`DEFAULT_SETTINGS`, `HOTKEY_LABELS`, `QUALITY_PRESETS`, `DEFAULT_PIP`), `@shared/filenames`.

## QA obrigatório
- `npm run typecheck && npm test` sem erros.
- Screenshot real: `npm run build && cross-env CIALIGHT_SHOT="<abs>/test-out/<nome>.png" [CIALIGHT_SCREEN=settings|history|review:<sessionId>] electron .` (sai sozinho) e **abra o PNG** (ferramenta Read) para conferir o visual. Ajuste até ficar excelente: alinhamento, contraste, hierarquia, sem textos cortados, sem overflow em 1180×760 e em 960×640 (a janela mínima; use `CIALIGHT_SHOT_SIZE=960x640` se implementar — opcional).
- Para a Revisão, crie uma sessão sintética: `npm run test:ffmpeg` gera `test-out/raw/test-ffmpeg-session/` (4 faixas, 12 s) — mas com `CIALIGHT_RAW_DIR=test-out/raw`; então rode o screenshot com o mesmo `CIALIGHT_RAW_DIR` e `CIALIGHT_SCREEN=review:test-ffmpeg-session`.
