# Helper PERSISTENTE de OCR do "Procurar dados sensíveis" (G3): Windows.Media.Ocr pela projeção WinRT do
# Windows PowerShell 5.1 (o pwsh 7 não a tem). Um processo por varredura, iniciado pelo main (src/main/sensitive/ocrHelper.ts).
# Protocolo (docs/research/2026-10-03-ocr-spike.md §6) — stdin binário, stdout texto UTF-8, uma linha JSON por resposta:
#   partida : {"ready":true,"lang":"en-US","maxDim":10000,"startMs":..}  ou  {"ready":false,"error":"..."} (e sai com 2)
#   pedido  : linha ASCII {"id":1,"w":3840,"h":2160,"fmt":"gray8","len":8294400} + "\n" + len bytes crus (cinza 8 bits,
#             linhas de cima para baixo; "bgra8" também é aceito, len = w*h*4). {"cmd":"quit"} encerra.
#   resposta: {"id":1,"ok":true,"ms":{"read":..,"ocr":..},"lines":[{"t":"texto","w":[["palavra",x,y,w,h],..]},..]}
#             coordenadas em px da imagem recebida (retângulo inteiro que CONTÉM a caixa do OCR: piso/teto).
#             Erro: {"id":1,"ok":false,"error":"..."} e o helper continua.
# Fim do stdin (main caiu/fechou) entre pedidos = sai com 0; no meio de um quadro = linha de erro e sai com 3.
# Idioma: -Lang força um (sem alternativa); sem -Lang: en-US (melhor medido) → pt-BR → idiomas do perfil → o 1º disponível.
# PRIVACIDADE: nada é gravado em disco e nenhum texto reconhecido vai para log/stderr — só para o stdout do main.
param([string]$Lang = '')
$ErrorActionPreference = 'Stop'
$t0 = [Diagnostics.Stopwatch]::StartNew()
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$out = [Console]::Out
function Send([string]$s) { $out.Write($s); $out.Write("`n"); $out.Flush() }

# Escape JSON rápido: a maioria das palavras não tem nada a escapar (caminho direto); só as que têm vão caractere a caractere.
$special = [char[]](@([char]'"', [char]'\') + (0..31 | ForEach-Object { [char]$_ }))
function Esc([string]$s) {
  if ($s.IndexOfAny($special) -lt 0) { return $s }
  $sb = New-Object System.Text.StringBuilder ($s.Length + 8)
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($ch -eq '"') { [void]$sb.Append('\"') } elseif ($ch -eq '\') { [void]$sb.Append('\\') }
    elseif ($c -lt 32) { [void]$sb.AppendFormat('\u{0:x4}', $c) } else { [void]$sb.Append($ch) }
  }
  $sb.ToString()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTaskOcr = $asTask.MakeGenericMethod([Windows.Media.Ocr.OcrResult])
  $engine = $null
  $chosen = ''
  if ($Lang -ne '') {
    $language = New-Object Windows.Globalization.Language $Lang
    if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) { throw "idioma de OCR não instalado: $Lang" }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    $chosen = $Lang
  } else {
    foreach ($tag in @('en-US', 'pt-BR')) {
      $language = New-Object Windows.Globalization.Language $tag
      if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        if ($null -ne $engine) { $chosen = $tag; break }
      }
    }
    if ($null -eq $engine) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -ne $engine) { $chosen = $engine.RecognizerLanguage.LanguageTag }
    }
    if ($null -eq $engine) {
      foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
        if ($null -ne $engine) { $chosen = $l.LanguageTag; break }
      }
    }
  }
  if ($null -eq $engine) { throw 'nenhum idioma de OCR do Windows está instalado' }
} catch {
  Send ('{"ready":false,"error":"' + (Esc $_.Exception.Message) + '"}')
  exit 2
}
Send ('{"ready":true,"lang":"' + (Esc $chosen) + '","maxDim":' + [Windows.Media.Ocr.OcrEngine]::MaxImageDimension + ',"startMs":' + $t0.ElapsedMilliseconds + '}')

$MAX_LEN = 100000000  # 1e8 bytes = 10000x10000 gray8; bgra8 so cabe dentro disso
$MAX_HDR = 4096
$in = [Console]::OpenStandardInput()
$hdr = New-Object System.IO.MemoryStream
$inv = [Globalization.CultureInfo]::InvariantCulture
$skip = [byte[]]::new(65536)

