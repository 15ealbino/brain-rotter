/**
 * "Lane Rot" — an original three-lane endless runner.
 *
 * Same-genre-as, not copied-from: every shape, colour, obstacle and rule here was
 * written for this project. There are no third-party assets, sprites, sounds,
 * character designs or branding of any kind.
 *
 * Rendering is a hand-rolled fake-3D projection: the world is a flat strip that
 * runs from the horizon toward the camera, and everything is projected with a
 * simple perspective divide.
 */

import type { GameHandle } from './flappy'

export interface RunnerOptions {
  highScore: number
  onHighScore: (score: number) => void
}

type ObstacleKind = 'block' | 'low' | 'high'

interface Obstacle {
  /** Distance ahead of the player, in world units. */
  z: number
  lane: 0 | 1 | 2
  kind: ObstacleKind
  hue: number
  passed: boolean
}

interface Coin {
  z: number
  lane: 0 | 1 | 2
  taken: boolean
  spin: number
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  hue: number
}

const VIEW_W = 420
const VIEW_H = 720

/** Camera / projection constants. */
const HORIZON_Y = VIEW_H * 0.32
const CAM_HEIGHT = 1.55
const FOCAL = 330
const LANE_WIDTH = 1.5
const DRAW_DISTANCE = 55
const PLAYER_Z = 0

const JUMP_V = 5.6
const GRAVITY = 15.5
const DUCK_TIME = 0.55

type Phase = 'ready' | 'playing' | 'dead'

