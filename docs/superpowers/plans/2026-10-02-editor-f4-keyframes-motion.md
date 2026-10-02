# Editor F4 — Keyframes completos, curvas, zoom/pan, animações e reenquadrar — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** v1.4.0. Tudo que é numérico no item pode ser animado com keyframes e **curvas** editáveis (linear, segurar, suavizar entrada/saída, bezier personalizado); **zoom/pan** ("Ken Burns" e zoom em detalhe da tela) com ferramenta dedicada; **animações de entrada/saída** completas (fade, deslizar, zoom, pop, girar, bater, desfoque); **reenquadrar** para 9:16/1:1/4:5 com keyframes de posição (e assistente "seguir o centro de interesse" manual por pontos); editor de keyframes na timeline (faixa de keyframes expandida por propriedade).

**Architecture:** O modelo já tem `Anim<number>` e `Ease` com bezier; `evalAnim` interpola. F4 adiciona: (1) `crop` e `adjust` animáveis (migração de campos estáticos para `Anim`, compatível), (2) ease por keyframe editável e um **editor de curvas** (popover com gráfico da curva bezier arrastável e presets), (3) **lanes de keyframes** na timeline (expandir item → linhas por propriedade com losangos e segmentos coloridos pelo ease; arrastar, copiar/colar keyframes), (4) **zoom/pan** = keyframes de transform (scale/x/y) no item de mídia gerados por uma ferramenta "Zoom" no visualizador (desenhar o retângulo-alvo; duração e easing; "zoom de entrada/saída"), (5) animações de entrada/saída implementadas no `resolve` (zoom, pop, rotate, bounce, blur — o último requer filtro de blur por camada no compositor), (6) **reenquadrar**: muda a proporção do projeto e converte itens em `fit: cover` com keyframes de posição para manter o ponto de interesse (pontos marcados pelo usuário no tempo), (7) envelope de volume da forma de onda já usa keyframes (F3) — curvas também.

**Spec:** `docs/superpowers/specs/2026-10-01-editor-design.md` (§4 Anim/Keyframe/Ease/VisualProps/animIn/animOut, §6 compositor, §9 Inspetor (botão de keyframe ◇ ◀ ▶), §10 "Reenquadrar", §15 F4) + notas §18–§20. Pendências F2/F3 a resolver aqui: envelope de áudio ignora ease do key (F1 Task 3 minor); keyframe markers por propriedade.

## Global Constraints

- Restrições globais F1–F3 (µs inteiros, `shared/editor` puro, v1 intacta, pt-BR, preview = exportação, sem input de SO, `settings.json` intocado/restaurado, repo público).
- Compatibilidade: projetos v1.1–v1.3 abrem sem mudança visual; campos que viram `Anim` aceitam o formato antigo (número) na migração (`migrateProject`), sem bump de `version` se o schema aceitar ambos (union) — decidir e documentar.
- Privacidade: animações/zoom aplicados a **mídia** nunca podem descobrir conteúdo sob efeito vinculado — efeitos seguidores devem acompanhar transformações do clipe? Não: o efeito é em coordenadas do quadro; se o clipe der zoom, o conteúdo sensível se move. **Regra F4:** ao aplicar zoom/pan/animação de movimento num clipe com efeitos vinculados `region`, oferecer "Ajustar efeitos ao movimento" (converte a região para seguir a transformação do clipe — keyframes calculados) e, se não ajustados, `privacyWarnings` gera aviso `transformedUnderEffect`.
- Curvas: `Ease` bezier com x1,x2 ∈ [0,1]; y livre (permite overshoot) — avaliação estável (Newton+bisseção já existe).
- Desempenho: avaliação de dezenas de propriedades animadas por item por quadro < 0,5 ms para 50 itens visíveis.

## Review Focus

- Keyframe exatamente na borda do item após split/trim/speed → valor contínuo, sem salto.
- Bezier com overshoot (y > 1) em opacidade/escala → clamp onde a propriedade exige (opacidade 0–1, escala > 0).
- Projeto antigo com `crop` numérico abre e exporta idêntico (pixel diff 0).
- Zoom em clipe com blur vinculado → aviso ou ajuste; nunca descoberta silenciosa.
- Copiar/colar keyframes entre itens de durações diferentes → tempos relativos preservados e clampados.

---

### Task 1: Modelo — tudo animável, ease por key e migração
Files: `src/shared/editor/project.ts`, `schema.ts` (+test), `anim.ts` (+test: `setEase`, `easeAt`, `copyKeys(range)`, `pasteKeys(at, clamp)`), `ops.ts` (+test: `setKeyEase(p,itemId,path,tUs,ease)`, `copyKeyframes`, `pasteKeyframes`, `AnimPath` ampliado: `crop.l/t/r/b`, `adjust.brightness/contrast/saturation`, `visual.radius`, `text.size` (F5 usa), `region.*`, `strength`, `audio.volume`), `resolve.ts` (avaliar novos animáveis), `audioPlan.ts` (envelope respeita ease do key — pendência F1), `migrate` (número → `{value}`), `privacy.ts` (`transformedUnderEffect`).
- [ ] Testes: round-trip de projeto antigo (crop numérico) → mesmo `resolveFrame` que antes; ease por key afeta interpolação; audio envelope com ease `in`; paste clamp; privacy warning quando item de mídia com scale/x/y animados tem efeito vinculado com região estática sobreposta.
- [ ] commit `feat(editor): todas as propriedades animáveis, ease por keyframe e migração`.

