# Spike técnico — resultados (18/08/2026)

Máquina: Windows 11 Pro 26200, i5-13400, Intel UHD 730 (GPU ativa do Chromium) + GTX 1060, 2 monitores 1920×1080 (escala 1.0), webcam EMEET SmartCam S600, headset HG04.
Electron 43.4.0 / Chromium 150.0.7871.224 / Node 24.18.1 · mediabunny 1.55.1 · ffmpeg BtbN n8.1.2 (gpl).

Execução: `npm run spike` (modo `CIALIGHT_SPIKE=1`), sequência automática em `src/renderer/src/spike/recordSpike.ts` + `src/main/spike/spikeMain.ts`. Duas rodadas: 1080p30/15 s (pausa 5→8 s) e 1080p60/20 s (pausa 5→8 s). Artefatos em `spike-out/` (ignorado no git); imagens-chave copiadas para `docs/research/spike/`.

| # | Suposição | Resultado | Evidência |
|---|---|---|---|
| A | `getDisplayMedia` sem gesto de usuário (necessário para iniciar por atalho global) | **OK** — funciona ao carregar a página, sem clique | log `[A:no-gesture-onload] getDisplayMedia OK` |
| B | Janela do gravador e overlay com `setContentProtection(true)` **não aparecem** na captura (thumbnail e stream) | **OK** — `protected.png` mostra só o Chrome por baixo; `unprotected.png` mostra as duas janelas; frame do `rec.mp4` gravado com proteção ligada não contém as janelas | `docs/research/spike/protected.png`, `unprotected.png`, `frame-screen-4s.png` |
| C | 4 faixas (tela H.264, webcam H.264, mic AAC, sistema AAC) num único fMP4 via mediabunny, com pausa contínua | **OK** — ffprobe: 2× h264 High (1920×1080 e 1280×720) + 2× aac LC 48 kHz; duração 12,0 s (15 − 3 de pausa) e 17,0 s (20 − 3), todas as faixas iguais ±0,2 s; 60 fps → avg 59,3 fps; arquivo abre no Chrome/WMP | `spike-out/report.json` (probe) |
| D | Encoder H.264 por hardware e custo baixo | **OK** — `VideoEncoder.isConfigSupported(prefer-hardware)` = true para 720p30, 1080p30, 1080p60; **false para 1440p30 com `avc1.640028`** (nível 4.0 não cobre 1440p — usar nível 5.0/5.1, `avc1.640032`); CPU: renderer ≈ 1 %, GPU ≈ 3 % (getAppMetrics), gravando 1080p60 + 720p30 + 2 áudios | log `isConfigSupported …`, `cpuSamples` |
| E | Overlay transparente click-through; interativa sob demanda | **OK** — transparente (após corrigir o CSS do body), clique físico via `mouse_event` chega à overlay quando `setIgnoreMouseEvents(false)` e passa por ela quando `true` | log `overlay event: pointerdown`, `unprotected.png` |
| F | `globalShortcut` Ctrl+Shift+F9 dispara com outro app em foco | **OK** — SendKeys com o Chrome em primeiro plano disparou o atalho | log `globalShortcut Ctrl+Shift+F9 disparado`, `foreground=… Google Chrome` |
| G | Áudio do sistema por `audio:'loopback'` com processamento desligado; mic separado | **OK** — faixa de sistema `deviceId: loopbackWithoutChrome`, EC/NS/AGC=false, 48 kHz stereo; som tocado por outro processo aparece (mean −27 dB, max −9 dB); mic capturado (max 0 dB com AGC) | log `áudio do sistema: {...}`, `audio` no report |

Outros fatos observados:
- `desktopCapturer.getSources` preenche `display_id` para as duas telas (`screen:0:0` → 915479809, `screen:1:0` → 3421553159); janelas vêm com nome e miniatura.
- Latências: `getDisplayMedia` ≈ 1,3–2 s; câmera + mic ≈ 2,5 s; `output.finalize()` < 100 ms.
- Taxa gravada 1080p30 a 12 Mbps VBR ficou em ≈ 4,3–4,5 Mbps (conteúdo estático) — a estimativa de tamanho deve usar o bitrate real medido, não o nominal.
- `restrictOwnAudio:true` é honrado (Electron 43.4.0 → `loopbackWithoutChrome`).

Decisões derivadas para o plano da Fase 1:
1. Manter a arquitetura da spec sem alterações.
2. Para 1440p usar `fullCodecString` com nível ≥ 5.0 (ou deixar o mediabunny escolher e validar por `isConfigSupported` antes de gravar; fallback para 1080p com aviso).
3. Overlay/barra: garantir `background: transparent` em html/body das páginas transparentes.
4. Estimativa de tamanho ao vivo = bytes escritos / tempo (bitrate real).
