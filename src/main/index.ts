import { app, BrowserWindow, ipcMain } from 'electron'
import { createRecorderWindow } from './windows/recorderWindow'
import { runSpike } from './spike/spikeMain'

app.setAppUserModelId('com.cialight.gravador')

app.whenReady().then(() => {
  ipcMain.handle('ping', () => 'pong')
  if (process.env.CIALIGHT_SPIKE) {
    void runSpike()
    return
  }
  createRecorderWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createRecorderWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
