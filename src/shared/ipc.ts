/**
 * The single source of truth for the IPC surface.
 *
 * `IpcContract` maps every `ipcRenderer.invoke` channel to its argument tuple and
 * its resolved value. `IpcEvents` maps every main -> renderer push channel to its
 * payload. Both sides import these types, so adding a channel without implementing
 * it (or calling one with the wrong arguments) is a compile error.
 */
import type {
  AppSettings,
  CaptureSource,
  HighScores,
  RecordingMeta,
  Result,
  StorageInfo,
  Transcript,
  TranscriptionProgress,
  ModelDownloadProgress,
  WhisperEnvironment,
  WhisperModelId,
  WhisperModelInfo,
  BrainRotPanelId
} from './types'

export interface SaveRecordingRequest {
  /** Suggested title; the main process falls back to a timestamp when empty. */
  title: string
  /** The raw `.webm` blob produced by MediaRecorder. */
  data: ArrayBuffer
  /** Container/codec the renderer actually recorded with, e.g. `audio/webm;codecs=opus`. */
  mimeType: string
  durationSec: number
  capturedSystemAudio: boolean
  capturedMicrophone: boolean
  /** Kick off transcription as soon as the file is written. */
  autoTranscribe: boolean
}

export interface VideoClip {
  /** Absolute path on disk. */
  path: string
  /** `media://` URL the renderer can put in a <video src>. */
  url: string
  name: string
}

export interface MediaRef {
  /** `media://` URL for the recording's audio file. */
  url: string
  path: string
  sizeBytes: number
}

export interface IpcContract {
  'app:getVersions': { args: []; result: Result<{ app: string; electron: string; chrome: string; node: string }> }

  'settings:get': { args: []; result: Result<AppSettings> }
  'settings:update': { args: [patch: Partial<AppSettings>]; result: Result<AppSettings> }
  'settings:pickVideoFolder': { args: []; result: Result<string | null> }
  'settings:pickStorageRoot': { args: []; result: Result<string | null> }
  'settings:pickWhisperBinary': { args: []; result: Result<string | null> }

  'capture:listSources': { args: []; result: Result<CaptureSource[]> }
  'capture:selectSource': { args: [sourceId: string | null]; result: Result<null> }

  'recordings:list': { args: []; result: Result<RecordingMeta[]> }
  'recordings:save': { args: [req: SaveRecordingRequest]; result: Result<RecordingMeta> }
  'recordings:delete': { args: [id: string]; result: Result<null> }
  'recordings:rename': { args: [id: string, title: string]; result: Result<RecordingMeta> }
  'recordings:getMedia': { args: [id: string]; result: Result<MediaRef> }
  'recordings:getTranscript': { args: [id: string]; result: Result<Transcript | null> }
  'recordings:revealInFolder': { args: [id: string]; result: Result<null> }

  'transcribe:start': { args: [id: string]; result: Result<null> }
  'transcribe:cancel': { args: [id: string]; result: Result<null> }

  'whisper:getEnvironment': { args: []; result: Result<WhisperEnvironment> }
  'whisper:listModels': { args: []; result: Result<WhisperModelInfo[]> }
  'whisper:downloadModel': { args: [model: WhisperModelId]; result: Result<null> }
  'whisper:cancelDownload': { args: []; result: Result<null> }

  'video:listClips': { args: []; result: Result<VideoClip[]> }

  'scores:get': { args: []; result: Result<HighScores> }
  'scores:set': { args: [game: keyof HighScores, score: number]; result: Result<HighScores> }

  'storage:info': { args: []; result: Result<StorageInfo> }
  'shell:openExternal': { args: [url: string]; result: Result<null> }
}

export type IpcChannel = keyof IpcContract

export interface IpcEvents {
  'event:modelDownloadProgress': ModelDownloadProgress
  'event:transcriptionProgress': TranscriptionProgress
  'event:recordingsChanged': RecordingMeta[]
  'event:mainError': { title: string; message: string }
}

export type IpcEventChannel = keyof IpcEvents

/**
 * `process.platform` values. Spelled out here rather than using `NodeJS.Platform`
 * so this file also compiles under the renderer's DOM-only tsconfig.
 */
export type PlatformId =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

/** The object exposed on `window.brainRotter` by the preload script. */
export interface BrainRotterApi {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: IpcContract[C]['args']
  ): Promise<IpcContract[C]['result']>
  on<E extends IpcEventChannel>(channel: E, listener: (payload: IpcEvents[E]) => void): () => void
  platform: PlatformId
}

export const IPC_CHANNELS: readonly IpcChannel[] = [
  'app:getVersions',
  'settings:get',
  'settings:update',
  'settings:pickVideoFolder',
  'settings:pickStorageRoot',
  'settings:pickWhisperBinary',
  'capture:listSources',
  'capture:selectSource',
  'recordings:list',
  'recordings:save',
  'recordings:delete',
  'recordings:rename',
  'recordings:getMedia',
  'recordings:getTranscript',
  'recordings:revealInFolder',
  'transcribe:start',
  'transcribe:cancel',
  'whisper:getEnvironment',
  'whisper:listModels',
  'whisper:downloadModel',
  'whisper:cancelDownload',
  'video:listClips',
  'scores:get',
  'scores:set',
  'storage:info',
  'shell:openExternal'
] as const

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'event:modelDownloadProgress',
  'event:transcriptionProgress',
  'event:recordingsChanged',
  'event:mainError'
] as const

export const DEFAULT_PANELS: BrainRotPanelId[] = ['video', 'flappy']
