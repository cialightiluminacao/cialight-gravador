# CiaLight Gravador — Especificação de design (v1.0)

Data: 2026-08-18 · Plataforma: Windows 11 (suporte a Windows 10 22H2 como "melhor esforço") · Base técnica validada em `docs/research/2026-08-18-relatorio-tecnico-validado.md` (41 agentes, 32 afirmações críticas verificadas adversarialmente).

## 1. Objetivo

Aplicativo desktop instalável (`.exe`) para a equipe da Cia Light gravar a tela — um monitor específico ou uma janela específica — com webcam sobreposta (redonda ou retangular, movível durante a gravação e visível apenas no vídeo final e no preview do gravador), áudio do sistema e microfone selecionáveis e independentes, pausa/retomada, anotações na tela por atalho (caneta, seta, apagar), tela de revisão com corte e presets de exportação (WhatsApp/e-mail, YouTube/Drive/Instagram, tutorial interno, edição posterior), e atualização automática via GitHub Releases em todas as máquinas.

Decisões do usuário (18/08/2026): somente Windows; nome **CiaLight Gravador**; projeto em `C:\Users\Eduardo\projetos\cialight-gravador`; repositório **público** `cialightiluminacao/cialight-gravador`; auto-update por GitHub Releases; pós-gravação = tela de revisão simples; pipeline **A** (faixas separadas + composição na exportação); máquinas-alvo Windows 11; WhatsApp usado como **vídeo** (alvo ≤ 64 MB); anotações **ficam até apagar**.

## 2. Decisões técnicas (validadas — ver relatório)

