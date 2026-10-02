# Spike F6 — captura de cliques e amostragem do cursor no gravador (02/10/2026)

Spec: `docs/superpowers/specs/2026-10-01-editor-design.md` §10 (auto-zoom no cursor/cliques) e §18–§21.
Objetivo: escolher como o gravador registra **posição do cursor + cliques** (e, no modo janela, os **limites da
janela** ao longo do tempo) para gravar `<sessão>/cursor.json`, sem nenhum input de SO (ruling R1: nada de
`SendInput`/`SetCursorPos`/`mouse_event`; o PC é de uso diário).

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Intel Core i5-13400, Windows 11 Pro 26200, 2 monitores 1920×1080 @100 % (um em x = −1920) |
| Electron / Node | 43.4.0 / 24.18.1 (processo main) |
| Candidatos | `uiohook-napi` 1.5.5, `koffi` 3.3.2 (+ `@koromix/koffi-win32-x64` 3.3.2) |

Como foi medido: scripts no Electron real (`electron spike.cjs`, um `BrowserWindow` próprio, `process.cpuUsage` em
janelas de 10 s, `process.hrtime` para custos por chamada com 100 000 repetições), cada execução serializada pelo
lock das worktrees. Os números de gravação vêm do `npm run test:capture` (seção 5). Nenhum evento de mouse foi
gerado: hooks foram só ligados e desligados ("liveness").

## 1. `uiohook-napi` (hook global de baixo nível, N-API pré-compilado)

| Medida | Resultado |
|---|---|
| Instalação sem compilador | **sim** — `prebuilds/win32-x64/uiohook-napi.node` (N-API); `npm install` em 3,8 s |
| Carrega no main do Electron 43.4.0 | **sim** — `require` em 31 ms |
| `start()` / `stop()` / reinício | 0,7 ms / 0,9 ms / 1,1 ms (start+stop) |
| CPU ociosa com o hook ligado (10 s) | 0 ms de CPU (0,000 % de um núcleo; base do processo 0,31 %) |
| Licença do pacote | MIT (`node_modules/uiohook-napi/LICENSE`) |
| Licença da libuiohook embutida | **LGPL-3.0-or-later** (cabeçalho de todos os `.c` em `node_modules/uiohook-napi/libuiohook/src`, ex.: `windows/input_hook.c`: "GNU Lesser General Public License … version 3 … or any later version"). Ela é **ligada estaticamente** dentro do `.node` |
| Empacotamento | `.node` precisa ir para `app.asar.unpacked` (como qualquer addon) |

Implicações e riscos:
- **LGPL estática**: distribuir o `.node` obriga a levar o texto da LGPL-3 + GPL-3, oferecer o código-fonte da
  libuiohook e permitir que o usuário **religue/substitua** a biblioteca (com ligação estática, isso significa
  entregar objetos/fonte do `.node` inteiro para recompilação). Viável (é tudo open source), mas é uma obrigação
  nova de conformidade para um app MIT público.
- Instala **também o hook de teclado** (`WH_KEYBOARD_LL`): todas as teclas do usuário passam pelo processo do app
  (privacidade; heurística de "keylogger" de antivírus).
- Entrega **todo** evento (inclusive cada movimento de mouse, até 1000/s em mouse gamer) ao JS por
  `napi_threadsafe_function`; `dispatch_proc` usa `NAPI_FATAL_IF_FAILED` (`src/lib/addon.c`) — uma falha nessa
  chamada **aborta o processo** (falha não isolável).
- Não resolve os limites da janela gravada → o modo janela precisaria de uma segunda dependência nativa.

## 2. `koffi` (FFI N-API pré-compilado) + user32/dwmapi

| Medida | Resultado |
|---|---|
| Instalação sem compilador | **sim** — binário em `@koromix/koffi-win32-x64/win32_x64/koffi.node`; o script de instalação (`cnoke --prebuild`) só confere o binário pronto (compila apenas se ele falhar ao carregar) |
| Carrega no main do Electron 43.4.0 | **sim** — `require` em 46,6 ms; `load('user32.dll')` + declarações em 0,3 ms |
| `GetAsyncKeyState` | **0,033 µs/chamada** |
| `GetCursorPos` | 0,85 µs/chamada |
| `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` | 1,40 µs/chamada |
| `screen.getCursorScreenPoint()` (Electron, referência) | 0,91 µs/chamada |
| `screen.dipToScreenPoint()` (Electron, referência) | 0,53 µs/chamada |
| Licença | MIT (`node_modules/koffi/LICENSE.txt`; o binário inclui cabeçalhos do node-addon-api, MIT) |
| Empacotamento | `asarUnpack` do `koffi.node` — conferido no pacote (seção 6) |

