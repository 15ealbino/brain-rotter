import type { IpcChannel, IpcContract, IpcEventChannel, IpcEvents, PlatformId } from '@shared/ipc'
import type { AppError } from '@shared/types'

/** An `AppError` from the main process, re-thrown so React code can use try/catch. */
export class IpcError extends Error {
  readonly code: AppError['code']
  readonly hint: string | undefined

  constructor(error: AppError) {
    super(error.message)
    this.name = 'IpcError'
    this.code = error.code
    this.hint = error.hint
  }
}

function bridge(): Window['brainRotter'] {
  const api = window.brainRotter
  if (!api) {
    throw new Error('The preload bridge is missing. Restart Brain Rotter; if it persists, reinstall the app.')
  }
  return api
}

/** Calls a channel and returns the value, throwing `IpcError` on failure. */
export async function call<C extends IpcChannel>(
  channel: C,
  ...args: IpcContract[C]['args']
): Promise<Extract<IpcContract[C]['result'], { ok: true }>['value']> {
  const result = await bridge().invoke(channel, ...args)
  if (result.ok) {
    return result.value as Extract<IpcContract[C]['result'], { ok: true }>['value']
  }
  throw new IpcError(result.error)
}

/** Calls a channel and returns `null` on failure instead of throwing. */
export async function tryCall<C extends IpcChannel>(
  channel: C,
  ...args: IpcContract[C]['args']
): Promise<Extract<IpcContract[C]['result'], { ok: true }>['value'] | null> {
  try {
    return await call(channel, ...args)
  } catch (err) {
    console.error(`[brain-rotter] ${String(channel)} failed:`, err)
    return null
  }
}

export function onEvent<E extends IpcEventChannel>(
  channel: E,
  listener: (payload: IpcEvents[E]) => void
): () => void {
  return bridge().on(channel, listener)
}

export function platform(): PlatformId {
  try {
    return bridge().platform
  } catch {
    return 'linux'
  }
}

export function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof IpcError) return err.hint ? { message: err.message, hint: err.hint } : { message: err.message }
  if (err instanceof Error) return { message: err.message }
  return { message: String(err) }
}
