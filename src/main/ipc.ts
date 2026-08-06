import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IpcChannel, IpcContract, IpcEventChannel, IpcEvents, VideoClip } from '@shared/ipc'
import type { CaptureSource, HighScores, StorageInfo } from '@shared/types'
import { guard } from './errors'
import { BrainRotError } from './errors'
import { getScoresStore, modelsDir, readSettings, storageRoot, updateSettings } from './settings'
import { cancelDownload, downloadModel, listModels } from './modelDownload'
import { detectWhisper } from './whisper'
import { toMediaUrl } from './mediaProtocol'
import {
  cancelTranscription,
  deleteRecording,
  listRecordings,
  readTranscript,
  recordingDir,
  renameRecording,
  saveRecording,
  storageStats,
  transcribeRecording,
  audioPath
} from './recordings'

/** The screen/window the renderer picked, consumed by the display-media handler. */
let selectedSourceId: string | null = null

export function getSelectedSourceId(): string | null {
  return selectedSourceId
}

function broadcast<E extends IpcEventChannel>(channel: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export { broadcast }

/**
 * Registers a handler for one channel. The generic ties the implementation's
 * arguments and return value to `IpcContract`, so a mismatch fails to compile.
 */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (
    ...args: IpcContract[C]['args']
  ) => Promise<Extract<IpcContract[C]['result'], { ok: true }>['value']>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    return guard(() => fn(...(args as IpcContract[C]['args'])))
  })
}

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.m4v', '.ogv', '.mkv']

async function notifyRecordingsChanged(): Promise<void> {
  broadcast('event:recordingsChanged', await listRecordings())
}

