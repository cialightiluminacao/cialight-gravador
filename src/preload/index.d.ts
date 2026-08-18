import type { IpcApi } from '@shared/ipc'
import type { SpikeApi } from './index'

declare global {
  interface Window {
    api: IpcApi
    spikeApi: SpikeApi
  }
}
export {}
