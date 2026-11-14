// The toaster: what the app (and @wisp/client's command rollback) calls to say something happened.
// Rules from design/ux.md: short, past tense, at most one action (Undo); the same text twice
// shows once; at most three stacked, only the newest in front; errors are red.
import * as toast from '@zag-js/toast';

export type ToastTone = 'info' | 'success' | 'error' | 'loading';

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastOptions {
  /** A second line under the message. */
  readonly description?: string;
  /** ms on screen; errors stay longer by default. */
  readonly duration?: number;
  readonly action?: ToastAction;
}

/** The slice of the toaster a command runner needs to roll back with a red toast. */
export interface RollbackToaster {
  error(message: string, options?: { action?: ToastAction }): string;
}

export interface Toaster extends RollbackToaster {
  show(message: string, options?: ToastOptions & { readonly tone?: ToastTone }): string;
  success(message: string, options?: ToastOptions): string;
  error(message: string, options?: ToastOptions): string;
  dismiss(id?: string): void;
  /** Clear all. */
  clear(): void;
  /** For <Toasts>. */
  readonly store: toast.Store;
}

export interface ToasterOptions {
  /** Most toasts on screen at once (default 3); more wait their turn. */
  readonly max?: number;
  /** Default ms on screen (default 4000; errors 6000). */
  readonly duration?: number;
}

const ERROR_DURATION = 6000;

/** Same tone and text, same id: Zag's store updates the toast in place instead of adding a second. */
const idFor = (tone: ToastTone, message: string): string => `toast:${tone}:${message}`;

export function createToaster(options: ToasterOptions = {}): Toaster {
  const duration = options.duration ?? 4000;
  const store = toast.createStore({ placement: 'bottom', max: options.max ?? 3, overlap: true, duration, gap: 8 });
  const show = (message: string, opts: ToastOptions & { readonly tone?: ToastTone } = {}): string => {
    const tone = opts.tone ?? 'info';
    return store.create({
      id: idFor(tone, message),
      title: message,
      type: tone,
      duration: opts.duration ?? (tone === 'error' ? ERROR_DURATION : duration),
      ...(opts.description === undefined ? {} : { description: opts.description }),
      ...(opts.action === undefined ? {} : { action: { label: opts.action.label, onClick: opts.action.onClick } }),
    });
  };
  return {
    show,
    success: (message, opts) => show(message, { ...opts, tone: 'success' }),
    error: (message, opts) => show(message, { ...opts, tone: 'error' }),
    dismiss: (id) => store.dismiss(id),
    clear: () => store.dismiss(),
    store,
  };
}
