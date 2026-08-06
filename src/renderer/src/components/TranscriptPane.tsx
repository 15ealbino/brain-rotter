import { useEffect, useMemo, useRef, useState } from 'react'
import type { RecordingMeta, Transcript, TranscriptionProgress } from '@shared/types'
import { formatTime } from '../lib/format'

interface Props {
  recording: RecordingMeta
  transcript: Transcript | null
  currentTime: number
  progress: TranscriptionProgress | undefined
  onSeek: (seconds: number) => void
  onTranscribe: () => void
  onCancelTranscribe: () => void
  whisperAvailable: boolean
}

export function TranscriptPane({
  recording,
  transcript,
  currentTime,
  progress,
  onSeek,
  onTranscribe,
  onCancelTranscribe,
  whisperAvailable
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef<HTMLOListElement>(null)
  const activeRef = useRef<HTMLLIElement>(null)

  // Stabilise the identity so the memos below do not recompute every render.
  const segments = useMemo(() => transcript?.segments ?? [], [transcript])

  const activeIndex = useMemo(() => {
    if (segments.length === 0) return -1
    // Binary search for the segment containing `currentTime`.
    let lo = 0
    let hi = segments.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const seg = segments[mid]
      if (!seg) break
      if (currentTime < seg.start) {
        hi = mid - 1
      } else {
        best = mid
        lo = mid + 1
      }
    }
    return best
  }, [segments, currentTime])

  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return null
    return new Set(
      segments.reduce<number[]>((acc, seg, i) => {
        if (seg.text.toLowerCase().includes(needle)) acc.push(i)
        return acc
      }, [])
    )
  }, [segments, needle])

  const visible = useMemo(() => {
    if (!matches) return segments.map((seg, i) => ({ seg, i }))
    return segments.map((seg, i) => ({ seg, i })).filter(({ i }) => matches.has(i))
  }, [segments, matches])

  useEffect(() => {
    if (!autoScroll || needle) return
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeIndex, autoScroll, needle])

  const status = progress?.state ?? recording.transcription

  return (
    <div className="transcript-pane">
      <div className="transcript-head">
        <div className="transcript-title">
          <h2 title={recording.title}>{recording.title}</h2>
          <span className="muted small mono">{formatTime(recording.durationSec)}</span>
        </div>
        <div className="transcript-tools">
          <input
            type="search"
            className="search-input"
            placeholder="Search the transcript…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={segments.length === 0}
          />
          <label className="checkbox small">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            <span>Follow</span>
          </label>
        </div>
        {needle && (
          <p className="muted small">
            {visible.length} matching segment{visible.length === 1 ? '' : 's'} — click one to jump there.
          </p>
        )}
      </div>

      {status === 'running' && (
        <div className="notice notice-info transcript-notice">
          <strong>Transcribing…</strong>
          <p className="small">{progress?.message ?? 'Working.'}</p>
          {progress && progress.ratio >= 0 && (
            <div className="progress">
              <div className="progress-fill" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
            </div>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelTranscribe}>
            Cancel
          </button>
        </div>
      )}

      {segments.length === 0 && status !== 'running' && (
        <div className="panel-empty">
          {status === 'error' ? (
            <>
              <h3>Transcription failed</h3>
              <p className="mono small">{recording.transcriptionError ?? progress?.message}</p>
            </>
          ) : (
            <>
              <h3>No transcript yet</h3>
              <p className="muted">
                Run whisper.cpp over this recording to get a synced, clickable transcript.
              </p>
            </>
          )}
          <button type="button" className="btn" onClick={onTranscribe} disabled={!whisperAvailable}>
            {status === 'error' ? 'Try again' : 'Transcribe now'}
          </button>
          {!whisperAvailable && (
            <p className="small muted">whisper.cpp is not set up yet — see Settings.</p>
          )}
        </div>
      )}

      <ol className="transcript-list" ref={listRef}>
        {visible.map(({ seg, i }) => {
          const isActive = i === activeIndex
          return (
            <li
              key={`${i}-${seg.start}`}
              ref={isActive ? activeRef : undefined}
              className={`segment${isActive ? ' is-active' : ''}`}
            >
              <button type="button" className="segment-btn" onClick={() => onSeek(seg.start)}>
                <span className="segment-time mono">{formatTime(seg.start)}</span>
                <span className="segment-text">{highlight(seg.text, needle)}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Wraps every case-insensitive occurrence of `needle` in a <mark>. */
function highlight(text: string, needle: string): React.ReactNode {
  if (!needle) return text
  const lower = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  let at = lower.indexOf(needle)
  let key = 0
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={key++}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}
