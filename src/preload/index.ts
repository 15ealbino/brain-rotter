import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '@shared/ipc'
import type { BrainRotterApi, IpcChannel, IpcContract, IpcEventChannel, IpcEvents } from '@shared/ipc'

/**
 * The only bridge between the renderer and the main process.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer gets
 * exactly this object and nothing else — no ipcRenderer, no require, no remote.
 * Channel names are validated against the shared allow-list before they reach IPC.
 */

const invokeChannels = new Set<string>(IPC_CHANNELS)
const eventChannels = new Set<string>(IPC_EVENT_CHANNELS)

const api: BrainRotterApi = {
  invoke: async <C extends IpcChannel>(
    channel: C,
    ...args: IpcContract[C]['args']
  ): Promise<IpcContract[C]['result']> => {
    if (!invokeChannels.has(channel)) {
      return {
        ok: false,
        error: { code: 'INVALID_INPUT', message: `Unknown IPC channel: ${String(channel)}` }
      } as IpcContract[C]['result']
    }
    try {
      return (await ipcRenderer.invoke(channel, ...args)) as IpcContract[C]['result']
    } catch (err) {
      // A rejection here means the main handler itself blew up outside `guard`.
      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
          hint: `Channel: ${String(channel)}`
        }
      } as IpcContract[C]['result']
    }
  },

  on: <E extends IpcEventChannel>(channel: E, listener: (payload: IpcEvents[E]) => void): (() => void) => {
    if (!eventChannels.has(channel)) {
      console.warn(`[brain-rotter] refusing to subscribe to unknown channel: ${String(channel)}`)
      return () => undefined
    }
    const wrapped = (_event: IpcRendererEvent, payload: IpcEvents[E]): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },

  platform: process.platform
}

contextBridge.exposeInMainWorld('brainRotter', api)
