/** Date-only value in the gym's timezone, formatted YYYY-MM-DD. */
export type ISODate = string
/** Instant in time, ISO 8601 with timezone offset (stored as UTC). */
export type ISODateTime = string
/** Integer minor units (paise for INR). Never a float. */
export type Paise = number

export interface BaseRecord {
  id: string
  createdAt: ISODateTime
  updatedAt: ISODateTime
  /** Optimistic-concurrency revision. Incremented on every write. */
  rev: number
  /** True only for records created by the labelled sample dataset. */
  sample?: boolean
}

export type MemberStatus = 'active' | 'archived'

export type Gender = 'female' | 'male' | 'other'

export interface Member extends BaseRecord {
  name: string
  phone: string
  joiningDate: ISODate
  status: MemberStatus
  notes?: string
  /** A small thumbnail for lists and cards. The full picture lives in the `photos` store under the member's id. */
  photoDataUrl?: string
  /** Fingerprint of the full picture, so a backup can tell which photos Drive already holds. */
  photoHash?: string
  archivedAt?: ISODateTime
  /** Short unique code printed on the member card and accepted by check-in search (e.g. GB-0042). */
  memberCode?: string
  dateOfBirth?: ISODate
  gender?: Gender
  heightCm?: number
  weightKg?: number
  goal?: string
  healthNotes?: string
  workoutPlanId?: string
  /** No longer collected or shown. Kept so records and backups made by earlier versions stay intact. */
  email?: string
  trainerId?: string
  emergencyName?: string
  emergencyPhone?: string
}

/** A member's full-size photo, kept apart from the member record so lists never have to load it. */
export interface MemberPhoto {
  /** The member's id. */
  id: string
  dataUrl: string
  hash: string
  updatedAt: ISODateTime
}

export type SessionStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'

/** A personal-training session between one trainer and one member. */
export interface Session extends BaseRecord {
  trainerId: string
  memberId: string
  startAt: ISODateTime
  durationMinutes: number
  status: SessionStatus
  note?: string
  statusChangedAt?: ISODateTime
}

export type EquipmentStatus = 'ok' | 'needs_service' | 'out_of_order'

export interface Equipment extends BaseRecord {
  name: string
  category: string
  status: EquipmentStatus
  location?: string
  serial?: string
  purchasedOn?: ISODate
  notes?: string
  archived: boolean
}

export type IncidentSeverity = 'low' | 'medium' | 'high'
export type IncidentStatus = 'open' | 'in_progress' | 'resolved'

export interface Incident extends BaseRecord {
  equipmentId: string
  title: string
  severity: IncidentSeverity
  status: IncidentStatus
  reportedAt: ISODateTime
  reportedBy?: string
  resolvedAt?: ISODateTime
  resolution?: string
  note?: string
}

export interface WorkoutExercise {
  name: string
  sets: number
  reps: string
  note?: string
}

export interface WorkoutDay {
  title: string
  exercises: WorkoutExercise[]
}

export interface WorkoutPlan extends BaseRecord {
  name: string
  goal: string
  source: 'library' | 'custom'
  description?: string
  days: WorkoutDay[]
  archived: boolean
}

export type DurationUnit = 'days' | 'months'

export interface Plan extends BaseRecord {
  name: string
  durationValue: number
  durationUnit: DurationUnit
  pricePaise: Paise
  description?: string
  archived: boolean
}

export interface Membership extends BaseRecord {
  memberId: string
  planId: string
  /** Snapshot of the plan at time of sale; survives later plan edits. */
  planName: string
  durationValue: number
  durationUnit: DurationUnit
  startDate: ISODate
  /** Inclusive last day of access. */
  endDate: ISODate
  listPricePaise: Paise
  discountPaise: Paise
  /** Net price actually charged = list − discount. */
  pricePaise: Paise
  invoiceId: string
  renewalOfId?: string
  note?: string
  /** Set when the invoice behind this membership was voided; the membership no longer grants access. */
  cancelledAt?: ISODateTime
  cancelReason?: string
}

