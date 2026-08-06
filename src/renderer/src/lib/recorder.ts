/**
 * Meeting recorder.
 *
 * Two inputs are mixed in WebAudio and recorded as one Opus/WebM stream:
 *   1. system audio, from `getDisplayMedia` (the main process answers the
 *      display-media request with the source the user picked on the record screen),
 *   2. the microphone, from `getUserMedia`.
 *
 * Either input may be unavailable. As long as one of them works we record; the
 * caller is told which ones made it so the UI can warn.
 */

export interface RecorderStartResult {
  capturedSystemAudio: boolean
  capturedMicrophone: boolean
  /** Non-fatal problems worth showing the user, e.g. "system audio unavailable". */
  warnings: string[]
}

export interface RecorderResult {
  blob: Blob
  mimeType: string
  durationSec: number
  capturedSystemAudio: boolean
  capturedMicrophone: boolean
}

export class RecorderError extends Error {
  readonly hint: string | undefined
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'RecorderError'
    this.hint = hint
  }
}

function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus'
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

export class MeetingRecorder {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer: Uint8Array<ArrayBuffer> | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private sourceStreams: MediaStream[] = []
  private startedAt = 0
  private pausedTotal = 0
  private pausedAt = 0
  private systemAudio = false
  private micAudio = false

  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive'
  }

  get isPaused(): boolean {
    return this.recorder?.state === 'paused'
  }

  /** Seconds of audio captured so far, excluding paused time. */
  elapsedSec(): number {
    if (!this.startedAt) return 0
    const paused = this.pausedAt ? Date.now() - this.pausedAt : 0
    return (Date.now() - this.startedAt - this.pausedTotal - paused) / 1000
  }

  /** Current input loudness, 0..1. Drives the level meter. */
  level(): number {
    if (!this.analyser || !this.levelBuffer) return 0
    this.analyser.getByteTimeDomainData(this.levelBuffer)
    let peak = 0
    for (let i = 0; i < this.levelBuffer.length; i++) {
      const v = Math.abs((this.levelBuffer[i] ?? 128) - 128) / 128
      if (v > peak) peak = v
    }
    // A little compression so quiet speech still moves the meter.
    return Math.min(1, Math.pow(peak, 0.6))
  }

  async start(options: { wantSystemAudio: boolean; micDeviceId?: string }): Promise<RecorderStartResult> {
    if (this.isRecording) throw new RecorderError('A recording is already in progress.')

    const warnings: string[] = []
    this.reset()

    const context = new AudioContext()
    this.context = context
    const destination = context.createMediaStreamDestination()

    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    this.analyser = analyser
    this.levelBuffer = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    analyser.connect(context.createGain()) // terminate the branch without audible output

    if (options.wantSystemAudio) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true, // required by the spec even though we drop the track
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
        this.sourceStreams.push(display)
        // We only ever want audio; stop the video track right away so no frames
        // are captured, encoded or stored.
        for (const track of display.getVideoTracks()) track.stop()
        const audioTracks = display.getAudioTracks()
        if (audioTracks.length > 0) {
          const src = context.createMediaStreamSource(new MediaStream(audioTracks))
          src.connect(destination)
          src.connect(analyser)
          this.systemAudio = true
        } else {
          warnings.push(
            'The selected source did not provide an audio track, so only your microphone is being recorded. On Linux pick "Share audio" in the system screen-share dialog if your desktop offers it.'
          )
        }
      } catch (err) {
        warnings.push(
          `System audio could not be captured (${errText(err)}). Recording your microphone only — you will hear your own side of the call but not the other participants unless they come through your mic.`
        )
      }
    }

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: options.micDeviceId
          ? { deviceId: { exact: options.micDeviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true }
      })
      this.sourceStreams.push(mic)
      const src = context.createMediaStreamSource(mic)
      src.connect(destination)
      src.connect(analyser)
      this.micAudio = true
    } catch (err) {
      warnings.push(`Microphone unavailable (${errText(err)}).`)
    }

    if (!this.systemAudio && !this.micAudio) {
      await this.cleanup()
      throw new RecorderError(
        'No audio input could be opened — neither system audio nor a microphone.',
        'Check that a microphone is connected and that Brain Rotter is allowed to use it in your OS privacy settings. On Linux, system audio also needs PipeWire and xdg-desktop-portal.'
      )
    }

    const mimeType = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = mimeType
        ? new MediaRecorder(destination.stream, { mimeType, audioBitsPerSecond: 128_000 })
        : new MediaRecorder(destination.stream)
    } catch (err) {
      await this.cleanup()
      throw new RecorderError(`This build of Electron could not start a MediaRecorder: ${errText(err)}`)
    }

    this.recorder = recorder
    this.chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.onerror = (event) => {
      console.error('[brain-rotter] MediaRecorder error:', event)
    }
    // A 1s timeslice means a crash loses at most a second rather than everything.
    recorder.start(1000)
    this.startedAt = Date.now()

    return { capturedSystemAudio: this.systemAudio, capturedMicrophone: this.micAudio, warnings }
  }

  pause(): void {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause()
      this.pausedAt = Date.now()
    }
  }

  resume(): void {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume()
      this.pausedTotal += Date.now() - this.pausedAt
      this.pausedAt = 0
    }
  }

  async stop(): Promise<RecorderResult> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      throw new RecorderError('There is no recording to stop.')
    }
    const durationSec = this.elapsedSec()
    const mimeType = recorder.mimeType || 'audio/webm'

    const blob = await new Promise<Blob>((resolvePromise) => {
      recorder.onstop = () => resolvePromise(new Blob(this.chunks, { type: mimeType }))
      recorder.stop()
    })

    const result: RecorderResult = {
      blob,
      mimeType,
      durationSec,
      capturedSystemAudio: this.systemAudio,
      capturedMicrophone: this.micAudio
    }
    await this.cleanup()
    return result
  }

  /** Tears everything down without producing a file. */
  async abort(): Promise<void> {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    } catch {
      /* ignore */
    }
    await this.cleanup()
  }

  private reset(): void {
    this.chunks = []
    this.sourceStreams = []
    this.startedAt = 0
    this.pausedTotal = 0
    this.pausedAt = 0
    this.systemAudio = false
    this.micAudio = false
  }

  private async cleanup(): Promise<void> {
    for (const stream of this.sourceStreams) {
      for (const track of stream.getTracks()) track.stop()
    }
    this.sourceStreams = []
    this.recorder = null
    this.analyser = null
    this.levelBuffer = null

    if (this.context) {
      try {
        await this.context.close()
      } catch {
        /* already closed */
      }
      this.context = null
    }
  }
}

function errText(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permission denied'
    if (err.name === 'NotFoundError') return 'no matching device or source'
    if (err.name === 'AbortError') return 'the request was cancelled'
    return `${err.name}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
