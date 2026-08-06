import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { app } from 'electron'
import type { Transcript, TranscriptSegment, WhisperEnvironment, WhisperModelId } from '@shared/types'
import { BrainRotError } from './errors'
import { modelsDir, readSettings } from './settings'

/**
 * Names whisper.cpp has shipped its CLI under over time. `whisper-cli` is the
 * current one; `main` is the pre-1.6 name and is also what a plain
 * `make` inside a whisper.cpp checkout produces.
 */
const CANDIDATE_BINARIES =
  process.platform === 'win32'
    ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
    : ['whisper-cli', 'whisper-cpp', 'whisper.cpp', 'whisper', 'main']

const EXTRA_SEARCH_DIRS =
  process.platform === 'win32'
    ? ['C:\\Program Files\\whisper.cpp', 'C:\\whisper.cpp\\build\\bin\\Release', 'C:\\whisper.cpp']
    : [
        '/usr/local/bin',
        '/usr/bin',
        '/opt/homebrew/bin',
        join(app.getPath('home'), '.local', 'bin'),
        join(app.getPath('home'), 'whisper.cpp', 'build', 'bin'),
        join(app.getPath('home'), 'whisper.cpp')
      ]

export const INSTALL_HINT =
  process.platform === 'win32'
    ? 'Download a whisper.cpp release build from https://github.com/ggml-org/whisper.cpp/releases, unzip it, then point Settings > whisper.cpp binary at whisper-cli.exe.'
    : 'Install whisper.cpp: `git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j --config Release`, then either add build/bin to your PATH or point Settings > whisper.cpp binary at build/bin/whisper-cli.'

function isExecutableFile(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/** Directory where a packaged build would place a vendored whisper binary. */
function bundledDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'whisper') : resolve(app.getAppPath(), 'resources', 'whisper')
}

export async function detectWhisper(): Promise<WhisperEnvironment> {
  const settings = await readSettings()

  if (settings.whisperBinaryPath && isExecutableFile(settings.whisperBinaryPath)) {
    return { binaryPath: settings.whisperBinaryPath, source: 'settings', installHint: INSTALL_HINT }
  }

  for (const name of CANDIDATE_BINARIES) {
    const p = join(bundledDir(), name)
    if (isExecutableFile(p)) return { binaryPath: p, source: 'bundled', installHint: INSTALL_HINT }
  }

  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean).concat(EXTRA_SEARCH_DIRS)
  for (const dir of pathDirs) {
    for (const name of CANDIDATE_BINARIES) {
      const p = join(dir, name)
      if (isExecutableFile(p)) return { binaryPath: p, source: 'path', installHint: INSTALL_HINT }
    }
  }

  return { binaryPath: null, source: 'none', installHint: INSTALL_HINT }
}

export async function requireWhisper(): Promise<string> {
  const env = await detectWhisper()
  if (!env.binaryPath) {
    throw new BrainRotError(
      'WHISPER_NOT_FOUND',
      'No whisper.cpp binary was found on this machine.',
      INSTALL_HINT
    )
  }
  return env.binaryPath
}

export function modelFileName(model: WhisperModelId): string {
  return `ggml-${model}.bin`
}

export function modelPath(model: WhisperModelId): string {
  return join(modelsDir(), modelFileName(model))
}

