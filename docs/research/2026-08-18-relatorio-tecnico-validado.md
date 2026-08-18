# CiaLight Gravador — Relatório Técnico Consolidado (Windows 10/11, Electron)

Data-base: 18/08/2026. Todas as afirmações abaixo vêm das 8 dimensões pesquisadas e da verificação adversarial; onde a verificação **refutou/corrigiu** uma afirmação, o texto já usa a versão corrigida (lista completa na seção 8). Confiança marcada como **alta / média / baixa**; o que não foi confirmado está dito explicitamente.

---

## 1. Resumo executivo

1. **Stack:** manter Electron (43.4.0 estável, Chromium 150; planejar salto para 44 previsto para 25/08/2026) com a toolchain já em produção (electron-vite + React 19 + Tailwind v4 + Radix + electron-builder NSIS + electron-updater). Tauri exigiria reescrever toda a pipeline de mídia em Rust (Cap precisou de 46 crates + forks; esforço estimado 3–5×); .NET+ScreenRecorderLib troca a stack e não tem máscara redonda/anotações; OBS-como-motor depende de instalação externa (160 MB, GPL) e não tem anotações.
2. **Captura:** `session.setDisplayMediaRequestHandler` + `desktopCapturer.getSources` no main e `getDisplayMedia` no renderer; áudio do sistema por `audio:'loopback'` (Windows, nativo do Electron); microfone em `getUserMedia` separado (nunca na mesma chamada que a tela — o Chromium derruba o renderer).
3. **Gravação = faixas separadas, sem composição ao vivo:** tela, webcam, mic e áudio do sistema gravados como faixas independentes num único fMP4 (WebCodecs H.264 por hardware + mediabunny, streaming para disco, fragmentos de 1 s), mais um JSON com a trajetória da PiP (posição/tamanho/forma) e os traços de anotação com timestamp. É o modelo de Cap Studio, Screen Studio e Screenity 4.6.
4. **Preview ao vivo** na janela do gravador (pode ficar no outro monitor) é só `<video>` + CSS/canvas; a janela é excluída da captura com `setContentProtection(true)` (WDA_EXCLUDEFROMCAPTURE) — a webcam nunca aparece na tela gravada.
5. **Anotações:** overlay transparente click-through por monitor, ativada por atalho global, registrada como vetores e composta na exportação (necessário porque, em modo "janela", o WGC não captura janelas sobrepostas).
6. **Exportação:** composição (PiP redonda/retangular + anotações) em OffscreenCanvas/WebCodecs quando houver, e **ffmpeg embutido** como finalizador (corte, presets, mistura de áudio, faststart, 2-pass para tamanho-alvo, thumbnails, progresso), com detecção de encoder de hardware por encode-teste (nvenc → qsv → mf → libx264). Atenção: FFmpeg 9.x não usa NVENC na GTX 1060 (driver ≥ 610 exigido; Pascal parou no 580) — usar build BtbN 8.1.
7. **Formato final:** MP4 + H.264 High 4:2:0 + AAC-LC 48 kHz + `+faststart` (o que YouTube/Instagram/WhatsApp recomendam); HEVC/AV1 só como opção avançada.
8. **Distribuição:** electron-builder 26.15.7 (pinar; `latest` do npm ainda é 26.15.3) + electron-updater 6.8.9, NSIS oneClick per-user, GitHub Releases público sem token no cliente, `releaseType: "release"`, download diferencial por blockmap (o ffmpeg de ~100 MB não é rebaixado a cada update).
9. **Assinatura:** não há rota barata para empresa brasileira (Azure Artifact Signing exclui o Brasil; OV/EV exigem token/HSM, US$ 300–500/ano). Começar sem assinatura, distribuir o primeiro instalador por rede interna/Tailscale; o auto-update não passa por SmartScreen nem verifica assinatura quando o build não é assinado.
10. **Maiores riscos:** regressões de `setContentProtection` no Windows (testar a cada bump), robustez do caminho WebCodecs (backpressure, MFT), desempenho de encode em máquina com iGPU+dGPU (spike obrigatório), overlay transparente preta em algumas máquinas (#40515) e sincronia mic↔vídeo com AEC no Win11 (~170 ms).

---

## 2. Decisões técnicas validadas

| Decisão | Escolha | Evidência (URL) | Confiança | Alternativa descartada e motivo |
|---|---|---|---|---|
| Runtime | Electron **43.4.0** (Chromium 150.0.7871.224, Node 24.18.1); testar 44 (Chromium 152, estável previsto 25/08/2026) | https://releases.electronjs.org/ · https://releases.electronjs.org/schedule | alta | Tauri v2 (2.11.5): pipeline de mídia inteira em Rust (Cap: 46 crates, forks de ffmpeg-next/cpal/nokhwa, LLVM/vcpkg) — https://raw.githubusercontent.com/CapSoftware/Cap/main/Cargo.toml · .NET+ScreenRecorderLib 6.6.0: sem máscara redonda/anotações, troca de UI — https://www.nuget.org/packages/ScreenRecorderLib · OBS motor: OBS instalado (159,8 MB) ou libobs GPL — https://github.com/streamlabs/obs-studio-node |
| API de captura | `ses.setDisplayMediaRequestHandler` + `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{320,180}, fetchWindowIcons:true})` + `getDisplayMedia` | https://raw.githubusercontent.com/electron/electron/main/docs/api/session.md · https://raw.githubusercontent.com/electron/electron/main/docs/api/desktop-capturer.md | alta | `getUserMedia` + `chromeMediaSource:'desktop'` (legado): mic + tela na mesma chamada ou áudio desktop sem vídeo = bad message 263 → renderer morto — https://chromium.googlesource.com/chromium/src/+/main/content/browser/renderer_host/media/media_stream_dispatcher_host.cc |
| Seleção de monitor | casar `source.display_id` com `screen.getAllDisplays()[i].id`; fallback por ordem/nome se vier `''` | https://raw.githubusercontent.com/electron/electron/main/shell/browser/api/electron_api_desktop_capturer.cc · https://github.com/electron/electron/issues/52232 | alta | — |
| Áudio do sistema | `callback({video, audio:'loopback'})` + no renderer `audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, restrictOwnAudio:true}` (43.4.0+) | https://raw.githubusercontent.com/electron/electron/main/shell/browser/electron_browser_context.cc · https://github.com/electron/electron/pull/52455 · https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc | alta | Módulo nativo wasapi-rs (só plano B) — https://github.com/HEnquist/wasapi-rs · ffmpeg + virtual-audio-capturer (driver DirectShow de terceiros, 2023) — https://github.com/rdp/screen-capture-recorder-to-video-windows-free · `'loopbackWithMute'` (silencia o PC) |
| Microfone | `getUserMedia({audio:{deviceId:{exact}}})` separado; mute via `track.enabled=false`; VU por `AnalyserNode` | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia · https://webaudio.github.io/web-audio-api/ | alta | Mixar via `MediaStreamAudioDestinationNode` no caminho de gravação (timestamps por `TimeTicks::Now()`, crbug 1302080) |
| Backend Windows | WGC para janela (Win10 1903+); tela = DXGI (<24H2) / WGC (Win11 24H2+); cursor sempre embutido; borda amarela só removível em build ≥ 20348 | https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/7871/content/browser/media/capture/desktop_capture_device.cc · https://webrtc.googlesource.com/src/+/main/modules/desktop_capture/win/wgc_capturer_win.cc | alta | — (não há alternativa dentro do Electron) |
| Excluir UI da captura | `win.setOpacity(1.0)` **antes** de `win.setContentProtection(true)`, só durante gravação, com opção de desligar (RDP/RustDesk) | https://raw.githubusercontent.com/electron/electron/main/docs/api/browser-window.md · https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity · https://github.com/electron/electron/issues/47834 | alta (API) / **média** (compat. com WGC/DXGI — validar) | Bolha "queimada" na tela (Loom): não editável, aparece na captura |
| Pipeline de gravação | WebCodecs `VideoEncoder` (H.264 HW, `no-preference`) + `AudioEncoder` + **mediabunny** (Mp4OutputFormat `fastStart:'fragmented'`, `MediaStream*TrackSource`, StreamTarget) | https://mediabunny.dev/guide/media-sources · https://raw.githubusercontent.com/Vanilagy/mediabunny/main/src/output-format.ts · https://raw.githubusercontent.com/alyssaxuu/screenity/master/src/pages/Recorder/webcodecs/WebCodecsRecorder.js | alta | MediaRecorder como caminho principal: 1 faixa de áudio + 1 de vídeo por recorder, sem timeslice = arquivo inteiro em RAM, com timeslice = fMP4 "live" sem duração — https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc · mp4-muxer/webm-muxer (depreciados) |
| Composição PiP/anotações | **Pós** (exportação); preview ao vivo por `<video>`+CSS/canvas | https://cap.so/docs/recording/studio-mode · https://screen.studio/guide/extracting-raw-recording-files · https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/project/src/meta.rs | alta | canvas.captureStream + MediaRecorder ao vivo: readback RGBA→NV12, throttling de rAF, drift, e impede reposicionar depois — https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webcodecs/video_encoder.cc |
| Overlay de anotação | BrowserWindow `{transparent, frame:false, alwaysOnTop:'screen-saver', skipTaskbar, focusable:false, resizable:false}` + `setIgnoreMouseEvents(true,{forward:true})` + `globalShortcut` | https://www.electronjs.org/docs/latest/tutorial/custom-window-styles · https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions · https://www.electronjs.org/docs/latest/api/global-shortcut | alta (API) / **média** (bug #40515) | — |
| Motor de exportação | **ffmpeg embutido** (BtbN série 8.1, gpl ou lgpl) + detecção nvenc→qsv→mf→libx264 por encode-teste | https://github.com/BtbN/FFmpeg-Builds · https://raw.githubusercontent.com/BtbN/FFmpeg-Builds/master/scripts.d/50-ffnvcodec.sh · https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/enc-ffmpeg/src/video/h264.rs | alta | Export só com WebCodecs+mediabunny (sem 2-pass, sem amix/showwavespic; plano B) · ffmpeg-static 5.3 (FFmpeg 6.1.1, antigo) · @ffmpeg-installer (FFmpeg 4.1) |
| Formato final | MP4 + H.264 High yuv420p + AAC-LC 48 kHz + `-movflags +faststart` | https://support.google.com/youtube/answer/1722171 · https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ · https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media | alta | HEVC (WMP exige extensão paga; Chrome só decodifica com HW) — https://apps.microsoft.com/detail/9nmzlz57r3t7 · AV1 (GTX 1060/UHD 730 não codificam) |
| Contêiner de gravação | fMP4 fragmentado (ou MKV) — nunca MP4 comum durante a captura | https://ffmpeg.org/ffmpeg-formats.html · https://obsproject.com/kb/hybrid-mp4 | alta | MP4 comum (indecodificável se interrompido) |
| Empacotamento | electron-builder **26.15.7** (tag `v26`) + electron-updater **6.8.9**, NSIS oneClick per-user, `publish:{provider:'github', releaseType:'release'}` | https://registry.npmjs.org/electron-builder · https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/auto-update.md · https://raw.githubusercontent.com/electron-userland/electron-builder/electron-builder%4026.15.7/packages/electron-publish/src/gitHubPublisher.ts | alta | v27/7.0 alpha (ESM, breaking changes) · Velopack (fora da toolchain) · MSIX (exige certificado) · Squirrel.Windows (não suportado pelo electron-updater) |
| Assinatura | Sem assinatura no início; reavaliar OV em nuvem se houver bloqueio | https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart · https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation | alta | Azure Artifact Signing (Brasil não elegível) · SignPath OSS (exige OSI puro) |
| Cursor/cliques | uiohook-napi 1.5.5 em `utilityProcess`; fallback polling `screen.getCursorScreenPoint()` + koffi `GetAsyncKeyState` | https://github.com/SnosMe/uiohook-napi · https://github.com/SnosMe/uiohook-napi/issues/54 | média | node-global-key-listener (arquivado, só teclado) |
| Atalhos padrão | Ctrl+Shift+F9..F12 (ABNT2-safe), configuráveis, checar retorno de `register()` | https://www.electronjs.org/docs/latest/api/global-shortcut · http://kbdlayout.info/KBDBR/ | alta / média (ABNT2) | Ctrl+Alt+X (AltGr em ABNT2), Ctrl+Shift+L etc. (Loom), Win+Alt+R (Game Bar) |

---

## 3. Arquitetura recomendada: captura → composição → encoding → arquivo

```
[main]  setDisplayMediaRequestHandler ──► callback({video: source, audio: 'loopback'|undefined})
              ▲ IPC (source escolhido no picker)
[renderer da gravação]
  getDisplayMedia(video 1080p/1440p, audio) ──► track tela + track áudio-sistema ─┐
  getUserMedia(webcam)                       ──► track webcam                    ├─► mediabunny Output (fMP4 fragmentado, 1 s)
  getUserMedia(mic)                          ──► track mic                       ┘     tracks: v0 tela, v1 webcam, a0 mic, a1 sistema
                                                                                      (VideoEncoder H.264 HW / AudioEncoder AAC)
  eventos UI (PiP move/resize/forma, traços, pausas) ──► session.json (t em "tempo de mídia")
                                                                                       └─► StreamTarget → disco (IPC fs.createWriteStream)
[janela do gravador]  <video tela> + <video webcam> (CSS redondo/retangular) + canvas traços = PREVIEW (setContentProtection ON)
[overlay por monitor] transparente, click-through, atalho alterna modo desenho (vetores → session.json)
[exportação]  (a) sem PiP/anotações → ffmpeg direto do rec.mp4
              (b) com PiP/anotações → OffscreenCanvas + WebCodecs → composed.mp4 (mezanino) → ffmpeg (preset, áudio, faststart)
```

### 3.1 Monitor / janela (picker próprio)
- `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{width:320,height:180}, fetchWindowIcons:true})`; filtrar as janelas do próprio processo (`id` `window:XX:1`); em erro de thumbnail (Razer Synapse etc., issue #51910) refazer com `thumbnailSize:{0,0}` — https://github.com/electron/electron/issues/51910.
- Monitor específico: `source.display_id === display.id`; no Windows isso só é preenchido quando o capturador DXGI é suportado; se vier `''` (RDP/GPU básica), cair para ordem/`Screen N` e avisar (issue #52232 aberta).
- Constraints: `video:{width:{ideal:display.size.width*scaleFactor}, height:{ideal:…}, frameRate:{ideal:30|60}}` (default 30 fps, máx 120; sem `min/exact`; captura limitada a ~50 % de um core — https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/7871/content/browser/media/capture/desktop_capture_device.cc); ler `track.getSettings()` para a resolução real. A constraint `cursor` é ignorada (não existe no IDL do Chromium); o cursor está sempre no vídeo — https://github.com/electron/electron/issues/23923.
- **Modo "janela específica"** (WGC): captura só o conteúdo daquela janela, mesmo coberta; NÃO captura janela minimizada, menus/popups/tooltips (Chromium deixa `IncludeSecondaryWindows=false`), e no Windows 10 mostra a **borda amarela** (remoção exige `IGraphicsCaptureSession3`, build ≥ 20348 ≈ Win11) — https://webrtc.googlesource.com/src/+/main/modules/desktop_capture/win/wgc_capture_session.cc · https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.includesecondarywindows. Recomendação: **padrão = monitor**; oferecer "janela" com aviso ("menus e dicas de ferramenta podem não aparecer"); opção futura "monitor recortado nos limites da janela" (bounds via `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` / electron-overlay-window, confiança média).
- Modo 0 Hz do WGC (janela sempre; tela no 24H2) só entrega frames quando o conteúdo muda → fps variável em conteúdo estático; o encoder deve tolerar (timestamps reais) e o export normaliza para CFR (`fps=` no ffmpeg).

### 3.2 Áudio do sistema + microfone (faixas separadas)
- Sistema: só pedir `audio` no `getDisplayMedia` se o toggle estiver ligado; no handler `audio: request.audioRequested ? 'loopback' : undefined`. É sempre o **mix do dispositivo de saída padrão** (WASAPI loopback, endpoint eConsole; DRM não é capturado; silêncio contínuo quando nada toca) — https://chromium.googlesource.com/chromium/src/+/main/media/audio/win/audio_low_latency_input_win.cc. Loopback por aplicativo (`applicationLoopback:<pid>`) existe no Chromium (Win11) mas **não há API no Electron** e não foi testado (confiança baixa).
- Desligar processamento no áudio do sistema: `audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}` (padrão do getDisplayMedia é EC "browser decides" = ligado, com AGC/NS seguindo) — confirmado no código; validar com `track.getSettings()`.
- `restrictOwnAudio:true` → Electron 43.4.0+ troca para `loopbackWithoutChrome` (Win11; ignorado no Win10) — evita gravar sons de UI do próprio app.
- Mic: `getUserMedia` separado, EC/NS/AGC como opções (padrão sugerido para headset: EC **off**, NS on, AGC on; toggle "caixas de som" liga EC). Com EC ligado no Win11, `SystemLoopbackAsAecReference` atrasa a captura em ~170 ms — https://chromium.googlesource.com/chromium/src/+/main/media/base/media_switches.cc (efeito real a medir).
- Mute independente: `track.enabled=false` (mantém timeline); VU por `AnalyserNode` fora do caminho de gravação.
- **Faixas separadas no arquivo:** mediabunny Mp4OutputFormat aceita múltiplas faixas de vídeo e áudio por Output (limite 2^32−1; MKV 127) e `MediaStreamAudioTrackSource` sincroniza todas as faixas ("earliest sample starts at 0, all tracks perfectly synchronized") — https://raw.githubusercontent.com/Vanilagy/mediabunny/main/src/output-format.ts · https://mediabunny.dev/guide/media-sources. AAC via `AudioEncoder` (`mp4a.40.2`, MF: 96/128/160/192 kbps, 44.1/48 kHz) com fallback Opus se `isConfigSupported` falhar (Windows N sem Media Feature Pack).

### 3.3 Webcam composta com forma e movimento (tempo real vs pós)
- **Gravar** a webcam como faixa v1 (720p30, ~5 Mbps H.264 HW). Toda interação do usuário na PiP do preview (arrastar/redimensionar/redondo↔retangular) gera keyframe `{t, x, y, w, h, shape}` em coordenadas **normalizadas (0–1)** do frame da tela.
- **Preview ao vivo** (janela do gravador, em qualquer monitor): `<video>` da tela + `<video>` da webcam com `border-radius:50%`, `object-fit:cover`, `transform:scaleX(-1)` (espelho) — quase grátis; `webPreferences.backgroundThrottling:false`.
- **Composição real na exportação** (seção 4): decodificar v0/v1 (mediabunny `VideoSampleSink`), desenhar em `OffscreenCanvas` (Worker) com `clip()` (arc/roundRect) na posição interpolada, `new VideoFrame(canvas,{timestamp})` → `VideoEncoder` → mediabunny. Motivo de não compor ao vivo: readback RGBA→NV12 por frame (D3D11 VideoProcessor fica atrás de `kMediaFoundationD3DVideoProcessing`, desabilitada), throttling de rAF, drift, e impossibilidade de reposicionar depois.

### 3.4 Preview no outro monitor e exclusão da UI do gravador
- Janela do gravador (controles + preview): `setOpacity(1.0)` e depois `setContentProtection(true)` **ao iniciar** a gravação e `false` ao parar. WDA_EXCLUDEFROMCAPTURE remove a janela de qualquer captura no Win10 2004+ (antes: retângulo preto). Histórico de regressões: #45990 (corrigido), #47834 (aberta: capturada em Win10 19045/Win11 22000 desde 36.3.2; workaround do mantenedor = `setOpacity`), e o Electron 43 removeu a mitigação WS_EX_LAYERED — https://github.com/electron/electron/pull/51733.
- Efeito colateral (Cap): janelas protegidas ficam **invisíveis em RDP/RustDesk/monitores virtuais** — https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/src/platform/win.rs. Aplicar só durante gravação e oferecer desligar.
- **Self-test automático** no início da gravação: capturar 1 frame (thumbnail via `getSources` ou 1º frame do stream) e verificar que a janela protegida não aparece; se aparecer, sugerir mover a janela para o outro monitor.

### 3.5 Anotações via overlay e o modo "janela"
- Uma `BrowserWindow` transparente por monitor gravado (bounds = `display.bounds` — opcionalmente −1/−2 px como precaução barata; **não** garante contra #40515), `alwaysOnTop('screen-saver')`, `setIgnoreMouseEvents(true,{forward:true})` (o Electron já instala um hook WH_MOUSE_LL nesse modo — https://github.com/electron/electron/blob/main/shell/browser/native_window_views_win.cc). Atalho global alterna para modo desenho (`setIgnoreMouseEvents(false)` + `focus()`), com mapa de teclas estilo ZoomIt dentro do modo (Shift = reta, Ctrl+Shift = seta, R/G/B/Y cores, Ctrl+Z, E apaga tudo, Esc sai) — https://learn.microsoft.com/en-us/sysinternals/downloads/zoomit.
- Cada traço vira evento vetorial `{t, tool, points[], color, width}` (coordenadas normalizadas; DIP → pixels físicos via `display.scaleFactor` / `screen.dipToScreenPoint`) e é espelhado no preview.
- **Decisão consistente para monitor e janela:** overlay também com `setContentProtection(true)` (invisível na captura) + composição sempre a partir dos vetores na exportação. Assim o modo janela (onde o WGC nunca capturaria a overlay) e o modo monitor produzem o mesmo resultado, e "edição posterior" recebe a tela limpa. Risco: se a proteção falhar (#47834), o traço aparece duas vezes → flag por máquina "queimar anotações ao vivo" (overlay não protegida e sem composição).
- Overlay preta/opaca em algumas máquinas (#40515, aberta, Win10/11, NVIDIA/AMD/Intel, ~1–2 % dos usuários; reproduzido em WinAPI/GLFW puros): detectar (thumbnail >99 % cor sólida), recriar a janela ao receber `WM_DWMCOMPOSITIONCHANGED` (`hookWindowMessage(0x031E)`) e em `app.on('gpu-info-update')`; última instância: desligar aceleração de hardware ou desativar a overlay — https://github.com/electron/electron/issues/40515.

### 3.6 Pausa/retomar
- `source.pause()` / `source.resume()` em todas as fontes mediabunny: "offset in timestamp such that the result plays back continuously with no gap" — https://mediabunny.dev/guide/media-sources. Não parar nem recriar tracks (evita renegociação/permissões). Manter no renderer um **relógio de mídia** (`t_media = t_wall − Σ pausas`) para carimbar keyframes/traços; registrar intervalos de pausa no session.json.
- Fallback MediaRecorder: `pause()/resume()` também remove o tempo pausado (`MuxerTimestampAdapter`).

### 3.7 Gravações longas (streaming para disco)
- mediabunny `StreamTarget` → chunks para o main via IPC → `fs.createWriteStream` (ou `FileSystemWritableFileStream` via `showSaveFilePicker`, suportado no Electron ≥ 30 com permission handler `fileSystem` — https://github.com/electron/electron/pull/41419). fMP4 com `minimumFragmentDuration:1` → arquivo reproduzível (VLC/ffmpeg) até o último fragmento em caso de crash.
- Consumo estimado: 1080p30 a 12 Mbps ≈ 5,4 GB/h (+ webcam ~2,3 GB/h). Checar espaço em disco antes e durante (Cap v0.5 faz isso); no PC do dev o SSD sem DRAM degrada com disco cheio — manter margem.
- Nunca reter Blobs/ArrayBuffers em memória; sem timeslice o MediaRecorder mantém tudo em RAM até `stop()` (Blob storage: 2 GiB em RAM antes de paginar — https://chromium.googlesource.com/chromium/src/+/refs/heads/main/storage/browser/blob/blob_memory_controller.cc).
- Backpressure: aguardar quando `encoder.encodeQueueSize` > N (Screenity: crash do encoder D3D11 se a fila enche — crbug 1504122); watchdog de erros com fallback para MediaRecorder por track (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`, timeslice 1000 ms) para o restante da sessão.

### 3.8 Sincronização
- Um único Output mediabunny com todas as faixas = sincronia garantida pela biblioteca (mesmo relógio). Se optar por arquivos separados, gravar o `t0` de cada fonte e os offsets no session.json.
- Offset mic↔vídeo: medir no spike (clap test) com EC on/off; oferecer ajuste fino de offset do mic na tela de revisão.
- Composição na exportação usa os timestamps dos pacotes decodificados (não `Date.now`), e o export normaliza para CFR.

### 3.9 Parâmetros de encoding na gravação (mezanino)
- `VideoEncoder.configure({codec:'avc1.640028', avc:{format:'avc'}, width, height, bitrate: 12e6 (1080p30) | 20e6 (1440p30/1080p60), bitrateMode:'constant', latencyMode:'realtime', hardwareAcceleration:'no-preference'})`; keyframe forçado a cada 1 s (`encode(frame,{keyFrame:true})`) → corte "rápido" com erro ≤ 1 s. `isConfigSupported` com `prefer-hardware` só para diagnosticar; MFTs: GTX 1060 = H.264/HEVC (sem AV1), UHD 730 = H.264/HEVC/VP9 (sem AV1); fallback automático OpenH264 (software). Screenity relata perfil Main (`4D`) "silent-no-output" no wrapper MFT — usar High (`64`) ou Baseline (`42`) — https://raw.githubusercontent.com/alyssaxuu/screenity/master/src/pages/CloudRecorder/encoder/chooseEncoder.js.
- Frames de `MediaStreamTrackProcessor` (câmera/tela) já vêm mapeáveis (NV12/I420) → sem readback (confiança média; medir na UHD 730).
- Qual GPU o processo GPU do Chromium usa (iGPU vs GTX 1060) e se o MFT fica em outro LUID (`dxgi_resource_mapping_required_`) → verificar com `app.getGPUInfo('complete')` e `chrome://media-internals` no spike.

---

## 4. Exportação

### 4.1 Fluxo
1. Revisão: player com o vídeo bruto (v0 + áudio mixado em tempo real via Web Audio só para ouvir), trim início/fim, escolha de preset.
2. Se houver PiP ou anotações → **composição** (3.3) para `composed.mp4` (mezanino H.264 HW ~20 Mbps). Se não → usar `rec.mp4` direto.
3. **ffmpeg** finaliza (corte exato, escala, encoder, áudio, faststart, thumbnails, progresso).

Nos comandos abaixo, `IN` = `rec.mp4` (faixas: `0:v:0` tela, `0:v:1` webcam, `0:a:0` mic, `0:a:1` sistema) ou `composed.mp4` (+ `rec.mp4` como 2ª entrada só para o áudio; troque `[0:a:0][0:a:1]` por `[1:a:0][1:a:1]`). Mistura: `amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95` (normalize=1 padrão reduz o volume pela metade; normalize=0 pode clipar → limiter) — https://ffmpeg.org/ffmpeg-filters.html. Substituir `-c:v libx264 …` pela variante de hardware detectada (4.3).

### 4.2 Presets

| Preset | Contêiner | Codec vídeo | Resolução | fps | Bitrate/CRF | Áudio | Comando ffmpeg (núcleo) |
|---|---|---|---|---|---|---|---|
| **Pequeno — WhatsApp / e-mail** | MP4 faststart | H.264 **Main, sem B-frames** (exigência WhatsApp) | ≤ 1280×720 | 30 | CRF 28, maxrate 1,5 Mbps; se estourar o alvo (16 MB padrão; opção 64 MB "WhatsApp HD" / 20 MB e-mail) → 2-pass com bitrate calculado | AAC 96 kbps 48 kHz stereo | `ffmpeg -hide_banner -nostdin -y -ss A -to B -i IN -filter_complex "[0:v:0]scale='min(1280,iw)':-2:flags=lanczos,fps=30,format=yuv420p[v];[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]" -map "[v]" -map "[a]" -c:v libx264 -profile:v main -bf 0 -preset slow -crf 28 -maxrate 1500k -bufsize 3000k -g 60 -c:a aac -b:a 96k -ac 2 -ar 48000 -movflags +faststart -progress pipe:1 -nostats out.mp4` |
| **Alta — YouTube / Drive / Instagram** | MP4 faststart, sem edit lists | H.264 High, 2 B-frames, GOP fechado | nativa (opção 9:16 1080×1920 p/ Reels) | nativo (30/60) | CRF 20 (≈ 8–12 Mbps 1080p; YouTube: 8/12 Mbps 1080p, 16/24 1440p) | AAC 192 kbps 48 kHz | `… -filter_complex "[0:v:0]format=yuv420p[v];[0:a:0][0:a:1]amix=…[a]" -map "[v]" -map "[a]" -c:v libx264 -profile:v high -preset slow -crf 20 -bf 2 -g {fps/2} -keyint_min {fps/2} -flags +cgop -c:a aac -b:a 192k -ar 48000 -movflags +faststart out.mp4`; Reels: `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2` (≤ 1920 px, ≤ 25 Mbps, ≤ 15 min, ≤ 300 MB via API) |
| **Tutorial interno — máxima** | MP4 faststart | H.264 High (opção HEVC `hvc1`, com aviso) | nativa (1440p se gravado) | nativo (60 se gravado) | CRF 17 (NVENC `-cq 19 -preset p7`) | AAC 256 kbps | `… -c:v libx264 -profile:v high -preset slow -crf 17 -bf 2 -g {2*fps} -c:a aac -b:a 256k -movflags +faststart out.mp4`; HEVC: `-c:v libx265 -crf 20 -preset medium -tag:v hvc1` (Windows Media Player exige extensão HEVC paga; ffmpeg grava `hev1` por padrão, `hvc1` só com `-tag:v hvc1`) |
| **Edição posterior — separado** | MP4 (vídeos) + WAV (áudios) + MKV combinado opcional | cópia dos pacotes (sem re-encode; o mezanino já é 12–20 Mbps, GOP 1 s) | nativa | nativo | — | PCM 16-bit 48 kHz (WAV) / AAC copiado no MKV | `ffmpeg -i rec.mp4 -map 0:v:0 -c copy -movflags +faststart screen.mp4` · `-map 0:v:1 … webcam.mp4` · `-map 0:a:0 -c:a pcm_s16le mic.wav` · `-map 0:a:1 -c:a pcm_s16le system.wav` · combinado: `-map 0:v:0 -map 0:a:0 -map 0:a:1 -c copy -disposition:a:0 default -metadata:s:a:0 title=Microfone -metadata:s:a:1 title=Sistema combined.mkv` + `pip-keyframes.json`, `annotations.json` |
| **Só corte rápido (sem recodificar vídeo)** | MP4 faststart | cópia (cai no keyframe anterior, ≤ 1 s com GOP de 1 s) | nativa | nativo | — | AAC 192 kbps (mix re-encodado) | `ffmpeg -ss A -to B -i rec.mp4 -map 0:v:0 -filter_complex "[0:a:0][0:a:1]amix=…[a]" -map "[a]" -c:v copy -c:a aac -b:a 192k -avoid_negative_ts make_zero -movflags +faststart out.mp4` |

Variantes de hardware (trocar `-c:v libx264 …`): NVENC `-c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq {23|30|19} -b:v 0 -bf 2 -b_ref_mode middle -spatial-aq 1 -temporal-aq 1 -rc-lookahead 20 -profile:v {high|main}` (no preset WhatsApp `-bf 0`) — https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html; QSV `-c:v h264_qsv -preset slower -global_quality {23|30} -look_ahead 1 -look_ahead_depth 20`; MF `-c:v h264_mf -rate_control quality -quality 70` (`-hw_encoding 1` falhou no teste com o MFT Intel na máquina do dev; sem a flag usa o MFT de software) — https://ffmpeg.org/ffmpeg-codecs.html.

Tamanho-alvo (preset Pequeno): `kbps_video = (alvo_MB × 8192 × 0,97 / dur_s) − kbps_audio`; 2-pass: `-b:v X -maxrate 1.5X -bufsize 3X -pass 1 -an -f mp4 NUL` e depois `-pass 2`; se X < 700 kbps a 720p → cair para 854×480; se < 350 kbps → avisar e sugerir enviar como documento (WhatsApp: documento até 2 GB sem passar pelo limite de mídia).

Limites verificados: WhatsApp app: vídeo como mídia 64 MB/480p (conexão lenta) ou 100 MB/720p (rápida), documento 2 GB — https://faq.whatsapp.com/453914586839706/; Cloud API: 16 MB, só H.264+AAC, 1 faixa de áudio, High+B-frames "not supported" no Android — https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media; Gmail 25 MB — https://support.google.com/mail/answer/6584; Outlook IMAP/POP 20 MB — https://learn.microsoft.com/en-us/troubleshoot/outlook/message-body/attachment-size-exceeds-the-allowable-limit-error; YouTube ≤ 256 GB/12 h — https://support.google.com/youtube/answer/71673; Drive 5 TB/arquivo — https://support.google.com/drive/answer/37603.

### 4.3 Detecção de encoder de hardware
1. `ffmpeg -hide_banner -encoders` (só diz o que foi compilado).
2. Encode-teste por candidato, na ordem do vendor da GPU ativa (NVIDIA: nvenc → qsv → mf → libx264; Intel: qsv → mf → nvenc → libx264 — modelo do Cap): `ffmpeg -f lavfi -i color=gray:s=256x256:r=30 -frames:v 8 -c:v h264_nvenc -f null -`. Cachear resultado por versão de driver.
3. **Fato medido na máquina do dev:** FFmpeg 9.0.1 (gyan/BtbN master) → `h264_nvenc` falha na GTX 1060 ("Required: 13.1 Found: 13.0 … minimum driver 610.00"); Pascal parou no ramo 580 → usar build BtbN **n8.1** (`ffmpeg-n8.1-latest-win64-gpl-8.1.zip`, nv-codec-headers SDK 13.0) — https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/master/README · https://raw.githubusercontent.com/BtbN/FFmpeg-Builds/master/scripts.d/50-ffnvcodec.sh. `h264_qsv` e `h264_mf` funcionaram.
4. Também detectar em runtime o suporte WebCodecs/MediaRecorder (`isConfigSupported`, `isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')`) para Windows N.

### 4.4 Corte
- `-ss` antes de `-i` + re-encode = corte exato (`accurate_seek` padrão); com `-c copy` cai no keyframe anterior — https://ffmpeg.org/ffmpeg.html. Mostrar ao usuário o keyframe efetivo: `ffprobe -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv rec.mp4`. GOP de 1 s na gravação torna o erro ≤ 1 s.

### 4.5 Thumbnails, waveform, progresso
- Tira de miniaturas: `-vf fps=1/10,scale=-2:120 -f image2 thumb_%03d.jpg`; capa: `-vf thumbnail,scale=640:-2 -frames:v 1 cover.jpg`; waveform: `-lavfi showwavespic=split_channels=1:s=1200x200 wave.png` — https://ffmpeg.org/ffmpeg-filters.html.
- Progresso: `-progress pipe:1 -nostats -hide_banner -nostdin`; percentual = `out_time_us / duração` (`ffprobe -show_entries format=duration`); usar `out_time_us` (o `out_time_ms` recebe o mesmo valor em µs — bug histórico) — https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/fftools/ffmpeg.c.
- MP4 com 2 faixas de áudio: `<video>` do Chromium só toca a faixa padrão (`audioTracks` experimental), WhatsApp API rejeita, YouTube usa só a primeira (fonte não oficial, confiança baixa) → "mixar" é o padrão em todos os presets, "separar" só em edição posterior.

---

## 5. Distribuição

- **Pacotes (pinar):** `electron-builder@26.15.7` (dist-tag `v26`; `latest`=26.15.3), `electron-updater@6.8.9`, `electron@43.4.0`; **não** adotar 27.0.0-alpha.7 / 7.0.0-alpha.6 (ESM nativo, Node ≥ 22.12, publish implícito removido, `quitAndInstall({isSilent,isForceRunAfter,waitUntilNextLaunch})`, `autoInstallEvent`, `disableWebInstaller=true`) — https://github.com/electron-userland/electron-builder/releases.
- **Config mínima:** `appId` fixo; `productName` ASCII; `nsis.artifactName: "CiaLightGravador-Setup-${version}.${ext}"` (GitHub reescreve espaços/acentos → o `latest.yml` usa o nome seguro); `publish: [{provider:"github", owner, repo, releaseType:"release"}]` (padrão é **draft**, que o updater ignora → `ERR_UPDATER_LATEST_VERSION_NOT_FOUND`); `extraResources: [{from:"resources/ffmpeg/", to:"ffmpeg/"}]` e executar `path.join(process.resourcesPath,'ffmpeg','ffmpeg.exe')` via `child_process`. Defaults NSIS: oneClick, per-user (sem UAC → update silencioso), `differentialPackage` ligado — https://raw.githubusercontent.com/electron-userland/electron-builder/electron-builder%4026.15.7/packages/app-builder-lib/src/targets/nsis/nsisOptions.ts.
- **Auto-update:** `autoUpdater.autoDownload=false; checkForUpdates()` ao abrir e a cada ~1 h; eventos `update-available → download-progress → update-downloaded` para um banner no renderer ("Nova versão X — Baixar / Reiniciar e atualizar"); `autoInstallOnAppQuit=true`; botão chama `quitAndInstall(true,true)`. Repositório **público** = sem token no cliente (GitHubProvider lê `releases.atom` + `/releases/latest`, baixa de `/releases/download/<tag>/`); token só no build. Diferencial: `.exe.blockmap` (7z não-sólido, dict 1 MB) + cópia do instalador em `%LOCALAPPDATA%\<cache>\installer.exe`; o release anterior deve manter o `.blockmap`; falha → download completo — https://raw.githubusercontent.com/electron-userland/electron-builder/electron-updater%406.8.9/packages/electron-updater/src/AppUpdater.ts. Dev: `forceDevUpdateConfig` + `dev-app-update.yml`. Notificação nativa exige atalho no Menu Iniciar/AppUserModelId (o NSIS cria).
- **CI (GitHub Actions, gratuito em repo público):**
  ```yaml
  on: { push: { tags: ['v*'] } }
  permissions: { contents: write }
  jobs:
    win:
      runs-on: windows-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 24, cache: npm }
        - uses: actions/cache@v4
          with: { path: ~\AppData\Local\electron, key: electron-${{ hashFiles('package-lock.json') }} }
        - run: npm ci
        - run: npx electron-builder --win --publish always
          env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
  ```
  `"postversion": "git push --follow-tags"` → `npm version patch` publica. Conferir que a release tem `latest.yml`, `.exe` e `.exe.blockmap`. Duração esperada 5–12 min (build comparável: 7,4 min) — https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/github-actions.md.
- **Assinatura (pragmático):** Azure Artifact Signing (US$ 9,99/mês) **não** aceita empresas do Brasil (Public Trust: EUA, CA, UE, UK, AU, NZ, JP, KR, SG, CH, NO, IL) — https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart; OV/EV exigem chave em token/HSM desde 06/2023 (US$ 300–500/ano), EV não pula mais o SmartScreen — https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview · https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation. **Começar sem assinatura:** primeiro instalador por compartilhamento de rede/Tailscale (zona intranet não recebe MotW → sem SmartScreen; instruir "Mais informações → Executar assim mesmo" se aparecer); atualizações via electron-updater não passam por SmartScreen (download pelo Node sem MotW — inferência, confiança média) e **não verificam assinatura** quando `publisherName` está ausente do `app-update.yml` (só é gravado em builds assinados). Se um dia assinar, manter o mesmo CN. Proteger o repositório (2FA, branch/tag protection) porque não há verificação de assinatura.
- **Tamanho e ffmpeg:** runtime Electron 43 zip = 144,4 MB; ffmpeg.exe ≈ 103–114 MB (34–48 MB comprimido) → instalador ~+35–45 MB (estimativa; total esperado ~130–170 MB, confiança média). Embutir (não baixar em runtime): pinar binário + sha256 num release próprio; incluir LICENSE do FFmpeg e link para o código-fonte no "Sobre" (GPLv3 se build gpl com libx264; BtbN `lgpl` mantém nvenc/qsv/mf/openh264 sem libx264) — https://ffmpeg.org/legal.html. Não depender de URLs "latest" de terceiros (BtbN retém poucos builds).

---

## 6. Benchmark de UX

**Table stakes** (todos os concorrentes relevantes têm): picker com miniaturas de tela/monitor/janela; seletor de mic e câmera + toggles independentes de sistema/mic + medidor de nível antes de gravar (Cap, Loom); contagem regressiva desligável (Loom `Settings > Video & audio > Recording countdown`; duração exata não documentada para desktop); barra flutuante pausar/retomar/reiniciar/cancelar/parar + cronômetro **fora do vídeo** (Loom "Hide only in the final video", Win10+ — https://support.atlassian.com/loom/docs/hide-the-recording-controls/); PiP redonda/retangular arrastável e redimensionável antes e durante (Loom/Zight/Cap; no Loom desktop a doc só confirma "resize/move", os 3 tamanhos são doc da extensão Chrome); atalhos globais configuráveis com aviso quando `register()` retorna false; pausa que gera arquivo contínuo; revisão com trim + presets (Cap: MP4 720p/1080p/4K a 15/30/60, presets, otimização de tamanho — https://cap.so/docs/recording/studio-mode); salvar em pasta previsível + "copiar caminho / abrir pasta / copiar arquivo" (ShareX/Screen Studio); gravação resistente a crash (OBS Hybrid MP4); checagem de disco (Cap v0.5); auto-update; faixas separadas tela/webcam para edição (Cap Studio, Tella).

**Diferenciais a incluir:** contagem 3-2-1 grande + som, desligáveis; ícone de bandeja piscando; caneta/seta/apagar por atalho com traço que some após N s (Loom: 5 s) e "apagar tudo"; realce de cliques (toggle salvo); "não perturbe" (sugerir Focus Assist do Windows — Vmaker); **estimativa de tamanho do arquivo ao vivo e por preset** (nenhum concorrente pesquisado mostra — oportunidade); ao terminar abrir revisão já com o vídeo e botões de copiar/abrir/gravar de novo; preview de câmera em tela cheia para enquadrar (Screen Studio 3.4.7); confirmação quando o mic está desligado (Cap 0.5.8); "gravar instantâneo" com a última configuração (Zight); ajuste de offset do mic na revisão (nenhum concorrente; necessário aqui).

**Atalhos recomendados (Windows, ABNT2-safe, todos configuráveis):** Ctrl+Shift+F9 iniciar/parar; Ctrl+Shift+F10 pausar/retomar; Ctrl+Shift+F11 cancelar (confirmar 2×); Ctrl+Shift+F12 mostrar/ocultar barra e preview; Ctrl+Shift+F8 reiniciar; anotações (só durante gravação): Ctrl+Shift+F5 caneta, F6 seta, F7 apagar tudo, Esc sai; Ctrl+Shift+F1 mic, F2 câmera. **Evitar:** Win+G / Win+Alt+R / Win+Alt+M / Win+Alt+PrtScn (Game Bar), Win+Shift+S / Win+Shift+R / PrtScn (Snipping Tool), Ctrl+Shift+L / Alt+Shift+P / Alt+Shift+C / Ctrl+Shift+R / Ctrl+Shift+D / Ctrl+Shift+1/2 (Loom desktop — https://support.atlassian.com/loom/docs/use-looms-keyboard-shortcuts/), Alt+Shift+6 e Ctrl+Alt+Shift+I (Zight), Shift/Ctrl/Alt+PrtScn (ShareX), **qualquer Ctrl+Alt+tecla** (AltGr = Ctrl+Alt no KBDBR), Ctrl+Shift+Esc, F1–F12 puros. Cap e OBS não têm atalhos padrão. `globalShortcut` engole a tecla e falha em silêncio se outro app já a registrou (#12418) — checar retorno e permitir remapear/"sem atalho".

**Armadilhas:** UI do gravador vazando no vídeo ou como retângulo preto (Cap #1737 — exclusão só no macOS; WDA_MONITOR em Win10 < 2004); gravações longas perdidas (Screenity, Cap); monitor errado em multi-monitor (Cap) — mostrar nome + miniatura + borda no monitor escolhido; áudio dessincronizado no export (Cap #382); atalhos que colidem ou só QWERTY (Loom); nuvem obrigatória (Loom, Recordit); excesso de opções (OBS); trocar mic depois de iniciar sem efeito (Snipping) — deixar claro o que muda durante a gravação; preview diferente do arquivo final (Cap) — o preview deve usar a mesma lógica de composição do export; contagem regressiva como janela normal quebrando a captura (bug Loom Mac) — fazer a contagem no overlay protegido.

---

## 7. Riscos técnicos (ordem de severidade)

| # | Risco | Mitigação | Plano B |
|---|---|---|---|
| 1 | **`setContentProtection` falha** e a janela do gravador/overlay aparece no vídeo (regressões #45990/#47834; mitigação WS_EX_LAYERED removida no Electron 43; compat. com WGC/DXGI só confirmada por doc do Electron + fontes secundárias) | `setOpacity(1.0)` antes; self-test no início da gravação; matriz de teste Win10 22H2 / Win11 22H2 / 24H2 a cada bump do Electron | Mover janela do gravador para o outro monitor automaticamente; esconder barra durante gravação (`Ctrl+Shift+F12`); "queimar" anotações ao vivo |
| 2 | **Robustez do caminho WebCodecs** (backpressure, MFT "silent-no-output", crash D3D11 com fila cheia, drift em sessões longas) | Padrões do Screenity (limite de `encodeQueueSize`, probe de 2 encoders simultâneos, perfil High/Baseline), watchdog, telemetria de frames perdidos, fMP4 1 s | Fallback automático para MediaRecorder por track (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`, timeslice 1000 ms → disco); remux no export |
| 3 | **Desempenho/GPU dupla** (UHD 730 + GTX 1060): encoder MFT em LUID diferente → readback; software encoder em 1080p60 | Spike de 2–3 dias medindo CPU/GPU/frames com `chrome://media-internals` e `app.getGPUInfo`; 1080p30 como padrão, 60 fps opt-in | Reduzir resolução/fps automaticamente; OpenH264 software; recomendar iGPU/dGPU via painel NVIDIA/Windows Graphics settings |
| 4 | **Overlay transparente preta/opaca** em parte das máquinas (#40515 aberta; −2 px não resolve; causas não diagnosticadas pelos mantenedores) | Detecção por thumbnail, recriar em `WM_DWMCOMPOSITIONCHANGED`/`gpu-info-update`, criar uma vez por monitor e alternar opacity | Desabilitar overlay naquela máquina (anotações só no preview/export); documentar "desativar otimizações de tela cheia"/aceleração de hardware |
| 5 | **Sincronia mic↔vídeo** (AEC Win11 +170 ms; timestamps de Web Audio; relógios distintos) | Um único Output mediabunny; EC off por padrão com headset; medir offset no spike | Ajuste manual de offset na revisão; gravar tudo em um mesmo arquivo com relógio comum |
| 6 | **Modo "janela"** perde menus/tooltips/janelas minimizadas, borda amarela no Win10, sem overlay | Padrão = monitor; aviso na UI; anotações vetoriais compostas no export | Modo "monitor recortado nos limites da janela" (bounds DWM) |
| 7 | **Sem assinatura**: SmartScreen na 1ª instalação; políticas de TI/Smart App Control; AV sinalizando hooks (uiohook #58) | Distribuir por intranet/Tailscale; uiohook opcional (só realce de cliques) em utilityProcess; documentação para TI | Comprar OV em nuvem (SSL.com/DigiCert/Sectigo — preços BR não verificados) se houver bloqueio |
| 8 | **NVENC no ffmpeg 9.x falha na GTX 1060** (driver ≥ 610); outras máquinas com GPUs antigas | Build BtbN 8.1; encode-teste + ordem nvenc→qsv→mf→libx264 | libx264 `-preset veryfast` (mais lento, sempre funciona) |
| 9 | **Updater não entrega** (release draft, nome de artefato reescrito, appId mudado, v27 alpha) | `releaseType:"release"`, artifactName ASCII, appId fixo, pin de versões, teste com `dev-app-update.yml` | Publicar release manualmente; instalador por link direto |
| 10 | **Gravações longas**: RAM/disco (5–8 GB/h), SSD sem DRAM travando com disco cheio | Streaming para disco, checagem de espaço, alerta de gravação > N min | Segmentar arquivos por hora |
| 11 | `display_id` vazio (#52232) → monitor errado | Fallback por ordem/nome + confirmação visual com borda no monitor | Picker por miniatura apenas |
| 12 | Licenças: ffmpeg GPL (libx264), libuiohook LGPL-3.0 (declarado MIT no npm, #61) | Incluir licenças/atribuição; usar BtbN lgpl se preferir | Remover uiohook (polling) e libx264 |
| 13 | Churn de APIs (getDisplayMedia pode exigir gesto de usuário — feature "experimental"; breaking changes por major) | Pin 43.x, ler breaking-changes a cada bump, teste de captura automatizado | Disparar captura a partir de clique na barra flutuante |
| 14 | Limites de plataforma mudam (WhatsApp/Instagram app não verificáveis por fonte legível) | Presets parametrizados; alvo conservador (16 MB) | Enviar como documento (2 GB) |

---

## 8. Afirmações refutadas/corrigidas na verificação (não repetir)

1. **"MP4 do MediaRecorder é sempre fMP4 em live mode sem duração"** → **Falso.** Sem timeslice, `start()` passa INT_MAX → nunca há flush forçado; o arquivo sai com `moov` **com duração** + `mfra` (Windows lê a duração). Só **com timeslice** o muxer entra em live mode (mvhd=0, sem mfra). Teste empírico Chromium 151 — https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/muxers/mp4_muxer_delegate.cc. Consequência: MediaRecorder MP4 sem timeslice é arquivo final válido (mas tudo em RAM); com timeslice, remuxar.
2. **"HEVC no MediaRecorder vale para WebM/MKV"** → HEVC (`hvc1/hev1`) é **rejeitado em `video/webm`**; só Matroska/MP4, perfil Main, feature `MediaRecorderHEVCSupport` (default desde Chrome 136) e encoder de plataforma; AAC exige `kPlatformAudioEncoder` e não ser Windows N; a lista `kVideoCodecs` inclui também `av1`, `opus`, `pcm`.
3. **"44.0.0-beta.5 usa Chromium 152/153"; "flags em release.gn"** → beta.5 usa **152.0.7977.30**; `proprietary_codecs`/`ffmpeg_branding` estão só em `build/args/all.gn`.
4. **"MP4 no MediaRecorder foi *reativado* no Chrome 126"** → foi **habilitado por padrão** no 126 (flag desde ~M120), sem histórico de remoção; H.265 exige encoder HW de plataforma e AAC encoder de plataforma.
5. **"O TypeError de `audio` ocorre se não for string nem WebFrameMain"** → o Electron aceita **três** formas: objeto `{id,name}` (escape hatch), WebFrameMain e string; e desde o PR #52455 (43.4.0) `'loopback'` vira `'loopbackWithoutChrome'` quando o renderer pediu `restrictOwnAudio`.
6. **"Issue #46369 = mic + vídeo desktop na mesma chamada"** → era **áudio desktop SEM vídeo** (`GUM_DESKTOP_AUDIO_CAPTURE` + `NO_SERVICE`), também inválido; o autor rotulou 263 errado (263 = `MSDH_INVALID_STREAM_TYPE_COMBINATION`). A regra "chamadas separadas" permanece.
7. **"WebRTC exige Win10 RS5/1809 para WGC"** → o WebRTC atual usa `IsWgcSupported()`: UniversalApiContract v8 = **Win10 1903 (18362)**, `IsSupported()`, display ativo, e **20H1** para tela; a linha "RS5" vem de um espelho desatualizado. A borda amarela só é removível com `IGraphicsCaptureSession3` (build 20348+ ≈ Win11); o Chromium não chama `RequestAccessAsync(Borderless)`.
8. **"Overlay −2 px resolve o preto (issue #27286)"** → #27286 é de Electron 11 (2021), fechada `not_planned`; a variação "menor que o display" foi testada em #40515 e **não resolveu** para os afetados; mitigação mais citada é desligar aceleração de hardware; "DWM desligado" é impreciso (crash do dwm.exe).
9. **"WhatsApp: vídeo 16 MB; documento 2 GB sem recompressão"** → 16 MB é da **Cloud API** (documento lá = 100 MB, e não aceita vídeo como documento); o **app** aceita mídia até 64 MB/480p ou 100 MB/720p (redação oficial ambígua; planejar ≤ 64 MB) e documento 2 GB — https://faq.whatsapp.com/453914586839706/; "documentos não são recomprimidos" não está em fonte oficial (inferência).
10. **"Loom: contagem de 3 s no desktop"** → a duração só aparece na doc do app Android; a doc do desktop confirma o toggle mas não o número; não há atalho documentado para o desenho.
11. **"Loom: bolha com 3 tamanhos, pinada sobre qualquer app"** → os 3 tamanhos são doc da **extensão Chrome**; no desktop a doc só diz "resize/move"; formato redondo/retangular só em fonte terceira; a bolha não aparece sobre certas janelas de sistema/PDFs.
12. **"Cap tem 8 ações de atalho e roda em macOS e Windows"** → a doc lista 9 e a UI expõe 11 ações; há build **Linux** (.deb) desde v0.5.2 (jun/2026); versão atual 0.5.9.

---

## 9. Perguntas em aberto

**Que só o usuário pode responder**
1. Quais builds do Windows rodam nas outras máquinas da Cia Light (Win10 22H2? Win11 22H2/23H2/24H2)? Define WGC vs DXGI para tela, borda amarela em modo janela e o comportamento de `setContentProtection`.
2. É aceitável que o vídeo composto (PiP + anotações) seja gerado na etapa de revisão/exportação (segundos a minutos) em vez de já sair pronto ao parar? (É o modelo Cap/Screen Studio e a base desta arquitetura.)
3. Preset "edição posterior": qual editor a equipe usa (CapCut/Premiere/DaVinci)? Basta MP4 de tela + MP4 de webcam + WAVs, ou é preciso um MKV/MP4 único com 2 faixas de áudio? Quer o mic também em WAV lossless gravado em paralelo?
4. A licença GPL do ffmpeg com libx264 é aceitável (com fonte/licença no "Sobre") ou preferem a variante LGPL (sem libx264, encoders de hardware/OpenH264 apenas)?
5. HEVC deve ser oferecido como opção "arquivo menor" (patentes; Windows Media Player exige extensão paga)?
6. Haverá orçamento para certificado OV (US$ 300–500/ano + token/HSM) ou aceitam começar sem assinatura com distribuição interna do primeiro instalador?
7. As gravações serão feitas enquanto o PC é acessado por RustDesk/RDP? (janelas protegidas ficam invisíveis remotamente → opção de desligar a proteção).
8. As anotações devem aparecer "ao vivo" na tela do apresentador apenas, ou também precisam ser visíveis para quem assiste ao vivo (ex.: reunião)? Isso decide entre overlay protegida (vetores no export) e overlay "queimada".
9. Auto-zoom/cursor suave (Screen Studio/Cap/FocuSee) entra no MVP ou fica para v2?
10. Como o WhatsApp é usado na prática (envio como vídeo ou como documento)? Define o alvo padrão do preset Pequeno (16 vs 64 MB).
11. Preferências de atalhos (as F-keys com Ctrl+Shift podem colidir com apps específicos em foco).

**Validações empíricas pendentes (spike, não dependem do usuário)**
- Janela protegida some do stream de `getDisplayMedia` e das thumbnails no Win11 (dev) e num Win10 22H2; comportamento com `setIgnoreMouseEvents(true)`.
- Encoder MFT usado pelo Chromium/WebCodecs na máquina iGPU+GTX 1060; custo de 2 `VideoEncoder` HW simultâneos a 1080p30/60 + 720p30; readback na composição 1080p/1440p.
- Offset real mic↔vídeo com EC on/off; comportamento do loopback quando o dispositivo de saída padrão muda durante a gravação.
- `track.getSettings().echoCancellation` no áudio de `getDisplayMedia` (esperado true por padrão).
- mediabunny: dois `MediaStreamVideoTrackSource` no mesmo Output em fMP4 (limite de faixas confirmado; comportamento com pause/resume a testar); trim por cópia de pacotes quando o corte não cai em keyframe.
- `h264_qsv` da UHD 730 e `h264_mf -hw_encoding 1` nas demais máquinas; tempo real do workflow no GitHub Actions.
- SmartScreen/Smart App Control não interferindo na atualização silenciosa em máquina nova (inferência por MotW).
- Se `applicationLoopback:<pid>` passado no handler funciona no Electron 43/44 em Win11 (só se loopback por app virar requisito).