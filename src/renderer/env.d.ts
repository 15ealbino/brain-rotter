/// <reference types="vite/client" />

import type { BrainRotterApi } from '@shared/ipc'

declare global {
  interface Window {
    brainRotter: BrainRotterApi
  }
}

/**
 * Electron's <webview> is not part of the DOM lib. React 19 exposes its JSX
 * namespace from the `react` module, so that is where the element is declared.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
        useragent?: string
        webpreferences?: string
      }
    }
  }
}

export {}
