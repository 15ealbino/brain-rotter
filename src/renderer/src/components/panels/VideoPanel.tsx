import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VideoClip } from '@shared/ipc'
import { call, describeError } from '../../lib/api'
import { useAppState } from '../../state/AppState'

/** Fisher-Yates, so the shuffle is uniform and does not repeat the same order. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

/**
 * Plays the user's own video files, muted, in a 9:16 letterboxed frame.
 *
 * Clips come exclusively from a folder the user picks in Settings. Nothing is
 * fetched, scraped or downloaded from any website.
 */
export function VideoPanel(): React.JSX.Element {
  const { settings, goTo } = useAppState()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [clips, setClips] = useState<VideoClip[]>([])
  const [order, setOrder] = useState<number[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [muted, setMuted] = useState(true)

  const folder = settings?.videoFolder ?? ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMediaError(null)
    try {
      const list = await call('video:listClips')
      setClips(list)
      setOrder(shuffle(list.map((_, i) => i)))
      setCursor(0)
    } catch (err) {
      setClips([])
      setOrder([])
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, folder])

  const current = useMemo(() => {
    const idx = order[cursor]
    return idx === undefined ? null : (clips[idx] ?? null)
  }, [clips, order, cursor])

  const advance = useCallback(() => {
    setMediaError(null)
    setCursor((prev) => {
      const next = prev + 1
      if (next < order.length) return next
      // Reshuffle at the end of the deck so the loop never repeats the same run.
      setOrder(shuffle(clips.map((_, i) => i)))
      return 0
    })
  }, [order.length, clips])

  useEffect(() => {
    const el = videoRef.current
    if (!el || !current) return
    el.currentTime = 0
    const attempt = el.play()
    if (attempt) {
      attempt.catch((err: unknown) => {
        // Autoplay is allowed for muted media; a failure here is worth showing.
        setMediaError(`Playback could not start: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }, [current])

  if (!folder) {
    return (
      <div className="panel-empty">
        <h3>Point this at your own clips</h3>
        <p>
          This panel plays videos from a folder on your computer — your own downloads, your own recordings,
          whatever you like. Brain Rotter never fetches video from the internet.
        </p>
        <ol className="how-to">
          <li>Put some .mp4 or .webm files in a folder.</li>
          <li>
            Open <strong>Settings → Brain rot panels → Video clip folder</strong> and choose it.
          </li>
          <li>Come back here — the clips will shuffle and loop automatically.</li>
        </ol>
        <button type="button" className="btn" onClick={() => goTo('settings')}>
          Open Settings
        </button>
      </div>
    )
  }

  if (loading) return <div className="panel-empty muted">Scanning folder…</div>

  if (error) {
    return (
      <div className="panel-empty">
        <h3>That folder could not be read</h3>
        <p className="mono small">{error.message}</p>
        {error.hint && <p className="small muted">{error.hint}</p>}
        <div className="field-row">
          <button type="button" className="btn" onClick={() => void load()}>
            Retry
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => goTo('settings')}>
            Change folder
          </button>
        </div>
      </div>
    )
  }

  if (clips.length === 0) {
    return (
      <div className="panel-empty">
        <h3>No playable clips in that folder</h3>
        <p className="mono small">{folder}</p>
        <p>
          Add some <code>.mp4</code> or <code>.webm</code> files to it, then refresh. Subfolders are not
          scanned.
        </p>
        <div className="field-row">
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => goTo('settings')}>
            Change folder
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="video-panel">
      <div className="video-frame">
        {current && (
          <video
            ref={videoRef}
            key={current.path}
            src={current.url}
            muted={muted}
            autoPlay
            playsInline
            loop={clips.length === 1}
            onEnded={advance}
            onError={() =>
              setMediaError(
                `"${current.name}" could not be decoded. It may be corrupt or use a codec Chromium does not ship.`
              )
            }
          />
        )}
        {mediaError && (
          <div className="video-overlay">
            <p>{mediaError}</p>
            <button type="button" className="btn btn-sm" onClick={advance}>
              Skip to next clip
            </button>
          </div>
        )}
      </div>

      <div className="video-bar">
        <button type="button" className="btn btn-sm btn-ghost" onClick={advance} title="Next clip">
          ⏭
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setMuted((m) => !m)}
          title={muted ? 'Unmute (this will talk over the meeting)' : 'Mute'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <span className="video-name" title={current?.name}>
          {current?.name ?? ''}
        </span>
        <span className="muted small mono">
          {cursor + 1}/{clips.length}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} title="Rescan folder">
          ⟳
        </button>
      </div>
    </div>
  )
}
