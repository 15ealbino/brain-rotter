import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface Props {
  direction: 'horizontal' | 'vertical'
  /** 0..1 fraction given to the first child. */
  ratio: number
  onRatioChange: (ratio: number) => void
  /** Called once when the user releases the divider, for persisting. */
  onRatioCommit?: (ratio: number) => void
  min?: number
  max?: number
  first: ReactNode
  second: ReactNode
  className?: string
}

/**
 * A two-child split with a draggable divider. `horizontal` splits left/right,
 * `vertical` splits top/bottom. Keyboard accessible via arrow keys on the divider.
 */
export function SplitPane({
  direction,
  ratio,
  onRatioChange,
  onRatioCommit,
  min = 0.15,
  max = 0.85,
  first,
  second,
  className
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const isHorizontal = direction === 'horizontal'

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max])

  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent): void => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const next = isHorizontal
        ? (event.clientX - rect.left) / Math.max(1, rect.width)
        : (event.clientY - rect.top) / Math.max(1, rect.height)
      onRatioChange(clamp(next))
    }
    const onUp = (): void => {
      setDragging(false)
      onRatioCommit?.(ratio)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // While dragging, keep the cursor consistent and stop text selection.
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, isHorizontal, clamp, onRatioChange, onRatioCommit, ratio])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? 0.1 : 0.02
    const back = isHorizontal ? 'ArrowLeft' : 'ArrowUp'
    const fwd = isHorizontal ? 'ArrowRight' : 'ArrowDown'
    if (event.key === back) {
      event.preventDefault()
      const next = clamp(ratio - step)
      onRatioChange(next)
      onRatioCommit?.(next)
    } else if (event.key === fwd) {
      event.preventDefault()
      const next = clamp(ratio + step)
      onRatioChange(next)
      onRatioCommit?.(next)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onRatioChange(0.5)
      onRatioCommit?.(0.5)
    }
  }

  const pct = `${(clamp(ratio) * 100).toFixed(3)}%`
  const style = isHorizontal
    ? { gridTemplateColumns: `${pct} 8px 1fr` }
    : { gridTemplateRows: `${pct} 8px 1fr` }

  return (
    <div
      ref={containerRef}
      className={`split split-${direction}${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <div className="split-pane">{first}</div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(clamp(ratio) * 100)}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          onRatioChange(0.5)
          onRatioCommit?.(0.5)
        }}
      >
        <span className="split-grip" aria-hidden="true" />
      </div>
      <div className="split-pane">{second}</div>
    </div>
  )
}
