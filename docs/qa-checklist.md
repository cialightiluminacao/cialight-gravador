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
