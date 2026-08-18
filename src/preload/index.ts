import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  spike: {
    getSources: (): Promise<unknown[]> => ipcRenderer.invoke('spike:getSources'),
    chooseSource: (id: string, wantAudio: boolean): Promise<void> => ipcRenderer.invoke('spike:chooseSource', id, wantAudio),
    openWrite: (name: string): Promise<number> => ipcRenderer.invoke('spike:openWrite', name),
    write: (handle: number, data: Uint8Array, position: number): Promise<void> =>
      ipcRenderer.invoke('spike:write', handle, data, position),
    closeWrite: (handle: number): Promise<void> => ipcRenderer.invoke('spike:closeWrite', handle),
    log: (msg: string): void => {
      ipcRenderer.send('spike:log', msg)
    },
    captureThumb: (name: string): Promise<string> => ipcRenderer.invoke('spike:captureThumb', name),
    protect: (on: boolean): Promise<void> => ipcRenderer.invoke('spike:protect', on),
    setOverlayInteractive: (on: boolean): Promise<void> => ipcRenderer.invoke('spike:overlayInteractive', on),
    cpu: (): Promise<{ percentCPUUsage: number }> => ipcRenderer.invoke('spike:cpu'),
    done: (report: unknown): Promise<unknown> => ipcRenderer.invoke('spike:done', report),
    osClickOverlay: (): Promise<void> => ipcRenderer.invoke('spike:osClickOverlay'),
    playSound: (): Promise<void> => ipcRenderer.invoke('spike:playSound'),
    testHotkeyNotepad: (): Promise<void> => ipcRenderer.invoke('spike:testHotkeyNotepad'),
    requestGestureStart: (): Promise<void> => ipcRenderer.invoke('spike:requestGestureStart'),
    onHotkey: (cb: () => void): (() => void) => {
      const l = (_e: IpcRendererEvent): void => cb()
      ipcRenderer.on('spike:hotkey', l)
      return () => ipcRenderer.removeListener('spike:hotkey', l)
    },
    onOverlayEvent: (cb: (msg: string) => void): (() => void) => {
      const l = (_e: IpcRendererEvent, msg: string): void => cb(msg)
      ipcRenderer.on('spike:overlayEvent', l)
      return () => ipcRenderer.removeListener('spike:overlayEvent', l)
    },
    overlayReport: (msg: string): void => {
      ipcRenderer.send('spike:overlayReport', msg)
    }
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
