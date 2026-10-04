import { app } from 'electron'
import { join } from 'path'

// Em dev os binários ficam em resources/ffmpeg/ (baixados por scripts/fetch-ffmpeg.mjs);
// empacotado, o electron-builder copia a pasta para process.resourcesPath/ffmpeg via extraResources.
export function ffmpegDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : join(app.getAppPath(), 'resources', 'ffmpeg')
}
export function ffmpegPath(): string {
  return join(ffmpegDir(), 'ffmpeg.exe')
}
export function ffprobePath(): string {
  return join(ffmpegDir(), 'ffprobe.exe')
}

// Modelos (resources/models/, baixados por scripts/fetch-models.mjs; empacotado: process.resourcesPath/models).
export function modelsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'resources', 'models')
}
/** Pasta do modelo RNNoise da redução de ruído (o ffmpeg roda com cwd aqui; ver media/audioProcess.ts). */
export function rnnoiseDir(): string {
  return join(modelsDir(), 'rnnoise')
}

// Helper de OCR do "Procurar dados sensíveis" (resources/ocr/; empacotado: process.resourcesPath/ocr via extraResources).
export function ocrScriptPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'ocr', 'ocr-winrt.ps1') : join(app.getAppPath(), 'resources', 'ocr', 'ocr-winrt.ps1')
}
// whisper.cpp (legendas automáticas): resources/whisper/ em dev (scripts/fetch-whisper.mjs, também no `npm run dev`);
// empacotado, process.resourcesPath/whisper (extraResources).
export function whisperDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'resources', 'whisper')
}
export function whisperCliPath(): string {
  return join(whisperDir(), 'whisper-cli.exe')
}
