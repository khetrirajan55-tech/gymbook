import { z } from 'zod'
import { ALL_STORES, readTx, writeTx, DB_VERSION } from './db'
import type { Settings } from '@/domain/types'
import { DEFAULT_SETTINGS } from './services/settings'
import { isISODate, isValidTimezone } from '@/domain/dates'
import { emitChange } from './events'
import { logActivity } from './repo'

export const BACKUP_FORMAT = 'gymbook-backup'
export const BACKUP_VERSION = 1

const base = {
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  rev: z.number().int().min(0),
  sample: z.boolean().optional(),
}
const isoDate = z.string().refine(isISODate, 'invalid date')
const paise = z.number().int()
const method = z.enum(['cash', 'upi', 'bank', 'card'])

const memberS = z.object({
  ...base,
  name: z.string().min(1),
  phone: z.string(),
  email: z.string().optional(),
  joiningDate: isoDate,
  status: z.enum(['active', 'archived']),
  notes: z.string().optional(),
  photoDataUrl: z.string().optional(),
  photoHash: z.string().optional(),
  trainerId: z.string().optional(),
  archivedAt: z.string().optional(),
  memberCode: z.string().optional(),
  dateOfBirth: z.string().optional(),
  gender: z.enum(['female', 'male', 'other']).optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
  heightCm: z.number().positive().optional(),
  weightKg: z.number().positive().optional(),
  goal: z.string().optional(),
  healthNotes: z.string().optional(),
  workoutPlanId: z.string().optional(),
})
const sessionS = z.object({
  ...base,
  trainerId: z.string(),
  memberId: z.string(),
  startAt: z.string(),
  durationMinutes: z.number().int().min(5).max(480),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
  note: z.string().optional(),
  statusChangedAt: z.string().optional(),
})
const equipmentS = z.object({
  ...base,
  name: z.string().min(1),
  category: z.string(),
  status: z.enum(['ok', 'needs_service', 'out_of_order']),
  location: z.string().optional(),
  serial: z.string().optional(),
  purchasedOn: z.string().optional(),
  notes: z.string().optional(),
  archived: z.boolean(),
})
const incidentS = z.object({
  ...base,
  equipmentId: z.string(),
  title: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']),
  status: z.enum(['open', 'in_progress', 'resolved']),
  reportedAt: z.string(),
  reportedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolution: z.string().optional(),
  note: z.string().optional(),
})
const workoutS = z.object({
  ...base,
  name: z.string().min(1),
  goal: z.string(),
  source: z.enum(['library', 'custom']),
  description: z.string().optional(),
  days: z.array(z.object({ title: z.string(), exercises: z.array(z.object({ name: z.string(), sets: z.number().int().min(1), reps: z.string(), note: z.string().optional() })) })),
  archived: z.boolean(),
})
const planS = z.object({
  ...base,
  name: z.string().min(1),
  durationValue: z.number().int().min(1),
  durationUnit: z.enum(['days', 'months']),
  pricePaise: paise.min(0),
  description: z.string().optional(),
  archived: z.boolean(),
})
const membershipS = z.object({
  ...base,
  memberId: z.string(),
  planId: z.string(),
  planName: z.string(),
  durationValue: z.number().int().min(1),
  durationUnit: z.enum(['days', 'months']),
  startDate: isoDate,
  endDate: isoDate,
  listPricePaise: paise.min(0),
  discountPaise: paise.min(0),
  pricePaise: paise.min(0),
  invoiceId: z.string(),
  renewalOfId: z.string().optional(),
  note: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
})
const invoiceS = z.object({
  ...base,
  number: z.string().min(1),
  memberId: z.string(),
  membershipId: z.string().optional(),
  issueDate: isoDate,
  lines: z.array(z.object({ description: z.string(), quantity: z.number(), unitPricePaise: paise, amountPaise: paise })),
  subtotalPaise: paise,
  discountPaise: paise,
  totalPaise: paise,
  status: z.enum(['issued', 'void']),
  voidedAt: z.string().optional(),
  voidReason: z.string().optional(),
  note: z.string().optional(),
})
const adjustmentS = z.object({ ...base, invoiceId: z.string(), memberId: z.string(), amountPaise: paise, reason: z.string() })
const paymentS = z.object({
  ...base,
  memberId: z.string(),
  invoiceId: z.string().optional(),
  amountPaise: paise.positive(),
  method,
  receivedAt: z.string(),
  reference: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['recorded', 'void']),
  voidedAt: z.string().optional(),
  voidReason: z.string().optional(),
})
const attendanceS = z.object({
  ...base,
  memberId: z.string(),
  checkInAt: z.string(),
  checkOutAt: z.string().nullable(),
  source: z.literal('manual'),
  note: z.string().optional(),
  overrideReason: z.string().optional(),
})
const trainerS = z.object({
  ...base,
  name: z.string().min(1),
  phone: z.string(),
  email: z.string().optional(),
  specialty: z.string(),
  notes: z.string().optional(),
  status: z.enum(['active', 'archived']),
  archivedAt: z.string().optional(),
})
const scheduleS = z.object({
  ...base,
  trainerId: z.string(),
  weekday: z.number().int().min(0).max(6),
  startMinutes: z.number().int().min(0).max(1440),
  endMinutes: z.number().int().min(0).max(1440),
  label: z.string(),
})
const expenseS = z.object({
  ...base,
  date: isoDate,
  category: z.enum(['rent', 'salary', 'equipment', 'maintenance', 'utilities', 'marketing', 'supplies', 'other']),
  amountPaise: paise.positive(),
  method,
  vendor: z.string().optional(),
  note: z.string().optional(),
})
const followupS = z.object({
  ...base,
  type: z.enum(['expiry', 'payment', 'lead', 'other']),
  memberId: z.string().optional(),
  leadName: z.string().optional(),
  leadPhone: z.string().optional(),
  leadEmail: z.string().optional(),
  dueDate: isoDate,
  assignee: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['open', 'done']),
  completedAt: z.string().optional(),
})
const settingsS = z.object({
  id: z.literal('settings'),
  rev: z.number().int(),
  updatedAt: z.string(),
  gymName: z.string(),
  logoDataUrl: z.string().optional(),
  address: z.string(),
  phone: z.string(),
  email: z.string(),
  currency: z.literal('INR'),
  timezone: z.string().refine(isValidTimezone, 'unknown timezone'),
  invoicePrefix: z.string(),
  invoiceFooter: z.string(),
  gstin: z.string().optional(),
  dataMode: z.enum(['unset', 'sample', 'empty']),
})
const activityS = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.string(),
  message: z.string(),
  memberId: z.string().optional(),
  refType: z.string().optional(),
  refId: z.string().optional(),
})
const photoS = z.object({ id: z.string().min(1), dataUrl: z.string().min(1), hash: z.string().min(1), updatedAt: z.string() })
const counterS = z.object({ key: z.string(), value: z.number().int().min(0) })

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  dbVersion: z.number().int().optional(),
  data: z.object({
    members: z.array(memberS),
    /** Full-size member photos. Absent in backups made before photos were stored apart, and in the Drive data file. */
    photos: z.array(photoS).optional().default([]),
    plans: z.array(planS),
    memberships: z.array(membershipS),
    invoices: z.array(invoiceS),
    adjustments: z.array(adjustmentS),
    payments: z.array(paymentS),
    attendance: z.array(attendanceS),
    trainers: z.array(trainerS),
    schedules: z.array(scheduleS),
    expenses: z.array(expenseS),
    followups: z.array(followupS),
    sessions: z.array(sessionS).optional().default([]),
    equipment: z.array(equipmentS).optional().default([]),
    incidents: z.array(incidentS).optional().default([]),
    workouts: z.array(workoutS).optional().default([]),
    settings: settingsS.nullable(),
    activity: z.array(activityS),
    counters: z.array(counterS),
  }),
})

