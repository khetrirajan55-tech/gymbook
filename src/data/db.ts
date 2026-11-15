import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import type {
  Activity,
  Adjustment,
  Attendance,
  Counter,
  Equipment,
  Expense,
  FollowUp,
  Incident,
  Invoice,
  Member,
  MemberPhoto,
  Membership,
  Payment,
  Plan,
  Session,
  Settings,
  Trainer,
  TrainerSchedule,
  WorkoutPlan,
} from '@/domain/types'
import { StorageError, toStorageError } from './errors'
import { consumeSaveFailure } from './failpoint'
import { emitChange, type StoreName } from './events'

export interface GymDB extends DBSchema {
  members: { key: string; value: Member; indexes: { status: string; name: string } }
  photos: { key: string; value: MemberPhoto }
  plans: { key: string; value: Plan }
  memberships: { key: string; value: Membership; indexes: { memberId: string; endDate: string; startDate: string } }
  invoices: { key: string; value: Invoice; indexes: { memberId: string; number: string; issueDate: string } }
  adjustments: { key: string; value: Adjustment; indexes: { invoiceId: string; memberId: string } }
  payments: { key: string; value: Payment; indexes: { memberId: string; invoiceId: string; receivedAt: string } }
  attendance: { key: string; value: Attendance; indexes: { memberId: string; checkInAt: string } }
  trainers: { key: string; value: Trainer }
  schedules: { key: string; value: TrainerSchedule; indexes: { trainerId: string } }
  expenses: { key: string; value: Expense; indexes: { date: string } }
  followups: { key: string; value: FollowUp; indexes: { dueDate: string; status: string; memberId: string } }
  sessions: { key: string; value: Session; indexes: { trainerId: string; memberId: string; startAt: string } }
  equipment: { key: string; value: Equipment }
  incidents: { key: string; value: Incident; indexes: { equipmentId: string; status: string } }
  workouts: { key: string; value: WorkoutPlan }
  settings: { key: string; value: Settings }
  activity: { key: string; value: Activity; indexes: { at: string } }
  counters: { key: string; value: Counter }
}

export const DB_NAME = 'gymbook'
export const DB_VERSION = 3

export const ALL_STORES: StoreName[] = [
  'members',
  'photos',
  'plans',
  'memberships',
  'invoices',
  'adjustments',
  'payments',
  'attendance',
  'trainers',
  'schedules',
  'expenses',
  'followups',
  'sessions',
  'equipment',
  'incidents',
  'workouts',
  'settings',
  'activity',
  'counters',
]

let dbPromise: Promise<IDBPDatabase<GymDB>> | null = null

export function getDb(): Promise<IDBPDatabase<GymDB>> {
  if (!dbPromise) {
    dbPromise = open().catch((err) => {
      dbPromise = null
      throw toStorageError(err)
    })
  }
  return dbPromise
}

