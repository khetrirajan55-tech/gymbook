export type StoreName =
  | 'members'
  | 'photos'
  | 'plans'
  | 'memberships'
  | 'invoices'
  | 'adjustments'
  | 'payments'
  | 'attendance'
  | 'trainers'
  | 'schedules'
  | 'expenses'
  | 'followups'
  | 'sessions'
  | 'equipment'
  | 'incidents'
  | 'workouts'
  | 'settings'
  | 'activity'
  | 'counters'

export interface ChangeEvent {
  stores: StoreName[]
  origin: 'local' | 'remote'
}

type Listener = (e: ChangeEvent) => void

const listeners = new Set<Listener>()
const CHANNEL = 'gymbook-changes'
let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (ev: MessageEvent<{ stores: StoreName[] }>) => {
    const stores = Array.isArray(ev.data?.stores) ? ev.data.stores : []
    for (const l of listeners) l({ stores, origin: 'remote' })
  }
  return channel
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  getChannel()
  return () => listeners.delete(listener)
}

const REVISION_KEY = 'gymbook-data-rev'

/**
 * A counter that goes up every time this browser changes its data. Code that needs to know whether
 * anything changed since some earlier moment (the Drive backup does) can compare two numbers
 * instead of reading the whole database. It lives in localStorage so every tab shares it.
 */
export function dataRevision(): number {
  try {
    return Number(localStorage.getItem(REVISION_KEY)) || 0
  } catch {
    return 0
  }
}

function bumpRevision(): void {
  try {
    localStorage.setItem(REVISION_KEY, String(dataRevision() + 1))
  } catch {
    // Storage blocked: callers fall back to comparing the data itself.
  }
}

/** Notify this tab and every other open tab that stores changed. */
export function emitChange(stores: StoreName[]): void {
  bumpRevision()
  for (const l of listeners) l({ stores, origin: 'local' })
  getChannel()?.postMessage({ stores })
}