export function createRunnerGame(canvas: HTMLCanvasElement, options: RunnerOptions): GameHandle {
  const maybeCtx = canvas.getContext('2d')
  if (!maybeCtx) {
    throw new Error('This system did not provide a 2D canvas context, so the game cannot run.')
  }
  const ctx: CanvasRenderingContext2D = maybeCtx

  let dpr = 1
  let scale = 1
  let offsetX = 0
  let offsetY = 0

  let phase: Phase = 'ready'
  let lane: 0 | 1 | 2 = 1
  let laneOffset = 0 // smoothed visual lane position, in lane units
  let y = 0 // vertical position, world units above ground
  let vy = 0
  let ducking = 0 // remaining duck time
  let travelled = 0
  let bonus = 0
  let speed = 11
  let score = 0
  let high = Math.max(0, Math.floor(options.highScore))
  let obstacles: Obstacle[] = []
  let coins: Coin[] = []
  let sparks: Spark[] = []
  let spawnZ = 24
  let deathT = 0
  let shake = 0
  let rafId = 0
  let lastT = 0
  let destroyed = false

  /* ---------------------------- projection --------------------------- */

  interface Projected {
    x: number
    y: number
    s: number
    visible: boolean
  }

  /** Projects a world point (lateral lanes, height, depth) into view space. */
  function project(laneX: number, height: number, z: number): Projected {
    const depth = z + 4.5 // keep the camera a little behind the player
    if (depth <= 0.4) return { x: 0, y: 0, s: 0, visible: false }
    const s = FOCAL / depth
    return {
      x: VIEW_W / 2 + laneX * LANE_WIDTH * s,
      y: HORIZON_Y + (CAM_HEIGHT - height) * s,
      s,
      visible: true
    }
  }

  /* ------------------------------ state ------------------------------ */

  function reset(): void {
    phase = 'ready'
    lane = 1
    laneOffset = 0
    y = 0
    vy = 0
    ducking = 0
    travelled = 0
    bonus = 0
    speed = 11
    score = 0
    obstacles = []
    coins = []
    sparks = []
    spawnZ = 24
    deathT = 0
    spawnRow()
  }

  function start(): void {
    if (phase === 'ready') {
      phase = 'playing'
    } else if (phase === 'dead' && deathT > 0.6) {
      reset()
      phase = 'playing'
    }
  }

  function moveLane(dir: -1 | 1): void {
    if (phase !== 'playing') {
      start()
      return
    }
    const next = lane + dir
    if (next >= 0 && next <= 2) lane = next as 0 | 1 | 2
  }

  function jump(): void {
    if (phase !== 'playing') {
      start()
      return
    }
    if (y <= 0.001) {
      vy = JUMP_V
      ducking = 0
    }
  }

  function duck(): void {
    if (phase !== 'playing') {
      start()
      return
    }
    if (y > 0.001) {
      // Fast-fall into a duck.
      vy = Math.min(vy, -6)
    }
    ducking = DUCK_TIME
  }

  function die(): void {
    if (phase !== 'playing') return
    phase = 'dead'
    deathT = 0
    shake = 1
    const p = project(laneOffset - 1, 0.7, PLAYER_Z)
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 80 + Math.random() * 260
      sparks.push({
        x: p.x,
        y: p.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 120,
        life: 0.5 + Math.random() * 0.7,
        hue: 180 + Math.random() * 120
      })
    }
    if (score > high) {
      high = score
      options.onHighScore(high)
    }
  }

  /* ----------------------------- spawning ---------------------------- */

  function spawnRow(): void {
    // Never block all three lanes: pick one or two lanes to occupy.
    const lanes: (0 | 1 | 2)[] = [0, 1, 2]
    const blockCount = Math.random() < Math.min(0.55, 0.18 + score / 900) ? 2 : 1
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const a = lanes[i] as 0 | 1 | 2
      const b = lanes[j] as 0 | 1 | 2
      lanes[i] = b
      lanes[j] = a
    }
    const chosen = lanes.slice(0, blockCount)
    for (const l of chosen) {
      const roll = Math.random()
      const kind: ObstacleKind = roll < 0.42 ? 'block' : roll < 0.74 ? 'low' : 'high'
      obstacles.push({ z: spawnZ, lane: l, kind, hue: 190 + Math.random() * 140, passed: false })
    }
    const free = lanes.slice(blockCount)
    const coinLane = free[Math.floor(Math.random() * free.length)]
    if (coinLane !== undefined && Math.random() < 0.75) {
      for (let k = 0; k < 3; k++) {
        coins.push({ z: spawnZ + k * 1.4, lane: coinLane, taken: false, spin: Math.random() * Math.PI })
      }
    }
    // Rows get closer together as speed climbs, but never closer than reaction time.
    spawnZ += Math.max(7.5, 15 - score / 120)
  }

  /* ------------------------------ update ----------------------------- */

  function update(dt: number): void {
    shake = Math.max(0, shake - dt * 3)
    for (const s of sparks) {
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vy += 700 * dt
      s.life -= dt
    }
    sparks = sparks.filter((s) => s.life > 0)

    if (phase === 'dead') {
      deathT += dt
      travelled += speed * dt * 0.25
      return
    }

    if (phase === 'ready') {
      travelled += 6 * dt
      laneOffset += (lane - laneOffset) * Math.min(1, dt * 10)
      return
    }

    speed = Math.min(30, 11 + travelled / 90)
    travelled += speed * dt
    score = Math.floor(travelled) + bonus

    laneOffset += (lane - laneOffset) * Math.min(1, dt * 11)

    if (ducking > 0) ducking = Math.max(0, ducking - dt)
    vy -= GRAVITY * dt
    y = Math.max(0, y + vy * dt)
    if (y === 0 && vy < 0) vy = 0

    for (const o of obstacles) o.z -= speed * dt
    for (const c of coins) c.z -= speed * dt

    // Collision window: an obstacle is "at" the player between z = 0.6 and -0.6.
    for (const o of obstacles) {
      if (o.passed || o.z > 0.75 || o.z < -0.9) continue
      if (o.lane !== nearestLane()) continue
      if (hits(o)) {
        die()
        return
      }
      o.passed = true
    }

    for (const c of coins) {
      if (c.taken || c.z > 0.7 || c.z < -0.7) continue
      if (c.lane === nearestLane() && y < 1.4) {
        c.taken = true
        bonus += 5 // coins are worth a small score bump
        const p = project(laneOffset - 1, 0.9, 0)
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2
          sparks.push({
            x: p.x,
            y: p.y,
            vx: Math.cos(a) * 90,
            vy: Math.sin(a) * 90 - 40,
            life: 0.3,
            hue: 48
          })
        }
      }
    }

    obstacles = obstacles.filter((o) => o.z > -6)
    coins = coins.filter((c) => c.z > -6 && !c.taken)

    // `spawnZ` is the depth of the next row and travels toward the camera with
    // everything else; top the track up whenever it comes inside draw distance.
    spawnZ -= speed * dt
    let guard = 0
    while (spawnZ < DRAW_DISTANCE && guard++ < 8) spawnRow()
  }

  function nearestLane(): 0 | 1 | 2 {
    return Math.round(laneOffset) as 0 | 1 | 2
  }

  /** Vertical extent each obstacle kind occupies, in world units above the track. */
  function obstacleGeometry(kind: ObstacleKind): { bottom: number; top: number } {
    switch (kind) {
      case 'block':
        return { bottom: 0, top: 1.9 } // full-height pillar — must change lane
      case 'low':
        return { bottom: 0, top: 0.62 } // knee-high barrier — jump it
      case 'high':
      default:
        return { bottom: 0.85, top: 1.95 } // overhead beam — duck under it
    }
  }

  /** Standing height, or a shorter box while crouching on the ground. */
  function playerHeight(): number {
    return ducking > 0 && y <= 0.01 ? 0.62 : 1.05
  }

  /** Whether the player's current pose collides with this obstacle. */
  function hits(o: Obstacle): boolean {
    // A lane change still in flight only counts once the visual position is
    // close enough, which makes last-second dodges feel fair.
    if (Math.abs(laneOffset - o.lane) > 0.45) return false
    const { bottom, top } = obstacleGeometry(o.kind)
    const playerBottom = y
    const playerTop = y + playerHeight()
    return playerTop > bottom && playerBottom < top
  }

  /* ------------------------------ render ----------------------------- */

  function drawSky(): void {
    const g = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 60)
    g.addColorStop(0, '#090418')
    g.addColorStop(0.6, '#2a1155')
    g.addColorStop(1, '#7b2c8f')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, VIEW_W, HORIZON_Y + 60)

    // Star field, deterministic so it does not shimmer.
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    for (let i = 0; i < 60; i++) {
      const sx = ((i * 977) % VIEW_W)
      const sy = ((i * 613) % Math.floor(HORIZON_Y))
      const r = (i % 3) * 0.4 + 0.4
      ctx.fillRect(sx, sy, r, r)
    }

    // Distant skyline blocks.
    const shift = (travelled * 4) % 90
    ctx.fillStyle = 'rgba(12, 6, 28, 0.85)'
    for (let i = -1; i < 9; i++) {
      const bx = i * 60 - shift
      const bh = 20 + ((i * 37) % 60)
      ctx.fillRect(bx, HORIZON_Y - bh, 46, bh)
    }
    ctx.fillStyle = 'rgba(255, 190, 90, 0.35)'
    for (let i = -1; i < 9; i++) {
      const bx = i * 60 - shift
      const bh = 20 + ((i * 37) % 60)
      for (let wy = HORIZON_Y - bh + 6; wy < HORIZON_Y - 4; wy += 9) {
        for (let wx = bx + 6; wx < bx + 40; wx += 11) {
          if ((wx + wy + i) % 3 === 0) ctx.fillRect(wx, wy, 4, 4)
        }
      }
    }
  }

  function drawTrack(): void {
    // Ground fill below the horizon.
    const g = ctx.createLinearGradient(0, HORIZON_Y, 0, VIEW_H)
    g.addColorStop(0, '#160a2c')
    g.addColorStop(1, '#0a0518')
    ctx.fillStyle = g
    ctx.fillRect(0, HORIZON_Y, VIEW_W, VIEW_H - HORIZON_Y)

    // Track surface as a trapezoid between the outer lane edges.
    const far = project(-1.5, 0, DRAW_DISTANCE)
    const near = project(-1.5, 0, -4)
    const farR = project(1.5, 0, DRAW_DISTANCE)
    const nearR = project(1.5, 0, -4)
    ctx.fillStyle = '#1d1038'
    ctx.beginPath()
    ctx.moveTo(far.x, far.y)
    ctx.lineTo(farR.x, farR.y)
    ctx.lineTo(nearR.x, nearR.y)
    ctx.lineTo(near.x, near.y)
    ctx.closePath()
    ctx.fill()

    // Rungs scrolling toward the camera give the sense of speed.
    const spacing = 2
    const phaseShift = travelled % spacing
    for (let z = DRAW_DISTANCE; z > -3; z -= spacing) {
      const zz = z - phaseShift
      const a = project(-1.5, 0, zz)
      const b = project(1.5, 0, zz)
      if (!a.visible) continue
      const alpha = Math.max(0, Math.min(0.5, (1 - zz / DRAW_DISTANCE) * 0.5))
      ctx.strokeStyle = `rgba(180, 130, 255, ${alpha})`
      ctx.lineWidth = Math.max(1, a.s * 0.012)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // Lane dividers.
    for (const lx of [-0.5, 0.5]) {
      const a = project(lx, 0, DRAW_DISTANCE)
      const b = project(lx, 0, -4)
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      grad.addColorStop(0, 'rgba(255,255,255,0)')
      grad.addColorStop(1, 'rgba(255,255,255,0.35)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // Glowing rails on the outside.
    for (const lx of [-1.5, 1.5]) {
      const a = project(lx, 0, DRAW_DISTANCE)
      const b = project(lx, 0, -4)
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      grad.addColorStop(0, 'rgba(90, 220, 255, 0)')
      grad.addColorStop(1, 'rgba(90, 220, 255, 0.9)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }

  function laneX(l: number): number {
    return l - 1
  }

  function drawObstacles(): void {
    const sorted = [...obstacles].sort((a, b) => b.z - a.z)
    for (const o of sorted) {
      if (o.z > DRAW_DISTANCE || o.z < -4) continue
      const lx = laneX(o.lane)
      const w = 0.62
      const geom = obstacleGeometry(o.kind)

      const depth = 0.7
      const nearZ = o.z - depth / 2
      const farZ = o.z + depth / 2

      const nb = project(lx - w, geom.bottom, nearZ)
      const nt = project(lx + w, geom.top, nearZ)
      const fb = project(lx - w, geom.bottom, farZ)
      const ft = project(lx + w, geom.top, farZ)
      if (!nb.visible || !fb.visible) continue

      const fade = Math.max(0.15, 1 - o.z / DRAW_DISTANCE)
      const light = o.kind === 'high' ? 62 : o.kind === 'low' ? 55 : 48

      // Top / far face for a bit of depth.
      ctx.fillStyle = `hsla(${o.hue} 70% ${light * 0.55}% / ${fade})`
      ctx.beginPath()
      ctx.moveTo(fb.x, ft.y)
      ctx.lineTo(ft.x, ft.y)
      ctx.lineTo(nt.x, nt.y)
      ctx.lineTo(nb.x, nt.y)
      ctx.closePath()
      ctx.fill()

      // Front face.
      const grad = ctx.createLinearGradient(nb.x, nt.y, nt.x, nb.y)
      grad.addColorStop(0, `hsla(${o.hue} 80% ${light}% / ${fade})`)
      grad.addColorStop(1, `hsla(${o.hue + 30} 80% ${light * 0.6}% / ${fade})`)
      ctx.fillStyle = grad
      ctx.fillRect(nb.x, nt.y, nt.x - nb.x, nb.y - nt.y)

      // Hazard stripes tell you what the obstacle wants from you.
      ctx.fillStyle = `rgba(255,255,255,${0.22 * fade})`
      const bw = nt.x - nb.x
      const bh = nb.y - nt.y
      if (o.kind === 'low') {
        ctx.fillRect(nb.x, nt.y + bh * 0.3, bw, Math.max(1, bh * 0.18))
      } else if (o.kind === 'high') {
        ctx.fillRect(nb.x, nt.y + bh * 0.6, bw, Math.max(1, bh * 0.18))
      } else {
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(nb.x, nt.y + (bh / 4.6) * i + bh * 0.08, bw, Math.max(1, bh * 0.06))
        }
      }

      ctx.strokeStyle = `hsla(${o.hue} 95% 78% / ${fade})`
      ctx.lineWidth = Math.max(0.6, nb.s * 0.006)
      ctx.strokeRect(nb.x, nt.y, bw, bh)
    }
  }

  function drawCoins(): void {
    for (const c of coins) {
      if (c.z > DRAW_DISTANCE || c.z < -3) continue
      const p = project(laneX(c.lane), 0.85, c.z)
      if (!p.visible) continue
      const r = Math.max(1, p.s * 0.09)
      const spin = Math.abs(Math.cos(performance.now() / 260 + c.spin))
      const fade = Math.max(0.15, 1 - c.z / DRAW_DISTANCE)
      ctx.fillStyle = `rgba(255, 208, 84, ${fade})`
      ctx.beginPath()
      ctx.ellipse(p.x, p.y, Math.max(0.6, r * spin), r, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 246, 200, ${fade * 0.9})`
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  function drawPlayer(): void {
    const lx = laneOffset - 1
    const crouch = ducking > 0 && y <= 0.01
    const height = crouch ? 0.62 : 1.05
    const width = crouch ? 0.42 : 0.3

    const base = project(lx, y, PLAYER_Z)
    const top = project(lx, y + height, PLAYER_Z)
    if (!base.visible) return

    // Shadow scales with jump height.
    const shadow = project(lx, 0, PLAYER_Z)
    const shadowScale = Math.max(0.25, 1 - y / 2.2)
    ctx.fillStyle = `rgba(0,0,0,${0.45 * shadowScale})`
    ctx.beginPath()
    ctx.ellipse(shadow.x, shadow.y, base.s * width * 1.1 * shadowScale, base.s * 0.06 * shadowScale, 0, 0, Math.PI * 2)
    ctx.fill()

    const w = base.s * width
    const bodyTop = top.y
    const bodyBottom = base.y
    const bodyH = bodyBottom - bodyTop

    // Trail streaks behind the runner.
    ctx.strokeStyle = 'rgba(120, 240, 255, 0.35)'
    ctx.lineWidth = 2
    for (let i = 1; i <= 3; i++) {
      const t = project(lx, y + height * 0.5, PLAYER_Z + i * 0.5)
      ctx.globalAlpha = 0.3 / i
      ctx.beginPath()
      ctx.moveTo(t.x - w * 0.7, t.y)
      ctx.lineTo(t.x + w * 0.7, t.y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Body: a capsule with a gradient, plus a head and two legs.
    const grad = ctx.createLinearGradient(base.x - w, bodyTop, base.x + w, bodyBottom)
    grad.addColorStop(0, '#8ef2ff')
    grad.addColorStop(0.5, '#4aa8ff')
    grad.addColorStop(1, '#8a5cff')
    ctx.fillStyle = grad
    const r = Math.min(w, bodyH / 2) * 0.6
    ctx.beginPath()
    ctx.moveTo(base.x - w + r, bodyTop)
    ctx.arcTo(base.x + w, bodyTop, base.x + w, bodyBottom, r)
    ctx.arcTo(base.x + w, bodyBottom, base.x - w, bodyBottom, r)
    ctx.arcTo(base.x - w, bodyBottom, base.x - w, bodyTop, r)
    ctx.arcTo(base.x - w, bodyTop, base.x + w, bodyTop, r)
    ctx.closePath()
    ctx.fill()

    // Head.
    ctx.fillStyle = '#d9f6ff'
    ctx.beginPath()
    ctx.arc(base.x, bodyTop - w * 0.55, w * 0.62, 0, Math.PI * 2)
    ctx.fill()

    // Legs pump when on the ground.
    if (y <= 0.01 && phase === 'playing') {
      const stride = Math.sin(performance.now() / 90) * w * 0.7
      ctx.strokeStyle = '#4aa8ff'
      ctx.lineWidth = Math.max(2, w * 0.35)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(base.x, bodyBottom - bodyH * 0.08)
      ctx.lineTo(base.x + stride, bodyBottom + bodyH * 0.12)
      ctx.moveTo(base.x, bodyBottom - bodyH * 0.08)
      ctx.lineTo(base.x - stride, bodyBottom + bodyH * 0.12)
      ctx.stroke()
    }

    // Rim light.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = 1.2
    ctx.stroke()
  }

  function drawSparks(): void {
    for (const s of sparks) {
      ctx.globalAlpha = Math.max(0, Math.min(1, s.life))
      ctx.fillStyle = `hsl(${s.hue} 95% 65%)`
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4)
    }
    ctx.globalAlpha = 1
  }

  function roundRect(x: number, yy: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr, yy)
    ctx.arcTo(x + w, yy, x + w, yy + h, rr)
    ctx.arcTo(x + w, yy + h, x, yy + h, rr)
    ctx.arcTo(x, yy + h, x, yy, rr)
    ctx.arcTo(x, yy, x + w, yy, rr)
    ctx.closePath()
  }

  function panel(title: string, lines: string[]): void {
    const w = 330
    const h = 46 + lines.length * 22
    const x = (VIEW_W - w) / 2
    const yy = VIEW_H / 2 - h / 2 + 60
    ctx.fillStyle = 'rgba(8, 4, 20, 0.78)'
    roundRect(x, yy, w, h, 14)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 20px system-ui, sans-serif'
    ctx.fillText(title, VIEW_W / 2, yy + 30)
    ctx.font = '13px system-ui, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.72)'
    lines.forEach((line, i) => ctx.fillText(line, VIEW_W / 2, yy + 54 + i * 20))
  }

  function drawHud(): void {
    ctx.textAlign = 'left'
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillText(String(score), 22, 47)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(String(score), 20, 45)

    ctx.font = '12px system-ui, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillText(`BEST ${high}`, 20, 66)

    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(`${speed.toFixed(1)} m/s`, VIEW_W - 20, 45)

    if (phase === 'ready') {
      panel('LANE ROT', [
        '← → or A/D to switch lane',
        '↑ / Space to jump  ·  ↓ to duck',
        'Swipe on a touchpad works too',
        'Click or press any key to start'
      ])
    } else if (phase === 'dead') {
      panel(score >= high && score > 0 ? `NEW BEST — ${score}` : `SCORE ${score}`, [
        deathT > 0.6 ? 'Click or press Space to run again' : '…'
      ])
    }
  }

  function render(): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#05030d'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.translate(offsetX, offsetY)
    ctx.scale(scale, scale)
    ctx.beginPath()
    ctx.rect(0, 0, VIEW_W, VIEW_H)
    ctx.clip()
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake * 10, (Math.random() - 0.5) * shake * 10)
    }

    drawSky()
    drawTrack()
    drawObstacles()
    drawCoins()
    drawPlayer()
    drawSparks()
    drawHud()

    ctx.restore()
  }

  /* ------------------------------- loop ------------------------------ */

  function frame(t: number): void {
    if (destroyed) return
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0
    lastT = t
    update(dt)
    render()
    rafId = requestAnimationFrame(frame)
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    scale = Math.min(w / VIEW_W, h / VIEW_H)
    offsetX = (w - VIEW_W * scale) / 2
    offsetY = (h - VIEW_H * scale) / 2
  }

  /* ------------------------------ input ------------------------------ */

  const onKeyDown = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        e.preventDefault()
        moveLane(-1)
        break
      case 'ArrowRight':
      case 'KeyD':
        e.preventDefault()
        moveLane(1)
        break
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        e.preventDefault()
        jump()
        break
      case 'ArrowDown':
      case 'KeyS':
        e.preventDefault()
        duck()
        break
      default:
        if (phase !== 'playing') start()
    }
  }

  let touchStart: { x: number; y: number; t: number } | null = null

  const onPointerDown = (e: PointerEvent): void => {
    canvas.focus()
    touchStart = { x: e.clientX, y: e.clientY, t: performance.now() }
    if (phase !== 'playing') {
      e.preventDefault()
      start()
    }
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (!touchStart) return
    const dx = e.clientX - touchStart.x
    const dy = e.clientY - touchStart.y
    const dtMs = performance.now() - touchStart.t
    touchStart = null
    if (dtMs > 700) return
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)
    if (Math.max(absX, absY) < 24) {
      jump()
      return
    }
    if (absX > absY) moveLane(dx > 0 ? 1 : -1)
    else if (dy < 0) jump()
    else duck()
  }

  const onWheel = (e: WheelEvent): void => {
    // Two-finger swipe on a trackpad.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 12) {
      e.preventDefault()
      moveLane(e.deltaX > 0 ? 1 : -1)
    } else if (Math.abs(e.deltaY) > 12) {
      e.preventDefault()
      if (e.deltaY < 0) jump()
      else duck()
    }
  }

  canvas.tabIndex = 0
  canvas.addEventListener('keydown', onKeyDown)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  resize()
  reset()
  rafId = requestAnimationFrame(frame)

  return {
    resize,
    destroy(): void {
      destroyed = true
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }
}
