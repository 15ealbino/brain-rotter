import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AppSettings,
  ModelDownloadProgress,
  RecordingMeta,
  TranscriptionProgress,
  WhisperEnvironment,
  WhisperModelInfo
} from '@shared/types'
import { call, describeError, onEvent, tryCall } from '../lib/api'

export type Screen = 'record' | 'library' | 'playback' | 'settings'

export interface Toast {
  id: number
  kind: 'error' | 'warning' | 'info' | 'success'
  title: string
  message?: string
  hint?: string
}

interface AppStateValue {
  ready: boolean
  screen: Screen
  goTo: (screen: Screen) => void

  settings: AppSettings | null
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>

  recordings: RecordingMeta[]
  refreshRecordings: () => Promise<void>

  openRecordingId: string | null
  openRecording: (id: string) => void

  whisper: WhisperEnvironment | null
  models: WhisperModelInfo[]
  refreshWhisper: () => Promise<void>

  modelProgress: ModelDownloadProgress | null
  transcriptionProgress: Record<string, TranscriptionProgress>

  toasts: Toast[]
  pushToast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  reportError: (title: string, err: unknown) => void
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) throw new Error('useAppState must be used inside <AppStateProvider>')
  return value
}

export function AppStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [screen, setScreen] = useState<Screen>('record')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [recordings, setRecordings] = useState<RecordingMeta[]>([])
  const [openRecordingId, setOpenRecordingId] = useState<string | null>(null)
  const [whisper, setWhisper] = useState<WhisperEnvironment | null>(null)
  const [models, setModels] = useState<WhisperModelInfo[]>([])
  const [modelProgress, setModelProgress] = useState<ModelDownloadProgress | null>(null)
  const [transcriptionProgress, setTranscriptionProgress] = useState<Record<string, TranscriptionProgress>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(1)

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = toastId.current++
    setToasts((prev) => [...prev.slice(-4), { ...t, id }])
    if (t.kind === 'success' || t.kind === 'info') {
      window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6000)
    }
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const reportError = useCallback(
    (title: string, err: unknown) => {
      const { message, hint } = describeError(err)
      console.error(`[brain-rotter] ${title}:`, err)
      pushToast(hint ? { kind: 'error', title, message, hint } : { kind: 'error', title, message })
    },
    [pushToast]
  )

  const refreshRecordings = useCallback(async () => {
    const list = await tryCall('recordings:list')
    if (list) setRecordings(list)
  }, [])

  const refreshWhisper = useCallback(async () => {
    const [env, list] = await Promise.all([tryCall('whisper:getEnvironment'), tryCall('whisper:listModels')])
    if (env) setWhisper(env)
    if (list) setModels(list)
  }, [])

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        setSettings(await call('settings:update', patch))
      } catch (err) {
        reportError('Could not save settings', err)
      }
    },
    [reportError]
  )

  const openRecording = useCallback((id: string) => {
    setOpenRecordingId(id)
    setScreen('playback')
  }, [])

  const goTo = useCallback((next: Screen) => setScreen(next), [])

  /* ------------------------- bootstrap + events ------------------------- */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await call('settings:get')
        if (!cancelled) setSettings(loaded)
      } catch (err) {
        reportError('Could not load settings', err)
        if (!cancelled) {
          setSettings({
            videoFolder: '',
            webviewUrl: '',
            whisperModel: 'base.en',
            whisperBinaryPath: '',
            storageRoot: '',
            brainRotPanels: ['video', 'flappy'],
            splitRatio: 0.5,
            brainRotSplitRatio: 0.5
          })
        }
      }
      await Promise.all([refreshRecordings(), refreshWhisper()])
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshRecordings, refreshWhisper, reportError])

  useEffect(() => {
    const offRecordings = onEvent('event:recordingsChanged', (list) => setRecordings(list))

    const offTranscribe = onEvent('event:transcriptionProgress', (p) => {
      setTranscriptionProgress((prev) => ({ ...prev, [p.recordingId]: p }))
      if (p.state === 'error') {
        pushToast({ kind: 'error', title: 'Transcription failed', message: p.message })
      } else if (p.state === 'done') {
        pushToast({ kind: 'success', title: 'Transcription finished', message: p.message })
      }
    })

    const offModel = onEvent('event:modelDownloadProgress', (p) => {
      setModelProgress(p.state === 'done' ? null : p)
      if (p.state === 'done') {
        pushToast({ kind: 'success', title: 'Model ready', message: `${p.model} downloaded.` })
        void refreshWhisper()
      } else if (p.state === 'error') {
        pushToast({ kind: 'error', title: 'Model download failed', message: p.message ?? 'Unknown error' })
      }
    })

    const offMainError = onEvent('event:mainError', ({ title, message }) => {
      pushToast({ kind: 'error', title, message })
    })

    const onUnhandled = (e: PromiseRejectionEvent): void => {
      e.preventDefault()
      const { message } = describeError(e.reason)
      pushToast({ kind: 'error', title: 'Unexpected error', message })
    }
    window.addEventListener('unhandledrejection', onUnhandled)

    return () => {
      offRecordings()
      offTranscribe()
      offModel()
      offMainError()
      window.removeEventListener('unhandledrejection', onUnhandled)
    }
  }, [pushToast, refreshWhisper])

  const value = useMemo<AppStateValue>(
    () => ({
      ready,
      screen,
      goTo,
      settings,
      saveSettings,
      recordings,
      refreshRecordings,
      openRecordingId,
      openRecording,
      whisper,
      models,
      refreshWhisper,
      modelProgress,
      transcriptionProgress,
      toasts,
      pushToast,
      dismissToast,
      reportError
    }),
    [
      ready,
      screen,
      goTo,
      settings,
      saveSettings,
      recordings,
      refreshRecordings,
      openRecordingId,
      openRecording,
      whisper,
      models,
      refreshWhisper,
      modelProgress,
      transcriptionProgress,
      toasts,
      pushToast,
      dismissToast,
      reportError
    ]
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}
