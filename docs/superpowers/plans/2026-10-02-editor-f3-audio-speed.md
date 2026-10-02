# Editor F3 — Velocidade, áudio, música, silêncios e narração — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** v1.3.0. Acelerar/câmera lenta com **tom preservado** (0,1×–16×), congelar quadro, reverso, shuttle J/K/L de verdade; **música** com **ducking automático** sob a voz; **redução de ruído** e **normalização** da voz; **remover silêncios** automaticamente; **gravar narração** direto na timeline; medidores de nível. Tudo idêntico no preview e na exportação.

**Architecture:** O mixer PCM (`engine/audio/mixer.ts`) ganha um caminho de time-stretch com `signalsmith-stretch` (WASM, MIT; validado no spike F0 num Worker) com estado contínuo por segmento entre blocos; >4× silencia por padrão. Ingestão passa a gerar **intervalos de fala** (silencedetect) e **loudness** (ebur128) por asset de áudio. Denoise (`arnndn` com modelo RNNoise empacotado; fallback `afftdn`) e normalização (`loudnorm` 2 passadas, −16 LUFS) são pré-processamentos ffmpeg que geram assets `generated` em cache, usados pelo plano de áudio quando o item tem a flag. Ducking = envelope de ganho calculado em `planAudio` a partir dos intervalos de fala das faixas `role: 'voice'` aplicado às faixas `role: 'music'`. Narração = `getUserMedia` + gravação WebCodecs/MediaRecorder → asset `generated`.

**Tech Stack:** igual F1/F2 + signalsmith-stretch 1.3.2, ffmpeg (silencedetect, ebur128, loudnorm, arnndn/afftdn).

**Spec:** `docs/superpowers/specs/2026-10-01-editor-design.md` (§4 MediaItem.audio/speed/freeze/reverse, §7 Motor de áudio, §8 ingestão, §9 Inspetor Velocidade/Áudio, §10 extras: remover silêncios, denoise/normalizar, narração, §15 F3) + §18/§19. Spike: `docs/research/2026-10-01-editor-spike-results.md` (signalsmith no Worker, como carregar o WASM, medições) e `src/renderer/src/spike-editor/stretch.worker.ts`.

## Global Constraints

- Restrições globais F1/F2 (µs inteiros, `shared/editor` puro, v1 intacta, pt-BR com acentos, `close()` de frames, sem input de SO, `settings.json` do usuário intocado ou restaurado, repo público → screenshots sem dados reais).
- **Preview = exportação** também no áudio: o mesmo `mixBlock`/stretch produz os blocos dos dois caminhos; a exportação é determinística (mesmo resultado em duas exportações).
- Stretch com estado **contínuo**: blocos consecutivos de um segmento não podem ter cliques nem lacunas (verificado por teste espectral/descontinuidade).
- Velocidade > 4× com `preservePitch`: áudio mudo por padrão (configurável por item: "Manter áudio acelerado"); sem `preservePitch`: reamostragem (pitch muda).
- Pré-processamentos (denoise/normalizar) nunca alteram o original; ficam em `generated/` do projeto, com chave de cache por (asset, parâmetros).
- Todos os assets novos de modelo (RNNoise) empacotados no instalador e com licença no `NOTICE`.

## Review Focus

- Clipe com velocidade 0,5× e 2× seguido de corte: tom igual ao original (frequência dominante ±2 %), duração exata, sem clique na emenda.
- Ducking com voz começando no meio de um bloco de 100 ms: rampa suave (250 ms), música volta depois do fim da fala + hold; sem "bombeamento" em pausas curtas (< 300 ms).
- Remover silêncios num projeto com webcam + tela + anotações + efeitos vinculados: todas as faixas cortadas em sincronia, efeitos seguem os clipes, desfazer em 1 passo.
- Denoise ligado e depois desligado: volta ao original sem reprocessar; projeto aberto em outro PC sem o cache → reprocessa automaticamente.
- Gravação de narração com microfone desconectado no meio: arquivo parcial preservado e inserido, aviso claro.

---

### Task 1: Time-stretch no motor de áudio

