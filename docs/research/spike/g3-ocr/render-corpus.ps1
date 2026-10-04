# Spike G3 — renderiza as telas sintéticas descritas em spec.json (gerado por make-corpus.mjs).
# Texto via GDI TextRenderer (ClearType, como apps Win32; backColor opaco é obrigatório, senão o GDI
# desenha texto escuro sem suavização sobre bitmap). Escreve layout.json (retângulo de cada item).
param([Parameter(Mandatory = $true)][string]$SpecPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$spec = Get-Content -Raw -Encoding UTF8 $SpecPath | ConvertFrom-Json
$flags = [System.Windows.Forms.TextFormatFlags]'NoPadding, NoPrefix, SingleLine'
$big = New-Object System.Drawing.Size 4000, 400
function C([string]$h) { [System.Drawing.ColorTranslator]::FromHtml($h) }
$layout = @{}

foreach ($s in $spec.screens) {
  $bmp = New-Object System.Drawing.Bitmap 1920, 1080, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $c = $s.colors
  $g.Clear((C $c.bg))
  # "chrome" de aplicativo: barra de título, barra lateral, painel
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (C $c.title)), 0, 0, 1920, 40)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (C $c.side)), 0, 40, 280, 1040)
  $p = $s.panel
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (C $c.panel)), $p.x, $p.y, $p.w, $p.h)
  $ui = New-Object System.Drawing.Font 'Segoe UI', 14, ([System.Drawing.GraphicsUnit]::Pixel)
  [System.Windows.Forms.TextRenderer]::DrawText($g, 'Sistema de Gestão — Cadastro', $ui, (New-Object System.Drawing.Point 16, 11), (C $c.text), (C $c.title), $flags)
  $yy = 70
  foreach ($m in @('Início', 'Clientes', 'Pedidos', 'Financeiro', 'Relatórios', 'Configurações')) {
    [System.Windows.Forms.TextRenderer]::DrawText($g, $m, $ui, (New-Object System.Drawing.Point 24, $yy), (C $c.muted), (C $c.side), $flags); $yy += 34
  }

  $font = New-Object System.Drawing.Font $s.font, ([single]$s.size), ([System.Drawing.GraphicsUnit]::Pixel)
  $gap = [int][math]::Round($s.size * 0.35)
  foreach ($ln in $s.lines) {
    $x = [int]$ln.x
    foreach ($seg in $ln.segs) {
      $sz = [System.Windows.Forms.TextRenderer]::MeasureText($g, $seg.text, $font, $big, $flags)
      [System.Windows.Forms.TextRenderer]::DrawText($g, $seg.text, $font, (New-Object System.Drawing.Point $x, ([int]$ln.y)), (C $seg.color), (C $c.panel), $flags)
      if ($seg.id) { $layout[$seg.id] = @{ x = $x; y = [int]$ln.y; w = $sz.Width; h = $sz.Height } }
      $x += $sz.Width + $gap
    }
  }
  $g.Dispose()
  $bmp.Save((Join-Path $spec.outDir ($s.name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$out = Join-Path (Split-Path $SpecPath) 'layout.json'
[System.IO.File]::WriteAllText($out, ($layout | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding $false))
Write-Host "layout: $($layout.Count) itens"
