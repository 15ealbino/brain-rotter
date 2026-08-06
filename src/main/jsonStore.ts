import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tiny atomic JSON file store. Everything the app persists (settings, the
 * recordings index, high scores) is small enough that read-modify-write of the
 * whole file is the simplest correct thing to do.
 */
export class JsonStore<T extends object> {
  private cache: T | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
    private readonly migrate: (raw: unknown) => T = (raw) => ({ ...defaults, ...(raw as object) }) as T
  ) {}

  get path(): string {
    return this.filePath
  }

  async read(): Promise<T> {
    if (this.cache) return this.cache
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      this.cache = this.migrate(JSON.parse(text) as unknown)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Corrupt or unreadable file: keep going with defaults rather than
        // bricking the app, but leave the bad file behind for inspection.
        console.error(`[brain-rotter] could not read ${this.filePath}, using defaults:`, err)
        await this.quarantine()
      }
      this.cache = { ...this.defaults }
    }
    return this.cache
  }

  async write(next: T): Promise<T> {
    this.cache = next
    const tmp = `${this.filePath}.tmp`
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
      await fs.rename(tmp, this.filePath)
    })
    await this.writeChain
    return next
  }

  async update(patch: Partial<T>): Promise<T> {
    const current = await this.read()
    return this.write({ ...current, ...patch })
  }

  /** Drops the in-memory copy so the next read hits disk (used when storage moves). */
  invalidate(): void {
    this.cache = null
  }

  private async quarantine(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
    } catch {
      /* best effort */
    }
  }
}
