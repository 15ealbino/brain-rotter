import { useEffect, useRef, useState } from 'react'
import type { GameHandle } from '../../games/flappy'

interface Props {
  /** Constructs the game against a freshly mounted canvas. */
  create: (canvas: HTMLCanvasElement, highScore: number, onHighScore: (score: number) => void) => GameHandle
  highScore: number
  onHighScore: (score: number) => void
  label: string
}

/**
 * Hosts a framework-free canvas game: owns the element, forwards resizes, and
 * turns a construction failure into a readable message instead of a blank panel.
 */
export function GameCanvas({ create, highScore, onHighScore, label }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  // The callback identity would otherwise tear the game down on every render.
  const highScoreRef = useRef(highScore)
  const onHighScoreRef = useRef(onHighScore)
  highScoreRef.current = highScore
  onHighScoreRef.current = onHighScore

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    let handle: GameHandle
    try {
      handle = create(canvas, highScoreRef.current, (score) => onHighScoreRef.current(score))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }

    const observer = new ResizeObserver(() => handle.resize())
    observer.observe(wrap)

    return () => {
      observer.disconnect()
      handle.destroy()
    }
  }, [create])

  if (error) {
    return (
      <div className="panel-empty">
        <h3>{label} could not start</h3>
        <p className="mono small">{error}</p>
      </div>
    )
  }

  return (
    <div className="game-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="game-canvas" aria-label={label} />
    </div>
  )
}
