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
- [ ] Exportar Alta 1080p, WhatsApp (≤ 64 MB), Original e Vertical 9:16 (projeto 9:16): progresso com %/velocidade/ETA, arquivo abre no Windows/VLC/WhatsApp Web, sem `.part` sobrando; cancelar apaga o parcial; sair durante a exportação pergunta uma vez.
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
- [ ] Exportar com efeitos (Alta 1080p e WhatsApp 720p): mesmo resultado do preview (lugar e intensidade); a tarja sai com a cor exata; nenhum quadro do trecho sai sem o efeito.
- [ ] Diálogo de exportação: efeito fraco (Blur < 50, Pixelizar < 30; invertido com mensagem própria), desativado/faixa oculta, ou com mídia visível numa faixa acima no trecho ("Há mídia acima deste efeito") aparece em **Privacidade** com "Revisar" (seleciona o efeito, leva o playhead ao instante do aviso e fecha o diálogo); o aviso nunca impede exportar.
- [ ] Efeito criado sobre um clipe mostra o ícone de vínculo; mover/aparar/dividir/apagar/duplicar o clipe e mudar a velocidade (ex.: 0,5×) levam o efeito junto (cobre o clipe inteiro); mover o efeito não move o clipe; "Desvincular" solta o efeito.
- [ ] Importar mídia com a faixa de vídeo ocupada cria a faixa nova abaixo da "Efeitos"; "Borrar tudo menos…" (80) deixa ilegível um texto grande fora da região; Pixelizar sobre conteúdo em movimento mostra blocos com a média (sem "cintilar" detalhe).