export async function modelExists(model: WhisperModelId): Promise<boolean> {
  try {
    const st = await fs.stat(modelPath(model))
    // A truncated download leaves a small file behind; treat anything tiny as absent.
    return st.isFile() && st.size > 1_000_000
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * whisper.cpp JSON output
 * ------------------------------------------------------------------ */

interface WhisperJsonOffsets {
  from?: number
  to?: number
}

interface WhisperJsonSegment {
  timestamps?: { from?: string; to?: string }
  offsets?: WhisperJsonOffsets
  text?: string
}

interface WhisperJson {
  result?: { language?: string }
  transcription?: WhisperJsonSegment[]
}

/** `HH:MM:SS,mmm` -> seconds. */
function parseTimestamp(ts: string): number {
  const m = /^(\d+):(\d+):(\d+)[.,](\d+)$/.exec(ts.trim())
  if (!m) return 0
  const [, h = '0', mi = '0', s = '0', ms = '0'] = m
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

export function parseWhisperJson(raw: string, model: WhisperModelId, durationMs: number): Transcript {
  let doc: WhisperJson
  try {
    doc = JSON.parse(raw) as WhisperJson
  } catch (err) {
    throw new BrainRotError(
      'WHISPER_FAILED',
      'whisper.cpp produced output that could not be parsed as JSON.',
      err instanceof Error ? err.message : undefined
    )
  }

  const rows = Array.isArray(doc.transcription) ? doc.transcription : []
  const segments: TranscriptSegment[] = []
  for (const row of rows) {
    const text = (row.text ?? '').trim()
    if (!text) continue
    let start: number
    let end: number
    if (row.offsets && typeof row.offsets.from === 'number' && typeof row.offsets.to === 'number') {
      start = row.offsets.from / 1000
      end = row.offsets.to / 1000
    } else if (row.timestamps?.from && row.timestamps?.to) {
      start = parseTimestamp(row.timestamps.from)
      end = parseTimestamp(row.timestamps.to)
    } else {
      continue
    }
    segments.push({ start, end: Math.max(end, start), text })
  }

  return {
    model,
    language: doc.result?.language ?? 'en',
    durationMs,
    createdAt: new Date().toISOString(),
    segments
  }
}

/* ------------------------------------------------------------------ *
 * Running whisper
 * ------------------------------------------------------------------ */

export interface TranscribeOptions {
  wavPath: string
  model: WhisperModelId
  /** Prefix whisper writes `<prefix>.json` to. */
  outputPrefix: string
  onLog?: (line: string) => void
  signal?: { cancelled: boolean; child?: ChildProcess }
}

export async function runWhisper(opts: TranscribeOptions): Promise<Transcript> {
  const bin = await requireWhisper()
  const model = modelPath(opts.model)

  if (!(await modelExists(opts.model))) {
    throw new BrainRotError(
      'MODEL_MISSING',
      `The whisper model "${opts.model}" has not been downloaded yet.`,
      'Open Settings and download it, or pick a model that is already on disk.'
    )
  }

  const threads = Math.max(1, Math.min(8, (await import('node:os')).cpus().length - 1 || 1))
  const args = [
    '-m', model,
    '-f', opts.wavPath,
    '-oj',                       // JSON output
    '-of', opts.outputPrefix,    // output file prefix (whisper appends .json)
    '-t', String(threads),
    '-pp',                       // print progress to stderr
    '-nt'                        // no timestamps in the console echo (JSON still has them)
  ]

  const startedAt = Date.now()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { windowsHide: true })
    if (opts.signal) opts.signal.child = child
    let stderrTail = ''

    const onChunk = (buf: Buffer): void => {
      const text = buf.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed) opts.onLog?.(trimmed)
      }
    }
    child.stderr.on('data', onChunk)
    child.stdout.on('data', onChunk)

    child.on('error', (err) => {
      rejectPromise(
        new BrainRotError('WHISPER_FAILED', `Could not start whisper.cpp (${bin}): ${err.message}`, INSTALL_HINT)
      )
    })

    child.on('close', (code, sig) => {
      if (opts.signal?.cancelled) {
        rejectPromise(new BrainRotError('WHISPER_FAILED', 'Transcription was cancelled.'))
        return
      }
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new BrainRotError(
          'WHISPER_FAILED',
          `whisper.cpp exited with ${sig ? `signal ${sig}` : `code ${code}`}.`,
          stderrTail.split('\n').filter(Boolean).slice(-6).join('\n') || undefined
        )
      )
    })
  })

  const jsonPath = `${opts.outputPrefix}.json`
  let raw: string
  try {
    raw = await fs.readFile(jsonPath, 'utf8')
  } catch {
    throw new BrainRotError(
      'WHISPER_FAILED',
      'whisper.cpp finished but did not write a JSON transcript.',
      `Expected ${jsonPath}. Your whisper build may be too old — it needs the -oj/-of flags (whisper.cpp 1.5 or newer).`
    )
  }

  const transcript = parseWhisperJson(raw, opts.model, Date.now() - startedAt)
  await fs.rm(jsonPath, { force: true })
  return transcript
}
