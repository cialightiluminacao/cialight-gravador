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

- Especificação: [docs/superpowers/specs/2026-10-01-editor-design.md](docs/superpowers/specs/2026-10-01-editor-design.md) (§18: notas de implementação da F1; §19: da F2; §20: da F3)
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
```

Screenshots em `docs/qa/editor-f1/`, `docs/qa/editor-f2/` e `docs/qa/editor-f3/`. Os scripts restauram o `settings.json` do usuário se algo mudar.

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