Limites da janela: `DwmGetWindowAttribute(hwnd, 9)` devolveu `{817,416,1103,609}` para uma janela cujo
`getBounds()` era `{810,416,300×200}` — exatamente a moldura visível, sem a borda invisível de redimensionamento de
7 px (é o que a captura de janela mostra). `GetWindowRect` devolve o retângulo com a borda. O HWND sai do id do
`desktopCapturer` (`window:<hwnd>:0`). Como o main do Electron é "per-monitor DPI aware", os valores são px físicos.

**Risco de clique perdido com consulta a cada tick.** O bit alto de `GetAsyncKeyState` diz "pressionado agora";
um clique (descida → subida) com duração d ≥ T (período do tick) é sempre visto por pelo menos uma consulta; com
d < T a chance de ser visto é d/T. Medido: o tick real é **T ≈ 15,6 ms** (seção 4). Cliques de mouse físico duram
tipicamente 60–150 ms (bem acima de T) — perda só em cliques "relâmpago" < 16 ms, raros. O bit baixo ("pressionado
desde a última consulta") cobre parte desses casos, mas a documentação o declara **não confiável** (outro processo
que consulte o mesmo botão o consome); usamos como melhor esforço, nunca como garantia. Toque de touchpad
("tap to click") pode gerar descida/subida muito próximas → é o caso de maior risco de perda. Botões trocados
(canhoto): `GetAsyncKeyState` lê o botão **físico**; convertemos para o lógico com `GetSystemMetrics(SM_SWAPBUTTON)`.
Para o auto-zoom (sugestão editável) um clique perdido raro é uma falha branda.

## 3. Processo auxiliar PowerShell/C# com `WH_MOUSE_LL` (papel + tempo de partida)

- Partida medida: `powershell -NoProfile -Command "Add-Type <classe C# com DllImport SetWindowsHookEx>; 'ready'"` →
  **697 ms** até "ready" (721 ms até sair) — só a compilação do `Add-Type`, sem instalar o hook.
- Riscos: `Add-Type` + `SetWindowsHookEx` em PowerShell é o padrão clássico de malware (AMSI/Defender podem
  bloquear ou alertar); política de execução / ConstrainedLanguage (GPO corporativa) proíbe `Add-Type`; um processo
  a mais para gerenciar (partida de ~0,7 s, morte, órfão se o app cair); comunicação por stdout.
- Vantagem: o hook roda em outro processo (sem LGPL, sem atraso de input causado pelo main).
- Não resolve os limites da janela por si.

## 4. Overlay transparente (papel)

Uma janela transparente por cima só recebe cliques **dentro dela**; com `setIgnoreMouseEvents(true, { forward })`
recebe apenas movimento, nunca cliques destinados a outros apps. Para capturar cliques em qualquer lugar ela teria
de interceptá-los (quebrando o uso do PC). Descartada.

## Cadência do timer no main e custo de CPU (decide 60 × 30 Hz — ruling R3)

No Windows o quantum padrão do timer é 15,6 ms; `setInterval` no main do Electron arredonda para cima:

| `setInterval(ms)` | Cadência real | CPU total do main (10 s, 2 repetições) |
|---|---|---|
| ocioso (base) | — | 0,16 % / 0,00 % |
| 1 | 77 / 74 Hz | 2,65 % / 1,10 % |
| **15** | **58 / 62,5 Hz** (p50 15,6 ms) | **0,63 % / 0,47 %** |
| 16 | 36,6 / 37,8 Hz (p50 30,6 ms) | 0,78 % / 0,46 % |
| 31 | 26 / 26,8 Hz | 0,16 % / 0,31 % |

Cada tick fez `getCursorScreenPoint` + `dipToScreenPoint` + 3 × `GetAsyncKeyState` + `DwmGetWindowAttribute`
(≈ 3 µs de trabalho). Ou seja: pedir "16 ms" dá **~32 Hz**, não 60; **15 ms dá ~60–64 Hz**. Custo a ~60 Hz ≈ 0,4 %
de um núcleo acima da base → **fica em 60 Hz** (< 1 %). Confirmado no teste de captura com a trilha real
(cursor do SO + botões nativos) ligada sem gravação, alternando 10 s ocioso / 10 s com trilha: custo **+0,23 %**
(ocioso 0,47/0,63 %, com trilha 0,78/0,78 %); em outras execuções a diferença ficou negativa (−0,17 %, −2,35 %), isto
é, abaixo do ruído do processo.

## Escolha: **koffi** (consulta de botões no tick + limites da janela pelo DWM)

