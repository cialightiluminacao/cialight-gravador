# Auditoria do produto — 17/10/2026

**Atualização:** este é o relatório histórico de 1.11.1. A continuação em 1.11.2 corrigiu as metas de renderização e concluiu 39/39 suítes; consulte [a rodada final](2026-10-17-product-audit-followup.md) para os resultados, novas correções e instalador.

Status: auditoria local executada sobre a versão 1.11.1. **38 de 39 suítes aprovadas; duas metas de desempenho permanecem reprovadas na suíte de renderização.** Não há certificação de cobertura completa ou aprovação de uma release.

## Escopo e evidências

O inventário gerado por `node scripts/qa/audit-catalog.mjs` registra controles JSX, funções, métodos, callbacks e os 125 cenários do checklist. A presença no inventário não significa execução ou aprovação. Os registros estão em `test-out/product-audit/catalog/`.

`scripts/qa/audit-suite.mjs` executa 39 suítes de integração e interface em sequência, com perfil de aplicativo separado por suíte. Os resultados iniciais estão em `test-out/product-audit/run-01/results.json`; cada diretório contém saída, erros e capturas. Os testes não substituem os screenshots existentes em `docs/qa`.

`scripts/qa/audit-ui.mjs` verifica páginas e abas em 960×640, 1180×760, 1366×768 e 1920×1080. Os sinais automáticos de obstrução, falta de nome e posição precisam de revisão: conteúdo em uma área com rolagem não é necessariamente um defeito. A primeira matriz visual teve seletores que não ativavam todas as abas; não serve como aprovação das abas. O roteiro foi corrigido para clicar com eventos de mouse e exigir `aria-selected=true`.

## Defeitos reproduzidos e alterações

- Importação e reapontamento assíncronos podiam alterar outro projeto aberto durante a espera. Dois testes de regressão falharam antes da correção; agora o resultado é aplicado somente ao projeto de origem.
- Mídias com erro persistente, como a falha anterior de ffprobe, não ofereciam nova tentativa. O cartão agora permite reprocessar a mesma mídia mantendo ID e referências da timeline. Um teste verifica que a operação não duplica o asset.
- Na janela de 960×640, o botão Exportar ultrapassava a borda direita e controles de reprodução invadiam o inspetor. A barra superior ganhou adaptação de rótulos e a reprodução permite quebra de linha. Confirmado no aplicativo reconstruído, em `visual-02/editor-960x640.png`.
- O nome acessível de sliders era aplicado ao contêiner, mas não ao elemento com papel `slider`. O componente compartilhado agora encaminha o nome ao thumb. Os controles de volume e das configurações de anotações aparecem nomeados no inventário DOM de `visual-02/observations.json`.
- Uma rejeição de `enumerateDevices()` gerava `unhandledrejection`, reproduzida no aplicativo isolado simulando indisponibilidade e disparando `devicechange`. Os caminhos automático e manual agora tratam a falha e informam o usuário. A repetição no aplicativo reconstruído confirmou mensagem visível e nenhuma rejeição sem tratamento (`visual-03/device-failure.json`).
- O build embutia um subconjunto da Manrope como `data:font`, bloqueado pela CSP do aplicativo. A configuração agora mantém arquivos de fonte locais mesmo quando pequenos. O build final foi exercitado e `visual-04/errors.json` ficou vazio.
- A captura ficou abaixo de 50 amostras/s do cursor em duas rodadas (49,2 e 48,2). Reduzir o intervalo solicitado de 15 para 12 ms elevou a cadência a 63,8 amostras/s, com erro máximo de timestamps de 0,53 ms. A medição com a fonte nativa deu 64,2 Hz, custo mediano de 0,67% e custo total de 0,93% de um núcleo. O fluxo completo passou com os critérios originais (`run-04/editor-e2e/capture-report.json`). Os 49 testes unitários de trilha e arquivo do cursor também passaram após o ajuste.

A recuperação pelo botão real foi exercitada no aplicativo reconstruído: o vídeo retornou a `ready`, com o mesmo ID e três assets antes/depois (`visual-03/retry-media.json`). A matriz válida percorreu 76 estados em quatro resoluções (`visual-02`); rodadas adicionais cobriram recuperação e rolagem até o final da exportação em 960×640 (`visual-03` e `visual-04`, 20 estados cada). O inventário ampliado inclui 589 controles JSX (também links e itens de menu) em 91 arquivos; essa contagem não representa 589 controles individualmente aprovados.

Checagem de tipos: passou em main, renderer e conector de agentes após essas alterações. A execução completa foi repetida depois do ajuste final do cursor e aprovou **2989 testes em 200 arquivos**, sem falhas ou testes ignorados (`test-out/product-audit/unit-final.json`). Inclui os três testes de regressão de importação.

## Resultados ainda em investigação

