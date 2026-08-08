/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 * Nothing in this file may import from `electron`, `node:*` or the DOM — it has to
 * compile under both the node and the web tsconfig.
 */

/** A single timed chunk of transcript, as produced by whisper.cpp. */
export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number
  /** Seconds from the start of the recording. */
  end: number
  text: string
}

export interface Transcript {
  /** Whisper model name that produced this transcript, e.g. `base.en`. */
  model: string
  language: string
  /** Wall-clock seconds the transcription run took. */
  durationMs: number
  createdAt: string
  segments: TranscriptSegment[]
}

export type TranscriptionStatus = 'none' | 'pending' | 'running' | 'done' | 'error'

/** One row in the recordings index. */
export interface RecordingMeta {
  id: string
  title: string
  /** ISO-8601 */
  createdAt: string
  /** Length of the audio in seconds. 0 when not yet known. */
  durationSec: number
  /** File name (not path) of the playable audio inside the recording folder. */
  audioFile: string
  /** Bytes on disk for the playable audio file. */
  sizeBytes: number
  transcription: TranscriptionStatus
  /** Human-readable reason when `transcription === 'error'`. */
  transcriptionError?: string
  /** Whether system audio actually made it into the mix. */
  capturedSystemAudio: boolean
  capturedMicrophone: boolean
}

export type WhisperModelId = 'tiny.en' | 'base.en' | 'small.en' | 'medium.en'

export interface WhisperModelInfo {
  id: WhisperModelId
  fileName: string
  /** Approximate download size, for the UI. */
  approxSizeMb: number
  description: string
  downloaded: boolean
}

export type BrainRotPanelId = 'video' | 'flappy' | 'webview' | 'runner' | 'smash'

export interface AppSettings {
  /** Folder of user-supplied .mp4/.webm clips for the video panel. Empty = unset. */
  videoFolder: string
  /** URL the webview panel points at. Empty = unset. */
  webviewUrl: string
  whisperModel: WhisperModelId
  /** Explicit path to a whisper.cpp CLI binary. Empty = auto-detect. */
  whisperBinaryPath: string
  /** Root folder for recordings. Empty = default (userData/recordings). */
  storageRoot: string
  /** Panels shown in the right-hand pane, top first. 1 or 2 entries. */
  brainRotPanels: BrainRotPanelId[]
  /** Fraction of the window width given to the transcript pane. */
  splitRatio: number
  /** Fraction of the right pane height given to the top panel when two are shown. */
  brainRotSplitRatio: number
}

export interface HighScores {
  flappy: number
  runner: number
  smash: number
}

/** A capturable screen/window offered by `desktopCapturer`. */
export interface CaptureSource {
  id: string
  name: string
  /** PNG data URL, may be an empty string if the thumbnail could not be produced. */
  thumbnailDataUrl: string
  type: 'screen' | 'window'
}

export interface WhisperEnvironment {
  /** Resolved path of the whisper binary, or null when none was found. */
  binaryPath: string | null
  /** How the binary was located. */
  source: 'settings' | 'bundled' | 'path' | 'none'
  /** Platform-specific install hint shown in the UI when `binaryPath` is null. */
  installHint: string
}

export interface StorageInfo {
  storageRoot: string
  modelsDir: string
  userDataDir: string
  recordingCount: number
  totalBytes: number
}

/* ------------------------------------------------------------------ *
 * Events pushed from main -> renderer
 * ------------------------------------------------------------------ */

export interface ModelDownloadProgress {
  model: WhisperModelId
  receivedBytes: number
  totalBytes: number
  /** 0..1, or -1 when the server did not send a content-length. */
  ratio: number
  state: 'downloading' | 'done' | 'error'
  message?: string
}

export interface TranscriptionProgress {
  recordingId: string
  state: TranscriptionStatus
  /** Free-form status line, e.g. "converting audio" or whisper's own stderr tail. */
  message: string
  /** 0..1 where known, else -1. */
  ratio: number
}

/** Envelope used by every invoke channel so failures are values, not exceptions. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export interface AppError {
  code: AppErrorCode
  message: string
  /** Optional extra guidance rendered under the message. */
  hint?: string
}

export type AppErrorCode =
  | 'WHISPER_NOT_FOUND'
  | 'WHISPER_FAILED'
  | 'MODEL_MISSING'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'FFMPEG_FAILED'
  | 'FILE_NOT_FOUND'
  | 'FILE_CORRUPT'
  | 'NO_SOURCES'
  | 'PERMISSION_DENIED'
  | 'INVALID_INPUT'
  | 'IO_ERROR'
  | 'UNKNOWN'
