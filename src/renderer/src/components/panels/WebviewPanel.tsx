import { useEffect, useRef, useState } from 'react'
import { call } from '../../lib/api'
import { useAppState } from '../../state/AppState'

/**
 * Renders exactly one URL: the one the user typed into Settings.
 *
 * This panel does not scrape, crawl, automate, log in to, or download anything
 * from any site. It is a browser view and nothing more. Many large sites send
 * `X-Frame-Options`/`frame-ancestors` headers or otherwise refuse to be embedded;
 * when that happens we say so plainly and offer to open the page in the user's
 * real browser instead.
 */
export function WebviewPanel(): React.JSX.Element {
  const { settings, goTo, reportError } = useAppState()
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const url = settings?.webviewUrl ?? ''

  useEffect(() => {
    const host = hostRef.current
    if (!host || !url) return

    setStatus('loading')
    setFailure(null)

    // The <webview> tag is created imperatively so it can be fully torn down —
    // React reusing the element across URL changes leaves the old guest attached.
    const view = document.createElement('webview')
    view.setAttribute('src', url)
    view.setAttribute('partition', 'persist:brainrot-webview')
    view.className = 'webview'
    // No node integration, no popups; a plain sandboxed guest page.
    view.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,javascript=yes')

    const onDidStop = (): void => setStatus('ready')
    const onFailLoad = (event: Event): void => {
      const e = event as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string }
      // -3 is ABORTED, which fires for ordinary in-page navigations too.
      if (e.errorCode === -3) return
      setStatus('failed')
      setFailure(
        `${e.errorDescription || 'The page could not be loaded'}${
          e.errorCode !== undefined ? ` (error ${e.errorCode})` : ''
        }`
      )
    }
    const onCrashed = (): void => {
      setStatus('failed')
      setFailure('The embedded page crashed.')
    }

    view.addEventListener('did-stop-loading', onDidStop)
    view.addEventListener('did-fail-load', onFailLoad)
    view.addEventListener('crashed', onCrashed)
    host.appendChild(view)

    return () => {
      view.removeEventListener('did-stop-loading', onDidStop)
      view.removeEventListener('did-fail-load', onFailLoad)
      view.removeEventListener('crashed', onCrashed)
      view.remove()
    }
  }, [url, nonce])

  if (!url) {
    return (
      <div className="panel-empty">
        <h3>Point this panel at a URL</h3>
        <p>
          Open <strong>Settings → Brain rot panels → Webview URL</strong> and paste any address you want
          rendered here.
        </p>
        <p className="small muted">
          Brain Rotter only displays the page you type. It never scrapes, downloads or automates a site, and
          it ships no third-party content of its own.
        </p>
        <button type="button" className="btn" onClick={() => goTo('settings')}>
          Open Settings
        </button>
      </div>
    )
  }

  return (
    <div className="webview-panel">
      <div className="webview-bar">
        <span className="mono small webview-url" title={url}>
          {url}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setNonce((n) => n + 1)}
          title="Reload"
        >
          ⟳
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void call('shell:openExternal', url).catch((e) => reportError('Could not open link', e))}
          title="Open in your normal browser"
        >
          ↗
        </button>
      </div>

      <div className="webview-host" ref={hostRef} />

      {status === 'loading' && <div className="webview-status muted">Loading…</div>}

      {status === 'failed' && (
        <div className="webview-status webview-status-error">
          <strong>This site would not load in an embedded view.</strong>
          <p className="small">{failure}</p>
          <p className="small muted">
            Most large sites — social networks especially — send headers that forbid being framed, and many
            block non-standard browsers outright. That is their call to make, and Brain Rotter does not try
            to work around it.
          </p>
          <div className="field-row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void call('shell:openExternal', url).catch((e) => reportError('Could not open link', e))}
            >
              Open in browser
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNonce((n) => n + 1)}>
              Retry
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => goTo('settings')}>
              Use a different URL
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
