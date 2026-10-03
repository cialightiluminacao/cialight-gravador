# Checklist de QA manual — CiaLight Gravador

Marcar a cada release. Máquinas: PC de desenvolvimento (Win11, 2 monitores) e pelo menos 1 outra máquina da Cia Light.

## Instalação / atualização
- [ ] Instalador `.exe` abre (SmartScreen: "Mais informações → Executar assim mesmo"), instala sem UAC, cria atalhos, abre ao final.
- [ ] Ícone do app na barra de tarefas e na bandeja; menu da bandeja funciona (mostrar, iniciar/parar, pausar, configurações, atualização, sair).
- [ ] Segunda instância não abre outra janela (traz a existente para frente).
- [ ] Com uma versão mais nova publicada: banner "Nova versão" aparece (≤ 60 min ou ao abrir), Baixar → progresso → Reiniciar e atualizar → app reabre na versão nova; notas da versão visíveis em Configurações → Atualização.

## Preparar
- [ ] Lista de monitores (nome + miniatura + "principal") e janelas (ícone + título + miniatura), busca por título; refresh automático.
- [ ] Preview da fonte selecionada atualiza; PiP arrasta/redimensiona/alterna forma/espelho; posição salva entre sessões.
- [ ] Câmera/mic/sistema: seleção e toggles persistem; VU do microfone reage à voz; modo Headset/Caixas de som.
- [ ] Qualidade/fps/contagem persistem. Sem câmera/mic conectados: mensagens claras, sem travar.
- [ ] Permissão negada de câmera/mic: diálogo com botão para as configurações de privacidade do Windows.

## Gravando
- [ ] Contagem 3-2-1 grande no monitor gravado (som opcional); borda vermelha; barra flutuante no monitor gravado.
- [ ] Nada do gravador (janela, barra, borda, contagem, anotações) aparece no vídeo bruto (proteção ligada).
- [ ] Pausar/retomar (barra, atalho, tela): cronômetro para; arquivo final sem buraco; borda fica âmbar.
- [ ] Mute mic / câmera off: refletidos no vídeo (silêncio / PiP some).
- [ ] Mover/redimensionar/alternar forma da PiP durante a gravação: refletido no vídeo exportado no instante certo.
- [ ] Anotações (Ctrl+Shift+F5): caneta, Shift reta, Ctrl+Shift seta, cores R/G/B/Y/W, [ ], Ctrl+Z, E, Esc; aparecem no export no instante certo; auto-sumir quando configurado.
- [ ] Modo janela: grava só a janela (mesmo coberta); anotações desabilitadas com aviso; janela minimizada gera aviso/tela preta (limitação do Windows).
- [ ] Atalhos globais funcionam com outro app em foco (ex.: navegador maximizado).
- [ ] Fechar a janela do gravador durante a gravação → esconde (bandeja) e a gravação continua; reabrir pela bandeja.
- [ ] Gravação de 30+ min: sem crescimento de memória visível, arquivo íntegro.
- [ ] Desconectar a webcam durante a gravação: aviso e continua sem travar.

## Revisão / Exportação
- [ ] Player reproduz com áudio mixado; PiP e traços iguais aos do vídeo exportado; corte início/fim; miniaturas e waveform.
- [ ] Cada preset gera arquivo válido (abre no Windows Media Player/VLC/Chrome), tamanho ≤ alvo no preset pequeno, faststart.
- [ ] "Edição posterior" gera tela.mp4, webcam.mp4, mic.wav, sistema.wav e combinado.mkv.
- [ ] Reexportar com outro preset; nova gravação; excluir bruto (vai para a Lixeira).
- [ ] Histórico lista sessões, abre na Revisão, exclui.
- [ ] Recuperação: matar o processo durante a gravação → ao reabrir, diálogo "gravação interrompida" → recuperar → exportável.

## Configurações
- [ ] Atalhos: gravar combinação, avisos (ABNT2/reservados), conflito duplicado, "não registrado" quando outro app usa, restaurar padrões.
- [ ] Anotações: cor/espessura/auto-sumir refletidos na overlay.
- [ ] Avançado: proteção das janelas ligada/desligada; teste de encoders; pastas; logs.

