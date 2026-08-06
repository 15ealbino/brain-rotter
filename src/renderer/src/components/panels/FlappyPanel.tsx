import { useCallback, useEffect, useState } from 'react'
import { call, tryCall } from '../../lib/api'
import { createFlappyGame } from '../../games/flappy'
import { GameCanvas } from './GameCanvas'

export function FlappyPanel(): React.JSX.Element {
  const [highScore, setHighScore] = useState(0)

  useEffect(() => {
    void (async () => {
      const scores = await tryCall('scores:get')
      if (scores) setHighScore(scores.flappy)
    })()
  }, [])

  const onHighScore = useCallback((score: number) => {
    setHighScore(score)
    void call('scores:set', 'flappy', score).catch((err) => {
      console.error('[brain-rotter] could not persist the flappy high score:', err)
    })
  }, [])

  const create = useCallback(
    (canvas: HTMLCanvasElement, initial: number, report: (score: number) => void) =>
      createFlappyGame(canvas, { highScore: initial, onHighScore: report }),
    []
  )

  return <GameCanvas create={create} highScore={highScore} onHighScore={onHighScore} label="Flap Rot" />
}
