# Editor F7 — Exportação completa, robustez e polimento — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Ler também `.superpowers/sdd/editor-invariants.md` (obrigatório).

**Goal:** v1.7.0. Exportação completa e robusta: presets (WhatsApp, YouTube 1080p/4K, Instagram Reels/Stories 9:16, Feed 1:1/4:5, Original, Edição/intermediário), **GIF** curto, **só áudio** (mp3/wav/m4a), **quadro atual como PNG**, **intervalo I–O**, **capítulos** a partir de marcadores (texto para descrição do YouTube, copiar), **HEVC** quando suportado, fila de exportações (várias em sequência), terceiro fallback (RGBA → ffmpeg libx264 por pipe), limites de memória do compositor (texturas 512 MB, filmstrips 200 MB) e relink automático por nome/tamanho.

**Architecture:** Pipeline atual (render worker → mediabunny → `.part` → faststart) continua; F7 adiciona: (1) presets declarativos puros (`exportPresets.ts`) com validação por projeto (aspecto/duração/tamanho alvo); (2) GIF = render a frames reduzidos → ffmpeg `palettegen/paletteuse` (2 passes) com limite de duração/tamanho; (3) só áudio = audio worker → WAV PCM ou encode AAC/MP3 via ffmpeg; (4) PNG = render do quadro no tamanho do projeto via export worker (mesmo compositor) → `canvas.convertToBlob`; (5) capítulos = puro a partir de markers (formato YouTube `00:00 Título`, primeiro em 00:00, mínimo 10 s entre capítulos — avisar quando não cumprir); (6) HEVC só se `VideoEncoder.isConfigSupported` confirmar hardware; (7) fila no main/renderer com persistência leve (se o app fechar, a fila é perdida com aviso); (8) fallback libx264: frames RGBA do export worker por IPC/stdin para ffmpeg (contrapressão), acionado se WebCodecs software falhar; (9) LRU de texturas/filmstrips com contagem de bytes; (10) relink automático: ao abrir projeto com asset `missing`, procurar na pasta original/irmãs por nome+tamanho e propor.

**Spec:** §11 (exportação), §13 (robustez: memória, relink), §10 (GIF, só áudio, PNG, capítulos), §15 F7; notas §18–§21; invariantes.

## Global Constraints
- Invariantes do editor (todas). Privacidade em TODOS os formatos novos (GIF/PNG/ fallback libx264): efeitos aplicados idênticos ao preview — teste de pixels por formato.
- Exportação v1 (Revisão) não muda.

## Tasks
1. **Presets e diálogo** (presets declarativos, validação, estimativa, HEVC condicional, intervalo I–O, nomes de arquivo) + testes + QA.
2. **GIF, PNG e só áudio** (pipelines + testes reais com ffprobe/pixels/astats; privacidade por pixels em GIF/PNG).
3. **Capítulos** (puro + UI copiar/ salvar .txt) + testes.
4. **Fila de exportações** (várias em sequência, cancelar item, progresso global, aviso ao sair) + QA.
5. **Fallback libx264 por pipe** (acionado por injeção de falha em teste; paridade de pixels com o caminho WebCodecs; privacidade).
6. **Memória e relink** (LRU texturas/filmstrips com limites e métricas; relink automático por nome+tamanho com confirmação) + testes.
7. **E2E, docs (§24), gate completo, notas** — sem release.
