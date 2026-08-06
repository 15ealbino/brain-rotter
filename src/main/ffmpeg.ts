import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import ffmpegStatic from 'ffmpeg-static'
import { BrainRotError } from './errors'

/**
 * `ffmpeg-static` resolves to a path inside `app.asar` once packaged. electron-builder
 * is configured to unpack that folder, so the real file sits in `app.asar.unpacked`.
 */
export function ffmpegPath(): string {
  const raw = ffmpegStatic as unknown as string | null
  if (!raw) {
    throw new BrainRotError(
      'FFMPEG_FAILED',
      'The bundled ffmpeg binary is missing.',
      'Reinstall dependencies with `npm install` (ffmpeg-static downloads its binary in a postinstall step).'
    )
  }
  const unpacked = raw.replace(`app.asar${sep()}`, `app.asar.unpacked${sep()}`)
  if (existsSync(unpacked)) return unpacked
  if (existsSync(raw)) return raw
  throw new BrainRotError(
    'FFMPEG_FAILED',
    `The bundled ffmpeg binary was not found at ${raw}.`,
    'Reinstall dependencies with `npm install`, or rebuild the app so ffmpeg-static is unpacked from the asar archive.'
  )
}

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

export interface FfmpegRunResult {
  stderr: string
}

function runFfmpeg(args: string[], onStderr?: (chunk: string) => void): Promise<FfmpegRunResult> {
  const bin = ffmpegPath()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      // ffmpeg is chatty; keep only the tail so an hour-long conversion does not
      // accumulate megabytes of progress lines in memory.
      stderr = (stderr + text).slice(-8000)
      onStderr?.(text)
    })
    child.on('error', (err) => {
      reject(
        new BrainRotError(
          'FFMPEG_FAILED',
          `Could not start ffmpeg (${bin}): ${err.message}`,
          'Check that the bundled ffmpeg binary is executable.'
        )
      )
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr })
      else
        reject(
          new BrainRotError(
            'FFMPEG_FAILED',
            `ffmpeg exited with code ${code}.`,
            stderr.split('\n').slice(-6).join('\n').trim() || undefined
          )
        )
    })
  })
}

/**
 * Converts any audio container to the exact format whisper.cpp wants:
 * 16 kHz, mono, signed 16-bit little-endian PCM in a WAV wrapper.
 */
export async function toWhisperWav(
  inputPath: string,
  outputPath: string,
  onProgress?: (line: string) => void
): Promise<void> {
  if (!existsSync(inputPath)) {
    throw new BrainRotError('FILE_NOT_FOUND', `Audio file not found: ${inputPath}`)
  }
  await runFfmpeg(
    ['-hide_banner', '-loglevel', 'warning', '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath],
    onProgress
  )
}

/** Reads the duration of a media file in seconds. Returns 0 when it cannot be determined. */
export async function probeDurationSec(inputPath: string): Promise<number> {
  try {
    // ffprobe is not shipped by ffmpeg-static, so parse ffmpeg's own summary instead.
    const { stderr } = await runFfmpeg(['-hide_banner', '-i', inputPath, '-f', 'null', '-'])
    const match = /time=(\d+):(\d+):(\d+\.\d+)/g
    let last: RegExpExecArray | null = null
    let m: RegExpExecArray | null
    while ((m = match.exec(stderr)) !== null) last = m
    if (!last) return 0
    const [, h = '0', mi = '0', s = '0'] = last
    return Number(h) * 3600 + Number(mi) * 60 + Number(s)
  } catch (err) {
    console.warn('[brain-rotter] duration probe failed:', err)
    return 0
  }
}

/**
 * Rewrites a MediaRecorder `.webm` into a seekable file. Blobs from MediaRecorder
 * carry no duration in their header, which makes HTML5 seeking unreliable; a
 * stream copy through ffmpeg fixes the cues without re-encoding.
 */
export async function remuxWebm(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(['-hide_banner', '-loglevel', 'warning', '-y', '-i', inputPath, '-c', 'copy', outputPath])
}
