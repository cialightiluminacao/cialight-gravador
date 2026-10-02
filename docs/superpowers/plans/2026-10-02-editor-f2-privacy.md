# Editor F2 — Efeitos de privacidade (blur, pixelização, tarja) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** v1.2.0. Esconder informações em vídeos: regiões de **blur**, **pixelização** ou **tarja sólida** desenhadas no visualizador (retângulo/elipse, rotação, borda suave, inverter = borrar tudo menos a região), que podem ser movidas e redimensionadas, animadas por **keyframes** no tempo, ativadas/desativadas por intervalo (item na timeline) e exportadas idênticas ao preview.

**Architecture:** `EffectItem` (já no modelo F1) em faixas de vídeo; `resolveFrame` já emite `EffectLayer` com valores interpolados. F2 adiciona: ops/fábricas de efeito + `enabled` por item; passe de efeito no compositor WebGL2 (FBO do acumulado → blur gaussiano separável com downsample ≥ 2× e scissor / pixelate / sólido → composição com máscara rotacionada com feather, normal ou invertida, escopo `below`/`track`); ferramenta de desenho e manipulação da região no visualizador; painel do efeito com botões de keyframe (componente genérico reaproveitado na F4); diamantes de keyframe nos itens da timeline; aba **Efeitos** na biblioteca; aviso de privacidade na exportação.

**Tech Stack:** igual F1 (WebGL2/twgl, zustand+immer, vitest, CDP QA, testes reais Electron).

**Spec:** `docs/superpowers/specs/2026-10-01-editor-design.md` (§4 EffectItem, §6 Efeitos, §9 Inspetor/Visualizador, §10 "Predefinições de privacidade", §15 F2) + §18 (notas F1). Spike (shaders de blur/pixelate medidos): `docs/research/2026-10-01-editor-spike-results.md` e `src/renderer/src/spike-editor/glPipeline.ts`.

## Global Constraints

- Mesmas restrições globais da F1 (µs inteiros, coordenadas normalizadas 0–1 ao quadro, `shared/editor` puro/imutável, v1 intacta, pt-BR com acentos, testes ao lado do código, padrão IPC, `close()` de todo VideoFrame, nunca input de SO, nunca alterar `settings.json` do usuário sem restaurar).
- **Preview = exportação**: o efeito é desenhado pelo mesmo `Compositor` nos dois caminhos.
- **Tarja (`solid`) é irreversível**: pixels da região = cor exata (sem mistura) quando `feather = 0`.
- Blur sempre com downsample ≥ 2× e scissor na região (ruling F0); raio efetivo proporcional a `strength` (0–100) e à **altura do quadro de saída** (mesma aparência em qualquer resolução de exportação).
- `region` em coordenadas normalizadas do quadro do projeto: `x,y` = centro, `w,h` = tamanho, `rotation` em graus.

## Review Focus

- Região de blur que sai parcialmente do quadro (x+w/2 > 1) → borra só a parte visível, sem artefato de borda (clamp de amostragem).
- Exportação em resolução diferente do projeto (projeto 1080p, saída 720p) → blur visualmente igual (raio relativo à altura) e região no mesmo lugar.
- Efeito sobre área com transição de quadros (vídeo em movimento) com keyframes `hold` vs `linear` → região segue exatamente os keyframes; nenhum quadro "pisca" sem blur entre keyframes.
- Dois efeitos sobrepostos (blur + tarja) → ordem da faixa respeitada; tarja por cima cobre totalmente.
- Desfazer depois de desenhar uma região e arrastá-la → cada gesto é um passo de desfazer.

---

### Task 1: Modelo — fábricas, ops e `enabled`

**Files:** Modify `src/shared/editor/project.ts`, `schema.ts` (+test), `factory.ts`, `ops.ts` (+test), `resolve.ts` (+test), `audioPlan.ts` (+test); Create `src/shared/editor/privacy.ts` (+test).

