import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { RecordingMeta, Transcript, TranscriptionProgress } from '@shared/types'
import type { SaveRecordingRequest } from '@shared/ipc'
import { BrainRotError } from './errors'
import { readSettings, storageRoot, tempDir } from './settings'
import { probeDurationSec, remuxWebm, toWhisperWav } from './ffmpeg'
import { runWhisper } from './whisper'

/**
 * On-disk layout (under the storage root, default `<userData>/recordings`):
 *
 *   index.json                       the list of recordings, newest first
 *   <recording-id>/audio.webm        the mixed opus audio as recorded
 *   <recording-id>/transcript.json   { model, language, segments: [{start,end,text}] }
 *   <recording-id>/meta.json         a copy of the index row, so a lost index can be rebuilt
 */

interface RecordingsIndex {
  version: 1
  recordings: RecordingMeta[]
}

const AUDIO_FILE = 'audio.webm'
const TRANSCRIPT_FILE = 'transcript.json'
const META_FILE = 'meta.json'

export async function indexPath(): Promise<string> {
  return join(await storageRoot(), 'index.json')
}

export async function recordingDir(id: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new BrainRotError('INVALID_INPUT', `Invalid recording id: ${id}`)
  }
  return join(await storageRoot(), id)
}

async function readIndex(): Promise<RecordingsIndex> {
  const p = await indexPath()
  try {
    const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as Partial<RecordingsIndex>
    if (Array.isArray(parsed.recordings)) {
      return { version: 1, recordings: parsed.recordings }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[brain-rotter] recordings index unreadable, rebuilding from disk:', err)
      return { version: 1, recordings: await rebuildIndexFromDisk() }
    }
  }
  return { version: 1, recordings: [] }
}

async function writeIndex(index: RecordingsIndex): Promise<void> {
  const p = await indexPath()
  await fs.mkdir(await storageRoot(), { recursive: true })
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
  await fs.rename(tmp, p)
}

/** Scans the storage root for `<id>/meta.json` files when the index is gone or corrupt. */
async function rebuildIndexFromDisk(): Promise<RecordingMeta[]> {
  const root = await storageRoot()
  const out: RecordingMeta[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(join(root, entry, META_FILE), 'utf8')
      out.push(JSON.parse(raw) as RecordingMeta)
    } catch {
      /* not a recording folder */
    }
  }
  return sortRecordings(out)
}

function sortRecordings(list: RecordingMeta[]): RecordingMeta[] {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const index = await readIndex()
  return sortRecordings(index.recordings)
}

export async function getRecording(id: string): Promise<RecordingMeta> {
  const list = await listRecordings()
  const found = list.find((r) => r.id === id)
  if (!found) throw new BrainRotError('FILE_NOT_FOUND', `No recording with id ${id}.`)
  return found
}

async function upsert(meta: RecordingMeta): Promise<RecordingMeta> {
  const index = await readIndex()
  const next = index.recordings.filter((r) => r.id !== meta.id)
  next.push(meta)
  await writeIndex({ version: 1, recordings: sortRecordings(next) })
  try {
    await fs.writeFile(join(await recordingDir(meta.id), META_FILE), JSON.stringify(meta, null, 2), 'utf8')
  } catch (err) {
    console.warn('[brain-rotter] could not write per-recording meta.json:', err)
  }
  return meta
}

export async function audioPath(id: string): Promise<string> {
  const meta = await getRecording(id)
  return join(await recordingDir(id), meta.audioFile)
}

