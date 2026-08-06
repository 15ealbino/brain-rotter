import { useCallback, useEffect, useRef, useState } from 'react'
import type { RecordingMeta, Transcript } from '@shared/types'
import { call, describeError } from '../lib/api'
import { formatTime } from '../lib/format'
import { useAppState } from '../state/AppState'
import { SplitPane } from '../components/SplitPane'
import { TranscriptPane } from '../components/TranscriptPane'
import { BrainRotPane } from '../components/BrainRotPane'

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]

export function PlaybackScreen(): React.JSX.Element {
  const {
    recordings,
    openRecordingId,
    openRecording,
    settings,
    saveSettings,
    transcriptionProgress,
    whisper,
    reportError,
    goTo
  } = useAppState()

  const audioRef = useRef<HTMLAudioElement>(null)
  const [recording, setRecording] = useState<RecordingMeta | null>(null)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loadError, setLoadError] = useState<{ message: string; hint?: string } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [ratio, setRatio] = useState(settings?.splitRatio ?? 0.5)

  const id = openRecordingId ?? recordings[0]?.id ?? null
  const progress = id ? transcriptionProgress[id] : undefined
  const whisperAvailable = Boolean(whisper?.binaryPath)

  /* ------------------------------ data load ------------------------------ */

  const loadTranscript = useCallback(async (recordingId: string) => {
    try {
      setTranscript(await call('recordings:getTranscript', recordingId))
    } catch (err) {
      console.error('[brain-rotter] transcript load failed:', err)
      setTranscript(null)
    }
  }, [])

  useEffect(() => {
    if (!id) {
      setRecording(null)
      setMediaUrl(null)
      setTranscript(null)
      return
    }
    let cancelled = false
    setLoadError(null)
    setMediaUrl(null)
    setTranscript(null)
    setCurrentTime(0)
    setPlaying(false)

    void (async () => {
      const meta = recordings.find((r) => r.id === id) ?? null
      if (!cancelled) setRecording(meta)
      try {
        const media = await call('recordings:getMedia', id)
        if (!cancelled) setMediaUrl(media.url)
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err))
      }
      await loadTranscript(id)
    })()

    return () => {
      cancelled = true
    }
  }, [id, recordings, loadTranscript])

  // Reload the transcript the moment a background run finishes.
  useEffect(() => {
    if (id && progress?.state === 'done') void loadTranscript(id)
  }, [id, progress?.state, loadTranscript])

  /* ------------------------------- controls ------------------------------ */

  const seek = useCallback((seconds: number) => {
    const el = audioRef.current
    if (!el) return
    el.currentTime = Math.max(0, seconds)
    setCurrentTime(el.currentTime)
  }, [])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      el.play().catch((err: unknown) => reportError('Playback failed', err))
    } else {
      el.pause()
    }
  }, [reportError])

  useEffect(() => {
    const el = audioRef.current
    if (el) el.playbackRate = rate
  }, [rate, mediaUrl])

  // Space toggles playback unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (target?.tagName === 'CANVAS') return // the games own the keyboard while focused
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'ArrowLeft' && e.altKey) {
        e.preventDefault()
        seek(currentTime - 5)
      } else if (e.code === 'ArrowRight' && e.altKey) {
        e.preventDefault()
        seek(currentTime + 5)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seek, currentTime])

  /* -------------------------------- render ------------------------------- */

  if (!id || !recording) {
    return (
      <div className="centered empty-state">
        <h2>Nothing open</h2>
        <p className="muted">Pick a recording from the library to play it back.</p>
        <button type="button" className="btn" onClick={() => goTo('library')}>
          Open the library
        </button>
      </div>
    )
  }

  const totalDuration = duration || recording.durationSec || 0

  const player = (
    <div className="player">
      <div className="player-row">
        <button
          type="button"
          className="btn btn-play"
          onClick={togglePlay}
          disabled={!mediaUrl}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="mono time-current">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="seek"
          min={0}
          max={Math.max(totalDuration, 0.01)}
          step={0.01}
          value={Math.min(currentTime, totalDuration)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!mediaUrl}
          aria-label="Seek"
        />
        <span className="mono muted time-total">{formatTime(totalDuration)}</span>
        <select
          className="rate-select"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          aria-label="Playback speed"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>

      {loadError && (
        <div className="notice notice-error">
          <strong>The audio for this recording could not be opened.</strong>
          <p className="small mono">{loadError.message}</p>
          {loadError.hint && <p className="small muted">{loadError.hint}</p>}
          <button type="button" className="btn btn-sm" onClick={() => goTo('library')}>
            Back to the library
          </button>
        </div>
      )}

      {mediaUrl && (
        <audio
          ref={audioRef}
          src={mediaUrl}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d) && d > 0) setDuration(d)
          }}
          onEnded={() => setPlaying(false)}
          onError={() =>
            setLoadError({
              message: 'The browser engine could not decode this audio file.',
              hint: 'The file may be truncated or corrupt. Try re-recording, or check the file with a media player.'
            })
          }
        />
      )}
    </div>
  )

  const left = (
    <div className="left-pane">
      {player}
      <TranscriptPane
        recording={recording}
        transcript={transcript}
        currentTime={currentTime}
        progress={progress}
        onSeek={seek}
        onTranscribe={() => void call('transcribe:start', recording.id).catch((e) => reportError('Could not start transcription', e))}
        onCancelTranscribe={() => void call('transcribe:cancel', recording.id)}
        whisperAvailable={whisperAvailable}
      />
      {recordings.length > 1 && (
        <div className="pane-footer">
          <label className="field-inline">
            <span className="muted small">Recording</span>
            <select value={recording.id} onChange={(e) => openRecording(e.target.value)}>
              {recordings.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )

  return (
    <SplitPane
      direction="horizontal"
      ratio={ratio}
      onRatioChange={setRatio}
      onRatioCommit={(r) => void saveSettings({ splitRatio: r })}
      className="playback-split"
      first={left}
      second={<BrainRotPane />}
    />
  )
}
