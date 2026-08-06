import { useAppState } from '../state/AppState'

export function ToastStack(): React.JSX.Element | null {
  const { toasts, dismissToast } = useAppState()
  if (toasts.length === 0) return null

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.message && <p>{t.message}</p>}
            {t.hint && <p className="toast-hint">{t.hint}</p>}
          </div>
          <button type="button" className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            &times;
          </button>
        </div>
      ))}
    </div>
  )
}