export type Backup = z.infer<typeof backupSchema>

/**
 * Everything in the database as one object. `photos: false` leaves the full-size pictures out, for
 * callers that only need the records (the Drive backup sends pictures separately, once each).
 */
export async function exportBackup(options: { photos?: boolean } = {}): Promise<Backup> {
  const withPhotos = options.photos !== false
  return readTx(ALL_STORES, async (tx) => {
    const settings = (await tx.objectStore('settings').get('settings')) ?? null
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      dbVersion: DB_VERSION,
      data: {
        members: await tx.objectStore('members').getAll(),
        photos: withPhotos ? await tx.objectStore('photos').getAll() : [],
        plans: await tx.objectStore('plans').getAll(),
        memberships: await tx.objectStore('memberships').getAll(),
        invoices: await tx.objectStore('invoices').getAll(),
        adjustments: await tx.objectStore('adjustments').getAll(),
        payments: await tx.objectStore('payments').getAll(),
        attendance: await tx.objectStore('attendance').getAll(),
        trainers: await tx.objectStore('trainers').getAll(),
        schedules: await tx.objectStore('schedules').getAll(),
        expenses: await tx.objectStore('expenses').getAll(),
        followups: await tx.objectStore('followups').getAll(),
        sessions: await tx.objectStore('sessions').getAll(),
        equipment: await tx.objectStore('equipment').getAll(),
        incidents: await tx.objectStore('incidents').getAll(),
        workouts: await tx.objectStore('workouts').getAll(),
        settings: settings as Settings | null,
        activity: await tx.objectStore('activity').getAll(),
        counters: await tx.objectStore('counters').getAll(),
      },
    } satisfies Backup
  })
}

