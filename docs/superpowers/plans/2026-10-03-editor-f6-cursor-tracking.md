# Editor F6 — Cursor/cliques, auto-zoom, realce de clique e blur que segue — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Ler também `.superpowers/sdd/editor-invariants.md` (obrigatório).

**Goal:** v1.6.0. O gravador registra cursor e cliques; o editor gera **auto-zoom** suave nos cliques (estilo Screen Studio, editável), desenha **realce de clique** (anel/pulso configurável) e **cursor suavizado/ampliado** opcional; **blur que segue**: marcar uma região num quadro e o app rastreia o conteúdo ao longo do tempo gerando keyframes revisáveis.

**Architecture:**
(1) Gravador (main): amostrar `screen.getCursorScreenPoint()` a 60 Hz durante a gravação (pausas respeitadas, tempo de mídia via MediaClock existente), cliques via hook global — avaliar opções reais no Windows: `uiohook-napi` (MIT, nativo — verificar build p/ Electron 43 e assinatura) vs. poll de `GetAsyncKeyState` via PowerShell/ffi (evitar) vs. overlay transparente (não captura cliques fora). Escolher com spike e evidência. Gravar em **arquivo separado** `cursor.json` na pasta da sessão (NUNCA adicionar campo ao `session.json`: o `SessionSchema` v1 é estrito e o app v1.3 instalado rejeitaria a gravação). Coordenadas normalizadas ao frame gravado (respeitar scaleFactor/DPI e multi-monitor; modo janela: relativo ao bounds da janela, com bounds amostrados).
(2) Editor: asset de sessão ganha `cursor` (caminho do json) via ingestão; `fromSession` cria item `cursor` opcional (camada de realce/cursor) e oferece auto-zoom.
(3) Auto-zoom: `planAutoZoom(clicks, cursor, opts)` puro → segmentos de zoom (agrupa cliques próximos, mantém zoom enquanto há atividade, pan suave seguindo o cursor com amortecimento, nunca bordas pretas) → keyframes via `zoom.ts` existente (merge com keys do usuário, um passo de desfazer); efeitos de privacidade: ancorados seguem automaticamente; não ancorados → aviso (regra F4) + oferta de ancorar.
(4) Realce de clique/cursor: camada `cursor` desenhada pelo compositor (anel pulsante, cor/tamanho; cursor ampliado opcional desenhado a partir de um sprite padrão do Windows embutido) em coordenadas de conteúdo do clipe de tela (segue zoom/reenquadrar automaticamente via contentPose).
(5) Blur que segue: worker de rastreamento (template matching NCC em frames reduzidos, multi-escala opcional, rejeição por confiança baixa → para e marca para revisão) gera keys `region.x/y` (e w/h se escala) na região do efeito; UI: botão "Seguir conteúdo" no EffectPanel com progresso/cancelar, faixa de confiança na timeline, keys editáveis. Privacidade: quando a confiança cai, **não** inventa posição — mantém a última e alarga a região (cobrir mais), aviso "rastreamento perdido" com instante.

**Spec:** §10 (auto-zoom, realce, blur que segue), §15 F6; notas §18–§21; invariantes.

## Global Constraints
- Invariantes do editor (todas). Gravação v1 não pode piorar: overhead de amostragem < 1 % CPU; `test:capture` continua passando; nenhuma alteração no `session.json`.
- Dependência nativa (se usada) precisa empacotar e rodar no instalador (`dist:win`) e ter licença compatível (registrar no NOTICE).

## Tasks
1. **Spike de captura de cliques** (documentar opções medidas; escolher) + amostragem de cursor no gravador → `cursor.json` (formato versionado: `{version:1, width,height, samples:[{tMs,x,y}], clicks:[{tMs,x,y,button}]}`), DPI/multi-monitor/janela, pausas; testes puros de normalização e teste real com `test:capture` (cursor movido por `SetCursorPos` via PowerShell **apenas em modo de teste e restaurado** — ou simulação injetada se possível sem input de SO real; preferir injeção).
2. **Ingestão e modelo**: asset de sessão expõe cursor; item `cursor` (camada) + toDiskProject compat; `fromSession` integra.
3. **Auto-zoom** (`planAutoZoom` puro + UI "Zoom automático nos cliques" com intensidade/duração/suavidade, prévia, aplicar como 1 passo) + testes densos (bordas pretas nunca, continuidade) + teste real de pixels.
4. **Realce de clique e cursor** (compositor + inspetor) + teste real (anel no ponto do clique ±2 px após zoom/reenquadrar).
5. **Blur que segue** (worker NCC, UI, confiança, comportamento conservador) + testes com vídeo sintético de texto em movimento (texto ilegível em todos os quadros exportados) + perda de rastreamento.
6. **E2E, docs (§23), gate completo, notas** — sem release.
