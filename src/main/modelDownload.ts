import { promises as fs, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { net } from 'electron'
import type { ModelDownloadProgress, WhisperModelId, WhisperModelInfo } from '@shared/types'
import { BrainRotError } from './errors'
import { modelsDir } from './settings'
import { modelExists, modelFileName, modelPath } from './whisper'

/**
 * Official GGML weights published by the whisper.cpp author. Nothing else is ever
 * fetched by this app, and the download only happens when the user asks for it.
 */
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const MODEL_CATALOG: Omit<WhisperModelInfo, 'downloaded'>[] = [
  { id: 'tiny.en', fileName: 'ggml-tiny.en.bin', approxSizeMb: 75, description: 'Fastest, roughest. Fine for a quick skim.' },
  { id: 'base.en', fileName: 'ggml-base.en.bin', approxSizeMb: 142, description: 'Default. Good accuracy/speed balance for meetings.' },
  { id: 'small.en', fileName: 'ggml-small.en.bin', approxSizeMb: 466, description: 'Noticeably better on crosstalk and accents. ~3x slower.' },
  { id: 'medium.en', fileName: 'ggml-medium.en.bin', approxSizeMb: 1500, description: 'Best quality here. Slow without a GPU build.' }
]

export function modelUrl(model: WhisperModelId): string {
  return `${HF_BASE}/${modelFileName(model)}`
}

export async function listModels(): Promise<WhisperModelInfo[]> {
  return Promise.all(
    MODEL_CATALOG.map(async (m) => ({ ...m, downloaded: await modelExists(m.id) }))
  )
}

type ProgressSink = (p: ModelDownloadProgress) => void

let activeController: AbortController | null = null

export function cancelDownload(): void {
  activeController?.abort()
  activeController = null
}

/**
 * Downloads a GGML model to a `.part` file and renames it into place only on
 * success, so an interrupted download can never masquerade as a usable model.
 */
export async function downloadModel(model: WhisperModelId, onProgress: ProgressSink): Promise<void> {
  if (await modelExists(model)) {
    onProgress({ model, receivedBytes: 0, totalBytes: 0, ratio: 1, state: 'done' })
    return
  }

  await fs.mkdir(modelsDir(), { recursive: true })
  const dest = modelPath(model)
  const partial = `${dest}.part`
  const controller = new AbortController()
  activeController = controller

  try {
    const response = await net.fetch(modelUrl(model), {
      signal: controller.signal,
      redirect: 'follow'
    })

    if (!response.ok) {
      throw new BrainRotError(
        'MODEL_DOWNLOAD_FAILED',
        `Model download failed: HTTP ${response.status} ${response.statusText}.`,
        `Tried ${modelUrl(model)}. Check your internet connection or download the file manually into ${modelsDir()}.`
      )
    }
    if (!response.body) {
      throw new BrainRotError('MODEL_DOWNLOAD_FAILED', 'The server returned an empty response body.')
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let received = 0
    let lastEmit = 0

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      // Throttle so a 1.5 GB download does not flood the renderer with IPC.
      if (now - lastEmit > 120) {
        lastEmit = now
        onProgress({
          model,
          receivedBytes: received,
          totalBytes,
          ratio: totalBytes > 0 ? received / totalBytes : -1,
          state: 'downloading'
        })
      }
    })

    await pipeline(source, createWriteStream(partial))

    const stat = await fs.stat(partial)
    if (stat.size < 1_000_000) {
      throw new BrainRotError(
        'MODEL_DOWNLOAD_FAILED',
        `The downloaded file is only ${stat.size} bytes, which is not a valid model.`,
        'The mirror may have returned an error page. Try again.'
      )
    }

    await fs.rename(partial, dest)
    onProgress({ model, receivedBytes: stat.size, totalBytes: stat.size, ratio: 1, state: 'done' })
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => undefined)
    const aborted = controller.signal.aborted
    const message = aborted
      ? 'Model download cancelled.'
      : err instanceof BrainRotError
        ? err.message
        : `Model download failed: ${err instanceof Error ? err.message : String(err)}`
    onProgress({ model, receivedBytes: 0, totalBytes: 0, ratio: 0, state: 'error', message })
    if (aborted) return
    if (err instanceof BrainRotError) throw err
    throw new BrainRotError(
      'MODEL_DOWNLOAD_FAILED',
      message,
      `You can also download ${modelUrl(model)} by hand and drop it in ${modelsDir()}.`
    )
  } finally {
    if (activeController === controller) activeController = null
  }
}