**Produces:**
```ts
// project.ts: ItemBase ganha `enabled?: boolean` (ausente = true). Item desativado não gera layer nem áudio.
// factory.ts
export type EffectPresetId = 'blur' | 'pixelate' | 'solid' | 'blurFace' | 'blurText' | 'blurAllExcept'
export function createEffectItem(preset: EffectPresetId, startUs: Us, durationUs: Us, region?: Partial<{ x: number; y: number; w: number; h: number; rotation: number; shape: 'rect' | 'ellipse' }>): EffectItem
//   blur: rect, strength 60, feather 0.15; pixelate: rect, strength 50 (tamanho do bloco); solid: rect, color '#000000', feather 0, strength 100;
//   blurFace: ellipse 0.18×0.32 centro, strength 70, feather 0.3; blurText: rect 0.4×0.08, strength 60; blurAllExcept: rect 0.5×0.5, invert true, strength 60, feather 0.2
// ops.ts
export function addEffect(p: Project, preset: EffectPresetId, atUs: Us, opts?: { durationUs?: Us; trackId?: string; region?: ... }): { project: Project; itemId: string }
//   duração padrão: até o fim do item de vídeo sob o playhead (faixa mais alta não-efeito) ou 5 s; procura faixa de vídeo acima de todas as faixas de mídia chamada "Efeitos" sem item no intervalo, senão cria uma nova faixa de vídeo no topo ("Efeitos", "Efeitos 2"…)
export function setItemEnabled(p: Project, itemIds: string[], enabled: boolean): Project
export function setAnimValue(p: Project, itemId: string, path: AnimPath, tUs: Us /* absoluto */, value: number): Project // usa setValue (cria key se animado)
export function toggleKeyframe(p: Project, itemId: string, path: AnimPath, tUs: Us): Project // se há key em ±meio quadro → remove; senão adiciona com valor avaliado
export function nextKeyframeUs(p: Project, itemId: string, path: AnimPath | 'any', fromUs: Us, dir: 1 | -1): Us | null
export type AnimPath = 'transform.x' | 'transform.y' | 'transform.scale' | 'transform.rotation' | 'transform.opacity' | 'region.x' | 'region.y' | 'region.w' | 'region.h' | 'region.rotation' | 'strength' | 'audio.volume'
export function getAnim(item: Item, path: AnimPath): Anim<number> | null
// privacy.ts
export interface PrivacyWarning { itemId: string; kind: 'weakBlur' | 'weakPixelate' | 'disabled' | 'feather'; message: string }
export function privacyWarnings(p: Project, fromUs: Us, toUs: Us): PrivacyWarning[]
//   blur strength < 35 em algum ponto → weakBlur ("Blur fraco pode ser revertido; use intensidade ≥ 35 ou Tarja"); pixelate strength < 30 → weakPixelate; efeito desativado no intervalo → disabled; feather > 0.4 com strength < 50 → feather (bordas podem revelar)
```
- [ ] Testes (RED→GREEN): fábrica de cada preset valida no schema; `addEffect` cria faixa "Efeitos" no topo e reaproveita quando livre; duração segue o clipe sob o playhead; `enabled:false` some do `resolveFrame` e do `planAudio`; `toggleKeyframe` adiciona e remove; `nextKeyframeUs` nos dois sentidos considerando todas as props com `'any'`; `privacyWarnings` para cada tipo; split/trim/setSpeed de `EffectItem` reparte keys de `region.*`/`strength` (já coberto pela F1 — adicionar caso explícito).
- [ ] `npm test` + typecheck; commit `feat(editor): efeitos de privacidade no modelo (fábricas, enabled, keyframes, avisos)`.

### Task 2: Compositor — passe de efeitos

**Files:** Modify `src/renderer/src/editor/engine/compositor/{compositor.ts,shaders.ts,gl.ts}`; Create `compositor/effects.ts` (+ `effectsMath.ts` puro com teste); Modify `render.worker.ts` (dimensões de saída para o raio), `src/main/editorTestMode.ts` + `test/renderHarness.ts` (cenários de pixel), `src/main/editorExportTestMode.ts` + `test/exportHarness.ts` (paridade de exportação).