while ($true) {
  $hdr.SetLength(0)
  $tooLong = $false
  while ($true) {
    $b = $in.ReadByte()
    if ($b -lt 0) { exit 0 }
    if ($b -eq 10) { break }
    if ($hdr.Length -lt $MAX_HDR) { $hdr.WriteByte([byte]$b) } else { $tooLong = $true }
  }
  $id = 'null'
  $req = $null
  $err = $null
  try {
    if ($tooLong) { throw 'cabeçalho longo demais' }
    $req = [Text.Encoding]::ASCII.GetString($hdr.ToArray()) | ConvertFrom-Json
  } catch {
    $err = 'cabeçalho inválido'
  }
  if ($null -eq $err -and $null -ne $req) {
    if ($req.cmd -eq 'quit') { exit 0 }
    $idv = 0L
    if ($null -ne $req.id -and [long]::TryParse([string]$req.id, [ref]$idv)) { $id = [string]$idv }
  }
  # o tamanho só é confiável (para pular os bytes e continuar sincronizado) se for um inteiro dentro do limite
  $len = -1L
  if ($null -eq $err) {
    $lv = 0L
    if ($null -ne $req.len -and [long]::TryParse([string]$req.len, [ref]$lv) -and $lv -gt 0 -and $lv -le $MAX_LEN) { $len = $lv }
    $w = 0; $h = 0
    $okW = $null -ne $req.w -and [int]::TryParse([string]$req.w, [ref]$w) -and $w -gt 0 -and $w -le 10000
    $okH = $null -ne $req.h -and [int]::TryParse([string]$req.h, [ref]$h) -and $h -gt 0 -and $h -le 10000
    $bpp = if ($req.fmt -eq 'gray8') { 1 } elseif ($req.fmt -eq 'bgra8') { 4 } else { 0 }
    if ($len -lt 0) { $err = 'len inválido' }
    elseif (-not ($okW -and $okH)) { $err = 'dimensões inválidas' }
    elseif ($bpp -eq 0) { $err = 'formato inválido' }
    elseif ([long]$w * [long]$h * $bpp -ne $len) { $err = 'len não confere com w*h' }
  }
  if ($null -ne $err) {
    # descarta os bytes do quadro (se o tamanho for confiável) para continuar sincronizado
    $rest = $len
    while ($rest -gt 0) {
      $n = $in.Read($skip, 0, [int][math]::Min($rest, $skip.Length))
      if ($n -le 0) { Send ('{"id":' + $id + ',"ok":false,"error":"entrada truncada"}'); exit 3 }
      $rest -= $n
    }
    Send ('{"id":' + $id + ',"ok":false,"error":"' + $err + '"}')
    continue
  }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $buf = [byte[]]::new([int]$len)
  $off = 0
  while ($off -lt $len) {
    $n = $in.Read($buf, $off, [int]$len - $off)
    if ($n -le 0) { Send ('{"id":' + $id + ',"ok":false,"error":"entrada truncada"}'); exit 3 }
    $off += $n
  }
  $tRead = $sw.Elapsed.TotalMilliseconds
  try {
    $fmt = if ($bpp -eq 4) { [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 } else { [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8 }
    $ibuf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($buf)
    $sbmp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($ibuf, $fmt, $w, $h)
    $task = $asTaskOcr.Invoke($null, @($engine.RecognizeAsync($sbmp)))
    $null = $task.Wait(-1)
    $res = $task.Result
    $sbmp.Dispose()
    $tOcr = $sw.Elapsed.TotalMilliseconds - $tRead
    $sb = New-Object System.Text.StringBuilder 4096
    [void]$sb.Append('{"id":').Append($id).Append(',"ok":true,"ms":{"read":').Append($tRead.ToString('0.0', $inv)).Append(',"ocr":').Append($tOcr.ToString('0.0', $inv)).Append('},"lines":[')
    $first = $true
    foreach ($line in $res.Lines) {
      if (-not $first) { [void]$sb.Append(',') }; $first = $false
      [void]$sb.Append('{"t":"').Append((Esc $line.Text)).Append('","w":[')
      $fw = $true
      foreach ($wd in $line.Words) {
        if (-not $fw) { [void]$sb.Append(',') }; $fw = $false
        $r = $wd.BoundingRect
        $x0 = [int][math]::Floor($r.X); $y0 = [int][math]::Floor($r.Y)
        $x1 = [int][math]::Ceiling($r.X + $r.Width); $y1 = [int][math]::Ceiling($r.Y + $r.Height)
        [void]$sb.Append('["').Append((Esc $wd.Text)).Append('",').Append($x0).Append(',').Append($y0).Append(',').Append($x1 - $x0).Append(',').Append($y1 - $y0).Append(']')
      }
      [void]$sb.Append(']}')
    }
    [void]$sb.Append(']}')
    Send $sb.ToString()
  } catch {
    Send ('{"id":' + $id + ',"ok":false,"error":"' + (Esc $_.Exception.Message) + '"}')
  }
}