**Files:** Create `src/renderer/src/editor/engine/audio/stretch.ts` (wrapper: carrega o WASM do signalsmith num módulo próprio, sem depender do formato do `.mjs` publicado — ver spike), `stretch.test.ts` (com fake determinístico onde o WASM não roda em node; teste real no harness); Modify `mixer.ts` (+test), `audio.worker.ts`, `src/shared/editor/project.ts`/`schema.ts` (`AudioProps.keepFastAudio?: boolean`), `src/shared/editor/audioPlan.ts` (+test: segmentos com `preservePitch`, `muted` acima de 4×), `src/main/editorTestMode.ts` + harness (cenário de stretch real), `editorExportTestMode.ts` (exportação com speed).

**Produces:**
```ts
// stretch.ts
export interface Stretcher { process(input: Float32Array /* estéreo intercalado 48k */, outFrames: number): Float32Array; reset(): void; latencyFrames: number }
export async function createStretcher(rate: number, channels: 2): Promise<Stretcher>   // rate = speed (tempo), pitch inalterado
// mixer.ts: PcmSource ganha readStretched(segKey, srcFromUs, frames, speed): Float32Array — mantém um Stretcher por segmento (chave itemId) com posição de fonte contínua; seek/descontinuidade → reset + pre-roll de latencyFrames
// audioPlan.ts: AudioSegment ganha `mode: 'copy' | 'resample' | 'stretch' | 'mute'`
```
- [ ] Testes puros: `audioPlan` escolhe o modo (1× copy; preservePitch e ≤4× stretch; >4× mute salvo keepFastAudio; sem preservePitch resample); mixer com fake stretcher garante continuidade da posição de fonte entre blocos e reset em seek.
- [ ] Harness real (Chromium + WASM): seno 440 Hz a 0,5×/1,5×/2×/4× → frequência dominante 440 ±2 %, duração ±1 bloco, descontinuidade entre blocos (energia de diferença amostra-a-amostra na emenda) ≤ 3× a média; exportação de clipe a 2× com voz sintética mantém o tom (teste em `test:editor-export`).
- [ ] Desempenho: 4 faixas com stretch ≥ 10× tempo real no worker (medir).
- [ ] commit `feat(editor): velocidade com tom preservado (signalsmith-stretch) no preview e na exportação`.

### Task 2: Velocidade, congelar, reverso e shuttle J/K/L

**Files:** Modify `ui/Inspector/SpeedPanel.tsx` (presets 0,1/0,25/0,5/0,75/1/1,25/1,5/2/4/8/16×, campo livre, "Manter tom" (preservePitch), "Manter áudio acima de 4×", botão "Congelar quadro" (cria freeze de 2 s no playhead via op), "Reverter"), `src/shared/editor/ops.ts` (+test: `freezeFrameAt(p, itemId, atUs, durationUs)` divide o item e insere um pedaço `freeze` com o quadro do playhead empurrando o resto com ripple; `setReverse(p, itemIds, reverse)` mantendo duração e vínculos/efeitos), `engine/decoderPool.ts` (reverso eficiente: decodificar o GOP que contém o tempo para trás em bloco e servir do cache, prefetch do GOP anterior), `engine/PlaybackController.ts` (taxa de reprodução: 1, 2, 4, 8 para frente; −1, −2, −4, −8 para trás; áudio esticado até 2× e mudo acima / em reverso), `ui/editorActions.ts` + `shortcuts.ts` (J/K/L clássico: L acelera 1→2→4→8, J idem para trás, K pausa, K+J/K+L quadro a quadro), timeline badge de reverso/congelado.
- [ ] Testes puros dos ops (freeze no meio/borda, reverse com keyframes espelhados no tempo, vínculos e efeitos seguem).
- [ ] Harness real: reverso exibe quadros em ordem decrescente (marcador de quadro do `testsrc2`) sem travar (≤ 1 quadro de atraso médio a 30 fps); shuttle 4× avança 4 s por segundo; reverso exportado = quadros invertidos (ffmpeg `reverse` como referência, PSNR > 30 dB).
- [ ] QA CDP (SpeedPanel, congelar, J/K/L) + screenshots `docs/qa/editor-f3/`.
- [ ] commit `feat(editor): congelar quadro, reverso e shuttle J/K/L`.