## Editor
- [ ] Histórico → Editar abre o editor com a gravação (tela, webcam na posição/forma gravada, microfone e sistema em faixas separadas); Editar de novo reabre o mesmo projeto; "Novo projeto desta gravação" cria outro.
- [ ] Projetos: novo projeto, renomear, abrir recentes, excluir (originais e gravações intocados); excluir uma gravação usada por projeto é recusado com aviso (Histórico, Revisão e diálogo de gravação interrompida).
- [ ] Importar (botão e arrastar do Explorer) vídeo mp4/mov/mkv, áudio mp3/wav/m4a/flac e imagem png/jpg: miniatura, filmstrip e forma de onda aparecem; HEVC/GOP longo/4K ganham proxy com progresso; FLAC/AC-3 tocam (intermediário AAC).
- [ ] Mover o arquivo original → "mídia indisponível" no item e "Localizar…" reconecta.
- [ ] Reprodução: Espaço, J/K/L, ←/→ (Shift = 1 s), Home/End; áudio sincronizado com o vídeo em 1 min; minimizar a janela tocando não mostra "O visualizador travou".
- [ ] Linha do tempo: dividir (S/Ctrl+B), mover com ímã (linha guia), Alt ignora o vínculo, trim e ripple (Ctrl), Q/W, Delete/Shift+Delete, I/O + Ctrl+Shift+X apaga o trecho em todas as faixas, faixa nova ao soltar acima, bloquear/ocultar/mudo, zoom (Ctrl+roda, +/−, Shift+Z), seleção por caixa, marcadores (M).
- [ ] Fades nos cantos do item (vídeo e áudio) com dica de duração; volume em dB no inspetor; fade audível/visível no preview e no arquivo exportado.
- [ ] Visualizador: mover/escalar/girar a webcam e imagens (guias de centro, Shift), corte, forma redonda/arredondada, borda, espelhar; o resultado no preview = exportado.
- [ ] Desfazer/refazer (Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y) de qualquer ação, incluindo arrastes (1 passo por gesto); salvamento automático ("Salvo") e reabrir o projeto depois de fechar o app.
- [ ] Exportar YouTube 1080p, WhatsApp (até 64 MB), Original (máxima) e Instagram Reels/Stories (9:16) (projeto 9:16): progresso com %/velocidade/ETA, arquivo abre no Windows/VLC/WhatsApp Web, sem `.part` sobrando; cancelar apaga o parcial; sair durante a exportação pergunta uma vez.
- [ ] Exportação usa a GPU quando disponível (NVIDIA/Intel/AMD) e cai para software sem erro quando o encoder falha.
- [ ] Projeto com 20+ cortes e 3 faixas de vídeo continua fluido (preview e arraste na linha do tempo).
- [ ] O app instalado (v1.0.x) e o de desenvolvimento podem dividir o mesmo `settings.json` sem perder configurações.

## Editor — efeitos de privacidade (F2)
- [ ] Ferramenta Desenhar região (`B`): arrastar no quadro cria Blur/Pixelizar/Tarja (escolha na barra lateral) em retângulo ou elipse (Shift; Alt = a partir do centro); o efeito entra na faixa "Efeitos" no playhead e fica selecionado; Esc sai da ferramenta.
- [ ] Mover, redimensionar (Shift mantém a proporção, Alt a partir do centro) e girar a região, com guias do quadro; cada gesto é 1 passo de desfazer; clicar fora da região seleciona a mídia por baixo.
- [ ] Aba **Efeitos** da biblioteca: as 6 predefinições (Blur, Pixelizar, Tarja, Esconder rosto, Esconder texto, Borrar tudo menos…) arrastadas para a linha do tempo (no ponto; na faixa de vídeo livre sob o ponteiro ou na "Efeitos") e para o visualizador (no playhead, região centrada onde soltou); duplo clique/Enter/"+" adicionam no playhead (Enter no "+" adiciona uma vez só). Soltar numa faixa oculta ou abaixo de mídia visível no trecho vai para a "Efeitos".
- [ ] Inspetor do efeito: tipo (converter para Tarja zera a borda suave), cor da tarja, intensidade, borda suave, inverter, forma, posição/tamanho/rotação; ativar/desativar (`Shift+E`, menu, chave do inspetor) mostra "Desativado" no visualizador.
- [ ] Keyframes: ◇ por propriedade no inspetor, `Alt+K` no playhead, `[`/`]` entre keyframes, losangos no item da timeline (arrastar move, Delete apaga); a região acompanha um texto que se move sem "piscar" sem blur entre os keyframes.
- [ ] Esconder texto (intensidade ≥ 60) sobre um texto grande (ex.: 48 px em 1080p): no preview e no arquivo exportado nenhum caractere é legível, só uma mancha.
- [ ] Região parcialmente fora do quadro borra só a parte visível, sem borda estranha; blur + tarja sobrepostos respeitam a ordem das faixas (tarja por cima cobre tudo).
- [ ] Exportar com efeitos (YouTube 1080p e WhatsApp 720p): mesmo resultado do preview (lugar e intensidade); a tarja sai com a cor exata; nenhum quadro do trecho sai sem o efeito.
- [ ] Diálogo de exportação: efeito fraco (Blur < 50, Pixelizar < 30; invertido com mensagem própria), desativado/faixa oculta, ou com mídia visível numa faixa acima no trecho ("Há mídia acima deste efeito") aparece em **Privacidade** com "Revisar" (seleciona o efeito, leva o playhead ao instante do aviso e fecha o diálogo); o aviso nunca impede exportar.
- [ ] Efeito criado sobre um clipe mostra o ícone de vínculo; mover/aparar/dividir/apagar/duplicar o clipe e mudar a velocidade (ex.: 0,5×) levam o efeito junto (cobre o clipe inteiro); mover o efeito não move o clipe; "Desvincular" solta o efeito.
- [ ] Importar mídia com a faixa de vídeo ocupada cria a faixa nova abaixo da "Efeitos"; "Borrar tudo menos…" (80) deixa ilegível um texto grande fora da região; Pixelizar sobre conteúdo em movimento mostra blocos com a média (sem "cintilar" detalhe).