| Tema | Decisão |
|---|---|
| Runtime | Electron **43.x** (Chromium 150) · electron-vite 5 · React 19 · TypeScript · Tailwind v4 · Radix · Zustand · electron-builder **26.15.7** · electron-updater **6.8.9** |
| Captura | `session.setDisplayMediaRequestHandler` (main) + `navigator.mediaDevices.getDisplayMedia` (renderer). Fontes via `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{320,180}, fetchWindowIcons:true})`. Monitor específico por `source.display_id === display.id` (fallback por ordem). |
| Áudio do sistema | `callback({video, audio:'loopback'})` no handler quando o toggle estiver ligado; no renderer `audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, restrictOwnAudio:true}`. **Nunca** pedir microfone na mesma chamada da tela. |
| Microfone / câmera | `getUserMedia` separados com `deviceId:{exact}`; mute por `track.enabled=false`; VU por `AnalyserNode` fora do caminho de gravação. |
| Gravação | WebCodecs (H.264 hardware `avc1.64xxxx`, AAC `mp4a.40.2`; fallback Opus) muxado por **mediabunny** em MP4 fragmentado (`fastStart:'fragmented'`, fragmentos de 1 s, keyframe a cada 1 s) com **4 faixas** (v0 tela, v1 webcam, a0 mic, a1 sistema — só as ativas), streaming para disco via IPC. Fallback: MediaRecorder por faixa (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`, timeslice 1 s). |
| Composição PiP/anotações | **Na exportação** (OffscreenCanvas + WebCodecs em Worker). Preview ao vivo por `<video>` + CSS. |
| Exclusão da UI da captura | `win.setOpacity(1.0)` e depois `win.setContentProtection(true)` em todas as janelas do app durante a gravação; desliga ao parar; opção "não excluir" nas configurações (acesso remoto). |
| Overlay | `BrowserWindow {transparent, frame:false, alwaysOnTop:'screen-saver', skipTaskbar, focusable:false, resizable:false, hasShadow:false}` por monitor gravado + `setIgnoreMouseEvents(true,{forward:true})`; modo desenho = `setIgnoreMouseEvents(false)` + `focus()`. |
| Atalhos | `globalShortcut` (checar retorno de `register`; UI de conflito). Padrões `Ctrl+Shift+F1..F12` (ABNT2-safe). |
| Exportação | ffmpeg embutido (build **BtbN n8.1 win64 gpl**, pinado com sha256) executado via `child_process.spawn` a partir de `process.resourcesPath/ffmpeg/ffmpeg.exe`; detecção de encoder por encode-teste (nvenc → qsv → mf → libx264) com cache por versão de driver. |
| Formato final | MP4 + H.264 High/Main yuv420p + AAC-LC 48 kHz + `-movflags +faststart`. |
| Distribuição | NSIS oneClick per-user; `publish:{provider:'github', owner:'cialightiluminacao', repo:'cialight-gravador', releaseType:'release'}`; GitHub Actions em tag `v*`; **sem assinatura** (SmartScreen na 1ª instalação: "Mais informações → Executar assim mesmo"); updates diferenciais por blockmap. |

## 3. Arquitetura

### 3.1 Processos e janelas

```
main/                         (processo principal)
  windows/   recorderWindow, floatingBar, overlayWindows (uma por display)
  capture/   sources.ts (desktopCapturer + displays), displayMediaHandler.ts
  session/   sessionStore.ts (pasta por gravação, session.json, escrita do rec.mp4 via stream)
  export/    ffmpeg.ts (spawn, progresso, cancel), encoderProbe.ts, presets → args
  update/    autoUpdater.ts
  hotkeys/   globalShortcuts.ts
  settings/  settingsStore.ts (JSON em userData, versionado)
  tray.ts, ipc.ts (contratos tipados em shared/ipc.ts)
preload/     API tipada exposta ao renderer (contextIsolation ON, nodeIntegration OFF)
renderer/    React
  app/       roteamento por estado: Preparar | Gravando | Revisão | Configurações | Histórico
  engine/    RecordingEngine (streams, mediabunny Output, Worker de encode, relógio de mídia, fallback)
  compositor/ (TS puro) keyframes PiP, interpolação, formas, traços → draw(ctx, t)
  export/    ExportComposer (Worker: mediabunny Input → OffscreenCanvas → VideoEncoder → mediabunny Output)
  overlay/   app da overlay (contagem, borda, canvas de desenho)
  bar/       app da barra flutuante
  ui/        componentes (Radix + Tailwind), tema
shared/      tipos (Session, Settings, Preset, IPC), constantes, utilitários puros (mediaClock, sizeEstimate)
```

Três entradas HTML no renderer: `index.html` (gravador), `bar.html` (barra flutuante), `overlay.html` (overlay). Preload único com API por janela.

### 3.2 Janelas

| Janela | Comportamento |
|---|---|
| **Gravador** (1180×760 mín. 960×640, redimensionável) | Estados Preparar/Gravando/Revisão. Hospeda o engine. Fechar durante gravação = esconder para a bandeja (aviso). `backgroundThrottling:false`. Protegida durante a gravação. |
| **Barra flutuante** (≈ 420×56, frameless, alwaysOnTop, arrastável, sem foco por padrão) | Aparece no monitor gravado (canto inferior-centro, posição lembrada). Cronômetro, pausar/retomar, parar, mute mic, câmera on/off, anotar, ciclar posição da PiP, mostrar gravador. Protegida. Ocultável (`Ctrl+Shift+F12`). |
| **Overlay** (uma por monitor gravado; em modo janela, no monitor que contém a janela) | Contagem regressiva 3-2-1 grande + som opcional; borda de 3 px "gravando" (vermelha, pulsa ao pausar → amarela); superfície de desenho no modo anotação; toast de status (pausado/retomado/atalho). Click-through fora do modo anotação. Protegida. |
| **Bandeja** | Ícone (muda quando gravando); menu: mostrar gravador, iniciar/parar, pausar, configurações, verificar atualização, sair. |

### 3.3 Módulos compartilhados-chave

- `compositor/`: `pipRectAt(t)`, `strokesAt(t)`, `drawFrame(ctx, {screenFrame, camFrame, t, layout})`. Coordenadas normalizadas 0–1 relativas ao frame da tela. Usado por preview, player de revisão e exportação → paridade garantida.
- `mediaClock`: `t_media = t_wall − Σ pausas`; fonte única de timestamps para keyframes/traços.
- `presets/`: `buildFfmpegArgs(preset, session, trim, encoder, opts)` — função pura testável.
- `sizeEstimate`: bitrate × duração → estimativa ao vivo (barra) e por preset (revisão).

## 4. Fluxos

### 4.1 Preparar
1. Ao abrir: lista monitores (miniatura, nome, resolução, "principal") e janelas (ícone, título, miniatura; oculta as próprias). Atualiza a cada 2 s enquanto o picker está visível. Busca por título.
2. Painel de dispositivos: câmera (dropdown + preview ao vivo + on/off), microfone (dropdown + VU + on/off + modo "headset/caixas de som"), áudio do sistema (on/off), qualidade (1080p · 1440p · nativa; 30 · 60 fps), contagem (0/3/5 s).
3. Preview grande da fonte selecionada (`getDisplayMedia` só ao iniciar a gravação; no preparar usa a miniatura do `getSources` atualizada a 1 fps para poupar CPU) com a **PiP posicionável** (arrasta/redimensiona, alterna forma, espelho).
4. Pré-checagens ao clicar Gravar: espaço em disco (≥ 2 GB e ≥ 3× estimativa de 10 min), dispositivos ainda presentes, atalhos registrados. Falha → mensagem clara e não inicia.
5. Botão **Gravar** (ou `Ctrl+Shift+F9`) → contagem na overlay → gravação.

### 4.2 Gravando
- Engine sobe streams (tela [+loopback], câmera, mic), inicia mediabunny Output → `rec.mp4` (streaming), inicia `session.json` (gravado a cada 5 s e em cada evento).
- Todas as janelas do app → `setContentProtection(true)`. Barra flutuante e borda aparecem no monitor gravado.
- Preview ao vivo no gravador (tela via `<video>` da track de captura em baixa taxa de repaint; PiP arrastável). Cada interação gera keyframe.
- Pausar: `pause()` em todas as fontes; overlay/borda amarela; cronômetro para; barra mostra "Pausado". Retomar: `resume()`.
- Mute mic / câmera off: `track.enabled=false` (faixa continua, silêncio/preto) — evita renegociação e mantém sincronia. Ícones refletem estado.
- Anotar (`Ctrl+Shift+F5`): overlay entra em modo desenho (cursor caneta). Ferramentas: caneta (arrasto), `Shift`+arrasto linha reta, `Ctrl+Shift`+arrasto seta, `R/G/B/Y` cores (padrão vermelho), `[`/`]` espessura, `Ctrl+Z` desfaz, `E` apaga tudo, `Esc` sai. Cada traço = evento vetorial → session.json e espelhado no preview. Traços persistem até apagar (opção "sumir após N s").
- Parar (`Ctrl+Shift+F9` ou botão): finaliza Output (flush do último fragmento), fecha streams, desliga proteção, fecha overlays/barra, abre Revisão.
- Cancelar (`Ctrl+Shift+F11`, confirmação): descarta sessão (move para lixeira).
- Tamanho estimado ao vivo na barra e no gravador (bitrate real médio × duração).

### 4.3 Revisão
1. Gera **proxy de revisão** em background (ffmpeg: `-map 0:v:0 -c:v copy` + áudio mixado AAC → `preview.mp4`, segundos) e `webcam.mp4` (cópia) para o player; enquanto isso mostra o primeiro frame.
2. Player: `<video>` do proxy + `<video>` da webcam sincronizado por `currentTime` + canvas com PiP/traços do compositor. Timeline com miniaturas (ffmpeg `fps=1/N`) e forma de onda (`showwavespic`), alças de corte início/fim, atalhos I/O, play/pause espaço.
3. Painel: cards de preset com **tamanho estimado**; opções: incluir webcam (on/off), forma/posição da PiP (editável — reposicionar depois), incluir anotações, áudio (mixar | só mic | só sistema | separado no preset de edição), offset do mic (±500 ms), nome do arquivo, pasta de saída (padrão `Vídeos\CiaLight Gravador`), Reels 9:16 (só preset Alta).
4. Exportar → progresso (composição + ffmpeg, cancelável) → concluído: **Abrir pasta · Copiar arquivo · Reexportar · Nova gravação · Excluir gravação bruta**.
5. Histórico: lista de sessões brutas (data, duração, tamanho, miniatura) → reabrir na Revisão / excluir / abrir pasta. Limpeza automática opcional (N dias).

### 4.4 Recuperação
Ao iniciar, se existir sessão bruta com `session.json.state !== 'finalized'`: oferecer "Recuperar" (abre na Revisão; o fMP4 é reproduzível até o último fragmento; ffmpeg remux com `-c copy` corrige índices) ou "Excluir".

## 5. Modelo de dados

### 5.1 `session.json` (v1)
```ts
interface Session {
  version: 1
  id: string                       // 2026-08-18T14-32-05
  createdAt: string
  state: 'recording' | 'stopped' | 'finalized' | 'aborted'
  source: { kind:'screen'|'window', id:string, name:string, displayId?:string, bounds:{x,y,width,height}, scaleFactor:number }
  video: { width:number, height:number, fps:number, codec:string, bitrate:number }
  webcam?: { deviceId:string, label:string, width:number, height:number, mirrored:boolean }
  mic?: { deviceId:string, label:string, echoCancellation:boolean, noiseSuppression:boolean, autoGainControl:boolean }
  systemAudio: boolean
  tracks: { screen:0, webcam?:1, mic?:0, system?:1 }   // índices no rec.mp4 (v:N / a:N)
  durationMs?: number              // tempo de mídia total
  pauses: { startMs:number, endMs:number }[]            // em tempo real (wall) relativo ao início
  pip: { tMs:number, x:number, y:number, w:number, h:number, shape:'circle'|'rounded', visible:boolean }[]  // normalizados
  strokes: { id:string, tMs:number, tool:'pen'|'line'|'arrow', points:{x:number,y:number}[], color:string, width:number, erasedAtMs?:number }[]
  clearEvents: { tMs:number }[]
  markers: { tMs:number, label?:string }[]
  engine: 'webcodecs' | 'mediarecorder'
  files: { rec:'rec.mp4', proxy?:'preview.mp4', webcam?:'webcam.mp4' }
}
```
Pasta: `%USERPROFILE%\Videos\CiaLight Gravador\Brutos\<id>\` (configurável).

### 5.2 `settings.json` (v1, em `app.getPath('userData')`)
Dispositivos padrão (ids + labels), toggles padrão, qualidade, contagem, som de início, PiP padrão (posição/tamanho/forma/espelho), atalhos, pasta de saída/brutos, protecção da UI (on/off), realce de cliques (on/off), anotações (cor, espessura, auto-sumir), retenção de brutos, canal de update, telemetria local de erros (arquivo de log). Migração por `SETTINGS_VERSION`.

## 6. Engine de gravação (renderer)

1. **Streams**: `getDisplayMedia({video:{width:{ideal},height:{ideal},frameRate:{ideal:30|60}}, audio: systemOn ? {...} : false})`; `getUserMedia({video:{deviceId:{exact}, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30}}})`; `getUserMedia({audio:{deviceId:{exact}, echoCancellation, noiseSuppression, autoGainControl}})`. Ler `track.getSettings()` para dimensões reais.
2. **Muxer**: `new Output({format: new Mp4OutputFormat({fastStart:'fragmented', minimumFragmentDuration:1}), target: new StreamTarget(writable)})`; `writable` encaminha chunks (`{data, position}`) ao main por IPC (`session:write`), que grava com `fs.write` posicional em `rec.mp4` (fMP4 fragmentado escreve sequencialmente; suporte a `position` mantido por segurança).
3. **Fontes**: `MediaStreamVideoTrackSource(track, {codec:'avc', bitrate, latencyMode:'realtime', keyFrameInterval:1, hardwareAcceleration:'no-preference'})` para tela e webcam; `MediaStreamAudioTrackSource(track, {codec:'aac', bitrate:160e3})` para mic e sistema; se `AudioEncoder.isConfigSupported(aac)` falhar → `opus`. Perfil H.264 High; se `isConfigSupported` falhar → Baseline.
4. **Backpressure/watchdog**: monitorar `encodeQueueSize` e erros dos encoders (mediabunny expõe erros via promessas/`onerror`); em erro fatal → fechar Output gracioso e trocar para MediaRecorder por faixa (`rec-fallback-*.mp4`), registrando `engine:'mediarecorder'` e continuando o relógio.
5. **Pausa**: `source.pause()` / `source.resume()` em todas as fontes (validado no spike). Relógio de mídia no renderer.
6. **Sincronia**: um único Output → faixas sincronizadas pela biblioteca. Offset do mic ajustável na revisão.
7. **Estimativa ao vivo**: bytes escritos / tempo.
8. **Encerramento**: `output.finalize()`; esperar confirmação de escrita; `session.state='stopped'`.

Requisitos de spike (fase 0) antes de qualquer UI: (a) janela com `setContentProtection(true)` não aparece no stream do `getDisplayMedia` nem no thumbnail; (b) `audio:'loopback'` entrega áudio do sistema com `getSettings()` mostrando EC/NS/AGC desligados; (c) 2 `MediaStreamVideoTrackSource` + 2 `MediaStreamAudioTrackSource` no mesmo Output fMP4, 60 s, arquivo válido no ffprobe (4 faixas, durações iguais ±100 ms), CPU/GPU aceitável a 1080p30 e 1080p60; (d) `pause()/resume()` sem buraco; (e) overlay transparente click-through com desenho; (f) `globalShortcut` Ctrl+Shift+F9 funcionando com foco em outro app. Resultados registrados em `docs/research/spike-results.md`.

## 7. Compositor e exportação

### 7.1 Compositor (TS puro)
- `pipRectAt(pip, tMs)`: keyframe anterior/posterior com interpolação linear + easing (150 ms) para movimentos; `visible=false` → oculto. `shape:'circle'` → `arc`; `'rounded'` → `roundRect` (raio 6 % do menor lado). `object-fit: cover` da webcam. Espelho opcional. Sombra sutil.
- `strokesAt(strokes, clears, tMs)`: traços com `tMs ≤ t` e não apagados; desenho progressivo (pontos com `tMs` ≤ t) para animar o traço; setas com cabeça proporcional à espessura.
- `drawFrame(ctx, W, H, screenFrame, camFrame, t)`.

### 7.2 Exportação
1. Se `webcam` incluída ou há traços → **ExportComposer** (Worker): `mediabunny Input(rec.mp4)` → `VideoSampleSink` de v0 (e v1) → para cada frame de v0 (CFR alvo = fps da gravação; frames de tela em conteúdo estático são repetidos), desenha em `OffscreenCanvas` → `new VideoFrame(canvas,{timestamp})` → `VideoEncoder` H.264 HW (~20 Mbps, `latencyMode:'quality'`) → `Output` MP4 fragmentado `composed.mp4` (só vídeo; o faststart final fica a cargo do ffmpeg). Progresso por frames. Backpressure por `encodeQueueSize`.
2. **ffmpeg** (main): entrada `composed.mp4` (ou `rec.mp4` quando não há composição) + `rec.mp4` para áudio; corte exato `-ss/-to` antes de `-i` (re-encode) ou `-c copy` no preset "Só cortar"; filtros de escala/fps/`format=yuv420p`; áudio `amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95` (ou só uma faixa; offset do mic via `adelay`/`atrim`); `-movflags +faststart`; `-progress pipe:1 -nostats -hide_banner -nostdin`; percentual = `out_time_us / duração`.
3. **Presets** (nomes na UI → parâmetros):

| Preset | Vídeo | Áudio | Regras |
|---|---|---|---|
| WhatsApp / e-mail — pequeno | H.264 **Main**, `-bf 0`, ≤ 1280×720, 30 fps, libx264 `-preset slow -crf 28 -maxrate 1500k -bufsize 3000k -g 60` (HW: `-cq 30`) | AAC 96k 48 kHz stereo | Alvo ≤ 64 MB (WhatsApp) / ≤ 20 MB (e-mail); se estimativa estourar → 2-pass com `kbps_video = alvo_MB×8192×0,97/dur − kbps_audio`; < 700 kbps → 854×480; < 350 kbps → aviso "envie como documento" |
| YouTube / Drive / Instagram — alta | H.264 High, nativa, fps nativo, `-crf 20 -preset slow -bf 2 -g fps/2 -keyint_min fps/2 -flags +cgop` (HW: `-cq 23`) | AAC 192k | Opção Reels 9:16 `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2` |
| Tutorial interno — máxima | H.264 High, nativa, fps nativo (60 se gravado), `-crf 17 -preset slow -bf 2 -g 2*fps` (HW NVENC `-cq 19 -preset p7`) | AAC 256k | — |
| Edição posterior — separado | `tela.mp4` (`-map 0:v:0 -c copy`), `webcam.mp4` (`-map 0:v:1 -c copy`), `mic.wav`, `sistema.wav` (`pcm_s16le`), `combinado.mkv` (v0 + 2 faixas de áudio nomeadas), `posicoes-webcam.json`, `anotacoes.json` | — | Sem composição |
| Só cortar (rápido) | `-c:v copy` (keyframe anterior, ≤ 1 s) | AAC 192k mix | Sem composição; aviso do corte aproximado |

Variantes de hardware substituem `-c:v libx264 …`: NVENC `-c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq N -b:v 0 -bf 2 -b_ref_mode middle -spatial-aq 1 -temporal-aq 1 -profile:v high|main`; QSV `-c:v h264_qsv -preset slower -global_quality N -look_ahead 1`; MF `-c:v h264_mf -rate_control quality -quality 70`. O preset Pequeno com alvo de tamanho usa sempre libx264 2-pass (qualidade por bit).

4. **Detecção de encoder** (primeira exportação, cache em settings por `gpuInfo+driver`): `ffmpeg -f lavfi -i color=gray:s=256x256:r=30 -frames:v 8 -c:v <enc> -f null -` para nvenc, qsv, mf; ordem por vendor da GPU ativa; sempre libx264 disponível.
5. **Thumbnails/waveform**: `-vf fps=1/N,scale=-2:90 -f image2`, `showwavespic=split_channels=0:s=1600x120`.
6. **Nome de saída**: `Gravação 2026-08-18 14-32.mp4` (não sobrescreve: sufixo `-2`).

## 8. UI/UX

- **Direção visual**: tema escuro "estúdio" (fundo #0f1115, superfícies #171a21, acento vermelho-coral para gravar, verde para pronto), tipografia Inter/Segoe UI, ícones lucide, animações discretas (tw-animate). Todas as ações principais com atalho visível. Português do Brasil em toda a UI.
- **Tela Preparar**: coluna esquerda (fontes: abas Monitores | Janelas, cards com miniatura), centro (preview 16:9 grande com PiP posicionável, chip com resolução/fps), rodapé (dispositivos: câmera · microfone com VU · áudio do sistema · qualidade · botão Gravar vermelho grande com atalho). Cabeçalho: logo, "Histórico", "Configurações", indicador de update.
- **Tela Gravando**: mesmo layout; preview vivo com PiP arrastável (alças + botão forma + espelho); cronômetro grande, tamanho estimado, VUs; botões Pausar/Retomar, Parar, Cancelar, Anotar; lembrete "a barra flutuante está no monitor gravado".
- **Tela Revisão**: player com composição; timeline (miniaturas + waveform + alças de corte + marcadores); painel direito com presets (cards com estimativa) e opções; botão Exportar; painel de progresso; estado concluído com ações.
- **Configurações**: abas Geral · Dispositivos · Atalhos (com "gravar atalho" e alerta de conflito) · Anotações · Avançado (proteção da UI, encoder detectado + "testar de novo", pasta de brutos e retenção, logs) · Atualização/Sobre (versão, canal, verificar agora, notas, licenças — FFmpeg GPL, Electron, mediabunny).
- **Barra flutuante**: pílula escura translúcida: ● 00:12:34 · ⏸ · ⏹ · 🎤 · 📷 · ✏️ · ▣(PiP) · ⤢ (mostrar gravador). Tooltips com atalhos.
- **Overlay**: contagem 3-2-1 (número grande centralizado, sem fundo); borda "gravando"; toasts pequenos no canto superior; cursor caneta e paleta mínima no canto quando em modo desenho.
- Estados vazios/erros sempre com ação sugerida ("Nenhuma câmera encontrada — conecte e clique Atualizar").

## 9. Distribuição e atualização

- `package.json build`: `appId: com.cialight.gravador`, `productName: "CiaLight Gravador"`, `win.artifactName: "CiaLightGravador-Setup-${version}.${ext}"`, `nsis: {oneClick:true, perMachine:false, createDesktopShortcut:true, shortcutName:"CiaLight Gravador"}`, `extraResources: [{from:"resources/ffmpeg", to:"ffmpeg"}]`, `publish: [{provider:"github", owner:"cialightiluminacao", repo:"cialight-gravador", releaseType:"release"}]`, `files` excluindo docs/scripts/src.
- ffmpeg: `scripts/fetch-ffmpeg.mjs` baixa o zip BtbN n8.1 (URL e sha256 pinados em `resources/ffmpeg/VERSION.json`), extrai `ffmpeg.exe`/`ffprobe.exe` + `LICENSE`. Não versionado no git (`.gitignore`), baixado no CI e no dev.
- **CI** (`.github/workflows/release.yml`): em `push` de tag `v*`: windows-latest, Node 24, `npm ci`, `node scripts/fetch-ffmpeg.mjs`, `npm run typecheck && npm test`, `npx electron-builder --win --publish always` com `GH_TOKEN=${{secrets.GITHUB_TOKEN}}`; `permissions: contents: write`. Verifica que a release contém `latest.yml`, `.exe`, `.exe.blockmap`. Um segundo workflow `ci.yml` roda typecheck+testes em push/PR.
- **Publicar** = `npm version patch|minor` (script `postversion: git push --follow-tags`).
- **Updater** (main): `autoUpdater.autoDownload=false; autoInstallOnAppQuit=true`; `checkForUpdates()` 10 s após abrir e a cada 60 min (nunca durante gravação); eventos → banner no gravador ("Nova versão X.Y.Z — Baixar (N MB)"; progresso; "Reiniciar e atualizar") + notificação nativa quando baixado; menu "Verificar atualização"; se estiver gravando, adia. Log do updater em arquivo. Notas de release do corpo da release.
- Sem assinatura: README/documento "Instalação em outra máquina" (SmartScreen: Mais informações → Executar assim mesmo; ou copiar por rede/Tailscale). Se um dia assinar, manter o mesmo publisher.

## 10. Robustez e erros

- Pré-checagens (disco, dispositivos, atalhos, permissão de câmera/mic do Windows — se `NotAllowedError`, abrir `ms-settings:privacy-webcam`/`privacy-microphone`).
- Disco: monitorar durante a gravação; < 1 GB → aviso; < 300 MB → parar automaticamente com aviso.
- Encoder/WebCodecs falha → fallback MediaRecorder sem perder sessão.
- Perda de dispositivo (câmera desconectada) → faixa continua preta; aviso; retorno automático se reconectar (best effort).
- Crash/energia → recuperação de sessão (4.4).
- ffmpeg falha → mensagem com últimas linhas do log + botão copiar log; retry com libx264.
- Proteção da UI: self-test opcional (Avançado → "Testar exclusão da janela"): grava 2 s do monitor onde está o gravador e mostra o frame para o usuário confirmar.
- Overlay preta (issue #40515): detecção por thumbnail sólido → recriar; opção "desativar overlay" (anotações só no preview/export via desenho no gravador).
- Logs em `userData/logs/` (electron-log) com rotação.

## 11. Testes e validação

- **Unitários (vitest)**: compositor (interpolação, formas, traços progressivos), mediaClock/pausas, `buildFfmpegArgs` por preset (snapshot), cálculo de tamanho-alvo/2-pass, validação de atalhos (ABNT2, lista negra), migração de settings, schema de session.json (zod).
- **Integração (scripts em `scripts/`)**: `test:ffmpeg` (probe de encoders na máquina; exporta cada preset a partir de uma sessão sintética e valida com ffprobe: codec/profile/nível/faststart/duração/tamanho/faixas); `test:capture` (lança o Electron em modo teste `CIALIGHT_TEST=capture`: grava 8 s do monitor principal com loopback + mic + câmera se houver, valida fMP4 com ffprobe: faixas, durações, sync); `test:update` (`dev-app-update.yml` apontando para release de teste; verifica eventos).
- **E2E manual (checklist em `docs/qa-checklist.md`)**: 2 monitores/1 monitor; janela; pausa; mute; anotações; atalhos com foco em outro app; instalação limpa; SmartScreen; auto-update de vX para vX+1 em máquina limpa; RustDesk com/sem proteção.
- **Verificação de release**: instalar o `.exe` gerado nesta máquina, abrir, gravar 10 s com webcam + sistema + mic, exportar 2 presets, conferir arquivos; publicar v1.0.0; instalar v1.0.0, publicar v1.0.1 e confirmar que o app detecta/baixa/instala.

## 12. Ordem de implementação

0. **Spike** (validações §6) → `spike-results.md`. Qualquer falha muda o plano antes de UI.
1. Scaffold (electron-vite, React, Tailwind, Radix, lint, vitest, electron-builder, ffmpeg fetch, CI).
2. Main: fontes, displayMediaHandler, sessão/escrita, settings, atalhos, janelas (gravador, barra, overlay), tray, proteção.
3. Engine de gravação (mediabunny) + fallback + relógio + session.json.
4. UI Preparar/Gravando + barra flutuante + PiP ao vivo + overlay (contagem/borda) + anotações.
5. Compositor + ExportComposer + ffmpeg (presets, encoder probe, progresso) + UI Revisão + Histórico + recuperação.
6. Auto-update + Configurações + Sobre + docs de instalação.
7. Empacotar, instalar, testar, publicar v1.0.0; testar update com v1.0.1.

## 13. Fora de escopo v1 (v2)
Auto-zoom/cursor suave; HEVC/AV1; loopback por aplicativo; captura de região arbitrária (parcial: recorte por janela via DWM em modo monitor); upload direto (Drive/YouTube); edição de trechos do meio; legendas automáticas; assinatura de código; macOS/Linux.

## 14. Riscos e planos B
Ver relatório §7. Principais: exclusão da UI da captura (self-test + mover para outro monitor + ocultar barra), robustez WebCodecs (fallback MediaRecorder), desempenho iGPU (1080p30 padrão; reduzir automaticamente), overlay preta (detecção + desativar), sincronia mic (EC off + offset), modo janela (padrão monitor + avisos), NVENC ffmpeg 9 (build 8.1), updater (releaseType, artifactName ASCII, versões pinadas), gravações longas (streaming + checagem de disco).

## 15. Notas de implementação (v1.0.x) — desvios e decisões tomadas
- **Modo janela sem anotações**: o Windows não permite desenhar sobre a janela capturada (a overlay não é capturada e não conhecemos os bounds da janela via desktopCapturer). Em modo janela o botão/atalho de anotar mostra um aviso; a borda de gravação vira uma pílula "Gravando · janela: <nome>". Fica para a v2 (bounds via DWM/koffi).
- **Fallback MediaRecorder** só na inicialização (encoder/WebCodecs indisponível). Falha fatal do encoder no meio da gravação encerra a gravação preservando o fMP4 (recuperável), com mensagem clara — em vez de trocar de motor no meio (evita segmentos a costurar).
- **Relógio entre janelas**: overlays carimbam eventos com `performance.timeOrigin + performance.now()` (epoch ms); o gravador converte para tempo de mídia. `performance.now()` puro não é comparável entre janelas.
- **composed.mp4** é apagado após cada exportação (main) e zerado pelo renderer em caso de erro/cancelamento.
- **CI**: workflows em `docs/ci/` (o token do gh não tinha escopo `workflow`); publicação feita a partir do PC (`npm run release:publish` ou `gh release create` com exe+blockmap+latest.yml).
- **ffmpeg**: build BtbN n8.1.2 **shared** (metade do tamanho dos estáticos), espelhado em release de dependência `deps-ffmpeg-n8.1.2` (marcada como pré-release para não virar "latest").
- **QA**: `window.__qa` (só fora do pacote) e `scripts/qa/cdp.mjs` permitem dirigir o app por CDP; `CIALIGHT_SHOT[_EVERY|_SIZE]`/`CIALIGHT_SCREEN` para screenshots.
