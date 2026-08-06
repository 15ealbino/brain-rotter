import { app, BrowserWindow, desktopCapturer, session, shell } from 'electron'
import { join } from 'node:path'
import { ensureDirs } from './settings'
import { installMediaProtocolHandler, registerMediaScheme } from './mediaProtocol'
import { broadcast, getSelectedSourceId, registerIpcHandlers } from './ipc'

// Must run before `app.whenReady()`.
registerMediaScheme()

// Chromium refuses to enumerate audio-capable desktop sources on some Linux setups
// unless the PipeWire capturer is explicitly enabled. Harmless elsewhere.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0b12',
    title: 'Brain Rotter',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The brain-rot URL panel is an out-of-process <webview>; it is only ever
      // pointed at a URL the user typed into Settings themselves.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Anything that tries to open a new window goes to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-place navigation of the app shell away from the app itself.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = process.env['ELECTRON_RENDERER_URL'] && url.startsWith(process.env['ELECTRON_RENDERER_URL'])
    if (!isDevServer && !url.startsWith('file://')) {
      event.preventDefault()
      if (url.startsWith('http')) void shell.openExternal(url)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * `navigator.mediaDevices.getDisplayMedia()` in the renderer lands here. We hand
 * back the source the user picked on the record screen, and ask for system audio.
 *
 * - Windows: `audio: 'loopback'` gives real desktop audio.
 * - Linux: the xdg-desktop-portal / PipeWire system picker is used when available,
 *   which is the only way to get system audio on Wayland. If the portal is missing,
 *   the video source still resolves and the renderer falls back to mic-only.
 * - The renderer discards the video track immediately; only audio is kept.
 */
function installDisplayMediaHandler(): void {
  const useSystemPicker = process.platform === 'linux'

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Electron treats this as a one-shot callback: calling it twice throws, so
      // the guard matters more than it looks.
      let answered = false
      const answer = (response: Parameters<typeof callback>[0]): void => {
        if (answered) return
        answered = true
        callback(response)
      }

      const chosen = getSelectedSourceId()
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === chosen) ?? sources[0]
          if (!source) {
            // Cancelling the request surfaces as a NotFoundError in the renderer,
            // which then offers the mic-only fallback.
            answer({})
            return
          }
          // `audio` must be omitted entirely when there is nothing to pass —
          // an explicit `undefined` is rejected by Electron's validation.
          answer(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source })
        })
        .catch((err: unknown) => {
          console.error('[brain-rotter] getSources failed inside display-media handler:', err)
          broadcast('event:mainError', {
            title: 'Screen capture unavailable',
            message:
              err instanceof Error
                ? err.message
                : 'The system could not provide a capture source. Recording will fall back to microphone only.'
          })
          answer({})
        })
    },
    { useSystemPicker }
  )

  // Microphone permission: this is a local, user-initiated recorder, so grant
  // media requests coming from our own renderer and deny anything exotic.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.log('[brain-rotter] another instance is already running; focusing it and exiting.')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    try {
      await ensureDirs()
    } catch (err) {
      console.error('[brain-rotter] could not create storage directories:', err)
    }
    installMediaProtocolHandler()
    installDisplayMediaHandler()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// Never let a stray rejection take the process down silently.
process.on('unhandledRejection', (reason) => {
  console.error('[brain-rotter] unhandled rejection in main:', reason)
  broadcast('event:mainError', {
    title: 'Unexpected background error',
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

process.on('uncaughtException', (err) => {
  console.error('[brain-rotter] uncaught exception in main:', err)
  broadcast('event:mainError', { title: 'Unexpected error', message: err.message })
})
