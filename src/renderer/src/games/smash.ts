/**
 * "Smash Rot" — an original drive-and-demolish game.
 *
 * You drive a car down an endless roadway and destroy the junk scattered across
 * it. Crates, barrels, cones, tyres and signs all explode for points and build a
 * combo; the concrete blocks do not move, and hitting one wrecks you instead.
 *
 * Same-genre-as, not copied-from: every shape, colour, prop and rule here was
 * written for this project. There are no third-party assets, sprites, sounds,
 * vehicle designs or branding of any kind.
 *
 * Rendering reuses the hand-rolled fake-3D projection idiom from `runner.ts` —
 * a flat strip running from the horizon toward the camera with a perspective
 * divide — but the road is continuous rather than lane-quantised, because
 * steering freely into things is the whole point.
 */

import type { GameHandle } from './flappy'

export interface SmashOptions {
  highScore: number
  onHighScore: (score: number) => void
}

type PropKind = 'crate' | 'barrel' | 'cone' | 'tyre' | 'sign' | 'block'

interface PropSpec {
  /** Half-width in world units. */
  halfW: number
  /** Height in world units. */
  height: number
  points: number
  /** Concrete: cannot be destroyed, damages the car. */
  solid: boolean
}

const PROPS: Record<PropKind, PropSpec> = {
  cone: { halfW: 0.17, height: 0.5, points: 5, solid: false },
  crate: { halfW: 0.29, height: 0.58, points: 10, solid: false },
  tyre: { halfW: 0.26, height: 0.44, points: 12, solid: false },
  barrel: { halfW: 0.24, height: 0.78, points: 15, solid: false },
  sign: { halfW: 0.32, height: 1.2, points: 20, solid: false },
  block: { halfW: 0.46, height: 0.78, points: 0, solid: true }
}

/** Draw order weight when spawning: cones are common, signs and concrete rare. */
const SPAWN_TABLE: PropKind[] = [
  'cone', 'cone', 'cone', 'cone',
  'crate', 'crate', 'crate',
  'tyre', 'tyre', 'tyre',
  'barrel', 'barrel',
  'sign',
  'block', 'block'
]

interface Prop {
  z: number
  x: number
  kind: PropKind
  hue: number
  /** Radians; purely cosmetic, so no two crates sit identically. */
  yaw: number
  gone: boolean
}

interface Debris {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  hue: number
  sat: number
  spin: number
  rot: number
}

const VIEW_W = 420
const VIEW_H = 720

const HORIZON_Y = VIEW_H * 0.34
const CAM_HEIGHT = 1.4
const FOCAL = 320
const DRAW_DISTANCE = 60
const CAM_BACK = 4.5

/** Half the drivable surface, in world units. The shoulder extends past this. */
const ROAD_HALF = 3.2
const SHOULDER = 1.15
const CAR_HALF_W = 0.42
const CAR_LENGTH = 1.5

const SPEED_START = 15
const SPEED_MAX = 46
const SPEED_RAMP = 0.62
const BOOST_FACTOR = 1.55
const STEER_ACCEL = 15
const STEER_MAX = 6.2
const STEER_DRAG = 6

const MAX_INTEGRITY = 100
const BLOCK_DAMAGE = 34
const INVULN_TIME = 0.9

const MAX_DEBRIS = 260

type Phase = 'ready' | 'playing' | 'dead'

interface Projected {
  x: number
  y: number
  s: number
  visible: boolean
}

