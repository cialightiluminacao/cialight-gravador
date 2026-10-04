# Spike G2 — whisper.cpp para legendas automáticas pt-BR (03/10/2026)

Spec: `docs/superpowers/specs/2026-10-01-editor-design.md` (aba Legendas → "Gerar legendas", transcrição offline).
Objetivo: fixar versão/arquivos do whisper.cpp e dos modelos ggml, decidir flags da CLI, formato JSON consumido,
filtro de silêncio, contorno de caminhos no Windows e número de threads — com medidas neste PC.

Decisões já tomadas (não reabertas aqui): binários CPU do whisper.cpp baixados em **tempo de build** para
`resources/whisper/` e empacotados (como o ffmpeg); modelos ggml baixados pelo app em **tempo de execução**; o áudio
entregue ao whisper é WAV PCM 16 kHz mono de um trecho do arquivo-fonte, extraído com o ffmpeg empacotado.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Intel Core i5-13400 (10 núcleos: 6P + 4E, 16 lógicos), Windows 11 Pro 26200 |
| Carga de fundo | outras worktrees ativas: CPU ocupada antes de cada execução entre 25 % e 45 % (uma vez 81 %) — coluna "carga" |
| Amostra | fala sintética pt-BR (System.Speech, voz "Microsoft Maria Desktop"), **74,56 s**, 124 palavras escritas (128 após normalização: hífens separam), 10 frases, 3 pausas (1,5 s / 2,0 s / 1,5 s), números (120, 14, 15) e acentos. Texto em `SSML_PTBR` de `scripts/qa/whisper-spike.mjs` |
| Verdade-base | início de cada palavra pelo `SpeakProgress.AudioPosition` (`scripts/qa/synthSpeech.mjs`) |
| Ferramentas | `scripts/qa/synth-speech.ps1` + `scripts/qa/synthSpeech.mjs` (fala sintética, nunca o microfone); `scripts/qa/whisper-spike.mjs` (todas as medidas abaixo; saída em `test-out/whisper-spike/results.json`) |

## 1. Pins

### whisper.cpp

| Campo | Valor |
|---|---|
| Versão | **v1.9.4** (commit `927cfce34f31707e17f2bff35c349632fb9e2c3a`); os binários Windows do release saem no build `b5130` do mesmo commit |
| Arquivo escolhido | `whisper-bin-x64.zip` (CPU) — 8 573 270 bytes, sha256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c` |
| Alternativa medida | `whisper-blas-bin-x64.zip` (OpenBLAS embutido) — 21 360 234 bytes, sha256 `55c06d09e8b9b6cfb2b0b47ddedc71803054f0e48be1f41848b3141c06c703a9`. Roda sem instalações extras, mas é **mais lento** neste PC (seção 3) → descartado |
| URLs (ordem) | 1) espelho `https://github.com/cialightiluminacao/cialight-gravador/releases/download/deps-whisper-v1.9.4/whisper-bin-x64.zip` 2) upstream `https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip` |
| Licença | MIT — `resources/whisper/LICENSE` (versionado; o zip não traz LICENSE) |
| Arquivos de execução (13) | `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu-*.dll` (9 variantes: alderlake, cannonlake, cascadelake, haswell, icelake, sandybridge, skylakex, sse42, x64 — o ggml escolhe a melhor para a CPU em tempo de execução; aqui carregou `ggml-cpu-alderlake.dll`). 10 514 432 bytes extraídos (+ LICENSE e VERSION.json) |
| Fora do pacote | `SDL2.dll`, `llama.dll`, `parakeet*`, `whisper-server/stream/command/talk-llama/lsp/bench/quantize/vad*`, `main.exe`/`bench.exe`/`stream.exe`/`command.exe` (stubs), `wchess.exe`, `test-*.exe` |

Conferido: o conjunto de 13 arquivos extraído para `resources/whisper/` roda sozinho (`--version` → `whisper.cpp version: 1.9.4`
e a segunda repetição das medidas de carimbo da seção 4 usou exatamente esse binário: `--bin resources/whisper`).
Requer o Visual C++ 2015–2022 x64 Redistributable (já exigido pelo Electron/ffmpeg na prática; `fetch-whisper.mjs` acusa
se o `.exe` não carregar).

### Modelos ggml (multilíngues; Hugging Face `ggerganov/whisper.cpp`, commit `5359861c739e955e79d9a303bcbc70fb988958b1`)

