import { useState } from 'react'
import type { BrainRotPanelId } from '@shared/types'
import { useAppState } from '../state/AppState'
import { SplitPane } from './SplitPane'
import { ErrorBoundary } from './ErrorBoundary'
import { PANEL_BLURBS, PANEL_LABELS, PANEL_ORDER } from './panels/registry'
import { VideoPanel } from './panels/VideoPanel'
import { FlappyPanel } from './panels/FlappyPanel'
import { WebviewPanel } from './panels/WebviewPanel'
import { RunnerPanel } from './panels/RunnerPanel'

function renderPanel(id: BrainRotPanelId): React.JSX.Element {
  switch (id) {
    case 'video':
      return <VideoPanel />
    case 'flappy':
      return <FlappyPanel />
    case 'webview':
      return <WebviewPanel />
    case 'runner':
      return <RunnerPanel />
    default:
      return <div className="panel-empty muted">Unknown panel.</div>
  }
}

interface SlotProps {
  active: BrainRotPanelId
  onPick: (id: BrainRotPanelId) => void
  onSplit?: () => void
  onClose?: () => void
  splitLabel?: string
}

/** One panel plus its tab bar. The bar is how you swap what a slot shows. */
function PanelSlot({ active, onPick, onSplit, onClose, splitLabel }: SlotProps): React.JSX.Element {
  return (
    <div className="panel-slot">
      <div className="panel-tabs" role="tablist">
        {PANEL_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === active}
            className={`panel-tab${id === active ? ' is-active' : ''}`}
            onClick={() => onPick(id)}
            title={PANEL_BLURBS[id]}
          >
            {PANEL_LABELS[id]}
          </button>
        ))}
        <span className="panel-tabs-spacer" />
        {onSplit && (
          <button type="button" className="icon-btn" onClick={onSplit} title={splitLabel ?? 'Split this pane'}>
            ⧉
          </button>
        )}
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} title="Close this panel">
            ✕
          </button>
        )}
      </div>
      <div className="panel-body">
        <ErrorBoundary label={PANEL_LABELS[active]}>{renderPanel(active)}</ErrorBoundary>
      </div>
    </div>
  )
}

/**
 * The right half of the playback view: one panel full height, or two stacked with
 * a draggable divider. Which panels are shown is persisted in settings.
 */
export function BrainRotPane(): React.JSX.Element {
  const { settings, saveSettings } = useAppState()
  const panels = settings?.brainRotPanels?.length ? settings.brainRotPanels : (['video'] as BrainRotPanelId[])
  const [ratio, setRatio] = useState(settings?.brainRotSplitRatio ?? 0.5)

  const top = panels[0] ?? 'video'
  const bottom = panels[1]

  const setPanels = (next: BrainRotPanelId[]): void => void saveSettings({ brainRotPanels: next })

  const nextUnused = (): BrainRotPanelId =>
    PANEL_ORDER.find((id) => !panels.includes(id)) ?? (PANEL_ORDER[1] as BrainRotPanelId)

  if (!bottom) {
    return (
      <PanelSlot
        active={top}
        onPick={(id) => setPanels([id])}
        onSplit={() => setPanels([top, nextUnused()])}
        splitLabel="Show a second panel below"
      />
    )
  }

  return (
    <SplitPane
      direction="vertical"
      ratio={ratio}
      onRatioChange={setRatio}
      onRatioCommit={(r) => void saveSettings({ brainRotSplitRatio: r })}
      className="brainrot-split"
      first={
        <PanelSlot
          active={top}
          onPick={(id) => setPanels([id, bottom])}
          onClose={() => setPanels([bottom])}
        />
      }
      second={
        <PanelSlot
          active={bottom}
          onPick={(id) => setPanels([top, id])}
          onClose={() => setPanels([top])}
        />
      }
    />
  )
}
