# Spike F0 do editor — resultados medidos (01/10/2026)

Spec: `docs/superpowers/specs/2026-10-01-editor-design.md` (§2, §3, §6, §7, §11, §17).
Como reproduzir: `npm run spike:editor` (env `CIALIGHT_SPIKE=editor`). Gera a mídia de teste com o ffmpeg
embutido em `spike-out/editor-media/`, serve via `cialight-file://media/<arquivo>` (Range), abre
`editor-spike.html`, roda tudo sozinho, grava `spike-out/editor-spike.json` (com ffprobe das saídas) e sai.
Variáveis: `CIALIGHT_SPIKE_ONLY=webgl,decode,concurrent,encode,stretch,audio,reclaim`, `CIALIGHT_SPIKE_IDLE_S`
(ociosidade do teste de reclaim, padrão 100), `CIALIGHT_SPIKE_NOFLAG=1` (sem `--disable-features`),
`CIALIGHT_SPIKE_BGTHROTTLE=1`, `CIALIGHT_SPIKE_REPORT=<nome>.json`.

Código: `src/main/spike/editorSpikeMain.ts`, `src/renderer/editor-spike.html`, `src/renderer/src/spike-editor/*`.
O modo spike do editor ignora o single-instance lock (o app instalado usa o mesmo userData `cialight-gravador`).

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Intel Core i5-13400, **Intel UHD Graphics 730** (iGPU, sem GPU dedicada), Windows 11 Pro 26200 |
| Electron / Chromium / Node | 43.4.0 / 150.0.7871.224 / 24.18.1 |
| WebGL2 (worker) | `ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| mediabunny | **1.61.0** (de 1.55.1) |
| twgl.js | **7.0.0** |
| signalsmith-stretch | **1.3.2** |
| Mídia de teste | testsrc2 1080p30 10 s H.264 GOP 60 (2 s) e GOP 15 (0,5 s) + AAC 1 kHz; HEVC (libx265, `hvc1`); VP9+Opus WebM; H.264 4K (baseline, ultrafast); PNG 1080p; MP3 440 Hz 44,1 kHz |

## 1. Upgrade mediabunny 1.55.1 → 1.61.0 — PASSOU

`npm test` 216/216 e `npm run typecheck` OK **sem nenhuma alteração** no código v1
(`RecordingEngine.ts`, `exportComposer.worker.ts`, `recordSpike.ts`). Nenhuma quebra de API nas classes usadas.

API 1.61 usada no spike (nomes exatos):
- Leitura: `new Input({ source: new UrlSource(url), formats: ALL_FORMATS })`, `input.getPrimaryVideoTrack()` /
  `getPrimaryAudioTrack()`, `track.canDecode()`, `track.getDecoderConfig()`, `track.computePacketStats(n)`
  (`averagePacketRate`, `averageBitrate`), `input.computeDuration()`, `input.dispose()`.
- Vídeo: `new VideoSampleSink(track, { hardwareAcceleration })` → `getSample(t)`, `samples(start, end)`,
  `samplesAtTimestamps(ts)`. `VideoSample.toVideoFrame()` devolve um `VideoFrame` que **deve ser fechado à parte**
  (além de `sample.close()`); `toCanvasImageSource()` só vale na mesma microtask.
- Áudio: `new AudioSampleSink(track).samples()` / `getSample(t)`; `AudioSample.copyTo(buf, { planeIndex, format: 'f32-planar' })`.
- Pacotes: `new EncodedPacketSink(track).packets()` + `packet.toEncodedVideoChunk()` (para `VideoDecoder` cru).
- Escrita: `new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })`;
  `new VideoSampleSource({ codec: 'avc'|'hevc', bitrate, keyFrameInterval: 2, latencyMode: 'quality', hardwareAcceleration, onEncoderConfig, onEncodedPacket })`;
  `new AudioSampleSource({ codec: 'aac', bitrate: 128e3, onEncoderConfig })`; `output.addVideoTrack(src, { frameRate: 30 })`,
  `output.addAudioTrack(asrc)`, `start()`, `src.add(new VideoSample(canvas, { timestamp, duration }))`,
  `asrc.add(new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: 48000, timestamp }))`,
  `vsrc.close()`, `asrc.close()`, `finalize()`. Helpers: `canEncodeVideo(codec, {width,height})`, `canEncodeAudio(codec, {sampleRate, numberOfChannels})`.

## 2. WebGL2 em Worker + VideoFrame como textura — PASSOU

`canvas.transferControlToOffscreen()` → worker → `getContext('webgl2')` funcionou. Upload: `gl.texImage2D(TEXTURE_2D, 0, RGBA8, RGBA, UNSIGNED_BYTE, videoFrame)`
direto do `VideoFrame` (formato decodificado **NV12**, conversão feita pelo ANGLE), depois cópia para FBO com flip de Y
(o VideoFrame entra com a linha 0 em cima; FBOs seguem a convenção GL). Tempos com sync por `readPixels` 1×1 (conservador), 90 frames 1080p:

| Etapa (ms/frame, 1080p) | mediana | p95 |
|---|---|---|
| Upload VideoFrame → textura → FBO | 4,0 | 5,8 |
| Só apresentar (cópia para o canvas) | 2,7 | 4,0 |
| Blur gaussiano separável **resolução cheia** (r=24, σ=10, quadro inteiro) + pixelização + composição | 16,9 | 52,4 |
| Mesmo com **downsample 2×** no blur | **4,4** | 11,9 |
| Pipeline completo (decode+upload+efeito+present, alternando os 3 modos) | 13,9 | 59,2 → **49–53 fps** |

Verificação por leitura de pixels (ruído aleatório como entrada, energia de alta frequência média |ΔL|):
blur 169,9 → **0,26**; pixelização 169,9 → **3,4** (só nas bordas das células); fora das regiões 170,0 → 170,0 (intacto).
Imagem de prova: `spike-out/editor-media/webgl-effects.png`. Conclusão: blur cheio na iGPU é caro e com picos;
**usar downsample (2× ou mais) e scissor só na região** como a spec já prevê.

## 3. Decodificação — PASSOU (HEVC só por hardware)

| Arquivo | codec string | canDecode | HW / SW suportado | 1º frame | sequencial | seek aleatório (20×) mediana / p95 |
|---|---|---|---|---|---|---|
| H.264 1080p GOP 2 s | avc1.640028 | sim | sim / sim | 21 ms | 602 fps | 54,8 / 71,5 ms |
| H.264 1080p GOP 0,5 s | avc1.640028 | sim | sim / sim | 18 ms | 708 fps | **32,9 / 39,3 ms** |
| HEVC 1080p | hev1.1.6.L120.90 | sim | sim / **não** | 12 ms | 1007 fps | 42,2 / 53,2 ms |
| VP9 1080p | vp09.00.40.08… | sim | sim / sim | 10 ms | 1206 fps | 38,3 / 50,1 ms |
| H.264 4K | avc1.42c033 | sim | sim / sim | 54 ms | 204 fps | 169,9 / 228 ms |

`getSample(t)` devolveu sempre o frame correto (maior timestamp ≤ t): 0 erros em 100 seeks. PNG 1080p via
`createImageBitmap`: 18 ms. GOP 0,5 s reduziu a latência de seek em ~1,7× (não 5×, mas o arquivo é curto e o GOP longo era só 2 s).

**Decoders simultâneos** (Inputs separados, cada um decodificando 2 s de 1080p ao mesmo tempo): **10 de 10 sem falha**,
tanto `prefer-hardware` quanto `no-preference`; vazão agregada estável em ~440–470 fps (≈ 15 faixas 1080p30 em tempo real).
Não houve teto de decoders nesta Intel (o limite de NVDEC citado na spec não se reproduz aqui).

## 4. Codificação — PASSOU (AAC disponível)

Suporte (`VideoEncoder/AudioEncoder.isConfigSupported`): H.264 High/Main 1080p e High 5.1 4K: HW e SW sim; **HEVC: só HW**;
VP9 HW e SW; AV1 só SW; **AAC-LC `mp4a.40.2` 48 k/44,1 k estéreo: sim**; HE-AAC não; Opus sim; FLAC não.

| Saída (10 s 1080p30 + AAC 10 s) | fps | ×tempo real | ffprobe |
|---|---|---|---|
| H.264 `prefer-hardware`, cena 2D sintética | 172,9 | 5,8× | h264 High 1920×1080, 300 frames, 10,000 s + aac LC 48 kHz 2 ch 10,005 s |
| H.264 `prefer-software` (OpenH264) | 148,2 | 4,9× | idem |
| HEVC `prefer-hardware` | 149,8 | 5,0× | hevc Main (tag hvc1), 300 frames + aac |
| **Ponta a ponta**: decode H.264 → WebGL2 (blur ds2 + pixelate) → `VideoSample(canvas WebGL)` → H.264 HW + AAC | **64,5** | **2,15×** | h264 High 300 frames + aac; frame em 5 s mostra “00:00:05.000 / 150” (frame-exato) |

Volume do AAC: média −13,5 dB, pico −10,4 dB (senoide 0,3 → correto). Reabrir o MP4 gerado com `AudioSampleSink`
dá 439,8 Hz. `new VideoSample(offscreenCanvasWebGL)` funcionou com `preserveDrawingBuffer: false` (captura na mesma task).
Obs.: o teste de VideoEncoder cru com quadro repetido (205 fps HW × 229 fps SW) não discrimina HW/SW; a prova de que existe
encoder de hardware é o HEVC (sem fallback SW) funcionando.

## 5. Time-stretch signalsmith-stretch 1.3.2 — PASSOU (em Worker comum)

Sinal tipo voz: 220 Hz + harmônicos, AM 4 Hz, pausa 2,00–2,25 s, 5 s estéreo 48 kHz. Preset default: latência entrada/saída
2880/2880 amostras (60 ms cada), carga do módulo 22 ms.

| Modo | rate | amostras (esperado = obtido) | f dominante | pausa medida (esperada) | ×tempo real (saída) |
|---|---|---|---|---|---|
| Worker, streaming `process(in,out)` | 0,5 | 480000 | 220 Hz | 4,035–4,47 s (4,0–4,5) | 65,7× |
| | 1,5 | 160000 | 220 Hz | 1,345–1,485 (1,333–1,5) | 68,4× |
| | 2 | 120000 | 220 Hz | 1,015–1,105 (1,0–1,125) | 65,6× |
| | 4 | 60000 | 220 Hz | 0,52–0,545 (0,5–0,563) | 58,4× |
| Worker, estilo worklet (`seek`+`process(0,B)`) | 0,5/1,5/2/4 | exatos | 221/220/220/220 | equivalentes | 48–58× |
| AudioWorkletNode oficial em `OfflineAudioContext` | 0,5/1,5/2/4 | exatos | 221/220/220/220 | equivalentes | 44–48× |

Pitch preservado em todas as velocidades; timing alinhado (pausa desloca ≤ 45 ms por suavização da janela de 120 ms).
Não foi preciso tentar `@soundtouchjs`.

**Como carregar no Worker sob Vite**: o pacote só exporta a fábrica de `AudioWorkletNode`; a fábrica emscripten crua fica
no início do `.mjs` e o WASM vem **embutido em base64** (sem arquivo `.wasm`). Em `stretch.worker.ts`:
`import src from 'signalsmith-stretch?raw'` → `src.slice(0, src.indexOf('function registerWorkletProcessor')) + 'export default SignalsmithStretch;'`
→ `import(URL.createObjectURL(new Blob([code], {type:'text/javascript'})))` → `const m = await factory(); m._main(); m._presetDefault(ch, 48000)`;
`ptr = m._setBuffers(ch, len)` com `len = m._inputLatency() + m._outputLatency()`; buffers de entrada em `ptr + len*4*c`, saída em
`ptr + len*4*(c+ch)` sobre `m.HEAP8.buffer` (re-obter a view após cada chamada). Streaming: `m._process(nIn, nOut)` com
`nIn ≈ nOut*rate`, atraso = `outLat + inLat/rate` amostras (descartar), `m._flush(n)` no fim. Recomendação: vendorizar esse
recorte num módulo próprio (`engine/audio/stretchWasm.ts`) com teste, em vez de depender do formato do arquivo publicado.
Para o AudioWorklet oficial a CSP precisa de `script-src blob: 'wasm-unsafe-eval'`.

**Atualização F3 (implementação):** em vez do recorte do `.mjs`, `scripts/vendor-signalsmith.mjs` extrai só o binário
WASM e o mapa dos nomes minificados (imports `a.a–a.d`, exports `e–y`) para `engine/audio/signalsmithWasm.ts`
(sha256 conferido em teste); `engine/audio/stretch.ts` instancia o WASM direto com 4 imports próprios (abort, memcpy,
resize_heap, random_get determinístico) — sem glue emscripten, blob nem eval; roda no worker, e também no Node (vitest
com o WASM real). Pré-roll após reset: `seek` com `latencyFrames` de histórico até `base + inputLatency` e descarte de
`outputLatency` frames de saída (sem isso a saída começa com ~50 ms de rampa). Medida: um stretcher ≈ 50–60× tempo real;
4 faixas no audio worker ≈ 12×. Atenção: nesta máquina (i5-13400, plano Equilibrado) qualquer carga contínua cai ~10×
depois de ~2 s (laço puro no Node: 7000 → 600 it/s) — medidas longas refletem esse estrangulamento, não o código.

## 6. `--disable-features=ReclaimInactiveWebCodecs` — PASSOU (inofensivo; reclaim não reproduzido)

Com a flag (`app.commandLine.getSwitchValue('disable-features')` = `ReclaimInactiveWebCodecs`) todos os testes acima passaram.
Teste dedicado: `VideoDecoder` cru + iterador do `VideoSampleSink` abertos, ociosos 155 s com a janela minimizada:

| Variante | estado após ócio | decode cru após ócio | iterador do sink |
|---|---|---|---|
| com flag | configured, 0 erros | OK (30/30) | OK (30 frames) |
| sem flag | configured, 0 erros | OK | OK |
| sem flag + `backgroundThrottling: true` | configured, 0 erros | OK | OK |

Gotcha: no Electron a página minimizada continua `visibilityState: 'visible'`, então o reclaim (que mira páginas em segundo
plano) não disparou nem sem a flag. Manter a flag por precaução + pool LRU com recriação transparente.

## 7. AudioSampleSink (PCM) — PASSOU

| Fonte | codec | taxa/canais | formato do AudioSample | duração PCM | f dominante | ×tempo real | getSample mediana |
|---|---|---|---|---|---|---|---|
| MP3 | mp3 | 44100/2 | **s16-planar** | 5,042 s | 440 Hz | 202× | 0,2 ms |
| AAC no MP4 | mp4a.40.2 | 48000/2 | f32-planar | 10,027 s (1º ts **−0,021 s**, priming) | 1000 Hz | 262× | 0,6 ms |
| Opus no WebM | opus | 48000/2 | **f32 (intercalado)** | 10,014 s | 999,8 Hz | 190× | 0,7 ms |

O formato nativo varia; usar sempre `copyTo(..., { format: 'f32-planar' })`. O timestamp negativo do AAC deve ser tratado no `AudioEngine`.

## Conclusões por risco (§17)

| Risco | Resultado | Plano B necessário? |
|---|---|---|
| WebGL2 em worker indisponível/instável | Funciona (ANGLE/D3D11 na iGPU), efeitos verificados | Não; manter Canvas2D como fallback só se `getContext('webgl2')` falhar |
| Encoder AAC indisponível | AAC-LC 48 kHz OK via mediabunny | Não; Opus também disponível |
| Desempenho 4+ faixas 1080p | Decode agregado ~450 fps; pipeline com blur ds2 ~50 fps; export e2e 2,15× | Downsample obrigatório no blur; resolução adaptativa |
| signalsmith no worker | OK, 58–66× tempo real | Não |
| HEVC sem decoder SW | HEVC só decodifica/codifica por HW | Proxy H.264 na ingestão quando `canDecode()` = false |

## Ajustes recomendados à spec

1. §6: blur sempre com downsample (≥2×) e scissor na região; blur cheio custa ~17 ms (p95 52 ms) na iGPU.
2. §6: “máximo 6 decoders” é conservador para Intel; manter LRU, mas o limite pode ser configurável (10 simultâneos sem falha).
3. §8: decidir proxy por `track.canDecode()` (HEVC em máquina sem HW) — não só por GOP; GOP 0,5 s dá ~1,7× no seek.
4. §7: stretch em Worker comum via módulo vendorizado (streaming `process`), não AudioWorklet; tratar timestamp negativo do AAC e formatos s16/f32 intercalados.
5. §11: `VideoSample(canvasWebGL)` + `VideoSampleSource` H.264 `prefer-hardware` + `AudioSampleSource` AAC validado ponta a ponta; HEVC opcional só quando `isConfigSupported` HW.
6. CSP do editor: `connect-src cialight-file:` e, se usar AudioWorklet, `script-src blob: 'wasm-unsafe-eval'`.
