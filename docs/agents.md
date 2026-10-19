# Integração com agentes

## Uso

1. Abra o CiaLight Gravador v1.11.0 ou posterior.
2. No editor, clique em **IA**; fora do editor, entre em **Configurações → Avançado**.
3. Ative **Conectar Codex e Claude Code**.
4. Para o Codex, copie e execute o comando oferecido pelo aplicativo no PowerShell. Para Claude Code ou outro cliente, copie o objeto `mcpServers` para a configuração MCP do cliente. Atualize/reinicie a conexão do cliente para carregar as ferramentas.
5. Peça ao agente que consulte o CiaLight, abra o projeto e faça a edição. Acompanhe o resultado na timeline.

A configuração aponta para o executável do próprio aplicativo, usando seu runtime Node para executar o conector empacotado. Não é necessário instalar Node no computador do usuário. Em desenvolvimento, `npm run dev`/`npm run build` geram `resources/agents/mcp.cjs`; o instalador o copia para `resources/agents/` junto das licenças de dependências.

O agente pode usar suas próprias ferramentas de análise e criação de material em conjunto com o editor. O CiaLight não inclui um chatbot proprietário ou uma API de geração de imagens/voz/vídeo paga. Os comandos de preparação, fala e legendas rodam localmente; textos e quadros solicitados por um agente são entregues ao cliente MCP e podem ser processados pelo provedor escolhido por ele.

## Fluxo de trabalho recomendado

1. `cialight_status`: descobrir projeto ativo, revisão, ingestão e jobs.
2. `cialight_projects`: listar, criar ou abrir projeto.
3. `cialight_inspect`: obter IDs, timeline, mídias, legendas, revisão e presets.
4. `cialight_import`: importar caminhos absolutos locais; aguardar as mídias ficarem prontas.
5. `cialight_edit`: inserir mídias e aplicar operações validadas. `dryRun: true` valida sem gravar. Cada lote é atômico e vira um passo de desfazer.
6. `cialight_analyze`: iniciar análise de fala/transcrição/silêncios ou preparação completa; acompanhar em `cialight_jobs`.
7. `cialight_preview`: obter um PNG do compositor real no instante escolhido. A imagem retornada é reduzida a no máximo 1280 px no maior lado para inspeção; o projeto mantém a resolução original.
8. `cialight_export`: enfileirar um instantâneo do projeto. Acompanhar em `cialight_jobs` até `done`, conferir avisos e informar o caminho efetivamente retornado.

As ferramentas recebem segundos; campos do projeto terminados em `Us` usam microssegundos inteiros. IDs retornados pela edição podem ser usados nas chamadas seguintes. Todas as mutações exigem `projectId` e a revisão atual. Após um conflito, o agente deve reler o projeto e reconsiderar a operação; não deve repetir cegamente o mesmo lote.

## Operações de edição

`add_media`, `add_track`, `split`, `trim`, `move`, `delete`, `delete_ranges`, `speed`, `audio`, `transform`, `text`, `caption`, `effect`, `transition`, `track`, `marker`, `reframe`, `rename`, `duplicate`, `enabled`, `reverse`, `freeze`, `text_update`, `animation`, `keyframe`, `zoom`, `mix`.

`add_media` recebe o instante de entrada na timeline (`at`), o ponto de entrada na fonte (`sourceStart`) e a duração opcional. Vídeo e áudio são inseridos vinculados. `trackId` escolhe a faixa principal do asset: vídeo para assets visuais, áudio para assets de áudio. O editor escolhe a outra faixa quando um vídeo também possui áudio.

Keyframes usam tempo absoluto da timeline, são inseridos/atualizados sem alternar sua existência e respeitam os limites da propriedade. `reframe` preserva os mecanismos existentes de proteção de efeitos; a ferramenta devolve avisos de regiões que exigem revisão.

## Análises e preparação

- `transcribe`: retorna palavras em tempo da fonte e da timeline; com `apply: true`, gera/substitui legendas.
- `silences`: retorna o plano de cortes; com `apply: true`, corta todas as faixas sincronizadas.
- `prepare`: planeja os cortes, solicita normalização nas faixas de voz de referência e transcreve/gera legendas. Com `apply: true`, aplica o conjunto em um único commit após concluir o trabalho assíncrono.

Sem `apply`, nenhum projeto é alterado. O modelo Whisper Base é o padrão; `small` pode ser escolhido para maior precisão. Download de modelo só acontece com `downloadModel: true`. A análise depende do cache de fala produzido na importação. Falha, cancelamento ou conflito antes do commit deixam a timeline intacta. Uma falha de salvamento após o commit é informada; a edição aplicada permanece disponível no histórico.

O tratamento de áudio pode continuar após o commit da preparação. `status` informa `audioJobs`; a exportação recusa iniciar enquanto os tratamentos necessários estiverem pendentes ou com erro. O agente deve aguardar, reler a revisão e tentar exportar quando estiver pronto.

## Conexão e consistência

O servidor usa um named pipe do Windows e um segredo de sessão aleatório, descobertos por arquivo dentro do perfil do aplicativo. Não abre uma porta TCP. A conexão fica desativada até ser habilitada na interface; a preferência persiste. Desativar fecha o pipe e revoga novos comandos. Trabalhos já iniciados podem ser cancelados em `cialight_jobs`.

O processo principal autentica e valida pedidos, limita tamanho/conexões e serializa as chamadas. Respostas IPC só são aceitas da janela principal. Não há execução de código ou comandos de shell nas ferramentas. Durante gravações, a automação do editor é recusada. O projeto aberto continua tendo um único escritor: o store da interface, com autosave e histórico existentes.

Jobs de análise rodam em segundo plano com progresso e cancelamento. Sua aplicação compara a revisão capturada; edições manuais, troca do projeto ou novas análises de mídia podem invalidar o resultado. Isso evita aplicar decisões tomadas sobre uma timeline antiga. Jobs de exportação carregam um instantâneo, portanto edições posteriores não mudam o vídeo já enfileirado.

O agente precisa do aplicativo aberto. Esta versão não oferece renderização headless, colaboração simultânea entre vários escritores ou conexão remota por rede. A decisão editorial depende do agente e da análise do material: a preparação local é determinística e não promete escolher sozinha os melhores momentos de qualquer vídeo.

## Desenvolvimento e verificação

- `npm run build:agents`: empacota o servidor MCP e gera avisos de licença.
- `npm run typecheck`: verifica main, renderer e conector.
- `npm test`: inclui contrato, edição atômica, limites de origem, keyframes e autenticação/serialização do pipe.
- `npm run test:agents`: integração real com cliente do SDK MCP, mídia/fala sintéticas, perfil isolado, importação, conflito de revisão, dry run, desfazer/refazer, PNG, pausas, Whisper, normalização e MP4 conferido por ffprobe.

O teste ponta a ponta usa o modelo já presente em `test-out/whisper-models/ggml-base.bin` (preparado pelo teste de transcrição do projeto). Não usa o microfone nem mídias pessoais. Evidências ficam em `test-out/agents/<execução>/`.

Para verificar o runtime do instalador, rode o teste com `CIALIGHT_MCP_EXECUTABLE` apontando para o executável empacotado. O editor de teste continua isolado; o conector é iniciado pelo Electron empacotado com `ELECTRON_RUN_AS_NODE=1`.
