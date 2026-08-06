import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, resolve, sep } from 'node:path'
import { readSettings, storageRoot } from './settings'

/**
 * `media://` serves local audio/video to the renderer.
 *
 * The renderer runs with `contextIsolation` and no node access, so it cannot read
 * files itself, and `file://` URLs are blocked from a custom-origin page. This
 * scheme bridges the gap while keeping an explicit allow-list: only files under the
 * storage root or the user's configured video folder are ever served.
 *
 * Range requests are handled by hand because <audio>/<video> seeking depends on
 * 206 responses with a correct Content-Range header.
 */

export const MEDIA_SCHEME = 'media'

const MIME_BY_EXT: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg'
}

/** Encodes an absolute path into a `media://` URL. */
export function toMediaUrl(absolutePath: string): string {
  return `${MEDIA_SCHEME}://f/${encodeURIComponent(absolutePath)}`
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

function isInside(child: string, parent: string): boolean {
  if (!parent) return false
  const a = resolve(child)
  const b = resolve(parent)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

async function allowedRoots(): Promise<string[]> {
  const settings = await readSettings()
  const roots = [await storageRoot()]
  if (settings.videoFolder) roots.push(settings.videoFolder)
  return roots
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export function installMediaProtocolHandler(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let filePath: string
    try {
      const url = new URL(request.url)
      filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    } catch {
      return text(400, 'Malformed media URL.')
    }
    if (!filePath) return text(400, 'Missing media path.')

    const roots = await allowedRoots()
    if (!roots.some((root) => isInside(filePath, root))) {
      console.warn('[brain-rotter] blocked media request outside allowed roots:', filePath)
      return text(403, 'That file is outside the folders this app is allowed to read.')
    }

    let size: number
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return text(404, 'Not a file.')
      size = stat.size
    } catch {
      return text(404, 'The media file no longer exists on disk.')
    }

    const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const rangeHeader = request.headers.get('range')

    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (m) {
        const [, rawStart = '', rawEnd = ''] = m
        let start: number
        let end: number
        if (rawStart === '') {
          // suffix range: last N bytes
          const suffix = Number(rawEnd || 0)
          start = Math.max(0, size - suffix)
          end = size - 1
        } else {
          start = Number(rawStart)
          end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
        }
        const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
        return new Response(stream, {
          status: 206,
          headers: {
            'content-type': mime,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store'
          }
        })
      }
    }

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      }
    })
  })
}