| Modelo | Nome na UI | Bytes | sha256 (= oid LFS do HF, conferido via API `paths-info`) | URL upstream |
|---|---|---|---|---|
| `ggml-base.bin` | Base (padrão) | 147 951 465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin` |
| `ggml-small.bin` | Preciso | 487 601 967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin` |

Licença: MIT (pesos do OpenAI Whisper; repositório do HF marcado `license: mit`).

### Espelho

Pré-release `deps-whisper-v1.9.4` em `cialightiluminacao/cialight-gravador` (título "Dependência: whisper.cpp v1.9.4
(win x64) e modelos ggml", corpo pt-BR com origens, licenças e sha256), 3 assets byte-idênticos aos originais:
`whisper-bin-x64.zip`, `ggml-base.bin`, `ggml-small.bin`. URLs dos modelos no espelho:
`https://github.com/cialightiluminacao/cialight-gravador/releases/download/deps-whisper-v1.9.4/ggml-{base,small}.bin`.
Verificação após o upload (download do espelho para uma pasta nova + `sha256sum`) bate nos 3 arquivos.

### Build

- `resources/whisper/VERSION.json` (tag, zip, urls [espelho, upstream], sha256, files, note) + `scripts/fetch-whisper.mjs`
  (cache `node_modules/.cache/whisper-v1.9.4-whisper-bin-x64.zip`, sha256, extrai só `files` achatando `Release/`,
  `.stamp` = `tag sha256`, `--force`, sanidade `whisper-cli.exe --version`).
- `package.json`: `fetch:whisper`; `dist:win` e `release:publish` rodam o fetch antes do `electron-vite build`;
  `build.extraResources`: `resources/whisper` → `whisper` (filtro `*.exe`, `*.dll`, `LICENSE*`, `VERSION.json`).
- `.gitignore`: `resources/whisper/*` exceto `VERSION.json` e `LICENSE`.

## 2. Precisão (palavras)

Normalização: minúsculas, hífen/travessão → espaço, remove pontuação, **mantém acentos**, números como o whisper
escreve. Alinhamento por distância de edição (palavras). A precisão é determinística no modo guloso (as duas
repetições deram resultados idênticos).

| Modelo | Decodificação | Palavras corretas | WER | Erros (ref→hip) |
|---|---|---|---|---|
| base | gulosa (`-bs 1 -bo 1`) | **97,7 %** (125/128) | 2,3 % (S 2, D 1, I 0) | `luminárias→luminarias` (acento perdido), `lembrem se→lebrense` |
| base | beam 5 (padrão da CLI) | 98,4 % | 1,6 % | — |
| small | gulosa | **99,2 %** (127/128) | 0,8 % (S 1) | `lembrem→lembre` |
| small | beam 5 | 100 % | 0 % | — |

Números: o whisper escreveu `120`, `14`, `15` em algarismos (como no texto) e `dois`/`seis` por extenso (como no
texto) — sem divergência "2" × "dois" nesta amostra. Atenção: com fala real o texto pode vir em algarismos onde a
pessoa falou por extenso; isso não é erro de transcrição, mas afeta comparações de teste.

## 3. Desempenho (RTF = segundos de áudio ÷ segundos de relógio; 74,56 s de áudio; 2 repetições)

### Build CPU × BLAS, gulosa, por threads

| Build | Modelo | Threads | Rep. 1: tempo / RTF / carga | Rep. 2: tempo / RTF / carga |
|---|---|---|---|---|
| CPU | base | 4 | 6,33 s / 11,8× / 36 % | 5,95 s / 12,5× / 41 % |
| CPU | base | **8** | 4,48 s / **16,6×** / 36 % | 3,96 s / **18,8×** / 38 % |
| CPU | base | 12 | 7,18 s / 10,4× / 39 % | 4,25 s / 17,6× / 29 % |
| CPU | small | 4 | 20,62 s / 3,6× / 45 % | 17,92 s / 4,2× / 35 % |
| CPU | small | **8** | 13,78 s / **5,4×** / 38 % | 13,76 s / **5,4×** / 35 % |
| CPU | small | 12 | 15,03 s / 5,0× / 31 % | 15,23 s / 4,9× / 34 % |
| BLAS | base | 4 | 5,97 s / 12,5× / 36 % | 6,00 s / 12,4× / 41 % |
| BLAS | base | 8 | 5,54 s / 13,5× / 40 % | 5,69 s / 13,1× / 35 % |
| BLAS | base | 12 | 5,09 s / 14,6× / 42 % | 6,14 s / 12,1× / 36 % |
| BLAS | small | 4 | 22,79 s / 3,3× / 42 % | 22,99 s / 3,2× / 36 % |
| BLAS | small | 8 | 21,01 s / 3,6× / 39 % | 21,37 s / 3,5× / 38 % |
| BLAS | small | 12 | 32,17 s / 2,3× / 38 % | 36,44 s / 2,1× / 38 % |

### Beam 5 (referência) e configuração final (gulosa + DTW + `-nfa`), build CPU

| Modelo | Decodificação | Threads | Rep. 1: tempo / RTF / carga | Rep. 2: tempo / RTF / carga |
|---|---|---|---|---|
| base | beam 5 | 8 | 11,88 s / 6,3× / 36 % | 7,86 s / 9,5× / 44 % |
| small | beam 5 | 8 | 29,12 s / 2,6× / 35 % | 18,55 s / 4,0× / 40 % |
| base | **final** | 4 | 6,50 s / 11,5× / 34 % | 7,11 s / 10,5× / 35 % |
| base | **final** | **8** | 6,32 s / 11,8× / **81 %** | 5,75 s / **13,0×** / 35 % |
| base | **final** | 12 | 5,37 s / 13,9× / 33 % | 5,51 s / 13,5× / 26 % |
| small | **final** | 4 | 20,92 s / 3,6× / 39 % | 23,88 s / 3,1× / 39 % |
| small | **final** | **8** | 17,75 s / **4,2×** / 32 % | 17,68 s / **4,2×** / 38 % |
| small | **final** | 12 | 18,08 s / 4,1× / 35 % | 18,63 s / 4,0× / 41 % |

Medidas avulsas da configuração final nas rodadas de carimbo (8 threads): base 6,21 s (12,0×) e 3,89 s (19,2×, binário
de `resources/whisper`); small 19,99 s (3,7×) e 13,26 s (5,6×).

Conclusões:
- Build **CPU** > BLAS em todos os casos do small e na maioria do base → empacotar só o CPU.
- **8 threads** é o melhor ponto (12 não ganha e piora o small; os 4 núcleos E e o SMT não ajudam).
- O custo de DTW + `-nfa` (sem flash attention) é ≈ 20–30 % de tempo: base cai de ~17× para ~12–13×.
- **Meta de 2× tempo real para o base na CPU: atendida com folga** (≈ 12–19× com a configuração final; small ≈ 4×).
  1 h de vídeo ≈ 5 min (base) / 15 min (small) neste PC; PCs de 4 núcleos devem ficar ~2–3× mais lentos.
- Beam 5 melhora pouco a precisão (+0,7 pp) a ~2× o custo → gulosa.

## 4. Carimbos de tempo por palavra (início; erro absoluto vs. verdade-base; 8 threads, gulosa)

| Opção | Modelo | Mediana | p90 | Máx. | ≤ 300 ms |
|---|---|---|---|---|---|
| (a) `-ojf`, `tokens[].offsets.from` | base | 222 ms | 676 ms | 1 380 ms | 63,2 % |
| (a) `-ojf` | small | 252 ms | 1 311 ms | 2 703 ms | 56,7 % |
| (b) `-ml 1 -sow`, `offsets.from` do segmento-palavra | base | 232 ms | 676 ms | 1 380 ms | 61,6 % |
| (b) `-ml 1 -sow` | small | 252 ms | 1 311 ms | 2 703 ms | 56,7 % |
| (c) `--dtw <modelo> -nfa -ojf`, `t_dtw` do próprio token | base | 288 ms | 616 ms | 952 ms | 52,8 % |
| (c) idem | small | 245 ms | 489 ms | 752 ms | 63,0 % |
| (c') DTW, início = `t_dtw` do token **anterior** | base | 42 ms | 214 ms | 405 ms | 96,0 % |
| (c') idem | small | 50 ms | 164 ms | 351 ms | 98,4 % |
| **(c'') (c') + ajuste à fala (escolhida)** | **base** | **42 ms** | **124 ms** | **388 ms** | **99,2 %** |
| **(c'') idem** | **small** | **50 ms** | **164 ms** | **351 ms** | **98,4 %** |

As duas repetições (binário do cache e binário de `resources/whisper`) deram erros **idênticos** (decodificação
determinística); só o tempo variou. `-nfa` sem DTW não muda os offsets (mesmo erro de (a)).

Por que (c'): `t_dtw` marca o **fim** do token (≈ início do próximo). Por isso o início da palavra é o `t_dtw` do token
não especial anterior no mesmo segmento; a 1ª palavra do segmento usa `offsets.from` do seu token.

Ajuste à fala ("snap"): intervalos de fala por `silencedetect=n=-35dB:d=0.35` (mesmo critério da ingestão), com 120 ms
de folga; palavra cujo início cai fora da fala vai para o início do próximo intervalo de fala; inícios não decrescentes.
Isso corrige a 1ª palavra após uma pausa longa. Teste com lacuna (fala 0–17 s + 10 s de silêncio digital + 10 s de
ruído rosa baixo + fala 17–34 s, 54 s):

| Modelo | Opção | Mediana | p90 | Máx. | ≤ 300 ms |
|---|---|---|---|---|---|
| base | offsets | 254 ms | 2 510 ms | 7 135 ms | 63,8 % |
| base | (c') | 51 ms | 300 ms | 7 135 ms | 91,4 % |
| base | **(c'')** | 51 ms | **220 ms** | **685 ms** | **96,6 %** |
| small | offsets | 203 ms | 1 322 ms | 7 125 ms | 64,4 % |
| small | (c') | 42 ms | 268 ms | 7 125 ms | 94,9 % |
| small | **(c'')** | 42 ms | **165 ms** | **351 ms** | **98,3 %** |

Escolha: **(c'')** — atende ±0,3 s em ≥ 96,6 % das palavras, inclusive após pausas longas.

## 5. Silêncio e ruído (10 s de silêncio digital; 10 s de ruído rosa a = 0,003)

| Entrada | Modelo | Padrão | `-sns` | `-nth 0.3` | `-sns -nf` |
|---|---|---|---|---|---|
| silêncio | base | `[MÚSICA DE FUNDO]` | `ucci` | `[MÚSICA DE FUNDO]` | laço "que é o que é…" (0–30 s) |
| silêncio | small | `[Música]` | `e aí` | `[Música]` | `e aí` |
| ruído | base | `[música]` | `ievous, e wodessilgido` | `[música]` | laço "eu sou o meu amigo…" (0–30 s) |
| ruído | small | `[música]` | `E aí, pessoal, até a próxima!` | `[música]` | `E aí` |

- Sem flags extras, o whisper só produz **anotações entre colchetes** — fáceis de descartar. `--suppress-nst` (`-sns`)
  **piora**: troca a anotação por palavras inventadas; `-nf` (sem fallback de temperatura) gera laços repetitivos.
  `-nth 0.3` não muda nada. → **não usar `-sns`, `-nf` nem `-nth`**.
- Probabilidade média dos tokens não separa: segmentos de fala real têm média mínima 0,85 (base) / 0,92 (small), e
  alucinações chegam a 0,92 → não usar limiar de `p`.

Filtro recomendado (aplicado por segmento do JSON):
1. **Anotação pura**: texto que só contém blocos `[…]`, `(…)`, `*…*` ou `♪…♪` → descarta
   (`/^\s*(?:(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪[^♪]*♪)\s*)+$/u`). Correção (G2 T4): a 1ª versão,
   `/^\s*([[(*♪].*[\])*♪]\s*)+$/u`, tinha `.*` guloso e descartava segmentos com fala entre anotações
   (" [Música] vamos começar [Música]"); no app, blocos de anotação dentro de um segmento mantido também saem das palavras.
2. **Fora da fala**: menos de 50 % dos tokens não especiais com `t_dtw ≥ 0` têm `t_dtw×10 ms` dentro dos intervalos
   de fala (silencedetect −35 dB / 0,35 s, folga 120 ms) → descarta. (Os `offsets` do segmento invadem pausas e não
   servem para isso; os `t_dtw` sim.)

Resultado: os 16 casos acima são todos descartados (8 por anotação, 8 por fora-da-fala). **Nenhum segmento de fala
real foi descartado**: na amostra completa (base) a fração de tokens na fala por segmento fica entre 0,85 e 1,00; no
teste com lacuna, entre 0,95 e 1,00. Na lacuna (10 s de silêncio + 10 s de ruído entre falas) o whisper não gerou
texto: o 3º segmento tem `offsets.from` = 30 000 ms (dentro da lacuna), mas os seus tokens estão todos na fala
seguinte — mais um motivo para não usar os offsets do segmento.

## 6. Caminhos no Windows (acento e espaço)

| Caso | Resultado |
|---|---|
| `-m` absoluto com não-ASCII (`test-out\whisper-spike\ação com espaço\modelo é.bin`) | **falha**: sai com 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) logo após carregar o backend, sem saída |
| `-m` ASCII absoluto + `-f` e `-of` com acento e espaço | ok |
| `cwd` = pasta acentuada + `-m ggml-base.bin` (relativo, ASCII) + `-f`/`-of` absolutos com acento e espaço | ok |

Contorno: **iniciar o `whisper-cli.exe` com `cwd` = pasta dos modelos e passar `-m ggml-<modelo>.bin` relativo** (nomes
de modelo são sempre ASCII). Isso cobre perfis de usuário com acento (`C:\Users\João\AppData\…`). `-f` e `-of` podem
ser absolutos. Sem necessidade de nomes 8.3.

## 7. Decisões

### Linha de comando

```
cwd = <pasta dos modelos>
whisper-cli.exe -m ggml-<modelo>.bin -f <trecho.wav> -l pt -t <threads> -bs 1 -bo 1 --dtw <modelo> -nfa -np -ojf -of <saída sem extensão>
```

`<modelo>` = `base` | `small` (o mesmo valor em `-m` e `--dtw`). Saída: `<saída>.json`. `-np` silencia o texto no
stdout. Sem `-sns`, `-nf`, `-nth` (seção 5).

Progresso (verificado na G2 T4): `-pp` (`--print-progress`) funciona junto com `-np`; o whisper-cli escreve no stderr
`whisper_print_progress_callback: progress =  34%` (uma linha por janela de 30 s, até 100 %), sem mudar o JSON. O app
passa `-pp` e usa esse percentual para o progresso dentro do trecho.

### Threads e prioridade

`threads = clamp(floor(núcleos lógicos / 2), 1, 8)` — dá 8 neste PC (16 lógicos), melhor ponto medido; 12 não ganha.
Rodar o processo com prioridade **abaixo do normal** (`os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)`)
para não travar a UI/preview durante a transcrição (recomendação; não medido neste spike).

### JSON consumido (`-ojf`)

```jsonc
{
  "result": { "language": "pt" },
  "transcription": [
    {
      "offsets": { "from": 0, "to": 7680 },          // ms, relativo ao início do WAV
      "text": " Bom dia a todos, e sejam bem-vindos …",
      "tokens": [
        { "text": "[_BEG_]", "offsets": { "from": 0, "to": 0 }, "p": 0.98, "t_dtw": -1 },     // especial: ignorar
        { "text": " Bom", "offsets": { "from": 110, "to": 350 }, "p": 0.83, "t_dtw": 30 },    // t_dtw em centésimos de s
        { "text": " dia", "offsets": { "from": 350, "to": 700 }, "p": 0.99, "t_dtw": 72 },
        { "text": "jam", "offsets": { "from": 2000, "to": 2150 }, "p": 0.99, "t_dtw": 226 }  // sem espaço: continua a palavra
      ]
    }
  ]
}
```

Campos usados: `transcription[].offsets.from/to` (ms), `transcription[].text` (filtro de anotação),
`transcription[].tokens[].text` (espaço inicial abre palavra; `[_…]` como `[_BEG_]`/`[_TT_n]` são ignorados),
`tokens[].offsets.from` (início da 1ª palavra do segmento), `tokens[].t_dtw` (início das demais palavras e filtro de
fala) e `tokens[].p` (só diagnóstico). Fim da palavra = início da próxima palavra do segmento ou `offsets.to` do
segmento. Converter para µs inteiros com `Math.round` e somar o início do trecho na fonte.

Fixtures para os testes unitários: `src/main/transcribe/__fixtures__/whisper-ptbr.json` (saída bruta da linha acima,
modelo base, 8 threads, amostra de 74,56 s; só `params.model` trocado pelo nome relativo, como o app passará) e
`whisper-ptbr.truth.json` (verdade-base do `synthSpeech`).

## 8. Riscos

- **VC++ Redistributable**: `whisper-cli.exe` depende do runtime MSVC (como o ffmpeg "shared"); em PC sem ele o processo
  não inicia → tratar o erro com mensagem clara.
- **Variantes `ggml-cpu-*`**: a escolha é automática; CPUs antigas sem AVX caem em `sse42`/`x64` (bem mais lentas). Não
  testado fora deste PC.
- **Fala real ≠ voz sintética**: a precisão e os carimbos foram medidos com TTS limpo; ruído, música e sotaques vão
  piorar (o small é a saída para quem precisa de mais precisão).
- **Pausa longa no meio de um segmento**: o whisper pode colar a palavra seguinte à pausa no início dela; o ajuste à
  fala resolve na maioria (máx. 685 ms no base no teste com lacuna).
- **Janelas de 30 s**: alucinações em laço só apareceram com `-nf`; não usar essa flag.
- **Upstream**: os binários Windows do v1.9.4 ficam no release `b5130`; se sumirem, o espelho próprio cobre.