### Task 2: Editor de curvas e lanes de keyframes na timeline
Files: `ui/Inspector/CurveEditor.tsx` (popover: gráfico 0–1 com alças bezier arrastáveis, presets Linear/Segurar/Suavizar entrada/Suavizar saída/Suavizar ambos/Overshoot; aplica ao segmento após o keyframe selecionado), `ui/Inspector/KeyframeButton.tsx` (clique direito no ◇ abre curva), `ui/timeline/KeyframeLanes.tsx` (item expandível — seta no item; uma linha por propriedade animada com losangos coloridos por ease e mini-curva do valor; arrastar losango (transação), selecionar vários (caixa/Shift), Delete, Ctrl+C/Ctrl+V de keyframes no playhead), `ui/timeline/layout.ts` (altura extra por lane), `shortcuts.ts`.
- [ ] Testes puros (layout das lanes, mapeamento valor→y da mini-curva, seleção múltipla).
- [ ] QA CDP `scripts/qa/editor-f4-keyframes.mjs` + screenshots `docs/qa/editor-f4/`.
- [ ] commit `feat(editor): editor de curvas e linhas de keyframes na timeline`.

### Task 3: Zoom/pan
Files: `ui/viewer/ZoomTool.tsx` (ferramenta "Zoom" (Z): arrastar um retângulo no visualizador = enquadramento-alvo; popover com duração (0,3–3 s), ease, "voltar ao normal depois de N s"; cria keyframes de scale/x/y no item de mídia sob o cursor (o de cima não-efeito), respeitando aspect do projeto), `src/shared/editor/zoom.ts` (+test: `zoomKeys(item, targetRect, atUs, durUs, holdUs, ease, canvas)` puro — calcula scale/x/y que levam o retângulo ao quadro inteiro, clamp para não mostrar bordas pretas (opção)), "Ken Burns" (preset no inspetor: zoom lento 1→1,15 com pan diagonal ao longo do item), integração com privacidade (oferta "Ajustar efeitos ao movimento" + aviso).
- [ ] Testes puros do cálculo (retângulo → transform; ida e volta; clamp de bordas; projeto 9:16).
- [ ] Teste real (`test:editor`): após zoom 2× num retângulo, o pixel do centro do retângulo-alvo aparece no centro do quadro no instante final (±2 px).
- [ ] commit `feat(editor): ferramenta de zoom/pan e Ken Burns`.

### Task 4: "Ajustar efeitos ao movimento"
Files: `src/shared/editor/followTransform.ts` (+test: dado item de mídia com transform animado e efeito vinculado com região em coordenadas do quadro, gera keyframes da região no espaço do quadro que acompanham o mesmo ponto do conteúdo (amostragem nos keyframes + quadros intermediários onde a curva não é linear, simplificada com tolerância 0,5 % do quadro)), op `fitEffectsToMotion(p, mediaItemId)`, UI (botão no inspetor do efeito e na oferta do Task 3), `privacy.ts` (`transformedUnderEffect` some após ajuste).
- [ ] Testes puros (zoom 2× central: região dobra e fica centrada; pan: região translada; rotação: região gira).
- [ ] Teste real de pixel: blur vinculado sobre texto + zoom 2× no clipe + ajuste → texto continua ilegível no export ao longo do zoom (métrica de legibilidade do F2).
- [ ] commit `feat(editor): efeitos acompanham zoom/pan do clipe`.

### Task 5: Animações de entrada/saída completas
Files: `src/shared/editor/resolve.ts` (+test: presets fade, slideL/R/U/D, zoom (0,8→1), pop (0,6→1,05→1), rotate (−15°→0), bounce (deslizar com overshoot), blur (desfoque 20→0 px) com ease configurável), `project.ts`/`schema.ts` (`AnimPreset` ampliado + `ease`), compositor (desfoque por camada para o preset blur — reaproveitar o passe de blur do F2 numa FBO da camada), `ui/Inspector/AnimPanel.tsx` (grade de cartões com prévia animada em miniatura (CSS), duração, ease; entrada e saída separadas; "Combinação" in+out).
- [ ] Testes puros por preset (valores em 0, ½, 1).
- [ ] Teste real: preset blur e pop em pixels (variância/escala medidas) e paridade preview=export.
- [ ] commit `feat(editor): animações de entrada e saída completas`.

### Task 6: Reenquadrar (vertical/quadrado)
Files: `src/shared/editor/reframe.ts` (+test: `reframeProject(p, aspect, opts: { mode: 'cover' | 'contain'; focus?: {tUs,x,y}[] per item })` → novo canvas; itens de mídia viram `fit: cover` com keyframes x/y que mantêm o ponto de foco; efeitos de região convertidos para o novo quadro (regiões mapeadas; fora do novo quadro = mantidos e avisados); textos reposicionados proporcionalmente), `ui/ReframeDialog.tsx` (escolher proporção, modo, marcar pontos de foco clicando no visualizador em instantes (lista editável), prévia; aplica como 1 passo de desfazer ou cria **cópia do projeto** "(Vertical)" — padrão cópia), IPC `project.duplicate`.
- [ ] Testes puros (16:9 → 9:16 com foco à direita: x keyframe correto; efeito de região mapeado e coberto; privacidade: região que saiu do novo quadro não gera vazamento — verificado).
- [ ] QA + export real em 1080×1920 (dimensões, foco visível).
- [ ] commit `feat(editor): reenquadrar para vertical/quadrado com pontos de foco`.

### Task 7: QA, docs e release v1.4.0
- [ ] E2E `scripts/qa/editor-f4-e2e.mjs`: zoom com ajuste de efeitos, animações in/out, curvas, reenquadrar para 9:16, export e verificações.
- [ ] Docs (README, checklist, spec §21 notas F4), gate completo, revisão final, merge, `npm version minor`, `dist:win`, smoke empacotado, `gh release create v1.4.0`.
