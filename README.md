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
npm run spike             # spike técnico (validações de captura/proteção/overlay)
npm run dist:win          # instalador NSIS em release/
```

Publicar uma versão (do PC de desenvolvimento): `npm version patch` (ou `minor`/`major`) e depois `npm run release:publish` — empacota e publica no GitHub Releases (usa o token do `gh`/`GH_TOKEN`); os apps instalados recebem a atualização automaticamente.

Os workflows de CI/Release do GitHub Actions estão em `docs/ci/` (para ativá-los, copie para `.github/workflows/` — exige token com escopo `workflow`).

## Estrutura

```
src/main       processo principal (janelas, captura, sessões, ffmpeg, atualização, atalhos, bandeja)
src/preload    API tipada window.api (contextIsolation)
src/renderer   UI React: gravador (index.html), barra flutuante (bar.html), overlay (overlay.html)
src/shared     tipos, schemas, compositor (PiP + traços), presets/ffmpeg, relógio de mídia, atalhos
docs           especificação, plano, pesquisa, guia de UI, instalação
```

## Licença

MIT. O ffmpeg embutido é distribuído sob GPLv3 (build BtbN; código-fonte em https://ffmpeg.org e https://github.com/BtbN/FFmpeg-Builds) e roda como processo separado.
