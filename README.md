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
npm run dev               # app em modo dev
npm run typecheck && npm test
npm run test:ffmpeg       # integração real: presets de exportação com ffmpeg (Electron)
npm run test:capture      # integração real: grava 9 s do monitor com loopback/mic/câmera
npm run test:ingest       # editor: ingestão real (probe, proxies, intermediários, decodable pelo WebCodecs)
npm run test:editor       # editor: render do compositor (pixels, cortes, cor, watchdog)
npm run test:editor-export  # editor: exportação real (WebCodecs + faststart, fallback, cancelamento)
npm run spike             # spike técnico (validações de captura/proteção/overlay)
npm run dist:win          # instalador NSIS em release/
```

Publicar uma versão (do PC de desenvolvimento): `npm version patch` (ou `minor`/`major`) e depois `npm run release:publish` — empacota e publica no GitHub Releases (usa o token do `gh`/`GH_TOKEN`); os apps instalados recebem a atualização automaticamente.

Os workflows de CI/Release do GitHub Actions estão em `docs/ci/` (para ativá-los, copie para `.github/workflows/` — exige token com escopo `workflow`).

## Editor de vídeo (v1.1.0)

Editor multi-faixa dentro do app: **Histórico → Editar** (ou **Projetos → Novo projeto**). A gravação vira um projeto com tela, webcam (PiP com os movimentos gravados), microfone e áudio do sistema em faixas separadas; dá para importar vídeos, áudios e imagens, dividir (`S`), apagar trechos (`I`/`O` + `Ctrl+Shift+X`), mover/aparar com ímã, ajustar posição/escala/corte/forma no visualizador e no inspetor, volume e fades, desfazer tudo (`Ctrl+Z`) e exportar (Alta 1080p, WhatsApp ≤ 64 MB, Original, Vertical 9:16). Os projetos ficam em `Vídeos\CiaLight Gravador\Projetos` (ao lado dos brutos) com salvamento automático; a mídia importada não é copiada.

**Efeitos de privacidade (v1.2.0):** esconda dados sensíveis com **Blur**, **Pixelizar** ou **Tarja** (cor sólida, a única proteção irreversível). Desenhe a região no visualizador com a ferramenta **Desenhar região** (`B`; Shift = elipse, Alt = do centro) ou arraste uma predefinição da aba **Efeitos** da biblioteca (Blur, Pixelizar, Tarja, Esconder rosto, Esconder texto, Borrar tudo menos…) para a linha do tempo ou para o visualizador (duplo clique adiciona no playhead). A região pode ser movida, redimensionada, girada e animada por **keyframes** (`Alt+K` liga/desliga no playhead, `[`/`]` navegam; losangos no item e botões ◇ no inspetor), com borda suave e "inverter" (borrar tudo menos a região). Cada efeito é um item na faixa "Efeitos": a duração define quando ele vale e `Shift+E` desativa/ativa. Criado sobre um clipe, o efeito fica **vinculado** a ele e acompanha mover, aparar, dividir, apagar, duplicar e mudar a velocidade do clipe (desvincule para soltá-lo). Mídia nova nunca entra por cima dos efeitos. O preview e o arquivo exportado são desenhados pelo mesmo compositor; o diálogo de exportação avisa (sem bloquear) sobre efeitos fracos, desativados no trecho ou com mídia por cima, com o botão **Revisar**.

- Especificação: [docs/superpowers/specs/2026-10-01-editor-design.md](docs/superpowers/specs/2026-10-01-editor-design.md) (§18: notas de implementação da F1; §19: da F2)
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
```

Screenshots em `docs/qa/editor-f1/` e `docs/qa/editor-f2/`. Os scripts restauram o `settings.json` do usuário se algo mudar.

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

MIT. O ffmpeg embutido é distribuído sob GPLv3 (build BtbN; código-fonte em https://ffmpeg.org e https://github.com/BtbN/FFmpeg-Builds) e roda como processo separado. Atribuições de terceiros (mediabunny MPL-2.0, twgl.js, immer etc.) em [NOTICE](NOTICE).
