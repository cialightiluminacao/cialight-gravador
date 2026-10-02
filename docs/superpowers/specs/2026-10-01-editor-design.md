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

## 18. Notas de implementação F1 (v1.1.0)

Desvios e decisões tomadas durante a F1, em relação ao texto acima (que continua valendo para as fases seguintes):

| Tema | Spec | Implementado na F1 e por quê |
|---|---|---|
| **DecoderPool** (§6) | máx. 6 decoders vivos | **8** por padrão (configurável no construtor). Gravação com tela + webcam + imagem + proxy de outro item já ocupa 4–5; 6 forçava fechar/reabrir decoders ao tocar cortes próximos. Abertura que falha é tentada de novo após 5 s (arquivo preso por instantes); a webcam de sessão abre `getVideoTracks()[v:N]` só no original (proxy/intermediário = v:0). |
| **Cor das fontes** (§6/§11) | — | Regra única em `shared/editor/sourceColor.ts`, usada por decoder, ffmpeg (filmstrip/miniatura/proxy) e exportação: **com marcação → a marcação; sem marcação → HD (altura > 576 ou largura > 1024) BT.709, SD BT.601, faixa limitada**. Proxies e intermediários saem marcados (`-colorspace/-color_*` + `h264_metadata` no SPS) para não mudarem de cor no caminho. |
| **Probe de encoders** (§11) | — | Encode-teste com os **mesmos argumentos** de cada preset v1 e do proxy/intermediário (`validationArgSets`, `argsVersion`). Cache em `settings.encoderProbeV2` (por GPU/driver); `lastEncoderProbe` recebe só a projeção sem AMF que a v1.0.1 instalada (mesmo `settings.json`) sabe ler; o cache só confia no V2 (instalação antiga refaz o probe uma vez). AMD testa AMF antes do Media Foundation. O probe roda na manutenção adiada (15 s após abrir), **só com o app ocioso** (gravando/exportando, confere de novo a cada 60 s) e é single-flight: a exportação v1 que chega durante o probe reaproveita a mesma execução. |
| **h264_mf** | — | Perfil **numérico** (`-profile:v 77/100`): `main`/`high` por nome eram recusados e o encoder nem abria. Falha do ffmpeg com um encoder → próximo disponível → libx264 (exportação v1, proxy e intermediário). |
| **Áudio não decodificável** (§8) | proxy só para vídeo | `decodable` decidido também para o áudio (`canDecode` do WebCodecs real). Só áudio → intermediário `.m4a` AAC 192k; vídeo decodificável com áudio não decodificável (FLAC/ALAC/AC-3…) → vídeo copiado + AAC (recodifica se a cópia falhar). Intermediários ocupam o slot pesado da fila (1 pesado + 2 leves). |
| **Fades** (§9) | fades arrastáveis nos cantos | Alças nos cantos superiores do item (visual ou áudio conforme a faixa), rampa diagonal, dica com a duração ("Fade de entrada: 0,50 s"); as alças nunca se sobrepõem e `setSpeed` mantém fadeIn + fadeOut dentro da nova duração. |
| **J/K/L** (§9) | shuttle | **J** volta 5 s, **K** pausa, **L** toca (tocando: salta +5 s sem parar). Sem velocidades 2×/4× de shuttle na F1 (a velocidade de reprodução fica para a F3, com o stretch). |
| **Watchdog do preview** (§13) | sem quadro em 5 s durante play → reinicia | Conta prazo **só com pedido de quadro pendente**: tocando com o rAF suspenso (janela minimizada) ninguém pede quadros e isso não é travamento. Ao disparar, worker novo num **canvas novo** (o OffscreenCanvas só pode ser transferido uma vez), restaurando projeto/seleção/tamanho; aviso "O visualizador travou e foi reiniciado". |
| **Proteção das gravações (C1)** | — | Gravação usada por algum projeto do editor nunca é apagada: `session.delete` recusa com mensagem em pt-BR (Histórico, Revisão e o diálogo de gravação interrompida mostram o aviso) e a retenção automática de brutos pula essas sessões. |
| **Exportação** (§11) | presets completos | F1: Alta 1080p, WhatsApp (≤ 64 MB, uma nova passada com bitrate × alvo/obtido × 0,97 se passar), Original, Vertical 9:16 (exige projeto 9:16). `.part` → `ffmpeg -c copy -movflags +faststart`; uma exportação por vez; sair durante a exportação pergunta uma vez e cancela apagando o parcial. Falha do encoder de hardware antes do 1º pacote → software. |
| **Manutenção adiada** | — | 15 s após abrir: retenção de brutos (protegendo os usados por projetos), `.part` com mais de 1 dia em `proxies/`, `cache/` e na pasta de saída, e o probe de encoders (acima). |
| **Testes** (§14) | `CIALIGHT_TEST=editor` | `npm run test:ingest`, `test:editor` (render, `CIALIGHT_TEST=editor-render`) e `test:editor-export`; E2E via CDP em `scripts/qa/editor-timeline.mjs`, `editor-export.mjs` e `editor-e2e.mjs` (gravação → Histórico → editar → exportar → ffprobe). |