async function open(): Promise<IDBPDatabase<GymDB>> {
  if (typeof indexedDB === 'undefined') {
    throw new StorageError('unavailable', 'This browser does not support IndexedDB, which GymBook needs to store data.')
  }
  const db = await openDB<GymDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
      const members = db.createObjectStore('members', { keyPath: 'id' })
      members.createIndex('status', 'status')
      members.createIndex('name', 'name')
      db.createObjectStore('plans', { keyPath: 'id' })
      const memberships = db.createObjectStore('memberships', { keyPath: 'id' })
      memberships.createIndex('memberId', 'memberId')
      memberships.createIndex('endDate', 'endDate')
      memberships.createIndex('startDate', 'startDate')
      const invoices = db.createObjectStore('invoices', { keyPath: 'id' })
      invoices.createIndex('memberId', 'memberId')
      invoices.createIndex('number', 'number', { unique: true })
      invoices.createIndex('issueDate', 'issueDate')
      const adjustments = db.createObjectStore('adjustments', { keyPath: 'id' })
      adjustments.createIndex('invoiceId', 'invoiceId')
      adjustments.createIndex('memberId', 'memberId')
      const payments = db.createObjectStore('payments', { keyPath: 'id' })
      payments.createIndex('memberId', 'memberId')
      payments.createIndex('invoiceId', 'invoiceId')
      payments.createIndex('receivedAt', 'receivedAt')
      const attendance = db.createObjectStore('attendance', { keyPath: 'id' })
      attendance.createIndex('memberId', 'memberId')
      attendance.createIndex('checkInAt', 'checkInAt')
      db.createObjectStore('trainers', { keyPath: 'id' })
      const schedules = db.createObjectStore('schedules', { keyPath: 'id' })
      schedules.createIndex('trainerId', 'trainerId')
      const expenses = db.createObjectStore('expenses', { keyPath: 'id' })
      expenses.createIndex('date', 'date')
      const followups = db.createObjectStore('followups', { keyPath: 'id' })
      followups.createIndex('dueDate', 'dueDate')
      followups.createIndex('status', 'status')
      followups.createIndex('memberId', 'memberId')
      db.createObjectStore('settings', { keyPath: 'id' })
      const activity = db.createObjectStore('activity', { keyPath: 'id' })
      activity.createIndex('at', 'at')
      db.createObjectStore('counters', { keyPath: 'key' })
      }
      if (oldVersion < 2) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
        sessions.createIndex('trainerId', 'trainerId')
        sessions.createIndex('memberId', 'memberId')
        sessions.createIndex('startAt', 'startAt')
        db.createObjectStore('equipment', { keyPath: 'id' })
        const incidents = db.createObjectStore('incidents', { keyPath: 'id' })
        incidents.createIndex('equipmentId', 'equipmentId')
        incidents.createIndex('status', 'status')
        db.createObjectStore('workouts', { keyPath: 'id' })
        // Give every existing member a code, continuing a fresh counter.
        void (async () => {
          const members = tx.objectStore('members')
          const counters = tx.objectStore('counters')
          let n = (await counters.get('member'))?.value ?? 0
          let cursor = await members.openCursor()
          while (cursor) {
            const m = cursor.value
            if (!m.memberCode) {
              n += 1
              await cursor.update({ ...m, memberCode: `GB-${String(n).padStart(4, '0')}` })
            }
            cursor = await cursor.continue()
          }
          if (n > 0) await counters.put({ key: 'member', value: n })
        })()
      }
      if (oldVersion < 3) {
        // Full-size member photos move out of the member records (see services/photos.ts for the move itself).
        db.createObjectStore('photos', { keyPath: 'id' })
      }
    },
    blocked() {
      // Another tab holds an older version open; the user is told via the error path.
    },
    blocking() {
      // A newer version wants to open elsewhere: close so the upgrade can proceed.
      db.close()
      dbPromise = null
    },
    terminated() {
      dbPromise = null
    },
  })
  return db
}

export type ReadTx<S extends StoreNames<GymDB>> = IDBPTransaction<GymDB, S[], 'readonly'>
export type WriteTx<S extends StoreNames<GymDB>> = IDBPTransaction<GymDB, S[], 'readwrite'>

/**
 * Run a read-write transaction. All dependent writes happen inside one IDB
 * transaction so either everything commits or nothing does. After commit,
 * change events are emitted to this and other tabs.
 */
export async function writeTx<S extends StoreNames<GymDB>, T>(
  stores: S[],
  fn: (tx: WriteTx<S>) => Promise<T>,
): Promise<T> {
  const db = await getDb()
  if (consumeSaveFailure()) {
    throw new StorageError('simulated', 'Simulated storage failure: nothing was saved.')
  }
  let tx: WriteTx<S>
  try {
    tx = db.transaction(stores, 'readwrite')
  } catch (err) {
    throw toStorageError(err)
  }
  // Swallow the rejection of tx.done on abort; the thrown error is what callers see.
  void tx.done.catch(() => {})
  try {
    const result = await fn(tx)
    await tx.done
    emitChange(stores as StoreName[])
    return result
  } catch (err) {
    try {
      tx.abort()
    } catch {
      // already aborted/finished
    }
    throw toStorageError(err)
  }
}

export async function readTx<S extends StoreNames<GymDB>, T>(stores: S[], fn: (tx: ReadTx<S>) => Promise<T>): Promise<T> {
  const db = await getDb()
  try {
    const tx = db.transaction(stores, 'readonly')
    void tx.done.catch(() => {})
    const result = await fn(tx)
    await tx.done
    return result
  } catch (err) {
    throw toStorageError(err)
  }
}

/** Close and forget the cached connection (used by reset and tests). */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return
  const db = await dbPromise.catch(() => null)
  db?.close()
  dbPromise = null
}

export async function deleteDatabase(): Promise<void> {
  await closeDb()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(toStorageError(req.error))
    req.onblocked = () => reject(new StorageError('blocked', 'Close other GymBook tabs, then try the reset again.'))
  })
  emitChange(ALL_STORES)
}