A primeira execução de renderização falhou em deriva entre áudio e vídeo, custo de blur, transições e velocidade de time-stretch. Havia outras tarefas de auditoria simultâneas. A repetição abaixo retirou essas cargas e manteve os critérios de aprovação.

A repetição sem outras tarefas da auditoria (`run-03`, build 1.11.1) aprovou sincronismo, time-stretch, arraste, remoção de silêncios e persistência da fila. Permanecem duas metas reprovadas na suíte de renderização: três blurs fortes em 1080p com mediana 16,8 ms (meta <12 ms); transições crossfade com média 24,81 ms e blur com média 29,94 ms (meta <20 ms). O ensaio sem efeitos mediu mediana 14,9 ms. O renderizador informado é ANGLE/D3D11 sobre Intel UHD Graphics 730. A causa final do custo não foi isolada; não atribuir ao hardware, driver ou aplicativo por suposição. Os critérios não foram afrouxados.

A diferença visual de silêncios não se repetiu depois que o roteiro passou a aguardar a confirmação do quadro correto, em vez de uma espera fixa de 900 ms. A verificação de pixels permaneceu com o mesmo limite. O teste da fila voltou a passar com o perfil inicializado com o esquema completo de configurações, em vez de `{}`; a guarda de integridade foi mantida.

A execução instrumentada de cobertura terminou com 2957 testes aprovados, sete falhas por tempo/desempenho e 25 ignorados (200 arquivos). Não gerou relatório de cobertura aproveitável; nenhuma porcentagem é reivindicada. A configuração foi corrigida para restringir a coleta a TS/TSX e gerar relatório mesmo em caso de falha. Seus resultados não equivalem à execução normal e precisam de repetição sem instrumentação.

As seis integrações de ffmpeg, ingestão, exportação, formatos, modelos e transcrição passaram na primeira rodada. A renderização teve as falhas descritas acima. As 32 suítes de interface dessa rodada não chegaram ao aplicativo por um erro do roteiro de Windows (`--import` com caminho absoluto em vez de URL de arquivo); esse resultado foi registrado e o roteiro corrigido. A rodada `run-02` executou as 32 suítes e aprovou 28. As repetições `run-03` e `run-04` elevaram o consolidado a 38/39; permanece reprovada apenas a suíte com as duas metas de GPU.

A inspeção posterior encontrou a tela Preparar ainda carregando na matriz inicial. O roteiro agora exige fontes carregadas. `visual-05` repetiu os 20 estados em 960×640, incluindo Preparar pronto, recuperação de mídia e final do formulário de exportação; as miniaturas de desktop foram borradas nas capturas. A execução terminou sem erros de console. Isso não equivale a testar todas as combinações de dispositivos e permissões.

## Pacote local

O instalador `release/CiaLightGravador-Setup-1.11.1.exe` foi gerado com publicação desativada (164991628 bytes). O hash SHA-256 está em `test-out/product-audit/installer.json`.

`node scripts/qa/audit-packaged.mjs` aprovou sete verificações na distribuição: versão 1.11.1 no ASAR, execução real de ffprobe e ffmpeg incluídos, presença do Whisper e dos avisos de terceiros, inicialização MCP usando o Node embutido no próprio executável distribuído, lista das dez ferramentas e tratamento da conexão ausente. Esses resultados estão em `test-out/product-audit/packaged-smoke.json`. Não foi necessário iniciar a GUI empacotada ou acessar o perfil pessoal para essas verificações.

## Condições que não podem ser certificadas por inspeção de código

O checklist inclui outra máquina, gravação de 30 minutos, desconexão física de dispositivos, atalhos com outros aplicativos em foco, instalação e atualização de uma release publicada. Esses itens precisam de suas respectivas execuções e evidências. Não marcar como aprovados por inferência ou por outros testes semelhantes.

Não houve publicação, instalação sobre a versão em uso ou alteração dos projetos pessoais como parte desta auditoria.

## Consultar e reproduzir

O consolidado está em `test-out/product-audit/summary.md` e `summary.json`, com última execução por suíte e histórico das falhas anteriores. São 1645 verificações aprovadas registradas nos logs das últimas execuções; essa quantidade não mede cobertura por botão ou função. O teste de privacidade aplicou OCR em todos os quadros do vídeo exportado e não encontrou os valores fictícios usados como oráculo. A integração com agentes foi exercitada por cliente MCP real.

Ambiente da auditoria: Windows, Node.js 24, Electron 43.4.0. Para repetir, reconstruir antes de iniciar as suítes:

```powershell
npm run build
npx vitest run --maxWorkers=2
npm run audit:catalog
npm run audit:suite
npm run audit:ui
```

Executar as medições de desempenho sem outras cargas da auditoria. Os roteiros produzem perfis e arquivos isolados em `test-out/`; os cenários manuais continuam exigindo suas execuções próprias.
