# Fala sintética (System.Speech, offline) para testes de transcrição — NUNCA o microfone.
# Gera WAV 16 kHz 16-bit mono e um JSON com o início de cada palavra (SpeakProgress.AudioPosition).
# Uso (Windows PowerShell 5.1; System.Speech não existe no pwsh 7):
#   powershell -NoProfile -ExecutionPolicy Bypass -File synth-speech.ps1 -InFile in.ssml|in.txt -OutWav a.wav -OutJson a.raw.json [-Voice pt-BR|en-US] [-Rate 0]
# Se o conteúdo de -InFile começar com "<speak", é tratado como SSML (permite <break time="1500ms"/>).
param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutWav,
  [Parameter(Mandatory = $true)][string]$OutJson,
  [ValidateSet('pt-BR', 'en-US')][string]$Voice = 'pt-BR',
  [ValidateRange(-10, 10)][int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

# Os eventos do sintetizador chegam em outra thread; coletamos em C# para não depender do runspace do PowerShell.
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
public static class SynthWords {
  public static List<string> Lines = new List<string>();
  public static void Attach(SpeechSynthesizer s) {
    s.SpeakProgress += (o, e) => {
      lock (Lines) { Lines.Add((e.AudioPosition.Ticks / 10).ToString() + "\t" + e.CharacterPosition + "\t" + e.Text); }
    };
  }
}
'@

$voices = @{ 'pt-BR' = 'Microsoft Maria Desktop'; 'en-US' = 'Microsoft Zira Desktop' }
$text = [IO.File]::ReadAllText($InFile, [Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice($voices[$Voice])
  $synth.Rate = $Rate
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutWav, $fmt)
  [SynthWords]::Attach($synth)
  if ($text.TrimStart().StartsWith('<speak')) { $synth.SpeakSsml($text) } else { $synth.Speak($text) }
  $synth.SetOutputToNull()
} finally {
  $synth.Dispose()
}

$words = @()
foreach ($l in [SynthWords]::Lines) {
  $p = $l.Split("`t", 3)
  $words += [pscustomobject]@{ startUs = [int64]$p[0]; charPos = [int]$p[1]; text = $p[2] }
}
$json = ConvertTo-Json -InputObject @{ voice = $voices[$Voice]; words = $words } -Depth 4 -Compress
[IO.File]::WriteAllText($OutJson, $json, (New-Object Text.UTF8Encoding($false)))
