import { useAppState } from './state/AppState'
import type { Screen } from './state/AppState'
import { ToastStack } from './components/ToastStack'
import { RecordScreen } from './screens/RecordScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { PlaybackScreen } from './screens/PlaybackScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ErrorBoundary } from './components/ErrorBoundary'

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: 'record', label: 'Record', icon: '●' },
  { id: 'library', label: 'Library', icon: '▤' },
  { id: 'playback', label: 'Playback', icon: '▶' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export default function App(): React.JSX.Element {
  const { screen, goTo, ready, recordings, openRecordingId } = useAppState()

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Brain Rotter</span>
          <span className="brand-tag">local meeting recorder &amp; transcript</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => {
            const disabled = item.id === 'playback' && !openRecordingId && recordings.length === 0
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-btn${screen === item.id ? ' is-active' : ''}`}
                onClick={() => goTo(item.id)}
                disabled={disabled}
                title={disabled ? 'Record something first' : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </button>
            )
          })}
        </nav>
      </header>

      <main className="screen">
        {!ready ? (
          <div className="centered muted">Starting up…</div>
        ) : (
          <ErrorBoundary label={screen}>
            {screen === 'record' && <RecordScreen />}
            {screen === 'library' && <LibraryScreen />}
            {screen === 'playback' && <PlaybackScreen />}
            {screen === 'settings' && <SettingsScreen />}
          </ErrorBoundary>
        )}
      </main>

      <ToastStack />
    </div>
  )
}
