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