export interface InvoiceLine {
  description: string
  quantity: number
  unitPricePaise: Paise
  amountPaise: Paise
}

export type InvoiceStatus = 'issued' | 'void'

export interface Invoice extends BaseRecord {
  number: string
  memberId: string
  membershipId?: string
  issueDate: ISODate
  lines: InvoiceLine[]
  subtotalPaise: Paise
  discountPaise: Paise
  totalPaise: Paise
  status: InvoiceStatus
  voidedAt?: ISODateTime
  voidReason?: string
  note?: string
}

/** Signed correction applied to an invoice after issue. Negative reduces what is owed. */
export interface Adjustment extends BaseRecord {
  invoiceId: string
  memberId: string
  amountPaise: Paise
  reason: string
}

export type PaymentMethod = 'cash' | 'upi' | 'bank' | 'card'
export type PaymentStatus = 'recorded' | 'void'

export interface Payment extends BaseRecord {
  memberId: string
  invoiceId?: string
  amountPaise: Paise
  method: PaymentMethod
  receivedAt: ISODateTime
  reference?: string
  note?: string
  status: PaymentStatus
  voidedAt?: ISODateTime
  voidReason?: string
}

export interface Attendance extends BaseRecord {
  memberId: string
  checkInAt: ISODateTime
  checkOutAt: ISODateTime | null
  source: 'manual'
  note?: string
  /** Set when staff allowed entry despite no valid membership. */
  overrideReason?: string
}

export type TrainerStatus = 'active' | 'archived'

export interface Trainer extends BaseRecord {
  name: string
  phone: string
  email?: string
  specialty: string
  notes?: string
  status: TrainerStatus
  archivedAt?: ISODateTime
}

export interface TrainerSchedule extends BaseRecord {
  trainerId: string
  /** 0 = Sunday … 6 = Saturday */
  weekday: number
  startMinutes: number
  endMinutes: number
  label: string
}

export type ExpenseCategory =
  | 'rent'
  | 'salary'
  | 'equipment'
  | 'maintenance'
  | 'utilities'
  | 'marketing'
  | 'supplies'
  | 'other'

export interface Expense extends BaseRecord {
  date: ISODate
  category: ExpenseCategory
  amountPaise: Paise
  method: PaymentMethod
  vendor?: string
  note?: string
}

export type FollowUpType = 'expiry' | 'payment' | 'lead' | 'other'
export type FollowUpStatus = 'open' | 'done'

export interface FollowUp extends BaseRecord {
  type: FollowUpType
  memberId?: string
  leadName?: string
  leadPhone?: string
  leadEmail?: string
  dueDate: ISODate
  assignee?: string
  note?: string
  status: FollowUpStatus
  completedAt?: ISODateTime
}

export type DataMode = 'unset' | 'sample' | 'empty'

export interface Settings {
  id: 'settings'
  rev: number
  updatedAt: ISODateTime
  gymName: string
  logoDataUrl?: string
  address: string
  phone: string
  email: string
  currency: 'INR'
  timezone: string
  invoicePrefix: string
  invoiceFooter: string
  gstin?: string
  dataMode: DataMode
}

export type ActivityKind =
  | 'member'
  | 'membership'
  | 'payment'
  | 'invoice'
  | 'attendance'
  | 'expense'
  | 'trainer'
  | 'followup'
  | 'session'
  | 'equipment'
  | 'workout'
  | 'system'

export interface Activity {
  id: string
  at: ISODateTime
  kind: ActivityKind
  message: string
  memberId?: string
  refType?: string
  refId?: string
}

export interface Counter {
  key: string
  value: number
}

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
]

export const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other / prefer not to say' },
]

export const FOLLOWUP_TYPES: { value: FollowUpType; label: string }[] = [
  { value: 'expiry', label: 'Membership expiry' },
  { value: 'payment', label: 'Outstanding payment' },
  { value: 'lead', label: 'New lead' },
  { value: 'other', label: 'Other' },
]

export function labelFor<T extends string>(list: { value: T; label: string }[], value: T): string {
  return list.find((x) => x.value === value)?.label ?? value
}
