# Spike G3 — helper PERSISTENTE de OCR via Windows.Media.Ocr (Windows PowerShell 5.1, projeção WinRT).
# Protocolo (stdin binário, stdout texto UTF-8, uma resposta JSON por linha):
#   pedido  : linha ASCII JSON {"id":1,"w":1920,"h":1080,"fmt":"gray8"|"bgra8","len":N} + "\n" + N bytes crus
#             (quadro descomprimido, sem cabeçalho de imagem; vem direto do pipe do ffmpeg -f rawvideo)
#             {"cmd":"quit"} encerra.
#   resposta: {"id":1,"ok":true,"ms":{"read":..,"ocr":..},"lines":[{"t":"texto","w":[["palavra",x,y,w,h],..]},..]}
#             coordenadas em pixels da imagem recebida. Erro: {"id":1,"ok":false,"error":"..."}
#   na partida: {"ready":true,"lang":"pt-BR","maxDim":10000,"startMs":..}  (ou {"ready":false,"error":..})
# Nada é gravado em disco; nenhum texto reconhecido vai para log.
param([string]$Lang = 'pt-BR')
$ErrorActionPreference = 'Stop'
$t0 = [Diagnostics.Stopwatch]::StartNew()
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$out = [Console]::Out
function Send([string]$s) { $out.WriteLine($s); $out.Flush() }
function Esc([string]$s) {
  $sb = New-Object System.Text.StringBuilder
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
  $language = New-Object Windows.Globalization.Language $Lang
  if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) { throw "idioma de OCR não instalado: $Lang" }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $engine) { throw "OcrEngine.TryCreateFromLanguage falhou: $Lang" }
} catch {
  Send ('{"ready":false,"error":"' + (Esc $_.Exception.Message) + '"}')
  exit 2
}
Send ('{"ready":true,"lang":"' + $Lang + '","maxDim":' + [Windows.Media.Ocr.OcrEngine]::MaxImageDimension + ',"startMs":' + $t0.ElapsedMilliseconds + '}')

$in = [Console]::OpenStandardInput()
$hdr = New-Object System.IO.MemoryStream
$inv = [Globalization.CultureInfo]::InvariantCulture
while ($true) {
  $hdr.SetLength(0)
  while ($true) { $b = $in.ReadByte(); if ($b -lt 0) { exit 0 }; if ($b -eq 10) { break }; $hdr.WriteByte([byte]$b) }
  $req = [Text.Encoding]::ASCII.GetString($hdr.ToArray()) | ConvertFrom-Json
  if ($req.cmd -eq 'quit') { exit 0 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $len = [int]$req.len
    $buf = [byte[]]::new($len)
    $off = 0
    while ($off -lt $len) { $n = $in.Read($buf, $off, $len - $off); if ($n -le 0) { exit 0 }; $off += $n }
    $tRead = $sw.Elapsed.TotalMilliseconds
    $fmt = if ($req.fmt -eq 'bgra8') { [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 } else { [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8 }
    $ibuf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($buf)
    $sbmp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($ibuf, $fmt, [int]$req.w, [int]$req.h)
    $task = $asTaskOcr.Invoke($null, @($engine.RecognizeAsync($sbmp)))
    $null = $task.Wait(-1)
    $res = $task.Result
    $sbmp.Dispose()
    $tOcr = $sw.Elapsed.TotalMilliseconds - $tRead
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('{"id":' + $req.id + ',"ok":true,"ms":{"read":' + $tRead.ToString('0.0', $inv) + ',"ocr":' + $tOcr.ToString('0.0', $inv) + '},"lines":[')
    $first = $true
    foreach ($line in $res.Lines) {
      if (-not $first) { [void]$sb.Append(',') }; $first = $false
      [void]$sb.Append('{"t":"' + (Esc $line.Text) + '","w":[')
      $fw = $true
      foreach ($w in $line.Words) {
        if (-not $fw) { [void]$sb.Append(',') }; $fw = $false
        $r = $w.BoundingRect
        [void]$sb.Append('["' + (Esc $w.Text) + '",' + [int]$r.X + ',' + [int]$r.Y + ',' + [int][math]::Ceiling($r.Width) + ',' + [int][math]::Ceiling($r.Height) + ']')
      }
      [void]$sb.Append(']}')
    }
    [void]$sb.Append(']}')
    Send $sb.ToString()
  } catch {
    Send ('{"id":' + $req.id + ',"ok":false,"error":"' + (Esc $_.Exception.Message) + '"}')
  }
}