## Editor — velocidade e áudio (F3)
- [ ] Velocidade (inspetor): presets 0,1×–16× e valor personalizado mudam vídeo e áudio vinculado juntos; a 2× com **Manter tom** a voz fica rápida com o mesmo tom (preview e arquivo exportado); sem ele, mais aguda; acima de 4× o áudio fica mudo, salvo **Manter áudio acima de 4×**.
- [ ] **Congelar quadro** insere 2 s parados com o quadro do playhead (áudio mudo no trecho, resto empurrado, selo na timeline); **Reverter** toca o clipe de trás para frente (vídeo e áudio) sem engasgar; efeitos de privacidade sobre o trecho continuam cobrindo o conteúdo.
- [ ] Shuttle: L/L/L acelera 1×→2×→4× (som até 2×), J para trás, K pausa e volta a 1×, K segurado + J/L anda um quadro.
- [ ] Importar mídia com áudio: a fala é detectada (sem travar a importação); falha na análise não deixa a mídia com erro.
- [ ] Voz: **Reduzir ruído (voz)** tira o chiado de uma gravação de microfone barulhenta; **Normalizar volume** deixa vozes baixas e altas no mesmo nível (−16 LUFS); progresso no inspetor; **A/B** segurado compara com o original sem pausar; desligar/religar não reprocessa; o projeto aberto em outro PC reprocessa sozinho.
- [ ] Música: mp3/m4a importado vai para a faixa **Música** (aviso "É narração? Mover para Voz" leva só o item para uma faixa de Voz); papel da faixa no cabeçalho (Voz / Música / Efeitos sonoros); prévia no cartão da aba Áudio.
- [ ] **Música sob a voz** (inspetor do projeto): tocando, a música abaixa sozinha quando alguém fala nas faixas de Voz e volta suave no fim (sem "bombear" em pausas curtas); intensidade/ataque/soltura mudam o efeito; o arquivo exportado soa igual ao preview; medidores master e por faixa acesos tocando e zerados parados.
- [ ] **Remover silêncios**: prévia em vermelho na régua com o total economizado; duração mínima/margem/trecho I–O mudam os cortes; aviso de fala em outra faixa ("Incluir como referência"); aplicar corta todas as faixas em sincronia (webcam, anotações, efeitos vinculados e marcadores juntos) em 1 passo; o "Desfazer" do aviso não desfaz edições feitas depois; faixa de vídeo bloqueada com efeitos impede aplicar com explicação.
- [ ] **Narração**: escolher o microfone, "ouvir o vídeo enquanto grava" (com fone), contagem 3-2-1, gravar com a timeline tocando, parar com Espaço/Esc; o item entra na faixa **Narração** no ponto certo (sem atraso perceptível) e em 1 passo de desfazer; durante a gravação o editor fica bloqueado ("Gravando narração — pare para editar"); Esc na contagem não grava nada.
- [ ] Narração com problemas: desconectar o microfone no meio insere o parcial com aviso; fechar/derrubar o app no meio e reabrir o projeto recupera o trecho com aviso; o microfone volta livre (luz de uso apagada) ao parar ou cancelar.
- [ ] Ponta a ponta: gravação com pausas → remover silêncios → música → narração → clipe a 2× → exportar YouTube 1080p: o arquivo tem a duração da timeline, a música abaixa sob a fala, a voz a 2× mantém o tom e a narração está no lugar.

