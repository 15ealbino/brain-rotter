import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown instead of the full-screen fallback when this boundary wraps a panel. */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * Catches render-time crashes so one broken panel cannot white-screen the app.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[brain-rotter] render error:', error, info.componentStack)
  }

  private reset = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="error-boundary">
        <h2>{this.props.label ? `${this.props.label} crashed` : 'Something went wrong'}</h2>
        <p className="mono">{error.message}</p>
        <button type="button" className="btn" onClick={this.reset}>
          Try again
        </button>
      </div>
    )
  }
}