export interface ImportPreview {
  ok: boolean
  errors: string[]
  warnings: string[]
  counts: Record<string, number>
  exportedAt?: string
  gymName?: string
  backup?: Backup
}

/** Parse and validate a backup file. Never touches the database. */
export function validateBackup(text: string): ImportPreview {
  const errors: string[] = []
  const warnings: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'], warnings, counts: {} }
  }
  const result = backupSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    if (result.error.issues.length > 8) issues.push(`…and ${result.error.issues.length - 8} more`)
    const isFormat = result.error.issues.some((i) => i.path[0] === 'format' || i.path[0] === 'version')
    return {
      ok: false,
      errors: [isFormat ? 'This is not a GymBook backup file (wrong format or version).' : 'The backup contains invalid records.', ...issues],
      warnings,
      counts: {},
    }
  }
  const b = result.data
  const d = b.data
  const ids = (list: { id: string }[]) => new Set(list.map((x) => x.id))
  const memberIds = ids(d.members)
  const planIds = ids(d.plans)
  const invoiceIds = ids(d.invoices)
  const trainerIds = ids(d.trainers)
  const membershipIds = ids(d.memberships)

  const dup = (list: { id: string }[], label: string) => {
    const seen = new Set<string>()
    for (const x of list) {
      if (seen.has(x.id)) errors.push(`${label}: duplicate id ${x.id}`)
      seen.add(x.id)
    }
  }
  dup(d.members, 'members')
  dup(d.plans, 'plans')
  dup(d.memberships, 'memberships')
  dup(d.invoices, 'invoices')
  dup(d.payments, 'payments')
  dup(d.attendance, 'attendance')

  for (const m of d.memberships) {
    if (!memberIds.has(m.memberId)) errors.push(`membership ${m.id} refers to missing member ${m.memberId}`)
    if (!planIds.has(m.planId)) warnings.push(`membership ${m.id} refers to a plan that no longer exists (snapshot kept)`)
    if (!invoiceIds.has(m.invoiceId)) errors.push(`membership ${m.id} refers to missing invoice ${m.invoiceId}`)
    if (m.endDate < m.startDate) errors.push(`membership ${m.id} ends before it starts`)
  }
  for (const i of d.invoices) {
    if (!memberIds.has(i.memberId)) errors.push(`invoice ${i.number} refers to missing member ${i.memberId}`)
    if (i.membershipId && !membershipIds.has(i.membershipId)) warnings.push(`invoice ${i.number} refers to a missing membership`)
  }
  const numbers = new Set<string>()
  for (const i of d.invoices) {
    if (numbers.has(i.number)) errors.push(`duplicate invoice number ${i.number}`)
    numbers.add(i.number)
  }
  const invoiceMember = new Map(d.invoices.map((i) => [i.id, i.memberId]))
  for (const p of d.payments) {
    if (!memberIds.has(p.memberId)) errors.push(`payment ${p.id} refers to missing member ${p.memberId}`)
    if (p.invoiceId && !invoiceIds.has(p.invoiceId)) errors.push(`payment ${p.id} refers to missing invoice ${p.invoiceId}`)
    else if (p.invoiceId && invoiceMember.get(p.invoiceId) !== p.memberId) errors.push(`payment ${p.id} is linked to an invoice that belongs to a different member`)
  }
  for (const a of d.adjustments) {
    if (!invoiceIds.has(a.invoiceId)) errors.push(`adjustment ${a.id} refers to missing invoice ${a.invoiceId}`)
  }
  for (const a of d.attendance) {
    if (!memberIds.has(a.memberId)) errors.push(`attendance ${a.id} refers to missing member ${a.memberId}`)
  }
  for (const s of d.schedules) {
    if (!trainerIds.has(s.trainerId)) errors.push(`schedule ${s.id} refers to missing trainer ${s.trainerId}`)
    if (s.endMinutes <= s.startMinutes) errors.push(`schedule ${s.id} ends before it starts`)
  }
  for (const f of d.followups) {
    if (f.memberId && !memberIds.has(f.memberId)) errors.push(`follow-up ${f.id} refers to missing member ${f.memberId}`)
  }
  const equipmentIds = ids(d.equipment)
  const workoutIds = ids(d.workouts)
  for (const s of d.sessions) {
    if (!memberIds.has(s.memberId)) errors.push(`session ${s.id} refers to missing member ${s.memberId}`)
    if (!trainerIds.has(s.trainerId)) errors.push(`session ${s.id} refers to missing trainer ${s.trainerId}`)
  }
  for (const i of d.incidents) {
    if (!equipmentIds.has(i.equipmentId)) errors.push(`incident ${i.id} refers to missing equipment ${i.equipmentId}`)
  }
  for (const m of d.members) {
    if (m.workoutPlanId && !workoutIds.has(m.workoutPlanId)) warnings.push(`member ${m.name} refers to a missing workout plan; the assignment will be cleared`)
  }
  const codes = new Set<string>()
  for (const m of d.members) {
    if (m.memberCode) {
      if (codes.has(m.memberCode)) errors.push(`duplicate member code ${m.memberCode}`)
      codes.add(m.memberCode)
    }
  }
  for (const m of d.members) {
    if (m.trainerId && !trainerIds.has(m.trainerId)) warnings.push(`member ${m.name} is assigned to a missing trainer; assignment will be kept but unresolved`)
  }
  // Counter must be at least the highest sequence already used, otherwise new invoice numbers could collide.
  const maxSeq = d.invoices.reduce((max, i) => {
    const n = Number(i.number.split('-').pop())
    return Number.isFinite(n) ? Math.max(max, n) : max
  }, 0)
  const counter = d.counters.find((c) => c.key === 'invoice')?.value ?? 0
  if (counter < maxSeq) warnings.push(`invoice counter (${counter}) is behind the highest invoice number (${maxSeq}); it will be raised to ${maxSeq}`)

  const counts: Record<string, number> = {
    members: d.members.length,
    photos: d.photos.length || d.members.filter((m) => m.photoDataUrl || m.photoHash).length,
    plans: d.plans.length,
    memberships: d.memberships.length,
    invoices: d.invoices.length,
    payments: d.payments.length,
    attendance: d.attendance.length,
    trainers: d.trainers.length,
    expenses: d.expenses.length,
    followups: d.followups.length,
    sessions: d.sessions.length,
    equipment: d.equipment.length,
    incidents: d.incidents.length,
    workouts: d.workouts.length,
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts,
    exportedAt: b.exportedAt,
    gymName: d.settings?.gymName,
    backup: errors.length === 0 ? b : undefined,
  }
}

