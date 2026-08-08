import { app } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type { AppSettings, BrainRotPanelId, HighScores, WhisperModelId } from '@shared/types'
import { JsonStore } from './jsonStore'

const VALID_PANELS: BrainRotPanelId[] = ['video', 'flappy', 'webview', 'runner', 'smash']
const VALID_MODELS: WhisperModelId[] = ['tiny.en', 'base.en', 'small.en', 'medium.en']

export const DEFAULT_SETTINGS: AppSettings = {
  videoFolder: '',
  webviewUrl: '',
  whisperModel: 'base.en',
  whisperBinaryPath: '',
  storageRoot: '',
  brainRotPanels: ['video', 'flappy'],
  splitRatio: 0.5,
  brainRotSplitRatio: 0.5
}

const DEFAULT_SCORES: HighScores = { flappy: 0, runner: 0, smash: 0 }

let settingsStore: JsonStore<AppSettings> | null = null
let scoresStore: JsonStore<HighScores> | null = null

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback
  return Math.min(hi, Math.max(lo, v))
}

/** Coerces whatever is on disk into a valid settings object. */
function sanitize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>
  const panels = Array.isArray(r.brainRotPanels)
    ? r.brainRotPanels.filter((p): p is BrainRotPanelId => VALID_PANELS.includes(p)).slice(0, 2)
    : []
  return {
    videoFolder: typeof r.videoFolder === 'string' ? r.videoFolder : '',
    webviewUrl: typeof r.webviewUrl === 'string' ? r.webviewUrl : '',
    whisperModel: VALID_MODELS.includes(r.whisperModel as WhisperModelId)
      ? (r.whisperModel as WhisperModelId)
      : 'base.en',
    whisperBinaryPath: typeof r.whisperBinaryPath === 'string' ? r.whisperBinaryPath : '',
    storageRoot: typeof r.storageRoot === 'string' ? r.storageRoot : '',
    brainRotPanels: panels.length > 0 ? panels : [...DEFAULT_SETTINGS.brainRotPanels],
    splitRatio: clamp(r.splitRatio, 0.15, 0.85, 0.5),
    brainRotSplitRatio: clamp(r.brainRotSplitRatio, 0.15, 0.85, 0.5)
  }
}

export function getSettingsStore(): JsonStore<AppSettings> {
  settingsStore ??= new JsonStore(join(app.getPath('userData'), 'settings.json'), DEFAULT_SETTINGS, sanitize)
  return settingsStore
}

export function getScoresStore(): JsonStore<HighScores> {
  scoresStore ??= new JsonStore(join(app.getPath('userData'), 'highscores.json'), DEFAULT_SCORES, (raw) => {
    const r = (raw ?? {}) as Partial<HighScores>
    return {
      flappy: Math.max(0, Math.floor(Number(r.flappy) || 0)),
      runner: Math.max(0, Math.floor(Number(r.runner) || 0)),
      smash: Math.max(0, Math.floor(Number(r.smash) || 0))
    }
  })
  return scoresStore
}

export async function readSettings(): Promise<AppSettings> {
  return getSettingsStore().read()
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings()
  const merged = sanitize({ ...current, ...patch })
  await getSettingsStore().write(merged)
  await ensureDirs()
  return merged
}

/** Where recordings live. Falls back to `userData/recordings`. */
export async function storageRoot(): Promise<string> {
  const s = await readSettings()
  return s.storageRoot || join(app.getPath('userData'), 'recordings')
}

/** Where downloaded GGML models live. Always under userData so it survives storage moves. */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

/** Scratch space for intermediate WAV files. */
export function tempDir(): string {
  return join(app.getPath('userData'), 'tmp')
}

export async function ensureDirs(): Promise<void> {
  await Promise.all([
    fs.mkdir(await storageRoot(), { recursive: true }),
    fs.mkdir(modelsDir(), { recursive: true }),
    fs.mkdir(tempDir(), { recursive: true })
  ])
}