**Produces:**
```ts
// effectsMath.ts (puro)
export function blurRadiusPx(strength: number, outH: number): number      // strength 0–100 → raio 0…(outH*0.04); 60 em 1080p ≈ 26 px
export function pixelBlockPx(strength: number, outH: number): number      // 0–100 → bloco 2…(outH/12)
export function regionScissor(region: {x,y,w,h,rotation}, feather: number, W: number, H: number): { x: number; y: number; w: number; h: number } // AABB da região rotacionada + feather, clampado ao quadro, em px (y para cima do GL)
export function downsampleFactor(radiusPx: number): 2 | 4 | 8                // ≥2 sempre; 4 se raio > 24; 8 se > 64
```
Comportamento: o compositor desenha camadas em um FBO de acumulação (não direto no canvas) para poder ler "o que está abaixo". Ao encontrar `EffectLayer` (escopo `below`): copia a AABB (scissor) do acumulado → downsample → blur H/V (separável, kernel gaussiano σ = raio/2, pesos em uniform) ou pixelate (amostra no centro do bloco, alinhado ao quadro inteiro para não "nadar") ou sólido → upsample → compõe sobre o acumulado com máscara (`rect`/`ellipse` rotacionada, borda suave `smoothstep` com largura `feather × min(w,h)/2`, `invert` inverte a máscara e passa a usar o quadro inteiro como área). Escopo `track`: só a camada imediatamente abaixo (renderiza-a isolada num FBO auxiliar). Ao final, blit do acumulado para o canvas. Recursos (FBOs) por tamanho, reaproveitados entre quadros e liberados no `dispose`.
- [ ] Teste puro `effectsMath.test.ts` (raio escala com altura; scissor de região rotacionada 45° contém os 4 cantos; clamp nas bordas; fatores de downsample).
- [ ] Integração real (`test:editor`): fundo `testsrc2` + 4 efeitos em quadrantes: blur (variância de luminância na região < 15 % da original e pixels fora da região + feather idênticos ao sem-efeito, diff ≤ 2), pixelate (blocos uniformes: desvio dentro de um bloco ≤ 3), sólido `#123456` feather 0 (todos os pixels da região exatamente 0x12,0x34,0x56), elipse rotacionada 30° (pixel no canto do AABB fora da elipse inalterado); `invert` (centro inalterado, canto borrado); região meio fora do quadro sem artefato; keyframe `region.x` 0.2→0.8 entre 1 s e 3 s: em 2 s o centro de massa da área borrada ≈ 0.5 (±0.02).
- [ ] Exportação real (`test:editor-export`): o mesmo projeto exportado em 1280×720 tem a tarja com cor exata (após decodificação H.264: ΔE pequeno, tolerância ±3 por canal no centro de blocos 16×16 inteiros dentro da região) e a região borrada no mesmo lugar (máscara de variância IoU ≥ 0.9 com o preview redimensionado).
- [ ] Desempenho: 1080p com 3 blurs fortes < 12 ms/quadro na Intel UHD 730 (medir no harness; registrar no relatório).
- [ ] commit `feat(editor): blur, pixelização e tarja no compositor (preview e exportação)`.

### Task 3: Visualizador — desenhar e manipular regiões

**Files:** Modify `src/renderer/src/editor/ui/ViewerOverlay.tsx` (separar em `ui/viewer/ItemTransformHandles.tsx` e `ui/viewer/EffectRegionHandles.tsx` se passar de ~300 linhas), `ui/viewerGeometry.ts` (+test), `ui/Viewer.tsx`, `ui/TopBar.tsx` ou barra do visualizador (ferramenta "Desenhar região").

Comportamento:
- Ferramenta **Desenhar região** (atalho `B`, ícone de pincel/quadrado tracejado; submenu: Blur, Pixelizar, Tarja; forma Retângulo/Elipse com `Shift` = elipse): arrastar no visualizador cria `addEffect` no playhead com a região desenhada; um gesto = um passo de desfazer.
- Efeito selecionado mostra a **região** (contorno tracejado + alças de canto/borda para redimensionar, alça de rotação, arrastar o interior move); `Shift` mantém proporção; `Alt` redimensiona a partir do centro; guias de centro/bordas do quadro com snap 1 %. Se a propriedade está animada, mover cria/atualiza keyframe no playhead (via `setAnimValue`); senão altera o valor estático.
- Clique fora da região seleciona o item de mídia abaixo (comportamento F1). Efeitos ficam sempre "por cima" para seleção.
- Indicador visual quando há keyframe exatamente no playhead (losango preenchido no canto da região).
- [ ] Testes puros de geometria (hit-test em região rotacionada; conversão arraste→região com Shift/Alt; clamp mínimo 1 % do quadro).
- [ ] QA CDP (`scripts/qa/editor-effects.mjs`): desenhar retângulo e elipse, mover, redimensionar, girar, desfazer (1 passo por gesto), com keyframes ligados mover em dois instantes e conferir interpolação no store e nos pixels (`readPixels` via `__qaEditor`). Screenshots `docs/qa/editor-f2/*.png` lidas e revisadas.
- [ ] commit `feat(editor): desenhar e editar regiões de efeito no visualizador`.

