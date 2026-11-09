import { readTx } from './db'
import { subscribe } from './events'
import type { Adjustment, Attendance, FollowUp, Invoice, Member, Membership, Payment, Plan, WorkoutPlan } from '@/domain/types'

export interface Snapshot {
  members: Member[]
  plans: Plan[]
  memberships: Membership[]
  invoices: Invoice[]
  adjustments: Adjustment[]
  payments: Payment[]
  attendance: Attendance[]
  followups: FollowUp[]
  workouts: WorkoutPlan[]
}

export const SNAPSHOT_STORES = ['members', 'plans', 'memberships', 'invoices', 'adjustments', 'payments', 'attendance', 'followups', 'workouts'] as const
/** The stores a page depends on when it does not read visits. */
export const SNAPSHOT_STORES_WITHOUT_VISITS = SNAPSHOT_STORES.filter((s) => s !== 'attendance')

export interface SnapshotOptions {
  /**
   * Which visits to read. Visits are by far the largest store (one row per check-in, for ever), and
   * reading all of them took seconds on a large gym, so a page that does not show visits leaves
   * them out, and a member's own page reads only that member's.
   */
  attendance?: 'all' | 'none' | { memberId: string }
}

/**
 * Pages share one in-memory copy of the stores. Reading them from IndexedDB costs a few hundred
 * milliseconds on a phone with a few thousand bills, and every page used to do it on open; now only
 * the first page after a change does. Any write (this tab or another) empties the cache.
 */
const cache = new Map<'all' | 'none', Promise<Snapshot>>()
let watching = false
function watchChanges(): void {
  if (watching) return
  watching = true
  subscribe((e) => {
    if (e.stores.some((s) => (SNAPSHOT_STORES as readonly string[]).includes(s))) cache.clear()
  })
}

/** Load every store the app's views are derived from, in one read transaction. */
export async function loadSnapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
  const visits = options.attendance ?? 'all'
  watchChanges()
  if (typeof visits === 'object') {
    const base = await loadSnapshot({ attendance: 'none' })
    const attendance = await readTx(['attendance'], (tx) => tx.objectStore('attendance').index('memberId').getAll(visits.memberId))
    return { ...base, attendance }
  }
  let pending = cache.get(visits)
  if (!pending && visits === 'none' && cache.has('all')) pending = cache.get('all')!.then((s) => ({ ...s, attendance: [] }))
  if (!pending) {
    pending = readStores(visits).catch((err: unknown) => {
      cache.delete(visits)
      throw err
    })
    cache.set(visits, pending)
  }
  return pending
}

function readStores(visits: 'all' | 'none'): Promise<Snapshot> {
  // All requests go out at once; the transaction answers them in order without a round trip each.
  return readTx([...SNAPSHOT_STORES], async (tx) => {
    const [members, plans, memberships, invoices, adjustments, payments, attendance, followups, workouts] = await Promise.all([
      tx.objectStore('members').getAll(),
      tx.objectStore('plans').getAll(),
      tx.objectStore('memberships').getAll(),
      tx.objectStore('invoices').getAll(),
      tx.objectStore('adjustments').getAll(),
      tx.objectStore('payments').getAll(),
      visits === 'none' ? Promise.resolve([]) : tx.objectStore('attendance').getAll(),
      tx.objectStore('followups').getAll(),
      tx.objectStore('workouts').getAll(),
    ])
    return { members, plans, memberships, invoices, adjustments, payments, attendance, followups, workouts }
  })
}

/** For pages that never show visits or "last visit": everything except the attendance store. */
export function loadSnapshotWithoutVisits(): Promise<Snapshot> {
  return loadSnapshot({ attendance: 'none' })
}

export function groupBy<T>(list: T[], key: (x: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const x of list) {
    const k = key(x)
    if (k === undefined) continue
    const arr = out.get(k)
    if (arr) arr.push(x)
    else out.set(k, [x])
  }
  return out
}