### Task 3: Análise de fala e loudness na ingestão

**Files:** Modify `src/main/media/analysis.ts` (+test), `ingest.ts`, `proxyPolicy.ts` (`derivedComplete` inclui as análises), `src/shared/editor/project.ts`/`schema.ts` (`Asset.speech?: string` (cache/<id>.speech.json), `Asset.loudness?: { integrated: number; truePeak: number; lra: number }`), `src/main/testMode.ts` (`test:ingest` cobre), `src/shared/editor/speech.ts` (+test: `parseSilencedetect(stderr) → silences`, `speechIntervals(silences, durationUs, padUs, minSpeechUs, mergeGapUs)`).
- silencedetect `n=-35dB:d=0.35` (configurável), resultado = intervalos de **fala** com padding 120 ms, mescla de lacunas < 250 ms; ebur128 → integrated LUFS, true peak, LRA. Para sessões: mic e sistema analisados separados.
- [ ] Testes puros com saídas reais de ffmpeg capturadas como fixtures.
- [ ] `test:ingest`: fala sintética (bursts de ruído rosa com pausas conhecidas) → intervalos ±50 ms; loudness de um seno −20 dBFS ≈ −23 LUFS ±1.
- [ ] commit `feat(editor): intervalos de fala e loudness na ingestão`.

### Task 4: Redução de ruído e normalização

**Files:** Add `resources/models/rnnoise/<modelo>.rnnn` (modelo do repositório GregorR/rnnoise-models — conferir licença; usar o "somnolent-hogwash" ou equivalente para voz — se a licença não permitir, usar `afftdn` com parâmetros medidos) + `scripts/fetch-models.mjs` com sha256 pinado (padrão do `fetch-ffmpeg.mjs`) + `package.json`/electron-builder `extraResources`; Modify `src/main/media/audioProcess.ts` (novo: `denoiseArgs`, `loudnormTwoPass`), `ingest.ts` (fila "processar áudio" pesada), IPC `media.processAudio(projectId, assetId, opts: { denoise: boolean; normalize: boolean })`, `src/shared/editor/audioPlan.ts` (usa o asset processado quando o item tem as flags e o processado está pronto; senão o original + indicador "processando"), `ui/Inspector/AudioPanel.tsx` (switches "Reduzir ruído (voz)" e "Normalizar volume (−16 LUFS)", status/progresso, comparar A/B segurando um botão), `NOTICE`.
- Normalização em 2 passadas (`loudnorm` measure → apply com `linear=true`), alvo −16 LUFS, TP −1,5 dB; denoise antes da normalização quando ambos.
- [ ] Testes puros de args e da chave de cache.
- [ ] `test:ingest`: voz sintética + ruído branco −30 dB → após denoise, ruído nas pausas cai ≥ 10 dB; normalização leva −30 LUFS para −16 ±1.
- [ ] commit `feat(editor): reduzir ruído e normalizar a voz (pré-processamento em cache)`.

### Task 5: Música, ducking e medidores

**Files:** Modify `src/shared/editor/project.ts`/`schema.ts` (`Project.audioMix?: { duckingDb: number (padrão −12); attackMs: 250; releaseMs: 400; holdMs: 300; enabled: boolean }`), `audioPlan.ts` (+test: envelope de ducking nas faixas `role: 'music'` a partir da união dos intervalos de fala dos itens ativos das faixas `role: 'voice'`, considerando speed/trim/reverse do item de voz; pausas < holdMs não soltam), `ui/MediaBin.tsx` aba **Áudio** (importar músicas → faixa "Música" `role: 'music'` automaticamente; prévia com play no cartão), `ui/timeline/TrackHeader.tsx` (seletor de papel da faixa: Voz / Música / Efeitos sonoros; ícone), `ui/Inspector` (painel do projeto: Ducking on/off, intensidade, ataque/soltura), medidores de nível por faixa e master (VU com pico) no cabeçalho/transport usando os níveis do `PlaybackController`, forma de onda na timeline refletindo volume (estático + keyframes, pendência F2/F4 resolvida aqui).
- [ ] Testes puros do envelope (voz no meio de bloco, pausas curtas, release, múltiplas vozes, música sem voz = ganho 1).
- [ ] Harness/export real: música (seno 220) + voz (bursts) → nível da música durante a fala −12 dB ±1, fora da fala 0 dB ±0,5, rampas monotônicas.
- [ ] commit `feat(editor): música com ducking automático e medidores de nível`.

