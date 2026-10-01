# CiaLight Gravador — Editor de vídeo (v2) — Especificação de design

Data: 2026-10-01 · Base: app v1.0.1 (`2026-08-18-cialight-gravador-design.md`) · Abordagem aprovada: **A — motor próprio, compositor único para preview e exportação**.

## 1. Objetivo

Transformar a tela de Revisão do Gravador num **editor não-linear completo** (estilo CapCut/Premiere) dentro do mesmo app, capaz de editar gravações do próprio app **e** mídia importada (vídeos, imagens, áudios), do início ao fim, sem precisar de outro programa:

- timeline multifaixa (vídeo/overlay/texto/efeitos/áudio), cortar/dividir em qualquer ponto, apagar trechos (com ripple), mover, duplicar, separar áudio do vídeo;
- **blur / pixelização / tarja** em regiões desenhadas (retângulo, elipse), movíveis, redimensionáveis, com keyframes no tempo, liga/desliga por intervalo — para esconder dados sensíveis;
- velocidade (0,1×–16×) com áudio de tom preservado, congelar quadro, reverso (imagem);
- zoom/pan, posição/escala/rotação/opacidade/corte com keyframes e curvas;
- transições, fade in/out de vídeo e de áudio, textos e animações de entrada/saída;
- música: importar, cortar, volume, fades, **ducking automático** sob a voz;
- desfazer/refazer ilimitado, autosave, exportação com presets.

Usuário (Eduardo/Cia Light) delegou as decisões de design e a aprovação das etapas (01/10/2026): "ir aprovando as melhores coisas … sem achismo, validando … adicionando coisas que ajudariam". Requisitos: **não quebrar o fluxo v1** (gravar → revisar → exportar continua funcionando), validar tudo com testes reais.

## 2. Evidências que fundamentam o design

Pesquisa de 01/10/2026 (fontes nos relatórios dos agentes; resumo):

