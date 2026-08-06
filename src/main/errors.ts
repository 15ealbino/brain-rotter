import type { AppError, AppErrorCode, Result } from '@shared/types'

export class BrainRotError extends Error {
  readonly code: AppErrorCode
  readonly hint: string | undefined

  constructor(code: AppErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'BrainRotError'
    this.code = code
    this.hint = hint
  }

  toAppError(): AppError {
    return this.hint ? { code: this.code, message: this.message, hint: this.hint } : { code: this.code, message: this.message }
  }
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T>(code: AppErrorCode, message: string, hint?: string): Result<T> {
  return { ok: false, error: hint ? { code, message, hint } : { code, message } }
}

/** Normalises anything thrown into the wire-safe `AppError` shape. */
export function toAppError(err: unknown): AppError {
  if (err instanceof BrainRotError) return err.toAppError()
  if (err instanceof Error) {
    const code = nodeErrnoToCode((err as NodeJS.ErrnoException).code)
    return { code, message: err.message }
  }
  return { code: 'UNKNOWN', message: String(err) }
}

function nodeErrnoToCode(errno: string | undefined): AppErrorCode {
  switch (errno) {
    case 'ENOENT':
      return 'FILE_NOT_FOUND'
    case 'EACCES':
    case 'EPERM':
      return 'PERMISSION_DENIED'
    case 'EIO':
    case 'ENOSPC':
      return 'IO_ERROR'
    default:
      return 'UNKNOWN'
  }
}

/**
 * Wraps an async handler so it always resolves to a `Result` instead of rejecting.
 * Every IPC handler goes through this — the renderer never sees a raw rejection.
 */
export async function guard<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    console.error('[brain-rotter] handler failed:', err)
    return { ok: false, error: toAppError(err) }
  }
}
