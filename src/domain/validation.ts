import { z } from 'zod'
import { isISODate, isValidTimezone, addDays, todayInTz, DEFAULT_TIMEZONE } from './dates'
import { parseRupees } from './money'

const trimmed = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`)

export const isoDate = z.string().refine(isISODate, 'Enter a valid date')

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine((v) => /^[+(\d][\d\s()-]{6,19}$/.test(v), 'Enter a valid phone number')
  .refine((v) => v.replace(/\D/g, '').length >= 8 && v.replace(/\D/g, '').length <= 15, 'Phone must have 8 to 15 digits')

export const optionalEmail = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((v) => (v === '' ? undefined : v))
  .refine((v) => v === undefined || z.email().safeParse(v).success, 'Enter a valid email address')

export const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v))

/** Optional body measurement typed by a person: blank → undefined, otherwise a number with at most one decimal. */
export const optionalMeasure = (opts: { min: number; max: number; unit: string; example: string }) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return undefined
      if (!/^\d{1,3}(\.\d)?$/.test(v)) {
        ctx.addIssue({ code: 'custom', message: `Enter a number in ${opts.unit}, like ${opts.example}` })
        return z.NEVER
      }
      const n = Number(v)
      if (n < opts.min || n > opts.max) {
        ctx.addIssue({ code: 'custom', message: `Enter between ${opts.min} and ${opts.max} ${opts.unit}` })
        return z.NEVER
      }
      return n
    })

/** Rupee text typed by a person → paise. */
export const rupeesInput = (opts: { min?: number; max?: number; allowZero?: boolean; label?: string } = {}) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === '' && opts.allowZero) return 0
      const paise = parseRupees(v)
      if (paise === null) {
        ctx.addIssue({ code: 'custom', message: `Enter a valid ${opts.label ?? 'amount'} in rupees` })
        return z.NEVER
      }
      if (paise < 0) {
        ctx.addIssue({ code: 'custom', message: 'Amount cannot be negative' })
        return z.NEVER
      }
      if (!opts.allowZero && paise === 0) {
        ctx.addIssue({ code: 'custom', message: 'Amount must be greater than zero' })
        return z.NEVER
      }
      if (opts.max !== undefined && paise > opts.max) {
        ctx.addIssue({ code: 'custom', message: `Amount must be at most ₹${(opts.max / 100).toLocaleString('en-IN')}` })
        return z.NEVER
      }
      if (opts.min !== undefined && paise < opts.min) {
        ctx.addIssue({ code: 'custom', message: `Amount must be at least ₹${opts.min / 100}` })
        return z.NEVER
      }
      return paise
    })

/** Normalize a phone to digits for duplicate comparison. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

export const memberForm = z.object({
  name: trimmed(80).min(2, 'Name must be at least 2 characters'),
  phone: phoneSchema,
  joiningDate: isoDate.refine((v) => v >= '1950-01-01', 'Joining date looks too far in the past').refine((v) => v <= addDays(todayInTz(DEFAULT_TIMEZONE), 366), 'Joining date can be at most a year ahead'),
  notes: optionalText(1000),
  photoDataUrl: z.string().max(1_500_000, 'Photo is too large; use a smaller image').optional(),
  dateOfBirth: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || (isISODate(v) && v >= '1900-01-01' && v <= todayInTz(DEFAULT_TIMEZONE)), 'Enter a valid date of birth in the past'),
  gender: z
    .enum(['female', 'male', 'other', ''])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
  heightCm: optionalMeasure({ min: 50, max: 250, unit: 'cm', example: '172' }),
  weightKg: optionalMeasure({ min: 20, max: 300, unit: 'kg', example: '68.5' }),
  goal: optionalText(120),
  healthNotes: optionalText(1000),
})
export type MemberFormValues = z.output<typeof memberForm>

export const planForm = z.object({
  name: trimmed(60).min(2, 'Plan name must be at least 2 characters'),
  durationValue: z.coerce.number().int('Use a whole number').min(1, 'Duration must be at least 1').max(3650, 'Duration can be at most 3650'),
  durationUnit: z.enum(['days', 'months']),
  price: rupeesInput({ allowZero: true, label: 'price', max: 1_000_000_000_00 }),
  description: optionalText(300),
})
export type PlanFormValues = z.output<typeof planForm>

export const membershipForm = z
  .object({
    planId: z.string().min(1, 'Choose a plan'),
    startDate: isoDate,
    discount: rupeesInput({ allowZero: true, label: 'discount' }),
    initialPayment: rupeesInput({ allowZero: true, label: 'payment' }),
    paymentMethod: z.enum(['cash', 'upi', 'bank', 'card']),
    note: optionalText(300),
  })
export type MembershipFormValues = z.output<typeof membershipForm>

/** The plan fields on the Add member page. Only checked when a plan is chosen there. */
export const firstPlanForm = z.object({
  planId: z.string().min(1, 'Choose a plan'),
  planStartDate: z.string().refine(isISODate, 'Enter a valid start date'),
  planDiscount: rupeesInput({ allowZero: true, label: 'discount' }),
  planReceived: rupeesInput({ allowZero: true, label: 'payment' }),
  planPaymentMethod: z.enum(['cash', 'upi', 'bank', 'card']),
})
export type FirstPlanValues = z.output<typeof firstPlanForm>

export interface NewMemberValues {
  member: MemberFormValues
  /** Present only when a plan was chosen on the Add member page. */
  plan?: FirstPlanValues
}

/**
 * Add member page: the member fields, plus the plan fields when `planId` is not empty.
 * Both halves are checked in one pass so every mistake shows at once.
 */
export const newMemberForm = {
  safeParse(data: unknown): { success: true; data: NewMemberValues } | { success: false; error: z.ZodError } {
    const member = memberForm.safeParse(data)
    const wantsPlan = typeof data === 'object' && data !== null && typeof (data as { planId?: unknown }).planId === 'string' && (data as { planId: string }).planId !== ''
    const plan = wantsPlan ? firstPlanForm.safeParse(data) : undefined
    if (member.success && (!plan || plan.success)) return { success: true, data: { member: member.data, plan: plan?.data } }
    return { success: false, error: new z.ZodError([...(member.success ? [] : member.error.issues), ...(plan && !plan.success ? plan.error.issues : [])]) }
  },
}

export const paymentForm = z.object({
  amount: rupeesInput({ label: 'amount' }),
  method: z.enum(['cash', 'upi', 'bank', 'card']),
  receivedAt: z.string().min(1, 'Enter when the payment was received'),
  invoiceId: optionalText(80),
  reference: optionalText(80),
  note: optionalText(300),
})
export type PaymentFormValues = z.output<typeof paymentForm>

export const followUpForm = z
  .object({
    type: z.enum(['expiry', 'payment', 'lead', 'other']),
    memberId: optionalText(80),
    leadName: optionalText(80),
    leadPhone: optionalText(20),
    leadEmail: optionalEmail,
    dueDate: isoDate,
    assignee: optionalText(80),
    note: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'lead') {
      if (!v.leadName) ctx.addIssue({ code: 'custom', path: ['leadName'], message: 'Enter the lead’s name' })
    } else if (v.type !== 'other' && !v.memberId) {
      ctx.addIssue({ code: 'custom', path: ['memberId'], message: 'Choose a member' })
    }
  })
  // A lead never carries a member, and a member follow-up never carries lead details.
  .transform((v) => (v.type === 'lead' ? { ...v, memberId: undefined } : v.type === 'other' ? v : { ...v, leadName: undefined, leadPhone: undefined, leadEmail: undefined }))
export type FollowUpFormValues = z.output<typeof followUpForm>

export const workoutExerciseSchema = z.object({
  name: trimmed(80).min(1, 'Exercise name is required'),
  sets: z.coerce.number().int('Whole number').min(1, 'At least 1 set').max(50),
  reps: trimmed(30).min(1, 'Reps or duration is required'),
  note: optionalText(120),
})
export const workoutForm = z.object({
  name: trimmed(80).min(2, 'Plan name must be at least 2 characters'),
  goal: trimmed(80).min(1, 'Enter the goal (e.g. Fat loss, Strength)'),
  description: optionalText(500),
  days: z.array(z.object({ title: trimmed(60).min(1, 'Day title is required'), exercises: z.array(workoutExerciseSchema).min(1, 'Add at least one exercise') })).min(1, 'Add at least one day').max(14),
})
export type WorkoutFormValues = z.output<typeof workoutForm>

export const settingsForm = z.object({
  gymName: trimmed(80).min(1, 'Gym name is required'),
  address: trimmed(300),
  phone: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === '' || /^[+(\d][\d\s()-]{6,19}$/.test(v), 'Enter a valid phone number'),
  email: optionalEmail.transform((v) => v ?? ''),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
  invoicePrefix: trimmed(10).min(1, 'Prefix is required').regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only'),
  invoiceFooter: trimmed(300),
  gstin: optionalText(20),
  logoDataUrl: z.string().max(400_000, 'Logo is too large; use a smaller image').optional(),
})
export type SettingsFormValues = z.output<typeof settingsForm>

/** Flatten zod issues into a { field: message } map for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_form'
    if (!out[key]) out[key] = issue.message
  }
  return out
}
