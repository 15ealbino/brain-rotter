import { useEffect, useState } from 'react'
import type { BrainRotPanelId, StorageInfo, WhisperModelId } from '@shared/types'
import { call, tryCall } from '../lib/api'
import { formatBytes } from '../lib/format'
import { useAppState } from '../state/AppState'
import { PANEL_LABELS } from '../components/panels/registry'

const PANEL_IDS: BrainRotPanelId[] = ['video', 'flappy', 'webview', 'runner', 'smash']

export function SettingsScreen(): React.JSX.Element {
  const { settings, saveSettings, whisper, models, modelProgress, refreshWhisper, reportError, pushToast } =
    useAppState()

  const [urlDraft, setUrlDraft] = useState(settings?.webviewUrl ?? '')
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [versions, setVersions] = useState<{ app: string; electron: string; chrome: string; node: string } | null>(
    null
  )

  useEffect(() => setUrlDraft(settings?.webviewUrl ?? ''), [settings?.webviewUrl])

  useEffect(() => {
    void (async () => {
      setStorage(await tryCall('storage:info'))
      setVersions(await tryCall('app:getVersions'))
    })()
  }, [settings?.storageRoot])

  if (!settings) return <div className="centered muted">Loading settings…</div>

  async function pick(channel: 'settings:pickVideoFolder' | 'settings:pickStorageRoot' | 'settings:pickWhisperBinary'): Promise<void> {
    try {
      const chosen = await call(channel)
      if (chosen) {
        await saveSettings({})
        await refreshWhisper()
        setStorage(await tryCall('storage:info'))
      }
    } catch (err) {
      reportError('Could not update that path', err)
    }
  }

  function commitUrl(): void {
    const raw = urlDraft.trim()
    if (!raw) {
      void saveSettings({ webviewUrl: '' })
      return
    }
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    try {
      const parsed = new URL(withScheme)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad scheme')
      setUrlDraft(parsed.toString())
      void saveSettings({ webviewUrl: parsed.toString() })
    } catch {
      pushToast({
        kind: 'error',
        title: 'That is not a valid URL',
        message: `"${raw}" could not be parsed. Use something like https://example.com.`
      })
    }
  }

  async function togglePanel(id: BrainRotPanelId): Promise<void> {
    const current = settings?.brainRotPanels ?? []
    let next: BrainRotPanelId[]
    if (current.includes(id)) {
      next = current.filter((p) => p !== id)
      if (next.length === 0) return // always keep at least one
    } else {
      next = current.length >= 2 ? [current[1] as BrainRotPanelId, id] : [...current, id]
    }
    await saveSettings({ brainRotPanels: next })
  }

  const activeModel = models.find((m) => m.id === settings.whisperModel)

  return (
    <div className="settings-screen">
      <section className="card">
        <h2>Transcription</h2>

        <div className={`notice ${whisper?.binaryPath ? 'notice-ok' : 'notice-error'}`}>
          {whisper?.binaryPath ? (
            <>
              <strong>whisper.cpp found</strong>
              <p className="mono small">{whisper.binaryPath}</p>
              <p className="small muted">Located via: {whisper.source}</p>
            </>
          ) : (
            <>
              <strong>whisper.cpp was not found.</strong>
              <p>Transcription is disabled until a binary is available. Recording still works.</p>
              <p className="small">{whisper?.installHint}</p>
            </>
          )}
        </div>

        <div className="field-row">
          <button type="button" className="btn" onClick={() => void pick('settings:pickWhisperBinary')}>
            Choose whisper.cpp binary…
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void refreshWhisper()}>
            Re-detect
          </button>
          {settings.whisperBinaryPath && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void saveSettings({ whisperBinaryPath: '' })}
            >
              Clear override
            </button>
          )}
        </div>

        <h3>Model</h3>
        <p className="muted small">
          Models are downloaded from the official whisper.cpp weights on Hugging Face and stored on this
          machine. Your audio never leaves your computer.
        </p>

        <ul className="model-list">
          {models.map((m) => {
            const selected = m.id === settings.whisperModel
            const downloading = modelProgress?.model === m.id && modelProgress.state === 'downloading'
            return (
              <li key={m.id} className={selected ? 'is-selected' : ''}>
                <label className="model-row">
                  <input
                    type="radio"
                    name="whisper-model"
                    checked={selected}
                    onChange={() => void saveSettings({ whisperModel: m.id as WhisperModelId })}
                  />
                  <span className="model-name">{m.id}</span>
                  <span className="muted small model-desc">{m.description}</span>
                  <span className="mono small muted">~{m.approxSizeMb} MB</span>
                  {m.downloaded ? (
                    <span className="chip chip-ok">downloaded</span>
                  ) : downloading ? (
                    <span className="chip">
                      {modelProgress.ratio >= 0
                        ? `${Math.round(modelProgress.ratio * 100)}%`
                        : formatBytes(modelProgress.receivedBytes)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void call('whisper:downloadModel', m.id).catch((e) => reportError('Download failed', e))}
                      disabled={Boolean(modelProgress)}
                    >
                      Download
                    </button>
                  )}
                </label>
                {downloading && (
                  <div className="progress">
                    <div
                      className="progress-fill"
                      style={{
                        width:
                          modelProgress.ratio >= 0 ? `${Math.round(modelProgress.ratio * 100)}%` : '100%',
                        opacity: modelProgress.ratio >= 0 ? 1 : 0.5
                      }}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {modelProgress?.state === 'downloading' && (
          <div className="field-row">
            <span className="muted small">
              Downloading {modelProgress.model} — {formatBytes(modelProgress.receivedBytes)}
              {modelProgress.totalBytes > 0 ? ` of ${formatBytes(modelProgress.totalBytes)}` : ''}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void call('whisper:cancelDownload')}>
              Cancel
            </button>
          </div>
        )}

        {activeModel && !activeModel.downloaded && (
          <p className="small error-text">
            The selected model ({activeModel.id}) is not downloaded yet, so transcription will fail until you
            download it.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Brain rot panels</h2>
        <p className="muted small">
          Pick one or two panels for the right-hand pane. With two selected the pane splits top/bottom.
        </p>
        <div className="panel-picker">
          {PANEL_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`panel-chip${settings.brainRotPanels.includes(id) ? ' is-on' : ''}`}
              onClick={() => void togglePanel(id)}
            >
              {PANEL_LABELS[id]}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Video clip folder</span>
          <div className="path-row">
            <input type="text" readOnly value={settings.videoFolder || 'Not set'} className="mono" />
            <button type="button" className="btn" onClick={() => void pick('settings:pickVideoFolder')}>
              Browse…
            </button>
            {settings.videoFolder && (
              <button type="button" className="btn btn-ghost" onClick={() => void saveSettings({ videoFolder: '' })}>
                Clear
              </button>
            )}
          </div>
        </label>
        <p className="muted small">
          The video panel shuffles the <code>.mp4</code> / <code>.webm</code> files you put in this folder.
          Brain Rotter never downloads video from anywhere — supply your own clips.
        </p>

        <label className="field">
          <span>Webview URL</span>
          <div className="path-row">
            <input
              type="url"
              value={urlDraft}
              placeholder="https://example.com"
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitUrl()
              }}
            />
            <button type="button" className="btn" onClick={commitUrl}>
              Save
            </button>
            {settings.webviewUrl && (
              <button type="button" className="btn btn-ghost" onClick={() => void saveSettings({ webviewUrl: '' })}>
                Clear
              </button>
            )}
          </div>
        </label>
        <p className="muted small">
          The URL panel simply renders the page you type here. It does not scrape, download or automate any
          site. Many sites (including most large social platforms) refuse to be embedded — the panel will say
          so and offer to open the page in your normal browser instead.
        </p>
      </section>

      <section className="card">
        <h2>Storage</h2>
        <label className="field">
          <span>Recordings folder</span>
          <div className="path-row">
            <input type="text" readOnly className="mono" value={storage?.storageRoot ?? '…'} />
            <button type="button" className="btn" onClick={() => void pick('settings:pickStorageRoot')}>
              Browse…
            </button>
            {settings.storageRoot && (
              <button type="button" className="btn btn-ghost" onClick={() => void saveSettings({ storageRoot: '' })}>
                Use default
              </button>
            )}
          </div>
        </label>
        {storage && (
          <dl className="kv">
            <dt>Models</dt>
            <dd className="mono">{storage.modelsDir}</dd>
            <dt>App data</dt>
            <dd className="mono">{storage.userDataDir}</dd>
            <dt>Recordings</dt>
            <dd>
              {storage.recordingCount} · {formatBytes(storage.totalBytes)}
            </dd>
          </dl>
        )}
        <p className="muted small">
          Changing the recordings folder does not move existing files; recordings already on disk stay where
          they are and will not appear in the library until you move them yourself.
        </p>
      </section>

      {versions && (
        <section className="card">
          <h2>About</h2>
          <dl className="kv">
            <dt>Brain Rotter</dt>
            <dd className="mono">{versions.app}</dd>
            <dt>Electron</dt>
            <dd className="mono">{versions.electron}</dd>
            <dt>Chromium</dt>
            <dd className="mono">{versions.chrome}</dd>
            <dt>Node</dt>
            <dd className="mono">{versions.node}</dd>
          </dl>
        </section>
      )}
    </div>
  )
}