export function registerIpcHandlers(): void {
  handle('app:getVersions', async () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  }))

  /* ---------------- settings ---------------- */

  handle('settings:get', () => readSettings())
  handle('settings:update', (patch) => updateSettings(patch))

  handle('settings:pickVideoFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a folder of your own video clips',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    await updateSettings({ videoFolder: res.filePaths[0] })
    return res.filePaths[0]
  })

  handle('settings:pickStorageRoot', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose where recordings are stored',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    await updateSettings({ storageRoot: res.filePaths[0] })
    return res.filePaths[0]
  })

  handle('settings:pickWhisperBinary', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Locate the whisper.cpp CLI binary',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Executables', extensions: ['exe'] }]
          : [{ name: 'All files', extensions: ['*'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    await updateSettings({ whisperBinaryPath: res.filePaths[0] })
    return res.filePaths[0]
  })

  /* ---------------- capture ---------------- */

  handle('capture:listSources', async () => {
    let sources
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false
      })
    } catch (err) {
      throw new BrainRotError(
        'PERMISSION_DENIED',
        `Screen capture sources could not be listed: ${err instanceof Error ? err.message : String(err)}`,
        process.platform === 'linux'
          ? 'On Wayland this needs xdg-desktop-portal plus a PipeWire session. Install xdg-desktop-portal and the backend for your desktop (xdg-desktop-portal-gnome / -kde / -wlr).'
          : 'Grant screen recording permission to Brain Rotter in your OS privacy settings, then restart the app.'
      )
    }

    if (sources.length === 0) {
      throw new BrainRotError(
        'NO_SOURCES',
        'No screens or windows were offered for capture.',
        'On Linux make sure xdg-desktop-portal and PipeWire are running. You can still record microphone-only audio.'
      )
    }

    return sources.map<CaptureSource>((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      type: s.id.startsWith('screen:') ? 'screen' : 'window'
    }))
  })

  handle('capture:selectSource', async (sourceId) => {
    selectedSourceId = sourceId
    return null
  })

  /* ---------------- recordings ---------------- */

  handle('recordings:list', () => listRecordings())

  handle('recordings:save', async (req) => {
    const meta = await saveRecording(req)
    await notifyRecordingsChanged()
    if (req.autoTranscribe) {
      // Fire-and-forget: progress and failures reach the UI over the event channel.
      void transcribeRecording(meta.id, (p) => broadcast('event:transcriptionProgress', p))
        .catch((err: unknown) => {
          console.error('[brain-rotter] auto transcription failed:', err)
        })
        .finally(() => void notifyRecordingsChanged())
    }
    return meta
  })

  handle('recordings:delete', async (id) => {
    await deleteRecording(id)
    await notifyRecordingsChanged()
    return null
  })

  handle('recordings:rename', async (id, title) => {
    const meta = await renameRecording(id, title)
    await notifyRecordingsChanged()
    return meta
  })

  handle('recordings:getMedia', async (id) => {
    const path = await audioPath(id)
    let stat
    try {
      stat = await fs.stat(path)
    } catch {
      throw new BrainRotError(
        'FILE_NOT_FOUND',
        'The audio file for this recording is missing.',
        `Expected it at ${path}. It may have been moved or deleted outside the app.`
      )
    }
    if (stat.size === 0) {
      throw new BrainRotError('FILE_CORRUPT', 'The audio file for this recording is empty.')
    }
    return { url: toMediaUrl(path), path, sizeBytes: stat.size }
  })

  handle('recordings:getTranscript', (id) => readTranscript(id))

  handle('recordings:revealInFolder', async (id) => {
    shell.showItemInFolder(await audioPath(id))
    return null
  })

  /* ---------------- transcription ---------------- */

  handle('transcribe:start', async (id) => {
    void transcribeRecording(id, (p) => broadcast('event:transcriptionProgress', p))
      .catch((err: unknown) => {
        console.error('[brain-rotter] transcription failed:', err)
      })
      .finally(() => void notifyRecordingsChanged())
    return null
  })

  handle('transcribe:cancel', async (id) => {
    cancelTranscription(id)
    await notifyRecordingsChanged()
    return null
  })

  /* ---------------- whisper ---------------- */

  handle('whisper:getEnvironment', () => detectWhisper())
  handle('whisper:listModels', () => listModels())

  handle('whisper:downloadModel', async (model) => {
    await downloadModel(model, (p) => broadcast('event:modelDownloadProgress', p))
    return null
  })

  handle('whisper:cancelDownload', async () => {
    cancelDownload()
    return null
  })

  /* ---------------- video panel ---------------- */

  handle('video:listClips', async () => {
    const { videoFolder } = await readSettings()
    if (!videoFolder) return []
    let entries: string[]
    try {
      entries = await fs.readdir(videoFolder)
    } catch (err) {
      throw new BrainRotError(
        'FILE_NOT_FOUND',
        `The configured video folder could not be read: ${videoFolder}`,
        err instanceof Error ? err.message : undefined
      )
    }
    const clips: VideoClip[] = []
    for (const name of entries.sort()) {
      const lower = name.toLowerCase()
      if (!VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
      const full = join(videoFolder, name)
      try {
        const stat = await fs.stat(full)
        if (stat.isFile() && stat.size > 0) clips.push({ path: full, url: toMediaUrl(full), name })
      } catch {
        /* skip unreadable entries */
      }
    }
    return clips
  })

  /* ---------------- scores ---------------- */

  handle('scores:get', () => getScoresStore().read())

  handle('scores:set', async (game, score) => {
    const store = getScoresStore()
    const current = await store.read()
    const clean = Math.max(0, Math.floor(Number(score) || 0))
    if (clean <= current[game]) return current
    return store.write({ ...current, [game]: clean } as HighScores)
  })

  /* ---------------- storage / shell ---------------- */

  handle('storage:info', async (): Promise<StorageInfo> => {
    const stats = await storageStats()
    return {
      storageRoot: await storageRoot(),
      modelsDir: modelsDir(),
      userDataDir: app.getPath('userData'),
      ...stats
    }
  })

  handle('shell:openExternal', async (url) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new BrainRotError('INVALID_INPUT', `Not a valid URL: ${url}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BrainRotError('INVALID_INPUT', 'Only http and https links can be opened externally.')
    }
    await shell.openExternal(parsed.toString())
    return null
  })
}

export { recordingDir }