### Task 6: Remover silêncios

**Files:** Create `src/shared/editor/silenceCut.ts` (+test: `planSilenceCuts(p, opts: { sourceTrackIds; thresholdDb; minSilenceUs; paddingUs; range? }) → { cuts: {fromUs,toUs}[]; savedUs }` usando os intervalos de fala dos assets (mapeados ao tempo de timeline considerando inUs/speed/reverse/trim), `applySilenceCuts(p, cuts)` = `deleteRange` do fim para o início em todas as faixas desbloqueadas, um passo de histórico), `ui/SilenceDialog.tsx` (faixa de voz de referência, limiar, duração mínima, margem; pré-visualização com faixas vermelhas na régua da timeline e total economizado; "Aplicar" / "Cancelar"), entrada na barra da timeline e menu.
- [ ] Testes puros (mapa de tempo com speed 2× e trim; cortes não cortam no meio de efeitos vinculados — efeitos seguem; nada é cortado em faixas bloqueadas e o diálogo avisa).
- [ ] QA CDP: projeto de gravação com fala sintética → aplicar → duração reduzida esperada ±0,2 s, webcam/tela/anotações/efeitos em sincronia (marcadores de quadro), desfazer em 1 passo.
- [ ] commit `feat(editor): remover silêncios automaticamente`.

### Task 7: Gravar narração na timeline

**Files:** Create `ui/NarrationRecorder.tsx` (botão "Gravar narração" na barra da timeline; escolhe microfone (lista do app), contagem 3-2-1, grava a partir do playhead com a timeline tocando muda (opção "ouvir o vídeo enquanto grava" com fone), VU ao vivo, parar com Espaço/Esc), `engine/narration.ts` (getUserMedia sem processamento → `MediaRecorder` Opus/WebM ou WebCodecs AAC em MP4 (preferir o que o F0/F1 já valida) → stream por IPC para `generated/narracao-<n>.m4a|webm` → asset `generated` + item numa faixa "Narração" `role: 'voice'` no tempo do início), IPC `project.writeGenerated*` (abrir/escrever/fechar, padrão do `session.write*`), recuperação de gravação interrompida (arquivo parcial vira asset com aviso).
- [ ] Testes puros do posicionamento (tempo de início compensando a latência medida do `AudioContext`).
- [ ] Teste real: Chromium com `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (tom de 440 Hz falso) em modo de teste → narração de 3 s gravada, asset criado, item no lugar certo (±50 ms), exportação contém o tom no intervalo.
- [ ] commit `feat(editor): gravar narração direto na timeline`.

### Task 8: QA, documentação e release v1.3.0

- [ ] E2E `scripts/qa/editor-f3-e2e.mjs`: gravação sintética com fala + pausas → remover silêncios → música com ducking → narração (fake device) → clipe a 2× com tom preservado → exportar → verificar com ffmpeg duração, ducking, tom.
- [ ] Docs: README, checklist, spec §20 (notas F3), NOTICE (signalsmith-stretch MIT, modelo RNNoise).
- [ ] Gate completo (unit, typecheck, test:ingest, test:editor, test:editor-export, test:capture, test:ffmpeg, todos os QA scripts) com backup/restauração do `settings.json`.
- [ ] Revisão final da branch → correções → merge → `npm version minor` → `dist:win` → smoke do empacotado (`--user-data-dir` isolado; limpar projetos criados na pasta real) → `gh release create v1.3.0`.