## Editor — keyframes e movimento (F4)
- [ ] Linhas de keyframes: a seta no item abre uma linha por propriedade animada (nome, mini-curva, losangos coloridos pela curva); clique/Shift/caixa selecionam, arrastar move o grupo (1 passo de desfazer), `Delete` apaga só os escolhidos, `Ctrl+C`/`Ctrl+V` colam no playhead com os tempos relativos (aviso quando o item não tem a propriedade); recolher volta a faixa à altura normal.
- [ ] Editor de curvas: botão direito num losango (ou no ◇ do inspetor) abre "Curva — <propriedade>" com o trecho; presets (Linear, Segurar, Suavizar entrada/saída/ambos, Overshoot) e alças arrastáveis (x preso em 0–1, y livre) mudam o movimento no preview e no arquivo exportado; Esc fecha; faixa bloqueada mostra só leitura.
- [ ] Dividir, aparar, remover silêncios e congelar um clipe com curvas não mudam a forma do movimento (o vídeo exportado antes e depois do corte é o mesmo nos trechos mantidos).
- [ ] Zoom (`Z`): arrastar o enquadramento-alvo no visualizador mostra o retângulo na proporção do quadro com o fator (ex.: "2,0×"); soltar grava o zoom no playhead (1 passo); o conteúdo do centro do retângulo chega ao centro do quadro; "Voltar ao normal depois", duração, curva e "Sem bordas pretas" respeitados; Esc sai; Shift+Z continua ajustando a timeline.
- [ ] Ken Burns (inspetor do vídeo): as 4 diagonais fazem uma aproximação lenta sem bordas pretas; num PiP a caixa fica parada e o conteúdo se aproxima dentro dela; repetir substitui o anterior (aviso com quantos keyframes).
- [ ] Zoom/Ken Burns/animação com movimento num clipe com blur vinculado: aviso de privacidade com **Ancorar efeito ao clipe** e **Ver efeito**; ancorado, a região acompanha o conteúdo (inclusive zooms feitos depois, sem novo aviso), no preview e no arquivo; texto sob o blur ilegível durante todo o zoom.
- [ ] Inspetor do efeito ancorado: chave "Ancorado ao clipe: <nome>"; arrastar a região a move sobre o conteúdo; desligar a chave desancora sem mudar o que se vê; apagar/desativar o clipe mostra "Clipe da âncora indisponível" e o efeito cobre a caixa de todo o movimento (invertido: o quadro inteiro); efeito solto sobre clipe em movimento oferece **Vincular e ancorar**.
- [ ] Animações de entrada/saída: os 10 presets (Fade, Esquerda, Direita, Cima, Baixo, Zoom, Pop, Girar, Quicar, Desfoque) com prévia animada no cartão; duração e curva; Combinação grava os dois lados; o 1º quadro de Zoom/Pop/Girar/Desfoque é invisível; Desfoque num PiP fora do centro borra só o PiP (sem borda dura em volta); o arquivo exportado é igual ao preview.
- [ ] Reenquadrar → 9:16 (Preencher): clique no visualizador marca pontos de foco no playhead (lista por clipe: ir, trocar, remover); a janela da prévia segue os pontos; "Caber inteiro" esconde os pontos; o painel avisa efeito fora do novo quadro, buraco fechado do "Borrar tudo menos…" e anotações; "Criar cópia" abre "<nome> (Vertical)" com o original intacto (mesmos proxies, sem reprocessar); "Este projeto" aplica em 1 passo de desfazer.
- [ ] Exportar a cópia em "Instagram Reels/Stories (9:16)": 1080×1920, o ponto de foco no centro, os efeitos de privacidade sobre o mesmo conteúdo, PiP com o tamanho relativo de antes.
- [ ] Compatibilidade: um projeto com zoom, efeito ancorado e animações Girar/Quicar/Desfoque abre na v1.3 (instalada em outra máquina) com o efeito cobrindo todo o movimento e as animações como Fade/Deslizar; um projeto com Ken Burns num PiP (keyframes de corte) não abre na v1.3 — e volta a abrir normal na v1.4.
- [ ] Ponta a ponta (como `editor-f4-e2e.mjs`): blur vinculado → zoom 2× → Ancorar → Pop/Desfoque → curva personalizada → YouTube 1080p → Reenquadrar 9:16 (cópia, foco) → Instagram Reels/Stories (9:16): tamanhos e durações certos, foco no centro e o texto ilegível em todo o zoom nos dois arquivos.

