/**
 * "Flap Rot" — an original flap-through-the-gaps game.
 *
 * Everything on screen is drawn procedurally with canvas primitives and gradients.
 * No sprites, sound files, code or level data from any existing game are used.
 *
 * The module is deliberately framework-free: `createFlappyGame` attaches to a
 * canvas, owns its own RAF loop and input listeners, and hands back a `destroy()`.
 */

export interface GameHandle {
  destroy(): void
  /** Called by the host when the canvas box changes size. */
  resize(): void
}

export interface FlappyOptions {
  highScore: number
  onHighScore: (score: number) => void
}

interface Pipe {
  x: number
  gapY: number
  gapH: number
  scored: boolean
  hue: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  hue: number
}

const WORLD_W = 400
const WORLD_H = 640

const GRAVITY = 1500 // px/s^2 in world units
const FLAP_VELOCITY = -430
const MAX_FALL = 780
const BIRD_X = WORLD_W * 0.3
const BIRD_R = 15
const PIPE_W = 62
const BASE_SPEED = 160
const GROUND_H = 70

type Phase = 'ready' | 'playing' | 'dead'

export function createFlappyGame(canvas: HTMLCanvasElement, options: FlappyOptions): GameHandle {
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
  let birdY = WORLD_H / 2
  let birdV = 0
  let birdAngle = 0
  let pipes: Pipe[] = []
  let particles: Particle[] = []
  let score = 0
  let high = Math.max(0, Math.floor(options.highScore))
  let distance = 0
  let spawnTimer = 0
  let flashT = 0
  let rafId = 0
  let lastT = 0
  let destroyed = false
  let deathT = 0

  /* ----------------------------- layout ----------------------------- */

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    // Letterbox the fixed 400x640 world into whatever box we were given.
    scale = Math.min(w / WORLD_W, h / WORLD_H)
    offsetX = (w - WORLD_W * scale) / 2
    offsetY = (h - WORLD_H * scale) / 2
  }

  /* ------------------------------ state ----------------------------- */

  function reset(): void {
    phase = 'ready'
    birdY = WORLD_H / 2
    birdV = 0
    birdAngle = 0
    pipes = []
    particles = []
    score = 0
    distance = 0
    spawnTimer = 0
    deathT = 0
  }

  function speed(): number {
    // Ramps from 160 up to ~300 px/s over the first ~40 pipes.
    return BASE_SPEED + Math.min(140, score * 3.5)
  }

  function gapHeight(): number {
    return Math.max(128, 190 - score * 1.6)
  }

  function spawnPipe(): void {
    const gapH = gapHeight()
    const margin = 60
    const playable = WORLD_H - GROUND_H
    const gapY = margin + Math.random() * (playable - gapH - margin * 2)
    pipes.push({ x: WORLD_W + PIPE_W, gapY, gapH, scored: false, hue: 140 + Math.random() * 60 })
  }

  function flap(): void {
    if (destroyed) return
    if (phase === 'ready') {
      phase = 'playing'
      birdV = FLAP_VELOCITY
      spawnTimer = 0.35
      return
    }
    if (phase === 'playing') {
      birdV = FLAP_VELOCITY
      return
    }
    // 'dead' — a short lockout so a panicked click does not instantly restart.
    if (deathT > 0.6) reset()
  }

  function die(): void {
    if (phase !== 'playing') return
    phase = 'dead'
    deathT = 0
    flashT = 1
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 60 + Math.random() * 220
      particles.push({
        x: BIRD_X,
        y: birdY,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 0.5 + Math.random() * 0.6,
        hue: 30 + Math.random() * 40
      })
    }
    if (score > high) {
      high = score
      options.onHighScore(high)
    }
  }

  /* ----------------------------- physics ---------------------------- */

  function update(dt: number): void {
    flashT = Math.max(0, flashT - dt * 2.5)

    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 900 * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)

    if (phase === 'ready') {
      // Idle bob so the panel is never a static image.
      birdY = WORLD_H / 2 + Math.sin(performance.now() / 380) * 12
      birdAngle = Math.sin(performance.now() / 380) * 0.12
      distance += 40 * dt
      return
    }

    if (phase === 'dead') {
      deathT += dt
      // Let the bird fall to the ground for a beat.
      birdV = Math.min(MAX_FALL, birdV + GRAVITY * dt)
      birdY = Math.min(WORLD_H - GROUND_H - BIRD_R, birdY + birdV * dt)
      birdAngle = Math.min(Math.PI / 2, birdAngle + dt * 4)
      return
    }

    const v = speed()
    distance += v * dt

    birdV = Math.min(MAX_FALL, birdV + GRAVITY * dt)
    birdY += birdV * dt
    // Tilt toward the direction of travel.
    const target = Math.max(-0.5, Math.min(1.2, birdV / 700))
    birdAngle += (target - birdAngle) * Math.min(1, dt * 9)

    spawnTimer -= dt
    if (spawnTimer <= 0) {
      spawnPipe()
      // Horizontal spacing shrinks slightly with score but never below ~1.05s.
      spawnTimer = Math.max(1.05, 1.75 - score * 0.02)
    }

    for (const pipe of pipes) {
      pipe.x -= v * dt
      if (!pipe.scored && pipe.x + PIPE_W < BIRD_X - BIRD_R) {
        pipe.scored = true
        score += 1
      }
    }
    pipes = pipes.filter((p) => p.x + PIPE_W > -20)

    // Collisions: circle vs. the two axis-aligned rectangles of each pipe.
    if (birdY + BIRD_R >= WORLD_H - GROUND_H || birdY - BIRD_R <= 0) {
      birdY = Math.max(BIRD_R, Math.min(WORLD_H - GROUND_H - BIRD_R, birdY))
      die()
      return
    }
    for (const pipe of pipes) {
      if (
        circleRectHit(BIRD_X, birdY, BIRD_R, pipe.x, 0, PIPE_W, pipe.gapY) ||
        circleRectHit(
          BIRD_X,
          birdY,
          BIRD_R,
          pipe.x,
          pipe.gapY + pipe.gapH,
          PIPE_W,
          WORLD_H - GROUND_H - (pipe.gapY + pipe.gapH)
        )
      ) {
        die()
        return
      }
    }
  }

  function circleRectHit(
    cx: number,
    cy: number,
    r: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number
  ): boolean {
    if (rh <= 0 || rw <= 0) return false
    const nx = Math.max(rx, Math.min(cx, rx + rw))
    const ny = Math.max(ry, Math.min(cy, ry + rh))
    const dx = cx - nx
    const dy = cy - ny
    return dx * dx + dy * dy < r * r
  }

  /* ------------------------------ render ---------------------------- */

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr)
    ctx.arcTo(x + w, y + h, x, y + h, rr)
    ctx.arcTo(x, y + h, x, y, rr)
    ctx.arcTo(x, y, x + w, y, rr)
    ctx.closePath()
  }

  function drawBackground(): void {
    const sky = ctx.createLinearGradient(0, 0, 0, WORLD_H)
    sky.addColorStop(0, '#1b1140')
    sky.addColorStop(0.45, '#4b2a7a')
    sky.addColorStop(0.8, '#b4477f')
    sky.addColorStop(1, '#f0864d')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, WORLD_W, WORLD_H)

    // Sun.
    const sunY = 150
    const sun = ctx.createRadialGradient(WORLD_W * 0.68, sunY, 5, WORLD_W * 0.68, sunY, 90)
    sun.addColorStop(0, 'rgba(255, 226, 150, 0.95)')
    sun.addColorStop(1, 'rgba(255, 140, 90, 0)')
    ctx.fillStyle = sun
    ctx.fillRect(WORLD_W * 0.68 - 100, sunY - 100, 200, 200)

    // Two parallax hill layers made of overlapping arcs.
    drawHills(distance * 0.12, WORLD_H - GROUND_H - 40, 90, 'rgba(30, 18, 60, 0.75)')
    drawHills(distance * 0.28, WORLD_H - GROUND_H - 8, 62, 'rgba(20, 12, 42, 0.9)')
  }

  /** A rolling hill silhouette; `shift` scrolls it, giving cheap parallax. */
  function drawHills(shift: number, baseY: number, amp: number, color: string): void {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, WORLD_H)
    for (let x = 0; x <= WORLD_W; x += 8) {
      const t = (x + shift) * 0.011
      const h = (Math.sin(t) * 0.6 + Math.sin(t * 2.3 + 1.1) * 0.4) * 0.5 + 0.5
      ctx.lineTo(x, baseY - h * amp)
    }
    ctx.lineTo(WORLD_W, WORLD_H)
    ctx.closePath()
    ctx.fill()
  }

  function drawPipes(): void {
    for (const pipe of pipes) {
      const grad = ctx.createLinearGradient(pipe.x, 0, pipe.x + PIPE_W, 0)
      grad.addColorStop(0, `hsl(${pipe.hue} 60% 26%)`)
      grad.addColorStop(0.35, `hsl(${pipe.hue} 65% 48%)`)
      grad.addColorStop(1, `hsl(${pipe.hue} 55% 22%)`)
      ctx.fillStyle = grad

      const bottomY = pipe.gapY + pipe.gapH
      const bottomH = WORLD_H - GROUND_H - bottomY
      roundRect(pipe.x, -20, PIPE_W, pipe.gapY + 20, 8)
      ctx.fill()
      roundRect(pipe.x, bottomY, PIPE_W, bottomH, 8)
      ctx.fill()

      // Lips.
      ctx.fillStyle = `hsl(${pipe.hue} 70% 58%)`
      roundRect(pipe.x - 5, pipe.gapY - 16, PIPE_W + 10, 16, 5)
      ctx.fill()
      roundRect(pipe.x - 5, bottomY, PIPE_W + 10, 16, 5)
      ctx.fill()
    }
  }

  function drawGround(): void {
    const y = WORLD_H - GROUND_H
    const g = ctx.createLinearGradient(0, y, 0, WORLD_H)
    g.addColorStop(0, '#2c1a4a')
    g.addColorStop(1, '#150c26')
    ctx.fillStyle = g
    ctx.fillRect(0, y, WORLD_W, GROUND_H)

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 3
    const stripe = 34
    const shift = distance % stripe
    ctx.beginPath()
    for (let x = -stripe; x < WORLD_W + stripe; x += stripe) {
      ctx.moveTo(x - shift, y + 12)
      ctx.lineTo(x - shift + 16, WORLD_H)
    }
    ctx.stroke()
  }

  function drawBird(): void {
    ctx.save()
    ctx.translate(BIRD_X, birdY)
    ctx.rotate(birdAngle)

    // Glow.
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, BIRD_R * 2.4)
    glow.addColorStop(0, 'rgba(255, 214, 120, 0.45)')
    glow.addColorStop(1, 'rgba(255, 214, 120, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(0, 0, BIRD_R * 2.4, 0, Math.PI * 2)
    ctx.fill()

    // Body.
    const body = ctx.createLinearGradient(-BIRD_R, -BIRD_R, BIRD_R, BIRD_R)
    body.addColorStop(0, '#ffe08a')
    body.addColorStop(1, '#f2913c')
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.ellipse(0, 0, BIRD_R * 1.15, BIRD_R, 0, 0, Math.PI * 2)
    ctx.fill()

    // Wing: a flapping arc driven by vertical velocity.
    const wingPhase = phase === 'playing' ? Math.sin(performance.now() / 70) : Math.sin(performance.now() / 260)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.beginPath()
    ctx.ellipse(-3, wingPhase * 3, BIRD_R * 0.72, BIRD_R * 0.42, wingPhase * 0.5, 0, Math.PI * 2)
    ctx.fill()

    // Eye + beak.
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(BIRD_R * 0.45, -BIRD_R * 0.3, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#241436'
    ctx.beginPath()
    ctx.arc(BIRD_R * 0.6, -BIRD_R * 0.3, 2.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ff8c3b'
    ctx.beginPath()
    ctx.moveTo(BIRD_R * 1.05, 0)
    ctx.lineTo(BIRD_R * 1.75, 3)
    ctx.lineTo(BIRD_R * 1.02, 7)
    ctx.closePath()
    ctx.fill()

    ctx.restore()
  }

  function drawParticles(): void {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life))
      ctx.fillStyle = `hsl(${p.hue} 90% 62%)`
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  function drawHud(): void {
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.font = 'bold 54px system-ui, sans-serif'
    ctx.fillText(String(score), WORLD_W / 2 + 2, 92)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(String(score), WORLD_W / 2, 90)

    ctx.font = '13px system-ui, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.fillText(`BEST ${high}`, WORLD_W / 2, 116)

    if (phase === 'ready') {
      panel('FLAP ROT', 'Click or press Space to flap', WORLD_H / 2 + 110)
    } else if (phase === 'dead') {
      panel(
        score > 0 && score >= high ? `NEW BEST — ${score}` : `SCORE ${score}`,
        deathT > 0.6 ? 'Click or press Space to try again' : '…',
        WORLD_H / 2 + 110
      )
    }
  }

  function panel(title: string, subtitle: string, y: number): void {
    const w = 300
    const h = 84
    const x = (WORLD_W - w) / 2
    ctx.fillStyle = 'rgba(10, 6, 22, 0.72)'
    roundRect(x, y - h / 2, w, h, 14)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 20px system-ui, sans-serif'
    ctx.fillText(title, WORLD_W / 2, y - 4)
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '13px system-ui, sans-serif'
    ctx.fillText(subtitle, WORLD_W / 2, y + 20)
  }

  function render(): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#07040f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.translate(offsetX, offsetY)
    ctx.scale(scale, scale)
    ctx.beginPath()
    ctx.rect(0, 0, WORLD_W, WORLD_H)
    ctx.clip()

    drawBackground()
    drawPipes()
    drawGround()
    drawParticles()
    drawBird()
    drawHud()

    if (flashT > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flashT * 0.5})`
      ctx.fillRect(0, 0, WORLD_W, WORLD_H)
    }

    ctx.restore()
  }

  /* ------------------------------ loop ------------------------------ */

  function frame(t: number): void {
    if (destroyed) return
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0
    lastT = t
    update(dt)
    render()
    rafId = requestAnimationFrame(frame)
  }

  /* ----------------------------- input ------------------------------ */

  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault()
    canvas.focus()
    flap()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault()
      flap()
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('keydown', onKeyDown)
  canvas.tabIndex = 0

  resize()
  reset()
  rafId = requestAnimationFrame(frame)

  return {
    resize,
    destroy(): void {
      destroyed = true
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('keydown', onKeyDown)
    }
  }
}
