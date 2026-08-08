import { useCallback, useEffect, useState } from 'react'
import { call, tryCall } from '../../lib/api'
import { createSmashGame } from '../../games/smash'
import { GameCanvas } from './GameCanvas'

export function SmashPanel(): React.JSX.Element {
  const [highScore, setHighScore] = useState(0)

  useEffect(() => {
    void (async () => {
      const scores = await tryCall('scores:get')
      if (scores) setHighScore(scores.smash)
    })()
  }, [])

  const onHighScore = useCallback((score: number) => {
    setHighScore(score)
    void call('scores:set', 'smash', score).catch((err) => {
      console.error('[brain-rotter] could not persist the smash high score:', err)
    })
  }, [])

  const create = useCallback(
    (canvas: HTMLCanvasElement, initial: number, report: (score: number) => void) =>
      createSmashGame(canvas, { highScore: initial, onHighScore: report }),
    []
  )

  return <GameCanvas create={create} highScore={highScore} onHighScore={onHighScore} label="Smash Rot" />
}