export function createSmashGame(canvas: HTMLCanvasElement, options: SmashOptions): GameHandle {
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
  let carX = 0
  let carVX = 0
  /** Smoothed lean, -1..1, for the body roll and wheel angle. */
  let lean = 0
  let speed = SPEED_START
  let travelled = 0
  let integrity = MAX_INTEGRITY
  let invuln = 0

  let score = 0
  let combo = 0
  let bestCombo = 0
  /** Seconds left on the floating "+N" popup. */
  let popupT = 0
  let popupText = ''
  let popupHue = 40

  let high = Math.max(0, Math.floor(options.highScore))
  let shake = 0
  let deathT = 0
  let flash = 0

  let steerLeft = false
  let steerRight = false
  let boosting = false

  const props: Prop[] = []
  const debris: Debris[] = []
  let nextSpawnAt = 0

  let rafId = 0
  let lastT = 0
  let destroyed = false

  /* --------------------------- projection --------------------------- */

  function project(x: number, height: number, z: number): Projected {
    const depth = z + CAM_BACK
    if (depth <= 0.4) return { x: 0, y: 0, s: 0, visible: false }
    const s = FOCAL / depth
    return {
      x: VIEW_W / 2 + (x - carX * 0.35) * s,
      y: HORIZON_Y + (CAM_HEIGHT - height) * s,
      s,
      visible: true
    }
  }

  /* ------------------------------ state ------------------------------ */

  function reset(): void {
    phase = 'ready'
    carX = 0
    carVX = 0
    lean = 0
    speed = SPEED_START
    travelled = 0
    integrity = MAX_INTEGRITY
    invuln = 0
    score = 0
    combo = 0
    bestCombo = 0
    popupT = 0
    shake = 0
    deathT = 0
    flash = 0
    props.length = 0
    debris.length = 0
    nextSpawnAt = 0
    // Pre-populate the road so it does not start empty.
    for (let z = 12; z < DRAW_DISTANCE; z += 4) spawnRow(z)
  }

  function start(): void {
    if (phase === 'playing') return
    reset()
    phase = 'playing'
  }

  function die(): void {
    if (phase !== 'playing') return
    phase = 'dead'
    deathT = 0
    shake = 1.4
    flash = 1
    if (score > high) {
      high = score
      options.onHighScore(score)
    }
  }

  function multiplier(): number {
    return Math.min(8, 1 + Math.floor(combo / 4))
  }

  /* ----------------------------- spawning ---------------------------- */

  function spawnRow(atZ: number): void {
    const count = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      const kind = SPAWN_TABLE[Math.floor(Math.random() * SPAWN_TABLE.length)] ?? 'cone'
      // Concrete sits on the road proper; scenery can drift onto the shoulder.
      const span = PROPS[kind].solid ? ROAD_HALF * 0.86 : ROAD_HALF + SHOULDER * 0.55
      const x = (Math.random() * 2 - 1) * span
      // Don't stack props on top of each other at the same depth.
      const clash = props.some((p) => !p.gone && Math.abs(p.z - atZ) < 1.4 && Math.abs(p.x - x) < 0.8)
      if (clash) continue
      props.push({
        z: atZ + (Math.random() - 0.5) * 1.6,
        x,
        kind,
        hue: propHue(kind),
        yaw: Math.random() * Math.PI,
        gone: false
      })
    }
  }

  function propHue(kind: PropKind): number {
    switch (kind) {
      case 'cone':
        return 18
      case 'crate':
        return 32
      case 'barrel':
        return Math.random() < 0.5 ? 4 : 200
      case 'tyre':
        return 0
      case 'sign':
        return 48
      case 'block':
        return 210
    }
  }

  /* ------------------------------ debris ----------------------------- */

  function burst(at: Projected, kind: PropKind, hue: number): void {
    const spec = PROPS[kind]
    const n = Math.min(34, Math.round(12 + spec.points * 0.9))
    for (let i = 0; i < n; i++) {
      if (debris.length >= MAX_DEBRIS) break
      const a = Math.random() * Math.PI * 2
      const sp = (60 + Math.random() * 320) * (at.s / 90)
      const life = 0.4 + Math.random() * 0.7
      debris.push({
        x: at.x + (Math.random() - 0.5) * at.s * 0.1,
        y: at.y - Math.random() * at.s * spec.height * 0.6,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 90,
        life,
        maxLife: life,
        size: Math.max(1.5, at.s * (0.012 + Math.random() * 0.02)),
        hue,
        sat: kind === 'tyre' ? 0 : 70,
        spin: (Math.random() - 0.5) * 14,
        rot: Math.random() * Math.PI
      })
    }
  }

  function smokePuff(): void {
    if (debris.length >= MAX_DEBRIS) return
    const life = 0.5 + Math.random() * 0.4
    debris.push({
      x: VIEW_W / 2 + (Math.random() - 0.5) * 26 - lean * 10,
      y: VIEW_H - 92 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 40,
      vy: -30 - Math.random() * 50,
      life,
      maxLife: life,
      size: 5 + Math.random() * 7,
      hue: 0,
      sat: 0,
      spin: 0,
      rot: 0
    })
  }

  /* ------------------------------ update ----------------------------- */

  function update(dt: number): void {
    if (dt <= 0) return

    shake = Math.max(0, shake - dt * 2.2)
    flash = Math.max(0, flash - dt * 3)
    popupT = Math.max(0, popupT - dt)

    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i]
      if (!d) continue
      d.life -= dt
      if (d.life <= 0) {
        debris.splice(i, 1)
        continue
      }
      d.x += d.vx * dt
      d.y += d.vy * dt
      d.vy += 520 * dt
      d.vx *= 1 - 1.4 * dt
      d.rot += d.spin * dt
    }

    if (phase === 'dead') {
      deathT += dt
      speed = Math.max(0, speed - dt * 26)
      travelled += speed * dt
      for (const p of props) p.z -= speed * dt
      return
    }

    if (phase !== 'playing') return

    invuln = Math.max(0, invuln - dt)

    // Steering is accelerated rather than instant, so the car has some weight.
    const dir = (steerLeft ? -1 : 0) + (steerRight ? 1 : 0)
    if (dir !== 0) {
      carVX += dir * STEER_ACCEL * dt
    } else {
      carVX -= carVX * Math.min(1, STEER_DRAG * dt)
    }
    carVX = Math.max(-STEER_MAX, Math.min(STEER_MAX, carVX))
    carX += carVX * dt

    const limit = ROAD_HALF + SHOULDER
    if (carX < -limit) {
      carX = -limit
      carVX = 0
    } else if (carX > limit) {
      carX = limit
      carVX = 0
    }

    lean += (Math.max(-1, Math.min(1, carVX / STEER_MAX)) - lean) * Math.min(1, dt * 9)

    // Off the tarmac you lose grip and speed — the shoulder is a penalty, not a lane.
    const offRoad = Math.abs(carX) > ROAD_HALF
    const target = boosting ? SPEED_MAX * BOOST_FACTOR : SPEED_MAX
    speed += SPEED_RAMP * dt * (boosting ? 3.4 : 1)
    if (offRoad) speed -= dt * 9
    speed = Math.max(SPEED_START * 0.55, Math.min(target, speed))

    if (boosting || offRoad) smokePuff()

    travelled += speed * dt

    // March the world toward the camera and spawn fresh rows at the far edge.
    for (const p of props) p.z -= speed * dt
    while (travelled > nextSpawnAt) {
      spawnRow(DRAW_DISTANCE)
      nextSpawnAt += 3.2
    }

    collide()

    for (let i = props.length - 1; i >= 0; i--) {
      const p = props[i]
      if (!p) continue
      if (p.gone || p.z < -CAM_BACK - 3) props.splice(i, 1)
    }
  }

  function collide(): void {
    for (const p of props) {
      if (p.gone) continue
      // The car occupies z in roughly [-CAR_LENGTH/2, CAR_LENGTH/2].
      if (p.z > CAR_LENGTH * 0.5 || p.z < -CAR_LENGTH * 0.65) continue

      const spec = PROPS[p.kind]
      if (Math.abs(p.x - carX) > CAR_HALF_W + spec.halfW) continue

      const at = project(p.x, spec.height * 0.5, Math.max(0.2, p.z))

      if (spec.solid) {
        if (invuln > 0) continue
        integrity -= BLOCK_DAMAGE
        invuln = INVULN_TIME
        combo = 0
        shake = 1.2
        flash = 0.8
        speed = Math.max(SPEED_START * 0.55, speed * 0.45)
        burst(at, 'block', 210)
        popupText = 'WRECKED'
        popupHue = 0
        popupT = 1.1
        if (integrity <= 0) {
          integrity = 0
          die()
          return
        }
      } else {
        p.gone = true
        combo += 1
        bestCombo = Math.max(bestCombo, combo)
        const mult = multiplier()
        const gained = spec.points * mult
        score += gained
        shake = Math.min(1, shake + 0.16 + spec.points * 0.004)
        burst(at, p.kind, p.hue)
        popupText = mult > 1 ? `+${gained}  ×${mult}` : `+${gained}`
        popupHue = p.hue
        popupT = 0.75
      }
    }
  }

  /* ----------------------------- drawing ----------------------------- */

  function drawSky(): void {
    const g = ctx.createLinearGradient(0, 0, 0, HORIZON_Y)
    g.addColorStop(0, '#180d24')
    g.addColorStop(0.55, '#48214a')
    g.addColorStop(1, '#c2543a')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, VIEW_W, HORIZON_Y)

    // Low sun sitting on the horizon.
    const sunY = HORIZON_Y - 26
    const sun = ctx.createRadialGradient(VIEW_W / 2, sunY, 4, VIEW_W / 2, sunY, 92)
    sun.addColorStop(0, 'rgba(255, 214, 140, 0.95)')
    sun.addColorStop(0.4, 'rgba(255, 150, 80, 0.5)')
    sun.addColorStop(1, 'rgba(255, 120, 60, 0)')
    ctx.fillStyle = sun
    ctx.fillRect(VIEW_W / 2 - 100, sunY - 100, 200, 130)

    // Distant hills, drawn as two soft bands.
    ctx.fillStyle = 'rgba(30, 16, 40, 0.85)'
    ctx.beginPath()
    ctx.moveTo(0, HORIZON_Y)
    for (let x = 0; x <= VIEW_W; x += 28) {
      ctx.lineTo(x, HORIZON_Y - 16 - Math.sin(x * 0.021) * 11 - Math.sin(x * 0.007) * 7)
    }
    ctx.lineTo(VIEW_W, HORIZON_Y)
    ctx.closePath()
    ctx.fill()
  }

  function drawRoad(): void {
    // Ground either side of the tarmac.
    const g = ctx.createLinearGradient(0, HORIZON_Y, 0, VIEW_H)
    g.addColorStop(0, '#2a1826')
    g.addColorStop(1, '#120a14')
    ctx.fillStyle = g
    ctx.fillRect(0, HORIZON_Y, VIEW_W, VIEW_H - HORIZON_Y)

    const edge = ROAD_HALF + SHOULDER
    const farL = project(-edge, 0, DRAW_DISTANCE)
    const farR = project(edge, 0, DRAW_DISTANCE)
    const nearL = project(-edge, 0, -CAM_BACK + 0.6)
    const nearR = project(edge, 0, -CAM_BACK + 0.6)

    // Shoulder: gravel, a shade lighter than the surrounding ground.
    ctx.fillStyle = '#241a24'
    ctx.beginPath()
    ctx.moveTo(farL.x, farL.y)
    ctx.lineTo(farR.x, farR.y)
    ctx.lineTo(nearR.x, nearR.y)
    ctx.lineTo(nearL.x, nearL.y)
    ctx.closePath()
    ctx.fill()

    // Tarmac.
    const tarL = project(-ROAD_HALF, 0, DRAW_DISTANCE)
    const tarR = project(ROAD_HALF, 0, DRAW_DISTANCE)
    const tarNL = project(-ROAD_HALF, 0, -CAM_BACK + 0.6)
    const tarNR = project(ROAD_HALF, 0, -CAM_BACK + 0.6)
    ctx.fillStyle = '#191320'
    ctx.beginPath()
    ctx.moveTo(tarL.x, tarL.y)
    ctx.lineTo(tarR.x, tarR.y)
    ctx.lineTo(tarNR.x, tarNR.y)
    ctx.lineTo(tarNL.x, tarNL.y)
    ctx.closePath()
    ctx.fill()

    // Alternating tarmac bands scrolling toward the camera give the speed cue.
    const spacing = 3
    const phaseShift = travelled % (spacing * 2)
    for (let z = DRAW_DISTANCE; z > -CAM_BACK; z -= spacing * 2) {
      const z0 = z - phaseShift
      const z1 = z0 - spacing
      const a = project(-ROAD_HALF, 0, z0)
      const b = project(ROAD_HALF, 0, z0)
      const c = project(ROAD_HALF, 0, z1)
      const d = project(-ROAD_HALF, 0, z1)
      if (!a.visible || !d.visible) continue
      ctx.fillStyle = 'rgba(255, 255, 255, 0.022)'
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(c.x, c.y)
      ctx.lineTo(d.x, d.y)
      ctx.closePath()
      ctx.fill()
    }

    // Dashed centre line.
    const dash = 2.4
    const dashPhase = travelled % (dash * 2)
    for (let z = DRAW_DISTANCE; z > -CAM_BACK; z -= dash * 2) {
      const z0 = z - dashPhase
      const z1 = z0 - dash
      const a = project(-0.09, 0, z0)
      const b = project(0.09, 0, z0)
      const c = project(0.09, 0, z1)
      const d = project(-0.09, 0, z1)
      if (!a.visible || !d.visible) continue
      const alpha = Math.max(0, Math.min(0.75, (1 - z0 / DRAW_DISTANCE) * 0.9))
      ctx.fillStyle = `rgba(255, 226, 150, ${alpha})`
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(c.x, c.y)
      ctx.lineTo(d.x, d.y)
      ctx.closePath()
      ctx.fill()
    }

    // Solid edge lines.
    for (const ex of [-ROAD_HALF, ROAD_HALF]) {
      const a = project(ex, 0, DRAW_DISTANCE)
      const b = project(ex, 0, -CAM_BACK + 0.6)
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      grad.addColorStop(0, 'rgba(255,255,255,0)')
      grad.addColorStop(1, 'rgba(255,255,255,0.5)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }

  function drawProps(): void {
    // Far to near, so nearer props overlap the ones behind them.
    const visible = props.filter((p) => !p.gone && p.z > -CAM_BACK + 0.5).sort((a, b) => b.z - a.z)
    for (const p of visible) {
      const spec = PROPS[p.kind]
      const base = project(p.x, 0, p.z)
      if (!base.visible) continue
      const top = project(p.x, spec.height, p.z)
      const w = spec.halfW * 2 * base.s
      const h = Math.max(1, base.y - top.y)
      if (w < 0.6) continue

      const fade = Math.max(0.25, Math.min(1, 1.25 - p.z / DRAW_DISTANCE))
      ctx.globalAlpha = fade

      // Contact shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.42)'
      ctx.beginPath()
      ctx.ellipse(base.x, base.y, w * 0.62, w * 0.2, 0, 0, Math.PI * 2)
      ctx.fill()

      switch (p.kind) {
        case 'cone':
          drawCone(base.x, base.y, w, h)
          break
        case 'crate':
          drawCrate(base.x, base.y, w, h, p.hue, p.yaw)
          break
        case 'tyre':
          drawTyre(base.x, base.y, w, h)
          break
        case 'barrel':
          drawBarrel(base.x, base.y, w, h, p.hue)
          break
        case 'sign':
          drawSign(base.x, base.y, w, h, p.hue)
          break
        case 'block':
          drawBlock(base.x, base.y, w, h)
          break
      }

      ctx.globalAlpha = 1
    }
  }

  function drawCone(x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = '#e2571f'
    ctx.beginPath()
    ctx.moveTo(x, y - h)
    ctx.lineTo(x + w * 0.5, y)
    ctx.lineTo(x - w * 0.5, y)
    ctx.closePath()
    ctx.fill()
    // Reflective band.
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    ctx.fillRect(x - w * 0.28, y - h * 0.62, w * 0.56, Math.max(1, h * 0.14))
    ctx.fillStyle = '#7a2f11'
    ctx.fillRect(x - w * 0.55, y - Math.max(1, h * 0.09), w * 1.1, Math.max(1, h * 0.09))
  }

  function drawCrate(x: number, y: number, w: number, h: number, hue: number, yaw: number): void {
    const lean2 = Math.sin(yaw) * w * 0.06
    ctx.fillStyle = `hsl(${hue}, 45%, 42%)`
    ctx.fillRect(x - w / 2 + lean2, y - h, w, h)
    ctx.fillStyle = `hsl(${hue}, 45%, 52%)`
    ctx.fillRect(x - w / 2 + lean2, y - h, w, Math.max(1, h * 0.16))
    // Plank seams.
    ctx.strokeStyle = `hsl(${hue}, 40%, 26%)`
    ctx.lineWidth = Math.max(1, w * 0.05)
    ctx.beginPath()
    ctx.moveTo(x - w / 2 + lean2, y - h)
    ctx.lineTo(x + w / 2 + lean2, y)
    ctx.moveTo(x + w / 2 + lean2, y - h)
    ctx.lineTo(x - w / 2 + lean2, y)
    ctx.stroke()
    ctx.strokeRect(x - w / 2 + lean2, y - h, w, h)
  }

  function drawTyre(x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = '#16151a'
    ctx.beginPath()
    ctx.ellipse(x, y - h * 0.5, w * 0.5, h * 0.5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#2c2b33'
    ctx.beginPath()
    ctx.ellipse(x, y - h * 0.5, w * 0.22, h * 0.24, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'
    ctx.lineWidth = Math.max(1, w * 0.04)
    ctx.beginPath()
    ctx.ellipse(x, y - h * 0.5, w * 0.5, h * 0.5, 0, 0, Math.PI * 2)
    ctx.stroke()
  }

  function drawBarrel(x: number, y: number, w: number, h: number, hue: number): void {
    ctx.fillStyle = `hsl(${hue}, 58%, 44%)`
    ctx.fillRect(x - w / 2, y - h, w, h)
    // Rounded lid and base to read as a drum.
    ctx.fillStyle = `hsl(${hue}, 58%, 54%)`
    ctx.beginPath()
    ctx.ellipse(x, y - h, w * 0.5, h * 0.1, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = `hsl(${hue}, 58%, 34%)`
    ctx.beginPath()
    ctx.ellipse(x, y, w * 0.5, h * 0.1, 0, 0, Math.PI * 2)
    ctx.fill()
    // Hoops.
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.fillRect(x - w / 2, y - h * 0.7, w, Math.max(1, h * 0.07))
    ctx.fillRect(x - w / 2, y - h * 0.34, w, Math.max(1, h * 0.07))
  }

  function drawSign(x: number, y: number, w: number, h: number, hue: number): void {
    const postW = Math.max(1, w * 0.14)
    ctx.fillStyle = '#6a6472'
    ctx.fillRect(x - postW / 2, y - h, postW, h)
    const plateH = h * 0.42
    const plateY = y - h
    ctx.fillStyle = `hsl(${hue}, 82%, 52%)`
    ctx.fillRect(x - w / 2, plateY, w, plateH)
    ctx.strokeStyle = 'rgba(30,20,10,0.75)'
    ctx.lineWidth = Math.max(1, w * 0.05)
    ctx.strokeRect(x - w / 2, plateY, w, plateH)
    // Chevron marking, drawn rather than lettered so it reads at any size.
    ctx.fillStyle = 'rgba(35,22,8,0.85)'
    ctx.beginPath()
    ctx.moveTo(x - w * 0.16, plateY + plateH * 0.22)
    ctx.lineTo(x + w * 0.2, plateY + plateH * 0.5)
    ctx.lineTo(x - w * 0.16, plateY + plateH * 0.78)
    ctx.closePath()
    ctx.fill()
  }

  function drawBlock(x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = '#5d6470'
    ctx.beginPath()
    ctx.moveTo(x - w / 2, y)
    ctx.lineTo(x - w * 0.36, y - h)
    ctx.lineTo(x + w * 0.36, y - h)
    ctx.lineTo(x + w / 2, y)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#767d89'
    ctx.fillRect(x - w * 0.36, y - h, w * 0.72, Math.max(1, h * 0.14))
    // Hazard stripes so it reads as "do not hit" at a glance.
    ctx.save()
    ctx.beginPath()
    ctx.rect(x - w * 0.42, y - h * 0.62, w * 0.84, h * 0.3)
    ctx.clip()
    const stripe = Math.max(3, w * 0.16)
    for (let i = -3; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#f0c419' : '#20222a'
      ctx.beginPath()
      ctx.moveTo(x - w * 0.42 + i * stripe, y - h * 0.32)
      ctx.lineTo(x - w * 0.42 + i * stripe + stripe, y - h * 0.32)
      ctx.lineTo(x - w * 0.42 + i * stripe + stripe * 2, y - h * 0.62)
      ctx.lineTo(x - w * 0.42 + i * stripe + stripe, y - h * 0.62)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  function drawCar(): void {
    // The camera tracks the car, so it stays near the middle and the world slides.
    const at = project(carX, 0, 0)
    const s = at.s
    const w = CAR_HALF_W * 2 * s
    const h = w * 0.52
    const cx = at.x
    const cy = at.y

    const wrecked = 1 - integrity / MAX_INTEGRITY
    // Flicker while the invulnerability window is open, so hits read clearly.
    if (invuln > 0 && Math.floor(invuln * 18) % 2 === 0) ctx.globalAlpha = 0.45

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(lean * 0.06)

    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.beginPath()
    ctx.ellipse(0, 0, w * 0.56, h * 0.22, 0, 0, Math.PI * 2)
    ctx.fill()

    const bodyTop = -h * 2.15
    const bodyH = h * 2.15

    // Wheels first, so the body sits over them.
    ctx.fillStyle = '#111015'
    const wheelW = w * 0.17
    const wheelH = bodyH * 0.26
    for (const sx of [-1, 1]) {
      for (const sy of [0.28, 0.86]) {
        ctx.fillRect(sx * (w * 0.5) - (sx > 0 ? 0 : wheelW), bodyTop + bodyH * sy - wheelH / 2, wheelW, wheelH)
      }
    }

    // Body: a tapered slab, narrower at the nose.
    const hue = 348
    const light = 52 - wrecked * 22
    ctx.fillStyle = `hsl(${hue}, ${68 - wrecked * 40}%, ${light}%)`
    ctx.beginPath()
    ctx.moveTo(-w * 0.4, bodyTop)
    ctx.lineTo(w * 0.4, bodyTop)
    ctx.lineTo(w * 0.5, bodyTop + bodyH * 0.55)
    ctx.lineTo(w * 0.44, bodyTop + bodyH)
    ctx.lineTo(-w * 0.44, bodyTop + bodyH)
    ctx.lineTo(-w * 0.5, bodyTop + bodyH * 0.55)
    ctx.closePath()
    ctx.fill()

    // Roof / cabin.
    ctx.fillStyle = `hsl(${hue}, ${58 - wrecked * 34}%, ${light - 14}%)`
    roundRect(-w * 0.32, bodyTop + bodyH * 0.3, w * 0.64, bodyH * 0.4, w * 0.06)
    ctx.fill()

    // Windscreen.
    ctx.fillStyle = 'rgba(150, 220, 255, 0.72)'
    ctx.beginPath()
    ctx.moveTo(-w * 0.26, bodyTop + bodyH * 0.34)
    ctx.lineTo(w * 0.26, bodyTop + bodyH * 0.34)
    ctx.lineTo(w * 0.2, bodyTop + bodyH * 0.2)
    ctx.lineTo(-w * 0.2, bodyTop + bodyH * 0.2)
    ctx.closePath()
    ctx.fill()

    // Centre stripe.
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillRect(-w * 0.04, bodyTop, w * 0.08, bodyH * 0.28)

    // Headlights throwing light up the road.
    for (const sx of [-1, 1]) {
      const lx = sx * w * 0.3
      ctx.fillStyle = 'rgba(255, 240, 190, 0.95)'
      roundRect(lx - w * 0.07, bodyTop + bodyH * 0.02, w * 0.14, bodyH * 0.07, w * 0.03)
      ctx.fill()
      const beam = ctx.createLinearGradient(lx, bodyTop, lx, bodyTop - bodyH * 1.6)
      beam.addColorStop(0, 'rgba(255, 233, 170, 0.26)')
      beam.addColorStop(1, 'rgba(255, 233, 170, 0)')
      ctx.fillStyle = beam
      ctx.beginPath()
      ctx.moveTo(lx - w * 0.07, bodyTop)
      ctx.lineTo(lx + w * 0.07, bodyTop)
      ctx.lineTo(lx + w * 0.5, bodyTop - bodyH * 1.6)
      ctx.lineTo(lx - w * 0.5, bodyTop - bodyH * 1.6)
      ctx.closePath()
      ctx.fill()
    }

    // Damage: cracks scratched over the body as integrity falls.
    if (wrecked > 0.3) {
      ctx.strokeStyle = `rgba(20,10,14,${Math.min(0.8, wrecked)})`
      ctx.lineWidth = Math.max(1, w * 0.03)
      for (let i = 0; i < 3; i++) {
        const yy = bodyTop + bodyH * (0.45 + i * 0.16)
        ctx.beginPath()
        ctx.moveTo(-w * 0.36, yy)
        ctx.lineTo(-w * 0.1, yy + bodyH * 0.05)
        ctx.lineTo(w * 0.14, yy - bodyH * 0.04)
        ctx.lineTo(w * 0.36, yy + bodyH * 0.03)
        ctx.stroke()
      }
    }

    ctx.restore()
    ctx.globalAlpha = 1
  }

  function drawDebris(): void {
    for (const d of debris) {
      const a = Math.max(0, d.life / d.maxLife)
      ctx.globalAlpha = a
      ctx.fillStyle = d.sat === 0 ? `rgba(210,205,215,${a * 0.5})` : `hsl(${d.hue}, ${d.sat}%, ${45 + a * 25}%)`
      ctx.save()
      ctx.translate(d.x, d.y)
      ctx.rotate(d.rot)
      ctx.fillRect(-d.size / 2, -d.size / 2, d.size, d.size)
      ctx.restore()
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
    ctx.fillText(`${speed.toFixed(0)} m/s`, VIEW_W - 20, 45)

    // Integrity bar — the only thing standing between you and the panel.
    const barW = 110
    const barX = VIEW_W - 20 - barW
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    roundRect(barX, 56, barW, 9, 4)
    ctx.fill()
    const frac = Math.max(0, integrity / MAX_INTEGRITY)
    ctx.fillStyle = frac > 0.6 ? '#4ad07a' : frac > 0.3 ? '#e8c33c' : '#e2503f'
    roundRect(barX, 56, Math.max(2, barW * frac), 9, 4)
    ctx.fill()

    if (combo >= 4 && phase === 'playing') {
      ctx.textAlign = 'center'
      ctx.font = 'bold 22px system-ui, sans-serif'
      ctx.fillStyle = `hsl(${(combo * 9) % 360}, 90%, 66%)`
      ctx.fillText(`×${multiplier()}  ${combo} SMASHED`, VIEW_W / 2, 44)
    }

    if (popupT > 0) {
      const a = Math.min(1, popupT / 0.5)
      ctx.textAlign = 'center'
      ctx.font = 'bold 26px system-ui, sans-serif'
      ctx.fillStyle = `hsla(${popupHue}, 85%, 66%, ${a})`
      ctx.fillText(popupText, VIEW_W / 2, VIEW_H * 0.62 - (0.75 - popupT) * 40)
    }

    if (phase === 'ready') {
      panel('SMASH ROT', [
        '← → or A/D to steer',
        'Hold Space to boost',
        'Flatten the junk · dodge the concrete',
        'Click or press any key to start'
      ])
    } else if (phase === 'dead') {
      panel(score >= high && score > 0 ? `NEW BEST — ${score}` : `SCORE ${score}`, [
        `Best combo ×${bestCombo}`,
        deathT > 0.6 ? 'Click or press Space to drive again' : '…'
      ])
    }
  }

  function render(): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#0a0610'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.translate(offsetX, offsetY)
    ctx.scale(scale, scale)
    ctx.beginPath()
    ctx.rect(0, 0, VIEW_W, VIEW_H)
    ctx.clip()
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12)
    }

    drawSky()
    drawRoad()
    drawProps()
    drawCar()
    drawDebris()

    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 90, 60, ${flash * 0.32})`
      ctx.fillRect(0, 0, VIEW_W, VIEW_H)
    }

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

  function poke(): void {
    if (phase === 'ready') start()
    else if (phase === 'dead' && deathT > 0.6) start()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat && e.code !== 'Space') return
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        e.preventDefault()
        steerLeft = true
        poke()
        break
      case 'ArrowRight':
      case 'KeyD':
        e.preventDefault()
        steerRight = true
        poke()
        break
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        e.preventDefault()
        boosting = true
        poke()
        break
      default:
        poke()
        break
    }
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        steerLeft = false
        break
      case 'ArrowRight':
      case 'KeyD':
        steerRight = false
        break
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        boosting = false
        break
      default:
        break
    }
  }

  /** Steer by pointer position: left half steers left, right half right. */
  const onPointerDown = (e: PointerEvent): void => {
    canvas.focus()
    poke()
    const rect = canvas.getBoundingClientRect()
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width)
    if (rel < 0.42) steerLeft = true
    else if (rel > 0.58) steerRight = true
    else boosting = true
  }

  const onPointerUp = (): void => {
    steerLeft = false
    steerRight = false
    boosting = false
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!steerLeft && !steerRight && !boosting) return
    const rect = canvas.getBoundingClientRect()
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width)
    steerLeft = rel < 0.42
    steerRight = rel > 0.58
  }

  /** Losing focus mid-hold would otherwise leave the car steering forever. */
  const onBlur = (): void => {
    steerLeft = false
    steerRight = false
    boosting = false
  }

  canvas.tabIndex = 0
  canvas.addEventListener('keydown', onKeyDown)
  canvas.addEventListener('keyup', onKeyUp)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerUp)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('blur', onBlur)

  resize()
  reset()
  rafId = requestAnimationFrame(frame)

  return {
    resize,
    destroy(): void {
      destroyed = true
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerUp)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('blur', onBlur)
    }
  }
}