| Fato | Consequência |
|---|---|
| Nenhum editor open-source é adotável como dependência: Remotion/OpenVideo (licença paga >3 funcionários), Diffusion Studio (marca d'água), etro/Shotcut/Olive (GPL), OpenCut em reescrita Rust. | Motor e timeline próprios. |
| **opencut-classic** (MIT, arquivado 2026-05) usa mediabunny `CanvasSink`/`CanvasSource`+`AudioBufferSource`, modelo `tracks{main,overlay[],audio[]}`, `retime{rate,maintainPitch}`, keyframes bezier, máscaras com feather, undo por Command. | Referência de código (adaptar com atribuição em `NOTICE`), não dependência. |
| `<video>` não garante seek frame-exato; `preservesPitch` do Chromium fica **mudo fora de 0,5×–4×**. | Preview por WebCodecs (mediabunny sinks), áudio por motor próprio + stretch WASM. |
| Latência de seek cai ~5× com GOP 0,5 s vs GOP único (vos#227). | Proxies short-GOP para mídia com GOP longo. |
| Chromium recupera ("reclaim") decoders inativos > 1 min; hardware tem teto de decoders simultâneos (ex.: NVDEC falha no 6º). | `--disable-features=ReclaimInactiveWebCodecs` + pool LRU de decoders com recriação transparente. |
| ffmpeg embutido (BtbN n8.1.2 gpl-shared) tem `rubberband`, `atempo`, `silencedetect`, `afftdn`, `arnndn`, `loudnorm`, `vidstab*`, encoders nvenc/qsv/**amf**/mf/libx264. `h264_amf` não é detectado hoje. | ffmpeg para ingestão, análise (silêncio/loudness), denoise; incluir AMF no probe. |
| `ffmpeg filter_complex` expressa mal blur com região de tamanho variável/animado, `xfade` exige entradas homogêneas, `drawtext` ≠ tipografia do canvas. | Exportação **renderizada pelo mesmo compositor** do preview (WebGL2 + WebCodecs), não por filtergraph. |
| `signalsmith-stretch` 1.3.2 (MIT, WASM), `dnd-timeline` 3.1.1 (MIT), `immer` 11, `twgl.js` 7 (MIT). | Dependências candidatas — confirmadas no spike F0. |

## 3. Arquitetura

```
main/
  project/   projectStore.ts  (pasta por projeto, project.json atômico, autosave, versões)
  media/     ingest.ts        (ffprobe → MediaInfo; decide proxy; fila de jobs)
             proxy.ts         (ffmpeg → proxy H.264 GOP 0,5 s 720p/1080p; intermediário para codec não decodificável)
             analysis.ts      (miniaturas/filmstrip, peaks de áudio, silencedetect, loudness)
  export/    (v1 intacto) + editorExport.ts (grava stream do worker, remux/faststart, fallback libx264)
  fileProtocol.ts  (+ host "media": serve só arquivos registrados em assets de projetos)
renderer/src/editor/
  model/     (TS puro, em shared/editor) tipos, ops, keyframes, timeMap, validação zod
  state/     editorStore (zustand + immer, histórico de snapshots, seleção, playhead, zoom)
  engine/
    render.worker.ts   OffscreenCanvas WebGL2: DecoderPool + Compositor (preview e export)
    audio/             AudioEngine (mixer TS puro em worker) + stretch (signalsmith) + scheduler WebAudio
    PlaybackController relógio mestre = AudioContext.currentTime; envia t ao worker
  ui/        EditorScreen, Viewer (canvas transferido), Timeline, Inspector, MediaBin, ExportDialog
shared/editor/   project.ts (tipos+schema), ops.ts, keyframes.ts, timeMap.ts, resolve.ts (o que está ativo em t), audioPlan.ts
```

Processos: a UI React nunca decodifica nem compõe. O **render worker** possui o `OffscreenCanvas` do Viewer (via `transferControlToOffscreen`) e, na exportação, um segundo canvas offscreen do tamanho de saída. O **audio worker** produz blocos PCM; no preview eles são agendados como `AudioBufferSourceNode` no `AudioContext` do renderer (padrão do exemplo `media-player` do mediabunny), na exportação vão direto ao `AudioSampleSource` do mediabunny.

### 3.1 Princípio "preview = exportação"

Preview e exportação chamam **as mesmas funções**: `resolveFrame(project, tUs)` (shared, puro) → lista de camadas com tempo-fonte e parâmetros já interpolados → `Compositor.draw(layers)`. Áudio: `planAudio(project)` → `AudioEngine.render(fromUs, toUs)`. Diferenças permitidas: no preview a resolução de render pode ser reduzida (½ durante reprodução, cheia em pausa) e usa proxy; na exportação usa o original em resolução cheia.

## 4. Modelo de dados (`shared/editor/project.ts`)

Tempos em **microssegundos inteiros** (`Us`), sem float acumulado. Coordenadas espaciais normalizadas ao quadro do projeto (0–1, origem no canto superior esquerdo), ângulos em graus.

```ts
interface Project {
  version: 1; id: string; name: string; createdAt: string; updatedAt: string
  canvas: { width: number; height: number; fps: number; background: string }   // ex.: 1920×1080@30, '#000000'
  assets: Asset[]
  tracks: Track[]              // ordem = ordem de empilhamento (índice 0 = fundo) para visuais; áudio à parte
  markers: { id: string; tUs: number; label: string; color: string }[]
  originSessionId?: string     // quando criado a partir de uma gravação
}
type AssetSource =
  | { type: 'session'; sessionId: string; stream: 'screen' | 'webcam' | 'mic' | 'system' }
  | { type: 'file'; path: string; size: number; mtimeMs: number }      // referência ao original (sem copiar)
  | { type: 'generated'; file: string }                                // dentro da pasta do projeto (ex.: gravação de narração)
interface Asset {
  id: string; name: string; kind: 'video' | 'audio' | 'image'; source: AssetSource
  durationUs: number | null    // null para imagem
  video?: { width: number; height: number; fps: number; codec: string; rotation: 0|90|180|270; decodable: boolean }
  audio?: { channels: number; sampleRate: number; codec: string }
  proxy?: string; intermediate?: string   // arquivos na pasta do projeto
  status: 'ready' | 'processing' | 'missing' | 'error'; error?: string
}
interface Track {
  id: string; kind: 'video' | 'audio'; name: string
  muted: boolean; hidden: boolean; locked: boolean; volume: number /* 0–2 */
  items: Item[]                // ordenados por startUs, sem sobreposição dentro da faixa
}
type Item = MediaItem | TextItem | ShapeItem | EffectItem
interface ItemBase { id: string; startUs: number; durationUs: number; name?: string; linkId?: string /* vídeo↔áudio vinculados */ }
interface MediaItem extends ItemBase {
  type: 'media'; assetId: string
  inUs: number                 // ponto de entrada na fonte
  speed: number                // 0.1–16; durationUs = (fonteUsada)/speed
  reverse: boolean; freeze?: { atUs: number }  // congelar quadro
  audio: { enabled: boolean; volume: Anim<number>; fadeInUs: number; fadeOutUs: number; preservePitch: boolean; denoise: boolean }
  visual?: VisualProps         // ausente em faixa de áudio
  transitionIn?: Transition    // transição com o item anterior adjacente na mesma faixa
}
interface VisualProps {
  transform: { x: Anim<number>; y: Anim<number>; scale: Anim<number>; rotation: Anim<number>; opacity: Anim<number> }  // x/y = centro
  crop: { l: number; t: number; r: number; b: number }
  fit: 'contain' | 'cover' | 'fill'
  fadeInUs: number; fadeOutUs: number
  animIn?: { preset: AnimPreset; durationUs: number }; animOut?: { preset: AnimPreset; durationUs: number }
  adjust?: { brightness: number; contrast: number; saturation: number }
  shape?: 'rect' | 'rounded' | 'circle'; radius?: number; border?: { width: number; color: string }  // p/ webcam PiP
}
interface TextItem extends ItemBase { type: 'text'; text: string; style: TextStyle; visual: VisualProps }
interface ShapeItem extends ItemBase { type: 'shape'; shape: 'rect'|'ellipse'|'arrow'; fill: string; stroke: string; strokeWidth: number; visual: VisualProps }
interface EffectItem extends ItemBase {
  type: 'effect'
  effect: 'blur' | 'pixelate' | 'solid'      // tarja sólida = esconder 100% garantido
  region: { shape: 'rect' | 'ellipse'; x: Anim<number>; y: Anim<number>; w: Anim<number>; h: Anim<number>; rotation: Anim<number> }
  strength: Anim<number>; feather: number; color: string; invert: boolean   // invert = borrar tudo menos a região
  scope: 'below' | 'track'      // afeta todas as camadas abaixo (padrão) ou só a faixa logo abaixo
}
// também existe o item especial 'annotations' (strokes da gravação v1) — type 'annotations', referencia sessionId, usa o renderer de traços existente
interface Anim<T> { value: T; keys?: Keyframe<T>[] }       // sem keys = constante
interface Keyframe<T> { tUs: number /* relativo ao início do item */; value: T; ease: 'linear'|'hold'|'in'|'out'|'inOut'|{ bezier: [number,number,number,number] } }
interface Transition { kind: 'crossfade'|'dipBlack'|'dipWhite'|'slideL'|'slideR'|'slideU'|'slideD'|'wipeL'|'wipeR'|'zoomIn'|'blur'; durationUs: number }
```

Invariantes (validadas por zod + `validateProject`): itens não se sobrepõem na mesma faixa; `inUs + durationUs*speed ≤ asset.durationUs`; keyframes ordenados e dentro do item; transição ≤ min(duração dos dois itens)/2. Migração: `project.version` com `migrateProject()` desde a v1.

**Gravação → projeto** (`fromSession`): faixa vídeo "Tela" (screen), faixa vídeo "Webcam" com `visual.shape` e keyframes de transform convertidos dos `PipKeyframe` (hold + rampa de 150 ms, igual ao compositor v1), item `annotations`, faixas de áudio "Microfone"/"Sistema" vinculadas (`linkId`) aos itens de vídeo, marcadores da sessão → markers. Assim **tudo que a v1 fazia continua editável**.

## 5. Operações de edição (`shared/editor/ops.ts`, puras e testadas)

`addAsset`, `insertItem(track, at, mode: 'overwrite'|'insert')`, `split(itemIds, atUs)` (respeita keyframes: reparte e reancora), `trimStart/trimEnd(item, deltaUs, ripple)`, `moveItems(ids, deltaUs, toTrack?)` com **snap** (playhead, bordas de itens, marcadores; tolerância em px convertida pelo zoom), `rippleDelete(ids)`, `deleteRange(trackIds|'all', fromUs, toUs)` (apaga trecho em todas as faixas desbloqueadas — "cortar o meio"), `detachAudio(item)`, `link/unlink`, `setSpeed(item, speed)` (recalcula duração), `freezeFrame(at)`, `duplicate`, `setKeyframe/removeKeyframe(item, prop, tUs, value)`, `addTransition`, `addTrack/removeTrack/reorderTrack`, `closeGaps(track)`. Itens vinculados se movem/cortam juntos (Alt ignora o vínculo).

Histórico: store zustand + immer; cada operação = um snapshot (compartilhamento estrutural); gestos contínuos (arrastar, slider) abrem **transação** e geram uma única entrada ao soltar. Limite 300 entradas. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.

## 6. Motor de render (render worker)

- **DecoderPool**: por asset, um `Input` mediabunny (`UrlSource` em `cialight-file://media/<projectId>/<assetId>[?proxy]`) e `VideoSampleSink`. Mantém no máximo 6 decoders vivos (LRU); prefetch do próximo item de cada faixa 1 s antes; `getFrame(assetId, srcUs)` devolve o `VideoSample` com maior timestamp ≤ srcUs (iterador sequencial durante play; `getSample` em seek); fecha todo `VideoFrame` após upload (sem vazamento de VRAM). Imagens: `createImageBitmap` uma vez → textura. Reverso: decodifica GOP para trás em blocos (cache de 1 GOP).
- **Compositor WebGL2** (twgl): para cada camada em ordem: textura → quad com matriz (fit, crop, transform, animações) → shader de ajuste (brilho/contraste/saturação, opacidade, forma/máscara arredondada/círculo, borda). Texto: rasterizado em `OffscreenCanvas` 2D (fontes do app + sistema), cache por conteúdo/estilo/escala. **Efeitos**: ao encontrar um `EffectItem`, o compositor copia o framebuffer acumulado (ou só a faixa abaixo) para FBO, aplica blur gaussiano separável com downsample (raio proporcional a `strength`) ou pixelização (`floor(uv*N)/N`) ou cor sólida, e compõe de volta com máscara retângulo/elipse rotacionada com feather (ou invertida). **Transições**: renderiza A e B em FBOs e mistura com shader da transição (progresso 0–1, easing).
- **Resolução**: preview em `min(canvas, viewer×dpr)` (½ durante play se o frame demorar > 1 quadro); export na resolução de saída.
- **Anotações v1**: camada `annotations` reutiliza `drawStrokes`/`visibleStrokesAt` num canvas 2D → textura (mesmo resultado da v1).

## 7. Motor de áudio

- `planAudio(project)` (puro): lista de segmentos `{assetId, srcFromUs, srcToUs, dstFromUs, speed, reverse, gainEnvelope[], preservePitch}` considerando mute/volume de faixa, fades de item, transições (crossfade de áudio acompanha a de vídeo) e **ducking** (faixas marcadas "música" abaixam −12 dB, rampa 250 ms, onde houver voz detectada nas faixas de voz; detecção por `silencedetect` na ingestão → intervalos de fala).
- `AudioEngine.render(fromUs, toUs)` (worker, puro sobre PCM): lê PCM via `AudioSampleSink` (mediabunny), reamostra para 48 kHz estéreo, aplica speed (1×: cópia; preservePitch: signalsmith-stretch em streaming; sem preservePitch: reamostragem; > 4×: silencia por padrão, configurável), envelope de ganho, soma, limitador suave (−1 dBFS). Blocos de 100 ms; exportação em streaming (memória constante, sem `OfflineAudioContext` gigante).
- Preview: `PlaybackController` pede blocos com 300 ms de antecedência e agenda no `AudioContext`; o relógio de vídeo segue `audioContext.currentTime` (sem deriva). Medidor de nível (VU) por faixa e master.
- Melhorias por item (opcional, pré-processadas por ffmpeg → `generated` asset cacheado): **redução de ruído** (`arnndn` modelo voz / `afftdn`), **normalizar volume** (`loudnorm` −16 LUFS).

## 8. Ingestão de mídia

1. Importar por botão, arrastar-e-soltar arquivos/pastas, colar; formatos: vídeo mp4/mov/m4v/mkv/webm/avi/ts, áudio mp3/wav/m4a/aac/flac/ogg/opus, imagem png/jpg/jpeg/webp/gif(estático)/bmp/svg(rasterizado).
2. `ffprobe` → MediaInfo (duração, streams, codec, rotação, fps, GOP médio). No renderer, `canDecode` via mediabunny/`VideoDecoder.isConfigSupported`.
3. **Proxy** (fila em background, cancelável, com progresso no MediaBin) quando: não decodificável (→ intermediário H.264 full-res `-crf 18` usado também no export), GOP > 2 s, > 1440p, ou VFR forte. Proxy: H.264 `-g` = fps/2, `-bf 0`, 720p (ou 1080p se a fonte ≤ 1080p e GOP longo), AAC. Gravações do app (GOP 1 s, H.264) não precisam de proxy.
4. Filmstrip (miniaturas por segundo em sprite) e peaks de áudio (min/max por 10 ms, binário) para a timeline; silêncio/fala por `silencedetect`.
5. Arquivo original movido/apagado → asset `missing` com "Localizar…" (relink por nome/tamanho).

## 9. Interface

Tela **Editor** no app principal (janela maximizada ao entrar). Layout estilo CapCut, tema escuro existente:

- **Topo**: nome do projeto (editável), desfazer/refazer, estado do autosave, proporção do projeto (16:9, 9:16, 1:1, 4:5, personalizada), **Exportar**.
- **Esquerda — Biblioteca**: abas Mídia (importados + gravações do Histórico), Áudio (músicas importadas), Texto (modelos), Efeitos (Blur, Pixelizar, Tarja, Destaque/spotlight), Transições, Modelos de marca (logo/marca d'água, intro/outro salvos).
- **Centro — Visualizador**: canvas do compositor; manipuladores diretos (mover/escalar/girar o item selecionado, desenhar região de blur arrastando; alças de redimensionar; guias de alinhamento/centro); zoom do visualizador; botões de transporte; timecode.
- **Direita — Inspetor** do item selecionado: Vídeo (transform, corte, ajuste, forma, fade, animação), Áudio (volume, fade, denoise, normalizar, tom), Velocidade (presets 0,25–8× + campo livre, congelar, reverso), Efeito (tipo, intensidade, feather, forma, inverter, escopo), Texto (fonte, tamanho, cor, fundo, contorno, sombra, alinhamento). Cada propriedade animável tem **botão de keyframe** (◇ adicionar/remover no playhead, ◀ ▶ navegar).
- **Base — Timeline**: régua com zoom (Ctrl+roda, slider, "ajustar tudo"), rolagem horizontal, cabeçalhos de faixa (nome, mute, ocultar, cadeado, volume), itens com filmstrip/waveform, alças de trim, fades arrastáveis nos cantos, marcadores de keyframe no item, transições entre itens, playhead arrastável, snap magnético (ligável com `N`), seleção por caixa e Ctrl/Shift, faixas criadas automaticamente ao soltar acima/abaixo.
- **Atalhos**: Espaço play/pausa; J/K/L; ←/→ frame (Shift = 1 s); Home/End; `S` ou Ctrl+B dividir; Q/W ripple trim até o playhead; Delete / Shift+Delete (ripple); Ctrl+C/V/D; Ctrl+Z/Y; I/O + Ctrl+Shift+X apagar intervalo; M marcador; `+`/`-` zoom; Ctrl+S salvar.
- Entradas: Histórico → **Editar**; Revisão → **Abrir no editor**; tela inicial → **Novo projeto** / **Projetos recentes**. A Revisão v1 continua existindo como caminho rápido.

## 10. Funcionalidades extras (além do pedido)

| Extra | Por quê |
|---|---|
| **Remover silêncios** automaticamente (limiar e duração mínima ajustáveis, pré-visualização dos cortes, aplica como ripple delete em todas as faixas vinculadas) | Tutoriais gravados ficam 20–40 % mais curtos sem esforço. |
| **Auto-zoom no cursor/cliques** — o gravador passa a registrar posição do cursor e cliques (`screen.getCursorScreenPoint` a 30 Hz + hook de clique no overlay) em `session.cursor`; o editor gera keyframes de zoom suaves nos cliques (editáveis) e pode desenhar **realce de clique** | Vídeo de tutorial "estilo Screen Studio" com 1 clique; realce de clique estava pendente na v1. |
| **Blur que segue** (rastreamento): marca a região num quadro e o app gera os keyframes acompanhando o movimento (template matching NCC em frames reduzidos, no worker), revisáveis | Esconder um dado que rola na tela sem keyframe manual quadro a quadro. |
| **Predefinições de privacidade**: tarja sólida (100 % irrecuperável), aviso ao exportar se houver blur com intensidade baixa | Blur fraco pode ser revertido; tarja garante. |
| Redução de ruído e normalização de volume da voz | Áudio de microfone de escritório. |
| **Modelos de marca** (logo Cia Light como marca d'água, intro/outro, terço inferior com nome) salvos e reaproveitáveis | Padronizar vídeos da empresa. |
| Legendas manuais: faixa de legenda, importar/exportar **SRT**, queimar no vídeo ou exportar separado | Vídeos sem som em redes sociais. |
| Proporções e **reenquadrar** para 9:16/1:1 com keyframes de posição | Reels/Stories a partir de gravação 16:9. |
| Exportar quadro atual como PNG, exportar **GIF** curto, exportar **só áudio** (mp3/wav), exportar trecho entre I/O | Usos do dia a dia. |
| Capítulos a partir de marcadores (texto para descrição do YouTube) | Publicação. |
| Autosave a cada alteração (debounce 1 s) + 20 versões rotativas + recuperação após queda | Nunca perder edição. |
| Gravar narração direto na timeline (microfone) | Corrigir explicações depois. |

## 11. Exportação

- **Diálogo**: presets (WhatsApp ≤ 64 MB, Alta 1080p, Máxima/original, 4K quando o projeto permitir, Vertical 9:16, Só áudio, GIF), resolução, fps, qualidade/bitrate ou tamanho alvo, codec H.264 (HEVC opcional se o encoder suportar), intervalo (tudo / I–O), nome e pasta; estimativa de tamanho.
- **Pipeline**: render worker avança `t = n/fps` de forma determinística → `VideoSampleSource` (mediabunny, `hardwareAcceleration: 'prefer-hardware'`, keyframe 2 s) + `AudioSampleSource` (AAC 48 kHz; fallback Opus se AAC indisponível) → MP4 por `StreamTarget` → IPC (contrapressão já existente) → arquivo. Pós: `ffmpeg -c copy -movflags +faststart`. Tamanho alvo: bitrate = (alvo·8 − áudio)/duração com margem de 4 %; se exceder, segunda passada com bitrate corrigido.
- **Fallback**: encoder de hardware recusa → `prefer-software` (OpenH264 do Chromium); se falhar, frames RGBA por pipe para `ffmpeg libx264`. Cancelamento a qualquer momento apaga o parcial.
- Exportação roda com o editor aberto (barra de progresso, ETA, velocidade ×tempo real); uma por vez.

## 12. Armazenamento

`<rawRoot>\..\Projetos\<projectId>\` (padrão `Vídeos\CiaLight Gravador\Projetos\`): `project.json` (escrita atômica), `versions/NNN.json`, `proxies/`, `cache/` (filmstrips, peaks, áudio processado), `generated/` (narrações). Mídia importada **não é copiada** (opção "Consolidar projeto" copia tudo para a pasta). Exclusão de projeto não apaga originais. Limpeza de cache por projeto nas Configurações. Protocolo `cialight-file://media/<projectId>/<assetId>` resolve só caminhos registrados no projeto (sem acesso arbitrário ao disco).

## 13. Robustez

- Erros de decodificação de um asset não derrubam o editor: camada desenhada como "mídia indisponível" e aviso.
- `--disable-features=ReclaimInactiveWebCodecs`; recriação de decoder em `QuotaExceededError`/`closed`.
- Worker com watchdog: sem frame em 5 s durante play → reinicia o worker e restaura o estado.
- Memória: frames fechados imediatamente, caches LRU com limite (texturas 512 MB, filmstrips 200 MB).
- Projeto inválido ao abrir → abre a última versão válida de `versions/`.

## 14. Testes e validação

- **Unidade (vitest, node)**: model/ops (split, ripple, trim, move com vínculo e snap, deleteRange, setSpeed, keyframes e easing, transições), `resolveFrame`, `planAudio` (fades, ducking, speed), timeMap, migração/validação, mixer PCM (sinais sintéticos), detecção de silêncio→cortes, rastreamento NCC (imagens sintéticas).
- **Integração real (Electron test mode, `CIALIGHT_TEST=editor`)**: monta projetos de teste com mídia gerada pelo ffmpeg (`testsrc2`, `sine`, imagem) e exporta; verifica com ffprobe duração/fps/streams e **pixels** (região borrada tem variância baixa; fora dela, idêntica; tarja = cor exata; cortes removem o trecho por detecção de quadro-marcador; speed 2× dura metade; áudio com fade começa em silêncio — medido por `astats`).
- **E2E via CDP** (`scripts/qa/cdp.mjs`): abrir gravação no editor, dividir, blur com keyframes, exportar; screenshots de cada painel para revisão visual.
- Regressão: suíte v1 (216 testes), `test:ffmpeg`, `test:capture` continuam passando.

## 15. Fases de entrega (cada uma: plano → implementação → testes → release)

| Fase | Conteúdo | Release |
|---|---|---|
| F0 | Spike de validação técnica: WebGL2 em worker + `VideoFrame` como textura, mediabunny 1.61 sinks/sources (AAC encode no Windows), signalsmith-stretch WASM no worker, decodificação HEVC, flag de reclaim. Atualizar mediabunny. | — |
| F1 | Modelo + ops + histórico, projectStore, ingestão/proxies, protocolo media, render worker + compositor (mídia, transform, crop, fit), AudioEngine básico (volume/fade), Editor UI (biblioteca, visualizador, inspetor, timeline com trim/split/move/snap/zoom/ripple/vincular/separar áudio), gravação→projeto, exportação básica | v1.1.0 |
| F2 | Efeitos de privacidade: blur/pixelate/tarja com regiões desenhadas, keyframes, feather, inverter; aviso de privacidade | v1.2.0 |
| F3 | Velocidade (stretch), congelar, reverso; música, ducking, denoise, normalizar; remover silêncios; narração | v1.3.0 |
| F4 | Keyframes para todas as propriedades + editor de curvas; zoom/pan; animações de entrada/saída; reenquadrar | v1.4.0 |
| F5 | Transições, fades de vídeo, textos, formas, legendas/SRT, modelos de marca | v1.5.0 |
| F6 | Auto-zoom (cursor/cliques no gravador) + realce de clique; blur que segue (tracking) | v1.6.0 |
| F7 | Exportação completa (presets, tamanho alvo, GIF, só áudio, PNG, capítulos, HEVC, AMF no probe, fallbacks) e polimento | v1.7.0 |

## 16. Fora de escopo (por ora)

Transcrição automática (o ffmpeg embutido não tem o filtro `whisper`; exigiria whisper.cpp + modelo de ~150 MB — candidato a fase futura), chroma key, multicâmera, colaboração em nuvem, LUTs/color grading avançado, efeitos 3D.

## 17. Riscos e planos B

| Risco | Plano B |
|---|---|
| WebGL2 em worker indisponível/instável | Canvas2D no worker com `filter: blur()` e downscale para pixelate (mesmo `resolveFrame`). |
| Encoder AAC do WebCodecs indisponível | Opus no MP4, ou PCM → ffmpeg remux para AAC. |
| Desempenho do preview com 4+ faixas 1080p | Resolução adaptativa, proxies 540p, pré-render de trechos com efeitos pesados. |
| signalsmith no worker falhar | `rubberband` do ffmpeg pré-renderizado por item (cache). |
| Mídia VFR com timestamps ruins | Intermediário CFR na ingestão. |
