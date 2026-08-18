# Instalação e uso — CiaLight Gravador

## Instalar em um computador (Windows 10/11, 64 bits)

1. Baixe o instalador `CiaLightGravador-Setup-X.Y.Z.exe` na página de releases: https://github.com/cialightiluminacao/cialight-gravador/releases/latest (ou receba o arquivo pela rede interna).
2. Execute o instalador. Ele instala só para o usuário atual (sem pedir administrador), cria atalho na Área de Trabalho e no Menu Iniciar e abre o app ao terminar.
3. **Aviso do SmartScreen na primeira instalação** ("O Windows protegeu o computador"): o instalador não é assinado digitalmente (assinatura comercial exige certificado pago). Clique em **Mais informações → Executar assim mesmo**. Isso só acontece na primeira instalação; as atualizações seguintes são automáticas e não passam por esse aviso.
4. Permissões: na primeira gravação o Windows pode pedir acesso à câmera e ao microfone. Se estiverem bloqueados, o app abre **Configurações → Privacidade → Câmera/Microfone** para você liberar.

## Atualizações

O app verifica novas versões ao abrir e a cada hora. Quando houver uma, aparece um banner "Nova versão X.Y.Z" — clique em **Baixar** e depois em **Reiniciar e atualizar** (nunca durante uma gravação). Também dá para verificar manualmente em **Configurações → Atualização e sobre**.

## Como gravar

1. **Preparar**: escolha um monitor ou uma janela (para gravar só uma aba do navegador, arraste a aba para uma janela própria e selecione essa janela); ligue/desligue câmera, microfone e áudio do sistema; escolha qualidade (1080p 30 fps por padrão) e contagem regressiva; posicione a webcam no preview (arraste, redimensione, escolha redonda ou retangular).
2. **Gravar** (`Ctrl+Shift+F9`): a contagem aparece no monitor gravado; a **barra flutuante** e a **borda vermelha** ficam no monitor gravado, mas **não aparecem no vídeo** (nem esta janela do gravador — deixe-a no outro monitor para acompanhar a webcam).
3. Durante a gravação: **pausar/retomar** (`Ctrl+Shift+F10`), silenciar microfone (`Ctrl+Shift+F1`), câmera (`Ctrl+Shift+F2`), mover/redimensionar a webcam no preview (a mudança entra no vídeo final), **anotar** na tela (`Ctrl+Shift+F5`: arraste para desenhar; **Shift** reta; **Ctrl+Shift** seta; **R/G/B/Y/W** cores; **[ ]** espessura; **Ctrl+Z** desfaz; **E** apaga tudo; **Esc** sai). As anotações também não aparecem sobre a sua tela na gravação bruta — são compostas no vídeo final.
4. **Parar** (`Ctrl+Shift+F9`) → **Revisão**: assista, corte início/fim, escolha o preset e exporte:
   - **WhatsApp / e-mail — pequeno**: MP4 até 64 MB (WhatsApp) ou 20 MB (e-mail), 720p.
   - **YouTube / Drive / Instagram — alta**: MP4 em qualidade alta (opção Reels 9:16).
   - **Tutorial interno — máxima**: MP4 em qualidade máxima.
   - **Edição posterior — separado**: tela e webcam em MP4 separados + microfone e sistema em WAV + arquivo combinado MKV.
   - **Só cortar (rápido)**: corte sem recodificar.
5. Os vídeos vão para `Vídeos\CiaLight Gravador` (configurável). As gravações brutas ficam em `Vídeos\CiaLight Gravador\Brutos` por 30 dias (configurável) e podem ser reexportadas pelo **Histórico**.

## Dicas e solução de problemas

- **Acesso remoto (RustDesk/RDP)**: as janelas do gravador ficam invisíveis para quem acessa remotamente enquanto a proteção está ligada. Desligue em **Configurações → Avançado → Esconder janelas do gravador da gravação** se precisar.
- **Aviso "atalho não registrado"**: outro programa usa a mesma combinação. Troque em **Configurações → Atalhos**.
- **Áudio do sistema não gravou**: o áudio do sistema é o do dispositivo de saída padrão do Windows. Confira em **Configurações de som** qual é a saída padrão.
- **Câmera em uso por outro programa**: feche o outro programa (Teams/Meet/OBS) e clique em Atualizar dispositivos.
- Logs: **Configurações → Avançado → Abrir pasta de logs**.