export async function transcriptPath(id: string): Promise<string> {
  return join(await recordingDir(id), TRANSCRIPT_FILE)
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

function defaultTitle(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `Meeting ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export async function saveRecording(req: SaveRecordingRequest): Promise<RecordingMeta> {
  if (!req.data || req.data.byteLength === 0) {
    throw new BrainRotError(
      'INVALID_INPUT',
      'The recording contained no audio data.',
      'This usually means no audio track was captured. Check your microphone and system-audio source and try again.'
    )
  }

  const id = randomUUID()
  const dir = await recordingDir(id)
  await fs.mkdir(dir, { recursive: true })

  const rawPath = join(dir, 'raw.webm')
  await fs.writeFile(rawPath, Buffer.from(req.data))

  // MediaRecorder output has no duration cue, so remux it into a seekable file.
  const finalPath = join(dir, AUDIO_FILE)
  try {
    await remuxWebm(rawPath, finalPath)
    await fs.rm(rawPath, { force: true })
  } catch (err) {
    console.warn('[brain-rotter] remux failed, keeping the raw MediaRecorder output:', err)
    await fs.rename(rawPath, finalPath).catch(() => undefined)
  }

  let durationSec = req.durationSec
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = await probeDurationSec(finalPath)
  }

  const stat = await fs.stat(finalPath)
  const meta: RecordingMeta = {
    id,
    title: req.title.trim() || defaultTitle(),
    createdAt: new Date().toISOString(),
    durationSec: Math.round(durationSec * 100) / 100,
    audioFile: AUDIO_FILE,
    sizeBytes: stat.size,
    transcription: 'none',
    capturedSystemAudio: req.capturedSystemAudio,
    capturedMicrophone: req.capturedMicrophone
  }
  return upsert(meta)
}

export async function renameRecording(id: string, title: string): Promise<RecordingMeta> {
  const meta = await getRecording(id)
  const trimmed = title.trim()
  if (!trimmed) throw new BrainRotError('INVALID_INPUT', 'A recording title cannot be empty.')
  return upsert({ ...meta, title: trimmed.slice(0, 200) })
}

export async function deleteRecording(id: string): Promise<void> {
  const dir = await recordingDir(id)
  cancelTranscription(id)
  await fs.rm(dir, { recursive: true, force: true })
  const index = await readIndex()
  await writeIndex({ version: 1, recordings: index.recordings.filter((r) => r.id !== id) })
}

export async function readTranscript(id: string): Promise<Transcript | null> {
  try {
    const raw = await fs.readFile(await transcriptPath(id), 'utf8')
    const parsed = JSON.parse(raw) as Transcript
    if (!Array.isArray(parsed.segments)) {
      throw new BrainRotError('FILE_CORRUPT', 'The transcript file is missing its segments array.')
    }
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (err instanceof BrainRotError) throw err
    throw new BrainRotError(
      'FILE_CORRUPT',
      `The transcript for this recording could not be read: ${err instanceof Error ? err.message : String(err)}`,
      'Re-run transcription to regenerate it.'
    )
  }
}

/* ------------------------------------------------------------------ *
 * Transcription orchestration
 * ------------------------------------------------------------------ */

interface Job {
  cancelled: boolean
  child?: ChildProcess
}

const jobs = new Map<string, Job>()

export function cancelTranscription(id: string): void {
  const job = jobs.get(id)
  if (!job) return
  job.cancelled = true
  job.child?.kill()
  jobs.delete(id)
}

export function isTranscribing(id: string): boolean {
  return jobs.has(id)
}

export async function transcribeRecording(
  id: string,
  onProgress: (p: TranscriptionProgress) => void
): Promise<void> {
  if (jobs.has(id)) {
    throw new BrainRotError('INVALID_INPUT', 'This recording is already being transcribed.')
  }

  const meta = await getRecording(id)
  const settings = await readSettings()
  const job: Job = { cancelled: false }
  jobs.set(id, job)

  const emit = (state: TranscriptionProgress['state'], message: string, ratio = -1): void =>
    onProgress({ recordingId: id, state, message, ratio })

  const wav = join(tempDir(), `${id}.wav`)
  const outPrefix = join(tempDir(), id)

  try {
    await upsert({ ...meta, transcription: 'running', transcriptionError: undefined })
    emit('running', 'Converting audio to 16 kHz mono WAV…', -1)

    const source = join(await recordingDir(id), meta.audioFile)
    await fs.access(source).catch(() => {
      throw new BrainRotError(
        'FILE_NOT_FOUND',
        'The audio file for this recording is missing from disk.',
        'It may have been deleted or moved. Delete the entry from the library and record again.'
      )
    })

    await fs.mkdir(tempDir(), { recursive: true })
    await toWhisperWav(source, wav)
    if (job.cancelled) throw new BrainRotError('WHISPER_FAILED', 'Transcription was cancelled.')

    emit('running', `Running whisper.cpp (${settings.whisperModel})…`, -1)

    const transcript = await runWhisper({
      wavPath: wav,
      model: settings.whisperModel,
      outputPrefix: outPrefix,
      signal: job,
      onLog: (line) => {
        const m = /progress\s*=\s*(\d+)\s*%/i.exec(line)
        if (m?.[1]) emit('running', `Transcribing… ${m[1]}%`, Number(m[1]) / 100)
        else if (line.length < 200) emit('running', line, -1)
      }
    })

    await fs.writeFile(await transcriptPath(id), JSON.stringify(transcript, null, 2), 'utf8')

    const fresh = await getRecording(id)
    const durationSec = fresh.durationSec > 0 ? fresh.durationSec : lastSegmentEnd(transcript)
    await upsert({ ...fresh, durationSec, transcription: 'done', transcriptionError: undefined })
    emit('done', `Done — ${transcript.segments.length} segments.`, 1)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hint = err instanceof BrainRotError ? err.hint : undefined
    try {
      const fresh = await getRecording(id)
      await upsert({ ...fresh, transcription: 'error', transcriptionError: message })
    } catch {
      /* recording may have been deleted mid-run */
    }
    emit('error', hint ? `${message}\n${hint}` : message, 0)
    throw err
  } finally {
    jobs.delete(id)
    await fs.rm(wav, { force: true }).catch(() => undefined)
    await fs.rm(`${outPrefix}.json`, { force: true }).catch(() => undefined)
  }
}

function lastSegmentEnd(t: Transcript): number {
  return t.segments.length > 0 ? (t.segments[t.segments.length - 1]?.end ?? 0) : 0
}

export async function storageStats(): Promise<{ recordingCount: number; totalBytes: number }> {
  const list = await listRecordings()
  return {
    recordingCount: list.length,
    totalBytes: list.reduce((sum, r) => sum + (r.sizeBytes || 0), 0)
  }
}