### Task 4: Inspetor de efeito, keyframes e timeline

**Files:** Create `ui/Inspector/EffectPanel.tsx`, `ui/Inspector/KeyframeButton.tsx` (genérico: ◀ ◇ ▶ por `AnimPath`), Modify `Inspector.tsx`, `VideoPanel.tsx`/`AudioPanel.tsx` (adotar `KeyframeButton` para transform/opacidade/volume — base para F4), `ui/timeline/ItemView.tsx` (+ `KeyframeMarks.tsx`: losangos dos keyframes do item; clicar move o playhead; arrastar um losango muda seu tempo em transação; Delete remove o selecionado), `ui/timeline/itemMenu.ts` ("Desativar/Ativar" para qualquer item, "Converter em Tarja/Blur/Pixelizar" para efeitos), `ui/editorActions.ts`, `shortcuts.ts` (`Shift+E` ativar/desativar item; `K` já é pausa — keyframe = `Alt+K`; `[`/`]` keyframe anterior/próximo).

EffectPanel: tipo (Blur/Pixelizar/Tarja — segmented), forma (Retângulo/Elipse), intensidade (0–100, com KeyframeButton) ou cor (Tarja), borda suave (0–100 %), inverter (switch "Borrar tudo menos a região"), escopo ("Tudo abaixo" / "Só a faixa abaixo"), posição X/Y, largura/altura, rotação — cada uma com KeyframeButton; botão "Ajustar ao quadro inteiro"; aviso inline de privacidade (de `privacyWarnings`).
- [ ] Testes puros onde houver lógica (posições dos losangos por zoom; arraste de keyframe limitado ao item e sem colisão com outro key — colisão substitui).
- [ ] QA CDP: criar keyframes pelo inspetor, navegar ◀ ▶, arrastar losango na timeline, Alt+K, desativar item (some no preview e no export).
- [ ] commit `feat(editor): inspetor de efeitos, botões de keyframe e losangos na timeline`.

### Task 5: Biblioteca de efeitos, aviso de privacidade na exportação, QA e release v1.2.0

**Files:** Modify `ui/MediaBin.tsx` (aba **Efeitos**: cartões Blur, Pixelizar, Tarja, Esconder rosto, Esconder texto, Borrar tudo menos…; arrastar para timeline/visualizador ou duplo clique adiciona no playhead), `ui/ExportDialog.tsx` (lista `privacyWarnings` no intervalo com botão "Revisar" que seleciona o item e move o playhead; não bloqueia), `README.md`, `docs/qa-checklist.md`, spec §19 (notas F2).
- [ ] QA E2E (`scripts/qa/editor-e2e.mjs` estendido ou `editor-f2-e2e.mjs`): importar vídeo de teste com "dados sensíveis" (texto desenhado com `drawtext` do ffmpeg em posição que se move), aplicar "Esconder texto" com 2 keyframes acompanhando o texto, uma tarja e um pixelizar; exportar Alta → verificar com ffmpeg que o texto não é legível na região (variância de alta frequência < limite) e que a tarja tem a cor exata.
- [ ] Gate completo: `npm test`, typecheck, `test:ingest`, `test:editor`, `test:editor-export`, `test:capture`, `test:ffmpeg` (backup/restore de settings.json).
- [ ] Revisão final da branch, correções, merge em `main`, `npm version minor`, `npm run dist:win`, `gh release create v1.2.0 …` (release normal), smoke do empacotado com `--user-data-dir` isolado (limpar projetos criados na pasta real).