## Editor — exportação completa (F7)
- [ ] `Ctrl+E` abre o diálogo com os 8 presets e a estimativa "≈ N MB · W×H · fps · codec"; num projeto 16:9 os presets Reels/Feed aparecem desativados com o motivo (e o 4K num projeto menor que 4K); escolher um preset muda resolução/bitrate; qualquer ajuste em **Personalizar** troca o rótulo para "Personalizado".
- [ ] Tamanho alvo: WhatsApp de um vídeo de vários minutos sai com ≤ 64 MB; "Tamanho alvo (MB)" pequeno demais bloqueia o botão Exportar com o motivo; um alvo baixo (ex.: 0,5 Mbps) só avisa da qualidade.
- [ ] HEVC: com codificador de hardware, o botão HEVC fica disponível e o arquivo sai em HEVC (tag `hvc1`, abre no player do Windows com a extensão HEVC); sem hardware aparece desativado com "HEVC não suportado neste computador"; nos presets WhatsApp/Reels/Feed/Intermediário o padrão é H.264.
- [ ] GIF: 320/480/640 px e 10/12/15 fps, estimativa aproximada, trecho I–O; mais de 30 s bloqueia ("use I/O"); o GIF abre no navegador em loop, com a tarja e o blur nos lugares certos.
- [ ] Quadro (PNG): no diálogo, `Ctrl+Shift+E` e o botão **Quadro** salvam "<projeto> - 00mSSs.png" do cursor no tamanho do projeto, com toast **Abrir pasta**; repetir numera "(2)" sem sobrescrever; a tarja tem a cor exata.
- [ ] Só áudio: MP3 (padrão), M4A e WAV, 48 kHz estéreo, com a mesma mixagem do vídeo (música abaixando sob a voz, narração) e o trecho I–O.
- [ ] Capítulos: com 3+ marcadores com rótulo, a seção **Capítulos do YouTube** mostra "00:00 …" relativo ao trecho (I–O descontado, marcadores fora descartados); rótulo vazio vira "Capítulo N"; avisos de menos de 3 capítulos / capítulo com menos de 10 s; **Copiar** e **Salvar .txt**; o botão **Capítulos** da barra de cima copia o mesmo texto; sem marcadores, toast "Adicione marcadores (M) para gerar capítulos".
- [ ] Fila: **Adicionar à fila** com o diálogo aberto (toast com a posição); vários formatos na fila; o painel **Exportações** mostra progresso, "Na fila", mover para cima/baixo, cancelar, abrir pasta e "Limpar concluídas"; editar o projeto depois de enfileirar não muda o que está na fila; toast final com o resumo.
- [ ] Fila ativa: voltar aos projetos ou fechar o app pede confirmação com a contagem ("Sair cancela todas (a fila não é salva).") — "Continuar exportando" mantém tudo; **Cancelar todas** não deixa arquivos parciais (.part) na pasta.
- [ ] Codificador de reserva: num PC onde o H.264 do Windows falha (ou driver de vídeo antigo), a exportação termina pelo libx264 com o mesmo enquadramento, cores e efeitos de privacidade (progresso "Codificador de reserva…" e o aviso "Exportado com o codificador de reserva (mais lento)").
- [ ] Memória: projeto longo (1 h, muitas imagens/clipes) — percorrer a linha do tempo e exportar não faz o Gerenciador de Tarefas passar de ~1,5 GB de GPU/memória do editor; miniaturas fora da tela somem e voltam ao rolar.
- [ ] Relink: mover/renomear a pasta das mídias de um projeto fechado e reabri-lo: "Mídia encontrada em outro local" lista nome e caminho antigo → novo, nada muda antes de confirmar; **Reapontar selecionadas** deixa as mídias prontas (preview e áudio sem erro); "Agora não" mantém ausentes e **Localizar…** continua funcionando; dois arquivos de mesmo nome e tamanho na mesma pasta-irmã não são propostos.
- [ ] Ponta a ponta (como `editor-f7-e2e.mjs`): tarja + blur + 3 marcadores → I–O → fila com YouTube 1080p, GIF 480 e MP3 → `Ctrl+Shift+E` → copiar capítulos: os 4 arquivos abrem, durações do trecho certas, tarja/blur presentes em todos, capítulos colados no YouTube aceitos.
- [ ] Exportações longas: com o plano de energia "Equilibrado" a CPU desacelera; com "Alto desempenho" a exportação fica bem mais rápida.