| Critério | uiohook-napi | **koffi (GetAsyncKeyState + DWM)** | PowerShell/C# | Overlay |
|---|---|---|---|---|
| Confiabilidade dos cliques | alta (hook) | boa: todo clique ≥ 15,6 ms; < 15,6 ms melhor esforço | alta (hook) | não captura |
| Limites da janela (modo janela) | não (2ª dependência) | **sim, mesma dependência** | não | — |
| Empacotamento | `.node` unpacked | `.node` unpacked (conferido) | script + processo | — |
| Licença | MIT + **LGPL-3 estática** | **MIT** | — | — |
| CPU | ~0 ocioso; JS a cada movimento | ~0,2–0,4 % a 60 Hz, constante | processo extra | — |
| Modos de falha | aborta o processo se o tsfn falhar; hook de teclado | falha ao carregar → só amostras (isolado) | AV/GPO bloqueiam; 0,7 s de partida | — |
| Privacidade/AV | hook de teclado global | sem hook nenhum | hook em PowerShell (suspeito) | — |

Racional: uma única dependência MIT resolve cliques e limites da janela, sem hook global (nada de teclado, nada que
possa atrasar o mouse do sistema), custo constante e pequeno, falha isolável (carregamento tardio com try/catch).
O preço é o risco de perder cliques mais curtos que ~16 ms (touchpad), aceitável para sugestões editáveis de zoom.
Caminho de melhoria, se for preciso: Raw Input (`RegisterRawInputDevices` com `RIDEV_INPUTSINK` + WM_INPUT pela
`hookWindowMessage`) via o mesmo koffi — sem perda de clique, mas com uma mensagem por movimento de mouse no JS.

## 5. Implementação e medidas na gravação real (`npm run test:capture`)

- `src/shared/cursor.ts` (formato `cursor.json` v1, `parseCursorTrack`, `normalizeToFrame`, DIP → físico por
  monitor), `src/main/cursor/cursorRecorder.ts` (amostragem, dedupe, relógio de mídia, escrita atômica),
  `buttonEdges.ts` (bordas de clique), `winInput.ts` (koffi), `cursorCapture.ts` (IPC/Electron).
- Relógio: o main roda um `MediaClock` próprio que começa/pausa/retoma quando o engine do renderer chama
  `recorder.begin/pause/resume` (IPC sem espera). Medido: clique injetado carimbado no main em **3998 ms** contra
  **4003 ms** no relógio do renderer (≈ 5 ms, latência de IPC); 64,6 amostras/s de mídia; mapeamento
  parede → mídia com a pausa removida com erro máx. 0,5 ms; nenhuma amostra no trecho pausado.
- **Relógio × PTS do vídeo.** O zero do relógio de mídia fica a **1,8–4,1 ms** do PTS 0 do vídeo (1º dado de mídia do
  Output do mediabunny, modo `synced-zero`) — dentro de 1 quadro a 30 fps. Mas o conteúdo chega ao vídeo atrasado:
  um "flash" verde/preto na janela do teste, carimbado no relógio de mídia, aparece no vídeo **96–163 ms** depois
  (10 medições em 5 execuções), dos quais **37–47 ms** são a pintura da página até a apresentação (Element Timing
  `renderTime`) e **55–120 ms** são captura + entrega do quadro + quantização a 1/30 s. O cursor é desenhado no
  quadro pela própria captura, então a amostra do cursor deve **adiantar ~55–120 ms (≈ 2–4 quadros a 30 fps)** em
  relação ao vídeo. É a mesma defasagem que já afeta os eventos v1 carimbados no `MediaClock` (traços, PiP). Não foi
  compensada aqui (a trilha segue a semântica do `MediaClock`, como pede a tarefa); fica registrada para o consumidor
  (auto-zoom/realce) decidir um deslocamento.

## 6. Pacote

`electron-vite build && electron-builder --win --dir --publish never`: `koffi.node` (1 044 992 bytes) em
`release/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/` e marcado
`"unpacked": true` no cabeçalho do `app.asar`. Com `ELECTRON_RUN_AS_NODE=1 "CiaLight Gravador.exe"`, `require` do
`koffi` de dentro do `app.asar` carrega (koffi 3.3.2, `GetAsyncKeyState`/`GetSystemMetrics` chamados com sucesso).

## Não verificado nesta máquina

- DPI misto real (os dois monitores são 100 %): a conversão DIP → físico é coberta por testes unitários com 1,0/1,5
  e origem negativa, e o teste real compara o helper com `screen.dipToScreenPoint` (erro 0 px aqui).
- Cliques sobre janelas elevadas (administrador) e toque de touchpad: sem input de SO no teste (R1), não medidos.
