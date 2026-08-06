import { useState } from 'react'
import type { RecordingMeta, TranscriptionStatus } from '@shared/types'
import { call } from '../lib/api'
import { formatBytes, formatDate, formatTime } from '../lib/format'
import { useAppState } from '../state/AppState'

const STATUS_LABEL: Record<TranscriptionStatus, string> = {
  none: 'Not transcribed',
  pending: 'Queued',
  running: 'Transcribing…',
  done: 'Transcribed',
  error: 'Failed'
}

export function LibraryScreen(): React.JSX.Element {
  const { recordings, openRecording, reportError, pushToast, transcriptionProgress, goTo, whisper } =
    useAppState()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? recordings.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))
    : recordings

  async function handleDelete(rec: RecordingMeta): Promise<void> {
    if (!window.confirm(`Delete "${rec.title}" and its transcript? This cannot be undone.`)) return
    try {
      await call('recordings:delete', rec.id)
      pushToast({ kind: 'info', title: 'Recording deleted', message: rec.title })
    } catch (err) {
      reportError('Could not delete the recording', err)
    }
  }

  async function commitRename(rec: RecordingMeta): Promise<void> {
    const next = draftTitle.trim()
    setRenaming(null)
    if (!next || next === rec.title) return
    try {
      await call('recordings:rename', rec.id, next)
    } catch (err) {
      reportError('Could not rename the recording', err)
    }
  }

  async function handleTranscribe(rec: RecordingMeta): Promise<void> {
    if (!whisper?.binaryPath) {
      pushToast({
        kind: 'error',
        title: 'whisper.cpp is not set up',
        message: 'No whisper.cpp binary was found on this machine.',
        hint: whisper?.installHint
      })
      goTo('settings')
      return
    }
    try {
      await call('transcribe:start', rec.id)
      pushToast({ kind: 'info', title: 'Transcription started', message: rec.title })
    } catch (err) {
      reportError('Could not start transcription', err)
    }
  }

  if (recordings.length === 0) {
    return (
      <div className="centered empty-state">
        <h2>No recordings yet</h2>
        <p className="muted">Head to the Record screen to capture your first meeting.</p>
        <button type="button" className="btn btn-record" onClick={() => goTo('record')}>
          ● Go to Record
        </button>
      </div>
    )
  }

  return (
    <div className="library-screen">
      <div className="library-head">
        <h2>Library</h2>
        <input
          type="search"
          className="search-input"
          placeholder="Filter by title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table className="library-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Recorded</th>
              <th>Length</th>
              <th>Size</th>
              <th>Transcript</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((rec) => {
              const progress = transcriptionProgress[rec.id]
              const status = progress?.state ?? rec.transcription
              return (
                <tr key={rec.id}>
                  <td>
                    {renaming === rec.id ? (
                      <input
                        type="text"
                        autoFocus
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onBlur={() => void commitRename(rec)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(rec)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="link title-link"
                        onClick={() => openRecording(rec.id)}
                        onDoubleClick={() => {
                          setRenaming(rec.id)
                          setDraftTitle(rec.title)
                        }}
                        title="Click to open, double-click to rename"
                      >
                        {rec.title}
                      </button>
                    )}
                    {!rec.capturedSystemAudio && (
                      <span className="chip chip-warn" title="System audio was not captured">
                        mic only
                      </span>
                    )}
                  </td>
                  <td className="muted">{formatDate(rec.createdAt)}</td>
                  <td className="mono">{formatTime(rec.durationSec)}</td>
                  <td className="mono muted">{formatBytes(rec.sizeBytes)}</td>
                  <td>
                    <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
                    {status === 'running' && progress && (
                      <div className="mini-progress" title={progress.message}>
                        <div
                          className="mini-progress-fill"
                          style={{
                            width: progress.ratio >= 0 ? `${Math.round(progress.ratio * 100)}%` : '100%',
                            opacity: progress.ratio >= 0 ? 1 : 0.45
                          }}
                        />
                      </div>
                    )}
                    {status === 'error' && rec.transcriptionError && (
                      <p className="small error-text">{rec.transcriptionError}</p>
                    )}
                  </td>
                  <td className="row-actions">
                    <button type="button" className="btn btn-sm" onClick={() => openRecording(rec.id)}>
                      Open
                    </button>
                    {status === 'running' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => void call('transcribe:cancel', rec.id)}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => void handleTranscribe(rec)}
                      >
                        {status === 'done' ? 'Re-transcribe' : 'Transcribe'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void call('recordings:revealInFolder', rec.id)}
                      title="Show the files on disk"
                    >
                      Reveal
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost"
                      onClick={() => void handleDelete(rec)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="muted centered">Nothing matches &ldquo;{query}&rdquo;.</p>}
      </div>
    </div>
  )
}
