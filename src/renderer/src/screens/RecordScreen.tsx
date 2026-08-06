import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureSource } from '@shared/types'
import { call, platform } from '../lib/api'
import { MeetingRecorder, RecorderError } from '../lib/recorder'
import { formatTime } from '../lib/format'
import { useAppState } from '../state/AppState'

type Stage = 'idle' | 'starting' | 'recording' | 'saving'

export function RecordScreen(): React.JSX.Element {
  const { pushToast, reportError, goTo, openRecording, whisper, models, settings } = useAppState()

  const recorderRef = useRef<MeetingRecorder | null>(null)
  const rafRef = useRef(0)

  const [stage, setStage] = useState<Stage>('idle')
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [wantSystemAudio, setWantSystemAudio] = useState(true)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState<string>('')
  const [title, setTitle] = useState('')
  const [autoTranscribe, setAutoTranscribe] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [paused, setPaused] = useState(false)
  const [liveWarnings, setLiveWarnings] = useState<string[]>([])

  const isLinux = platform() === 'linux'
  const modelReady = models.some((m) => m.id === settings?.whisperModel && m.downloaded)
  const whisperReady = Boolean(whisper?.binaryPath) && modelReady

  /* --------------------------- device discovery --------------------------- */

  const loadSources = useCallback(async () => {
    setSourcesError(null)
    try {
      const list = await call('capture:listSources')
      setSources(list)
      setSelectedSource((prev) => prev ?? list.find((s) => s.type === 'screen')?.id ?? list[0]?.id ?? null)
    } catch (err) {
      setSources([])
      setSourcesError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadMics = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setMics(devices.filter((d) => d.kind === 'audioinput'))
    } catch (err) {
      console.error('[brain-rotter] enumerateDevices failed:', err)
      setMics([])
    }
  }, [])

  useEffect(() => {
    void loadSources()
    void loadMics()
    const onChange = (): void => void loadMics()
    navigator.mediaDevices.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', onChange)
  }, [loadSources, loadMics])

  useEffect(() => {
    void call('capture:selectSource', selectedSource).catch(() => undefined)
  }, [selectedSource])

  /* ------------------------------ meter loop ------------------------------ */

  useEffect(() => {
    if (stage !== 'recording') return
    const tick = (): void => {
      const rec = recorderRef.current
      if (rec) {
        setElapsed(rec.elapsedSec())
        setLevel(rec.level())
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [stage])

  // Never leave a recorder running when the screen goes away.
  useEffect(() => {
    return () => {
      void recorderRef.current?.abort()
      recorderRef.current = null
    }
  }, [])

  /* ------------------------------- actions -------------------------------- */

  async function handleStart(): Promise<void> {
    if (stage !== 'idle') return
    setStage('starting')
    setLiveWarnings([])
    const recorder = new MeetingRecorder()
    recorderRef.current = recorder
    try {
      const result = await recorder.start(
        micId ? { wantSystemAudio, micDeviceId: micId } : { wantSystemAudio }
      )
      setLiveWarnings(result.warnings)
      for (const warning of result.warnings) {
        pushToast({ kind: 'warning', title: 'Recording with reduced input', message: warning })
      }
      setStage('recording')
      setPaused(false)
      // Refresh labels — they are only populated once permission has been granted.
      void loadMics()
    } catch (err) {
      recorderRef.current = null
      setStage('idle')
      if (err instanceof RecorderError) {
        pushToast(
          err.hint
            ? { kind: 'error', title: 'Could not start recording', message: err.message, hint: err.hint }
            : { kind: 'error', title: 'Could not start recording', message: err.message }
        )
      } else {
        reportError('Could not start recording', err)
      }
    }
  }

  async function handleStop(): Promise<void> {
    const recorder = recorderRef.current
    if (!recorder || stage !== 'recording') return
    setStage('saving')
    try {
      const result = await recorder.stop()
      recorderRef.current = null

      if (result.blob.size === 0) {
        throw new Error('The recording came out empty — no audio data was captured.')
      }

      const meta = await call('recordings:save', {
        title,
        data: await result.blob.arrayBuffer(),
        mimeType: result.mimeType,
        durationSec: result.durationSec,
        capturedSystemAudio: result.capturedSystemAudio,
        capturedMicrophone: result.capturedMicrophone,
        autoTranscribe: autoTranscribe && whisperReady
      })

      setTitle('')
      setElapsed(0)
      setLevel(0)
      setStage('idle')
      pushToast({
        kind: 'success',
        title: 'Recording saved',
        message: `${meta.title} · ${formatTime(meta.durationSec)}${
          autoTranscribe && whisperReady ? ' · transcribing in the background' : ''
        }`
      })
      openRecording(meta.id)
    } catch (err) {
      setStage('idle')
      recorderRef.current = null
      reportError('Could not save the recording', err)
    }
  }

  async function handleDiscard(): Promise<void> {
    await recorderRef.current?.abort()
    recorderRef.current = null
    setStage('idle')
    setElapsed(0)
    setLevel(0)
    setPaused(false)
    pushToast({ kind: 'info', title: 'Recording discarded' })
  }

  function togglePause(): void {
    const recorder = recorderRef.current
    if (!recorder) return
    if (recorder.isPaused) {
      recorder.resume()
      setPaused(false)
    } else {
      recorder.pause()
      setPaused(true)
    }
  }

  /* -------------------------------- render -------------------------------- */

  const busy = stage === 'starting' || stage === 'saving'

  return (
    <div className="record-screen">
      <div className="record-main">
        <section className="card">
          <h2>Record a meeting</h2>
          <p className="muted">
            Audio is mixed from your system output and your microphone, stored on this machine, and
            transcribed locally. Nothing is uploaded anywhere.
          </p>

          <label className="field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              placeholder="e.g. Weekly platform sync"
              onChange={(e) => setTitle(e.target.value)}
              disabled={stage === 'recording' || busy}
            />
          </label>

          <div className="field-row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={wantSystemAudio}
                onChange={(e) => setWantSystemAudio(e.target.checked)}
                disabled={stage !== 'idle'}
              />
              <span>Capture system audio (the other participants)</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={autoTranscribe}
                onChange={(e) => setAutoTranscribe(e.target.checked)}
                disabled={stage !== 'idle'}
              />
              <span>Transcribe when I stop</span>
            </label>
          </div>

          <label className="field">
            <span>Microphone</span>
            <select value={micId} onChange={(e) => setMicId(e.target.value)} disabled={stage !== 'idle'}>
              <option value="">System default</option>
              {mics.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          </label>

          {!whisperReady && (
            <div className="notice notice-warn">
              <strong>Transcription is not ready.</strong>{' '}
              {!whisper?.binaryPath
                ? 'No whisper.cpp binary was found.'
                : `The ${settings?.whisperModel} model has not been downloaded.`}{' '}
              You can still record now and transcribe later.{' '}
              <button type="button" className="link" onClick={() => goTo('settings')}>
                Open Settings
              </button>
            </div>
          )}

          <div className="record-controls">
            {stage === 'recording' ? (
              <>
                <button type="button" className="btn btn-danger btn-lg" onClick={() => void handleStop()}>
                  ■ Stop &amp; save
                </button>
                <button type="button" className="btn" onClick={togglePause}>
                  {paused ? '▶ Resume' : '❚❚ Pause'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void handleDiscard()}>
                  Discard
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-record btn-lg"
                onClick={() => void handleStart()}
                disabled={busy}
              >
                {stage === 'starting' ? 'Starting…' : stage === 'saving' ? 'Saving…' : '● Start recording'}
              </button>
            )}
          </div>

          <div className={`meter-row${stage === 'recording' ? ' is-live' : ''}`}>
            <div className="timer mono">
              {formatTime(elapsed)}
              {paused && <span className="paused-tag">paused</span>}
            </div>
            <div className="level-meter" aria-label="Input level">
              <div className="level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
              <div className="level-ticks" aria-hidden="true" />
            </div>
          </div>

          {liveWarnings.length > 0 && (
            <ul className="warning-list">
              {liveWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="record-side">
        <section className="card">
          <div className="card-head">
            <h3>System audio source</h3>
            <button type="button" className="btn btn-sm" onClick={() => void loadSources()}>
              Refresh
            </button>
          </div>

          {isLinux && (
            <p className="muted small">
              On Linux this goes through PipeWire and your desktop&rsquo;s screen-share portal. When you
              start recording, your desktop will show its own picker — choose the window or screen and
              tick &ldquo;share audio&rdquo; if it is offered.
            </p>
          )}

          {sourcesError ? (
            <div className="notice notice-error">
              <strong>Could not list capture sources.</strong>
              <p className="mono small">{sourcesError}</p>
              <p>You can still record microphone-only audio.</p>
            </div>
          ) : sources.length === 0 ? (
            <p className="muted small">No capture sources were reported.</p>
          ) : (
            <ul className="source-list">
              {sources.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`source-btn${selectedSource === s.id ? ' is-selected' : ''}`}
                    onClick={() => setSelectedSource(s.id)}
                    disabled={stage !== 'idle'}
                  >
                    {s.thumbnailDataUrl ? (
                      <img src={s.thumbnailDataUrl} alt="" />
                    ) : (
                      <span className="thumb-placeholder" aria-hidden="true">
                        {s.type === 'screen' ? '🖵' : '▭'}
                      </span>
                    )}
                    <span className="source-name" title={s.name}>
                      {s.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  )
}
