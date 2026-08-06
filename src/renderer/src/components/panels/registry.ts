import type { BrainRotPanelId } from '@shared/types'

export const PANEL_LABELS: Record<BrainRotPanelId, string> = {
  video: 'Your clips',
  flappy: 'Flap Rot',
  webview: 'Web panel',
  runner: 'Lane Rot'
}

export const PANEL_BLURBS: Record<BrainRotPanelId, string> = {
  video: 'Shuffle-plays muted clips from a folder you choose.',
  flappy: 'Original flap-through-the-gaps game, drawn from scratch.',
  webview: 'Renders one URL you paste in Settings. Nothing is scraped.',
  runner: 'Original three-lane endless runner, drawn from scratch.'
}

export const PANEL_ORDER: BrainRotPanelId[] = ['video', 'flappy', 'webview', 'runner']