## 19. Notas de implementação F2 (v1.2.0)

Desvios e decisões tomadas durante a F2 (efeitos de privacidade), em relação ao texto acima. As partes marcadas **(revisão final)** vêm da onda de correções da revisão final da F2 (I1–I4, M1–M9):

| Tema | Spec | Implementado na F2 e por quê |
|---|---|---|
| **`enabled` por item** (§4) | — | `ItemBase.enabled?: boolean` (ausente = ativo; só é gravado quando `false`, então projetos antigos não mudam). Item desativado não gera camada (`resolveFrame`) nem áudio (`planAudio`). `Shift+E`/menu/inspetor desativam o item **e os vinculados** (vídeo + áudio juntos); `Alt+Shift+E` ignora o vínculo, como mover e aparar. |
| **Faixa dos efeitos** (§4/§6) | efeito em faixa de vídeo | `addEffect` reaproveita uma faixa de vídeo chamada "Efeitos"/"Efeitos N" acima de todas as faixas de mídia e livre no intervalo; senão cria "Efeitos", "Efeitos 2"… no topo. Duração padrão: até o fim do clipe visível sob o ponto (faixa visível mais alta, item não-efeito ativo) ou 5 s (`defaultEffectDurationUs`). **(revisão final, I2)** A faixa "Efeitos" reaproveitada tem de estar visível; faixa nova de mídia (importar, soltar em "nova faixa", mover para faixa nova) entra **abaixo** do bloco de faixas "Efeitos" do topo, e a escolha automática de faixa para mídia nunca usa uma faixa "Efeitos": mídia nova nunca fica por cima dos efeitos. |
| **Predefinições** (§10) | — | `createEffectItem`: Blur (retângulo 0,4×0,3, intensidade 60, borda 0,15), Pixelizar (50), Tarja (`#000000`, borda 0), Esconder rosto (elipse 0,18×0,32, **80**, borda 0,3), Esconder texto (0,4×0,08, **80**, borda 0), Borrar tudo menos… (0,5×0,5, inverter, **80** (revisão final; era 60), borda 0,2). Os três últimos são `effect: 'blur'` com outra região. |
| **Compositor** (§6) | camadas num FBO de acumulação | O FBO de acumulação só é usado **em quadros com efeito**; sem efeito o caminho é o da F1 direto no canvas (pixels idênticos à F1, sem custo extra). Blur gaussiano separável com downsample 2×/4×/8× e scissor na região; **raio efetivo = max(intensidade × altura da saída × 0,04; 1,25 × menor lado da região em px × intensidade/100)** (`effectBlurRadiusPx`, o mesmo no preview e na exportação; proporcional à saída, então igual em qualquer resolução). Só pela altura, uma região justa sobre um texto grande ficava legível (CPF de 47 px em 1080p a 60: raio 26 px). k = 1,25 foi medido no E2E: a 60 o contraste local da linha de texto cai a 0,08 da fonte (k 0,5 → 0,34; 1,0 → 0,135, com os grupos de dígitos ainda distinguíveis). O lado da região é limitado ao quadro. **(revisão final, I1)** Em **inverter** o termo de tamanho usa o **menor lado do quadro** (a área escondida é o quadro inteiro fora da região). Só pela altura, a 60, o raio era 26 px e um texto de 47 px fora da região ficava legível (contraste 0,31/0,28 da fonte a 80 e 0,42/0,39 a 50 no teste de render, antes da correção). A 80 em 1080p o raio vale 1 080 px; o kernel de 32 taps em 8× limita o alcance a ±256 px (borrão quase em caixa). Medido no `test:editor` com texto de 47 px fora da região: contraste local 0,006–0,017 a 80 e 0,009–0,014 a 50 (limite 0,15), laplaciano ≈ 0. Pixelização: **bloco = max(bloco pela altura; 0,35 × lado da área escondida × intensidade/100)** (`effectPixelBlockPx`; invertido também pelo menor lado do quadro), grade presa ao canto do quadro. **(revisão final, I4)** A cor de cada bloco é a **média exata dos pixels do bloco** (dois passes de caixa, H e V, para uma textura com um texel por bloco), e não mais uma amostra no centro: com conteúdo andando sob a grade fixa, amostrar um ponto diferente a cada quadro reconstituía o detalhe ao longo do tempo (decisão do controlador: privacidade acima do texto do plano). O bloco é quantizado a 1/256 px e cada pixel `i` cai no bloco `((2i + 1)·128) / q` em conta inteira, igual nos três shaders e no teste (com divisão em float a GPU arredondava diferente em cada shader e a linha da borda caía no bloco vizinho). Medido no `test:editor` com ruído em movimento: erro máx. 0,52 da média da fonte (limite ±2), blocos uniformes (desvio 0). |
| **Borda suave e inverter** | — | A borda suave cresce **para fora** da região (a região inteira fica 100 % coberta); no modo inverter ela cresce **para dentro** (nenhuma faixa nítida vaza na borda). A AABB/scissor da elipse é a do retângulo girado (conservadora). |
| **Tarja** | irreversível | Ignora `strength` e o alpha de `color`: sempre opaca, cor exata com borda 0. Converter um efeito para Tarja zera a borda e remove os keys de intensidade; voltar para Blur/Pixelizar restaura a borda do preset. |
| **Escopo `track`** | — | Pega a camada de mídia/anotações **logo abaixo** (pulando faixas ocultas); sem camada logo abaixo (ex.: outro efeito) o efeito é ignorado. Texto/forma da F5 ainda não entram no escopo `track` (pendente para a F5). |
| **Vínculo efeito ↔ clipe** (§4) **(revisão final, I3)** | — | Efeito criado sobre um clipe de mídia (preset da biblioteca, arraste para o visualizador/linha do tempo ou região desenhada) recebe o `linkId` do clipe (e do áudio vinculado a ele); clipe sem vínculo ganha um novo. O efeito é **seguidor**: edições a partir do clipe levam os efeitos. Mover; aparar (a borda do efeito alinhada à borda aparada, ±½ quadro, acompanha ao encolher e ao estender; efeito no meio fica parado, ou anda com o conteúdo no ripple pelo início); ripple (o efeito anda com a mídia do grupo, mesmo começando antes do pivô, e não bloqueia a própria faixa); dividir (cada pedaço fica com o lado em que começa; dividir só o efeito não o desvincula); apagar; duplicar (a cópia vincula à cópia do clipe); **velocidade** (o tempo a partir do início do clipe é escalado pela mesma razão: início, duração e keyframes do efeito; a 0,5× o efeito continua cobrindo o clipe inteiro, conferido no E2E com nova exportação). A partir do efeito, só ele: mover/aparar/dividir/apagar o efeito nunca mexe no clipe, e ativar/desativar o clipe não desliga os efeitos dele. "Desvincular" devolve o comportamento livre. O ícone de vínculo aparece também nos itens de efeito. Custo: para o clipe andar sem o efeito, é preciso desvincular. |
| **Visualizador** (§9) | desenhar e manipular regiões | Ferramenta **Desenhar região** (`B`), Shift ao desenhar = elipse (nas alças, Shift mantém a proporção), Alt = a partir do centro. **(revisão final, M7)** As alças de mídia também passam a usar **Alt** = a partir do centro (antes era Shift; a mídia sempre escala na proporção); guias imantam o centro em 0,5 e as bordas em 0/0,5/1 (bordas só sem rotação). Regiões ficam "por cima" na seleção, inclusive sob a mídia selecionada; região só aparece/edita com o playhead dentro do item `[início, fim)`; efeito desativado/em faixa oculta não é clicável no quadro, mas mostra contorno "Desativado" quando selecionado pela timeline. A barra de ferramentas vertical reserva 48 px de cada lado do quadro. |
| **Keyframes** (§9) | atalho K | **K** já é pausa (J/K/L), então ligar/desligar keyframe é **`Alt+K`** (liga/desliga o grupo: região, transformação ou volume); `[`/`]` vão ao keyframe anterior/próximo; tolerância ±meio quadro em tudo (◇ do inspetor, Alt+K, losangos). Um losango na timeline é um instante de todas as propriedades (clicar/arrastar/Delete agem em todos os keys daquele instante); o ◇ do inspetor edita uma propriedade só. Losango da região considera só keys de `region.*`. Edição no inspetor com o playhead fora do item vai para o instante mais próximo dentro dele. |
| **Biblioteca** (§9/§10) | aba Efeitos | Cartões das 6 predefinições, arrastáveis (`application/x-cialight-effect`): na linha do tempo, no instante sob o ponteiro (com ímã) e na faixa de vídeo sob ele **se estiver desbloqueada e livre no intervalo** (nunca sobrescreve mídia) **e, revisão final (I2), visível e sem mídia visível numa faixa de vídeo mais alta no intervalo** (`effectTrackAllowed`, também aplicado ao `trackId` explícito de `addEffect`), senão na faixa "Efeitos"; no visualizador, no playhead com a região centrada no ponto solto. Duplo clique, Enter ou "+" adicionam no playhead com a região no centro (revisão final, M1: o Enter só vale no cartão em foco; o Enter no "+" adicionava duas vezes). |
| **Aviso de privacidade** (§11) | — | `privacyWarnings(p, de, até)`: Blur **< 50** (era 35: com o raio pela região, medido no E2E sobre o texto de 47 px, 35 deixa contraste 0,23 da fonte, 45 → 0,147, 50 → 0,12 — o limite de legibilidade é 0,15), Pixelizar < 30 (avaliado nas bordas do trecho e em cada key dentro dele), e efeito desativado **ou em faixa oculta** (não renderiza → conteúdo sem proteção). **Revisão final:** (I1) o piso de blur vale também para inverter, agora calibrado: o raio invertido usa o lado do quadro, então a 50 ele é ≥ ao de qualquer região justa a 50 (medido: 0,009–0,014 de contraste no texto fora da região), com mensagem própria "Blur fraco fora da região pode ser revertido; use intensidade ≥ 50". (I2) Novo aviso **`covered`**, "Há mídia acima deste efeito; ela não será borrada": item de mídia ativo numa faixa de vídeo visível mais alta que se sobrepõe ao efeito no tempo e, quando dá para saber (região e transformação paradas, sem recorte, não invertido), também no espaço (caixa da mídia × caixa da região + borda). Aparece no diálogo e no inspetor. (M2) O aviso de borda suave larga com intensidade baixa saiu: com a borda crescendo para fora (invertido: para dentro) a área escondida sempre fica coberta, então era alarme falso. (M5) Cada aviso traz `tUs`, e "Revisar" leva o playhead ao instante do aviso (o mais fraco, o início da sobreposição…, dentro do intervalo); é também o horário mostrado na lista. O diálogo de exportação lista os avisos do intervalo em **Privacidade**; nunca bloqueia. |
| **Exportar "Tudo"** (§11) **(revisão final, M6)** | — | O fim do intervalo "Tudo" é `contentEndUs` (sem efeitos e sem itens desativados): um efeito solto depois do fim da mídia não estica a exportação com quadros pretos. A linha do tempo continua usando `projectDurationUs` (navegação). |
| **Testes** (§14) | — | `test:editor` (pixels de cada efeito, tarja exata, invert/elipse/meio fora, escopo `track`, F1 inalterado) e `test:editor-export` (projeto 1080p com fundo de ruído exportado em 720p a 12 Mbps: tarja ±3 após o H.264, área borrada no mesmo lugar do preview com IoU ≥ 0,9). Métrica de blur = energia de detalhe (ΔL² entre vizinhos), porque a variância local sobe com o blur em barras chapadas. QA via CDP: `scripts/qa/editor-effects.mjs` e o ponta a ponta `scripts/qa/editor-f2-e2e.mjs` (vídeo com CPF que se move desenhado por `drawtext` → Esconder texto com 2 keyframes, Tarja e Pixelizar pela biblioteca → Alta 1080p → variância do laplaciano na caixa do texto < 0,2 da fonte e tarja com a cor exata ±3). **Revisão final:** o `test:editor` ganhou "Borrar tudo menos…" sobre texto de 47 px fora da região (preset 80 e piso 50: contraste < 0,15 e laplaciano < 0,2; tabela a 80/50/35/20 no log) e a pixelização sobre ruído em movimento (cor do bloco = média da fonte ±2, em 2 quadros). O E2E confere também o 1º e o último quadro do item (0 e 179, M4), o vínculo do efeito com o clipe e o ícone, e muda o clipe para 0,5× pelo inspetor e exporta de novo (CPF ilegível nos 12 s, inclusive na 2ª metade e no último quadro; tarja na 2ª metade). `test:ffmpeg` agora guarda e devolve o `settings.json` (o probe de encoders grava o cache nele; M9). |
| **Pendências conhecidas** | — | A forma de onda na timeline usa o volume estático (não reflete keyframes de volume) — F4. Escopo `track` com texto/forma — F5. **(revisão final, M8)** A folga de desempenho ficou menor depois do raio pela região: 3 blurs fortes em 1080p dão ≈ 8–10 ms de mediana e p95 14–19 ms na UHD 730 (o teste só barra a mediana < 12 ms). É folgado a 30 fps e apertado para projetos a 60 fps. O kernel truncado em 32 taps deixa raios grandes com cara de caixa (seguro para privacidade, visualmente não gaussiano). Rever na F4/F5 se aparecer projeto a 60 fps. Nota de versão: todo blur não invertido ficou bem mais forte (o Blur padrão 0,4×0,3 a 60 tem raio ≈ 243 px em 1080p), então intensidades baixas não dão mais um desfoque "estético" suave. |