/** Replace every store with the backup contents in a single transaction. */
export async function importBackup(backup: Backup): Promise<void> {
  const d = backup.data
  const maxSeq = d.invoices.reduce((max, i) => {
    const n = Number(i.number.split('-').pop())
    return Number.isFinite(n) ? Math.max(max, n) : max
  }, 0)
  await writeTx(ALL_STORES, async (tx) => {
    for (const store of ALL_STORES) await tx.objectStore(store).clear()
    const putAll = async <S extends (typeof ALL_STORES)[number]>(store: S, rows: unknown[]) => {
      const os = tx.objectStore(store) as unknown as { put: (v: unknown) => Promise<unknown> }
      for (const r of rows) await os.put(r)
    }
    const workoutIdSet = new Set(d.workouts.map((w) => w.id))
    await putAll('members', d.members.map((m) => (m.workoutPlanId && !workoutIdSet.has(m.workoutPlanId) ? { ...m, workoutPlanId: undefined } : m)))
    const memberIdSet = new Set(d.members.map((m) => m.id))
    await putAll('photos', d.photos.filter((p) => memberIdSet.has(p.id)))
    await putAll('plans', d.plans)
    await putAll('memberships', d.memberships)
    await putAll('invoices', d.invoices)
    await putAll('adjustments', d.adjustments)
    await putAll('payments', d.payments)
    await putAll('attendance', d.attendance)
    await putAll('trainers', d.trainers)
    await putAll('schedules', d.schedules)
    await putAll('expenses', d.expenses)
    await putAll('followups', d.followups)
    await putAll('sessions', d.sessions)
    await putAll('equipment', d.equipment)
    await putAll('incidents', d.incidents)
    await putAll('workouts', d.workouts)
    await putAll('activity', d.activity)
    const maxCode = d.members.reduce((max, m) => {
      const n = Number(m.memberCode?.split('-').pop())
      return Number.isFinite(n) ? Math.max(max, n) : max
    }, 0)
    const counters = d.counters.map((c) => (c.key === 'invoice' ? { ...c, value: Math.max(c.value, maxSeq) } : c.key === 'member' ? { ...c, value: Math.max(c.value, maxCode) } : c))
    if (!counters.some((c) => c.key === 'invoice')) counters.push({ key: 'invoice', value: maxSeq })
    if (!counters.some((c) => c.key === 'member')) counters.push({ key: 'member', value: maxCode })
    await putAll('counters', counters)
    const settings: Settings = { ...DEFAULT_SETTINGS, ...(d.settings ?? {}), id: 'settings', dataMode: d.settings?.dataMode === 'unset' ? 'empty' : (d.settings?.dataMode ?? 'empty') }
    await tx.objectStore('settings').put(settings)
    await logActivity(tx, { kind: 'system', message: `Restored backup exported ${backup.exportedAt}` })
  })
  emitChange(ALL_STORES)
}
