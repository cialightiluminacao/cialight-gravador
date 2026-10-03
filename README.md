# CiaLight Gravador

Gravador de tela para Windows da Cia Light: grava um **monitor** ou uma **janela**, com **webcam** sobreposta (redonda ou retangular, movível durante a gravação e visível só no vídeo final), **áudio do sistema** e **microfone** independentes, **pausa**, **anotações na tela** por atalho (caneta, linha, seta), tela de **revisão** com corte e **presets de exportação** (WhatsApp/e-mail, YouTube/Drive/Instagram, tutorial interno, edição posterior) e **atualização automática** via GitHub Releases.

- Instalação e uso: [docs/instalacao.md](docs/instalacao.md)
- Especificação: [docs/superpowers/specs/2026-08-18-cialight-gravador-design.md](docs/superpowers/specs/2026-08-18-cialight-gravador-design.md)
- Pesquisa técnica validada: [docs/research/2026-08-18-relatorio-tecnico-validado.md](docs/research/2026-08-18-relatorio-tecnico-validado.md) · [spike](docs/research/spike-results.md)

## Stack

Electron 43 · electron-vite 5 · React 19 · TypeScript · Tailwind v4 · Radix UI · Zustand · [mediabunny](https://mediabunny.dev) (WebCodecs → fMP4 com 4 faixas) · ffmpeg (build [BtbN](https://github.com/BtbN/FFmpeg-Builds) n8.1, embutido) · electron-builder 26 + electron-updater 6.

## Desenvolvimento

```bash
npm install
npm run fetch:ffmpeg      # baixa o ffmpeg pinado (VERSION.json) para resources/ffmpeg/
npm run fetch:models      # baixa o modelo RNNoise pinado (sha256 em models.json) para resources/models/
npm run dev               # app em modo dev
npm run typecheck && npm test
npm run test:ffmpeg       # integração real: presets de exportação com ffmpeg (Electron)
npm run test:capture      # integração real: grava 9 s do monitor com loopback/mic/câmera
npm run test:ingest       # editor: ingestão real (probe, proxies, intermediários, decodable pelo WebCodecs)
npm run test:editor       # editor: render do compositor (pixels, cortes, cor, watchdog)
npm run test:editor-export  # editor: exportação real (WebCodecs + faststart, fallback, cancelamento, 2×, ducking, voz tratada)
npm run test:editor-narration  # editor: narração com o microfone falso do Chromium (gravar, desconectar, queda, exportar)
npm run test:models       # editor: modelo RNNoise presente e usado pelo ffmpeg (redução de ruído)
npm run spike             # spike técnico (validações de captura/proteção/overlay)
npm run dist:win          # instalador NSIS em release/
```

Publicar uma versão (do PC de desenvolvimento): `npm version patch` (ou `minor`/`major`) e depois `npm run release:publish` — empacota e publica no GitHub Releases (usa o token do `gh`/`GH_TOKEN`); os apps instalados recebem a atualização automaticamente.

Os workflows de CI/Release do GitHub Actions estão em `docs/ci/` (para ativá-los, copie para `.github/workflows/` — exige token com escopo `workflow`).

## Editor de vídeo (v1.1.0)

Editor multi-faixa dentro do app: **Histórico → Editar** (ou **Projetos → Novo projeto**). A gravação vira um projeto com tela, webcam (PiP com os movimentos gravados), microfone e áudio do sistema em faixas separadas; dá para importar vídeos, áudios e imagens, dividir (`S`), apagar trechos (`I`/`O` + `Ctrl+Shift+X`), mover/aparar com ímã, ajustar posição/escala/corte/forma no visualizador e no inspetor, volume e fades, desfazer tudo (`Ctrl+Z`) e exportar (Alta 1080p, WhatsApp ≤ 64 MB, Original, Vertical 9:16). Os projetos ficam em `Vídeos\CiaLight Gravador\Projetos` (ao lado dos brutos) com salvamento automático; a mídia importada não é copiada.

**Efeitos de privacidade (v1.2.0):** esconda dados sensíveis com **Blur**, **Pixelizar** ou **Tarja** (cor sólida, a única proteção irreversível). Desenhe a região no visualizador com a ferramenta **Desenhar região** (`B`; Shift = elipse, Alt = do centro) ou arraste uma predefinição da aba **Efeitos** da biblioteca (Blur, Pixelizar, Tarja, Esconder rosto, Esconder texto, Borrar tudo menos…) para a linha do tempo ou para o visualizador (duplo clique adiciona no playhead). A região pode ser movida, redimensionada, girada e animada por **keyframes** (`Alt+K` liga/desliga no playhead, `[`/`]` navegam; losangos no item e botões ◇ no inspetor), com borda suave e "inverter" (borrar tudo menos a região). Cada efeito é um item na faixa "Efeitos": a duração define quando ele vale e `Shift+E` desativa/ativa. Criado sobre um clipe, o efeito fica **vinculado** a ele e acompanha mover, aparar, dividir, apagar, duplicar e mudar a velocidade do clipe (desvincule para soltá-lo). Mídia nova nunca entra por cima dos efeitos. O preview e o arquivo exportado são desenhados pelo mesmo compositor; o diálogo de exportação avisa (sem bloquear) sobre efeitos fracos, desativados no trecho ou com mídia por cima, com o botão **Revisar**.

**Velocidade e áudio (v1.3.0):**

- **Velocidade:** aba **Velocidade** do inspetor com presets de 0,1× a 16× (ou um valor qualquer), **Manter tom** (ligado por padrão: a voz a 2× continua com o mesmo tom, via signalsmith-stretch, no preview e no arquivo) e **Manter áudio acima de 4×** (acima de 4× o áudio fica mudo por padrão). **Congelar quadro** (2 s no playhead), **Reverter** e o shuttle clássico **J/K/L** (L/J aceleram até 8×, K pausa, K segurado + J/L anda um quadro).
- **Áudio da voz:** no inspetor de áudio, **Reduzir ruído (voz)** (RNNoise) e **Normalizar volume (−16 LUFS)**, processados uma vez e guardados em cache no projeto; segure **A/B** para comparar com o original. Medidores de nível (master e por faixa) tocando.
- **Música:** áudio importado vai para a faixa **Música** (papel de cada faixa: Voz, Música ou Efeitos sonoros, no cabeçalho). Com **Música sob a voz** (inspetor do projeto, ligado por padrão) a música abaixa sozinha −12 dB enquanto há fala nas faixas de Voz e volta no fim da fala (intensidade, ataque e soltura ajustáveis). A fala de cada mídia é detectada na importação.
- **Silêncios:** **Silêncios** na barra da linha do tempo abre o painel **Remover silêncios**: escolha as faixas de referência (padrão: as de Voz), a duração mínima e a margem, veja os cortes em vermelho na régua e aplique — todas as faixas são cortadas juntas, em sincronia, num passo de desfazer.
- **Narração:** **Narração** na barra da linha do tempo grava direto na timeline: escolha o microfone (sem processamento), "ouvir o vídeo enquanto grava", contagem 3-2-1 e Espaço/Esc para parar. O arquivo fica em `generated/` dentro do projeto e entra na faixa **Narração** (Voz) no ponto do playhead; microfone desconectado ou janela que cai não perdem o que já foi gravado.

**Keyframes e movimento (v1.4.0):**

- **Keyframes:** posição, escala, rotação e opacidade da mídia, região e intensidade dos efeitos e volume têm keyframes no inspetor (◇, `Alt+K`); corte, raio dos cantos, ajustes de cor e tamanho do texto também são animáveis no projeto (o Ken Burns de um PiP, por exemplo, anima o corte) e aparecem nas linhas de keyframes. A seta no item da linha do tempo abre **uma linha por propriedade animada**, com a mini-curva e losangos coloridos pela curva: clique/Shift/caixa seleciona, arrastar move o grupo, `Delete` apaga, `Ctrl+C`/`Ctrl+V` copiam e colam no playhead (tempos relativos mantidos).
- **Curvas:** botão direito num losango (ou no ◇ do inspetor) abre o **editor de curvas** do trecho que começa nele: Linear, Segurar, Suavizar entrada/saída/ambos, Overshoot ou uma curva personalizada arrastando as alças (bezier). Dividir, aparar, cortar silêncios e congelar mantêm a forma exata da curva.
- **Zoom/pan:** a ferramenta **Zoom** (`Z`) desenha no visualizador o enquadramento-alvo (na proporção do quadro) sobre o clipe sob o ponteiro e grava os keyframes de escala/posição no playhead, com duração, curva, "Voltar ao normal depois de N s" e "Sem bordas pretas" no botão de opções. **Ken Burns** no inspetor do vídeo: aproximação lenta do clipe inteiro numa das quatro diagonais (num PiP o movimento é feito pelo corte, a caixa fica parada).
- **Animações de entrada e saída:** grade de cartões no inspetor (Entrada / Saída / Combinação) com Fade, Deslizar (4 lados), Zoom, Pop, Girar, Quicar e Desfoque, com prévia animada no cartão, duração e curva (vídeo, imagem, texto e forma).
- **Efeitos ancorados ao clipe:** um blur/pixelizar/tarja **ancorado** acompanha o conteúdo do clipe em qualquer zoom, pan, Ken Burns, corte animado ou animação de entrada/saída, inclusive editados depois. Ao dar zoom (ou Ken Burns, ou uma animação com movimento) num clipe com efeito de privacidade vinculado, o aviso oferece **Ancorar efeito ao clipe** (ou **Vincular e ancorar** para um efeito solto); no inspetor do efeito, a chave **Ancorado ao clipe** liga/desliga a âncora (desancorar grava keyframes no quadro que reproduzem o movimento). O diálogo de exportação avisa quando um efeito não acompanha o movimento, quando o clipe da âncora sumiu ou quando o efeito passa do fim do clipe.
- **Reenquadrar:** **Reenquadrar** na barra de cima converte o projeto para **9:16**, **1:1** ou **4:5**, em "Preencher" (com **pontos de foco**: clique no visualizador marca o ponto que fica no centro naquele instante; a câmera vai suave de um ponto ao outro e o ponto continua no centro durante um zoom do clipe) ou "Caber inteiro". O padrão é **Criar cópia** ("<nome> (Vertical)", numa pasta própria com os proxies, sem reprocessar a mídia) — o original fica intacto; "Este projeto" aplica em um passo de desfazer. PiP e textos mantêm o tamanho relativo; os efeitos de privacidade continuam sobre o mesmo conteúdo (ancorados ou ajustados ao novo quadro) e o painel lista o que precisa de conferência (efeito fora do novo quadro, buraco do "Borrar tudo menos…" fechado, anotações).
- **Compatibilidade:** projetos salvos pela v1.4 continuam abrindo na v1.3, **exceto** os que usam recursos novos sem equivalente nela (keyframes em corte, ajustes, raio ou tamanho do texto; Ken Burns num PiP): esses só abrem na v1.4 — atualize todas as máquinas. Efeitos ancorados e as animações Girar/Quicar/Desfoque abrem na v1.3 de forma segura (região fixa que cobre todo o movimento — no "Borrar tudo menos…" ancorado, o quadro inteiro borrado; animação trocada por Fade/Deslizar).

**Textos, transições e legendas (v1.5.0):**

- **Transições:** aba **Transições** da biblioteca com 11 tipos (Dissolver, Mergulho no preto/branco, Deslizar ←→↑↓, Cortina ←/→, Zoom, Desfoque). Arraste o cartão até o corte entre dois clipes encostados (o corte fica realçado) ou use `Ctrl+T` (Dissolver no corte mais próximo do playhead — com clipes selecionados, na faixa deles; sem seleção, ignora a faixa de Legendas e cortes só entre textos). O ícone no corte tem a largura da transição: arraste as bordas para mudar a duração (mínimo 0,1 s, máximo metade do clipe mais curto), clique para abrir o inspetor (tipo, duração, remover), botão direito para o menu e `Delete` para remover. A transição fica **centrada no corte** e usa só o que está na timeline: o último quadro de A e o primeiro de B ficam parados durante a mistura, então nenhum trecho cortado aparece (os efeitos de privacidade de A e B continuam valendo dentro dela). O som acompanha: A some e B entra com fade de potência constante. Se um aparar, mover ou apagar separar os dois clipes, a transição sai com o aviso "Transição removida porque os clipes não estão mais encostados" (`Ctrl+Z` desfaz).
- **Textos:** aba **Texto** com Título, Subtítulo, Terço inferior, Legenda, Citação e Contagem (arraste para a linha do tempo ou para o visualizador; `T` põe um Título no playhead). **Duplo clique** no texto do visualizador edita direto (Enter quebra a linha, `Ctrl+Enter` ou clicar fora confirma, Esc cancela). No inspetor: fonte (Manrope do app, fontes comuns do Windows e as do sistema), tamanho, peso, itálico, alinhamento, altura da linha, quebra automática, cor, fundo (cor, opacidade, espaçamento, cantos), contorno, sombra, transformação e animações de entrada/saída.
- **Formas e holofote:** Retângulo, Elipse, Seta, Destaque (moldura amarela) e **Holofote** (escurece tudo fora da forma), com preenchimento, contorno, cantos, tamanho da caixa e intensidade do holofote no inspetor.
- **Legendas e SRT:** aba **Legendas**: **Nova legenda no playhead**, Enter no texto da última cria a próxima, início/fim editáveis em `mm:ss,mmm`, clicar numa linha leva o playhead até ela e um estilo comum (fonte, tamanho, cor, fundo, posição vertical) para todas. **Importar SRT…** lê UTF-8, UTF-16 e Windows-1252, aceita arquivos bagunçados (avisa os blocos ignorados) e pergunta se substitui ou acrescenta; **Exportar SRT…** grava UTF-8 com BOM. Um texto da biblioteca solto na faixa Legendas vira legenda (estilo das legendas, com aviso). Na exportação do vídeo: **Queimar no vídeo** e/ou **Salvar arquivo .srt ao lado** (mesmo nome do vídeo; nunca sobrescreve um .srt que já exista).
- **Modelos de marca:** aba **Modelos**: selecione textos, formas e imagens/vídeos importados (logo, vinheta) e **Salvar seleção como modelo…** (Sobreposição, Abertura, Encerramento ou Marca d'água). Em qualquer projeto: **Aplicar no playhead**, **Usar como abertura** (empurra todo o projeto para a frente, efeitos, legendas, Entrada/Saída e playhead juntos), **Usar como encerramento** ou **Aplicar como marca d'água** (do início ao fim do conteúdo). Os modelos valem para todos os projetos e os arquivos são copiados para o projeto ao aplicar (apagar o modelo não quebra nada). Efeitos de privacidade e gravações não entram em modelos. Se um modelo do arquivo não puder ser lido (ex.: criado numa versão mais nova), só ele fica de fora, com aviso, e o arquivo original é guardado como `brand-templates.corrupt-<data>.json`.
- **Compatibilidade:** projetos salvos pela v1.5 continuam abrindo na v1.3, mas lá as transições viram **corte seco**, textos e formas **não aparecem** e a faixa de legendas vira uma faixa comum. Se o projeto for salvo de novo na v1.3, os estilos novos (itálico, quebra, espaçamento, sombra ajustável, holofote, caixa das formas, contagem) e a marcação da faixa de legendas se perdem — atualize todas as máquinas para a v1.5.

- Especificação: [docs/superpowers/specs/2026-10-01-editor-design.md](docs/superpowers/specs/2026-10-01-editor-design.md) (§18: notas de implementação da F1; §19: da F2; §20: da F3; §21: da F4; §22: da F5)
- Checklist manual: [docs/qa-checklist.md](docs/qa-checklist.md) (seção Editor)

QA automatizado via CDP (eventos sintéticos na página, sem mexer no mouse/teclado do Windows; tudo em `test-out/`), depois de `npm run build`:

```bash
node scripts/qa/editor-timeline.mjs   # linha do tempo: dividir, mover, ímã, trim, ripple, J/K/L, desempenho
node scripts/qa/editor-export.mjs     # diálogo de exportação e exportação da fixture
node scripts/qa/editor-e2e.mjs        # ponta a ponta: grava 9 s → Histórico → Editar → corta, move webcam,
                                      # importa mp3/png, volume → exporta Alta 1080p → ffprobe (--reuse: sem regravar;
                                      # screenshots com a mídia borrada, --no-blur desliga)
node scripts/qa/editor-effects.mjs    # efeitos: desenhar/mover/girar regiões, keyframes, inspetor, losangos, desativar
node scripts/qa/editor-f2-e2e.mjs     # privacidade ponta a ponta: vídeo com CPF/conta/senha (drawtext) → Esconder texto
                                      # com 2 keyframes, Tarja e Pixelizar pela biblioteca → aviso → Alta 1080p → ffmpeg
                                      # confere o texto ilegível (laplaciano) e a cor exata da tarja
node scripts/qa/editor-f3-speed.mjs   # velocidade: presets, Manter tom, congelar, reverso, shuttle J/K/L
node scripts/qa/editor-f3-voice.mjs   # reduzir ruído / normalizar, A/B, cache reprocessado em outro PC
node scripts/qa/editor-f3-music.mjs   # música: faixa Música, papel da faixa, ducking no worker, medidores
node scripts/qa/editor-f3-silence.mjs # remover silêncios: prévia, aplicar em sincronia, desfazer em 1 passo
node scripts/qa/editor-f3-narration.mjs  # narração com o microfone falso (= npm run test:editor-narration)
node scripts/qa/editor-f3-e2e.mjs     # F3 ponta a ponta: gravação com pausas → remover silêncios → música → narração
                                      # → clipe a 2× → Alta 1080p → ffmpeg confere duração, ducking (−12 dB),
                                      # tom preservado (Goertzel) e a narração no lugar
node scripts/qa/editor-f4-keyframes.mjs  # linhas de keyframes por propriedade, seleção, copiar/colar, editor de curvas
node scripts/qa/editor-f4-zoom.mjs    # ferramenta Zoom (Z), opções, enquadramento-alvo, Ken Burns (tela cheia e PiP)
node scripts/qa/editor-f4-follow.mjs  # Ancorar ao clipe: oferta no zoom, região acompanha, desancorar, âncora perdida
node scripts/qa/editor-f4-anim.mjs    # animações de entrada/saída: cartões, duração, curva, combinação, texto
node scripts/qa/editor-f4-reframe.mjs # Reenquadrar: painel, pontos de foco, este projeto × criar cópia
node scripts/qa/editor-f4-e2e.mjs     # F4 ponta a ponta: blur vinculado → zoom 2× → Ancorar → Pop/Desfoque → curva
                                      # personalizada → Alta 1080p → Reenquadrar 9:16 (cópia, foco) → Vertical 9:16;
                                      # ffmpeg confere tamanhos, durações, o foco no centro e o texto ilegível no zoom
node scripts/qa/editor-f5-text.mjs    # Texto/Formas/Transições: cartões, edição direta, inspetores, holofote, ícone da
                                      # transição (bordas, menu, Delete), atalhos T e Ctrl+T
node scripts/qa/editor-f5-captions.mjs  # legendas: Enter cria a próxima, tempos, estilo comum, importar SRT Windows-1252,
                                      # exportar SRT, exportação com queimar / .srt ao lado (trecho I–O)
node scripts/qa/editor-f5-brand.mjs   # modelos de marca: salvar seleção, abertura, marca d'água, excluir, renomear,
                                      # arquivo corrompido renomeado (pasta de modelos de teste; modelo inválido
                                      # isolado: só ele sai, coberto em brandStore.test.ts)
node scripts/qa/editor-f5-e2e.mjs     # F5 ponta a ponta: Dissolver no corte → Título editado no visualizador → holofote
                                      # → tarja → 3 legendas + SRT → modelo como abertura → Alta 1080p com legendas
                                      # queimadas e .srt ao lado; ffmpeg confere a mistura, o título, a legenda e a
                                      # tarja em todos os quadros; desfaz e refaz tudo
```

Screenshots em `docs/qa/editor-f1/`, `docs/qa/editor-f2/`, `docs/qa/editor-f3/`, `docs/qa/editor-f4/` e `docs/qa/editor-f5/`. Os scripts restauram o `settings.json` do usuário se algo mudar.

## Estrutura

```
src/main       processo principal (janelas, captura, sessões, ffmpeg, atualização, atalhos, bandeja)
src/preload    API tipada window.api (contextIsolation)
src/renderer   UI React: gravador (index.html), barra flutuante (bar.html), overlay (overlay.html)
src/renderer/src/editor   editor: estado (zustand+immer), motor (render/audio workers, DecoderPool, WebGL2), UI, exportação
src/shared     tipos, schemas, compositor (PiP + traços), presets/ffmpeg, relógio de mídia, atalhos
src/shared/editor         modelo do projeto e operações puras (split, ripple, deleteRange, keyframes…)
docs           especificação, plano, pesquisa, guia de UI, instalação
```

## Licença

MIT. O ffmpeg embutido é distribuído sob GPLv3 (build BtbN; código-fonte em https://ffmpeg.org e https://github.com/BtbN/FFmpeg-Builds) e roda como processo separado. Atribuições de terceiros (mediabunny MPL-2.0, twgl.js, signalsmith-stretch MIT, modelo RNNoise, immer etc.) em [NOTICE](NOTICE).
