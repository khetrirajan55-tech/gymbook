import { readTx, writeTx } from '../db'
import { logActivity, stampNew, withIdempotency, type AnyWriteTx } from '../repo'
import type { Member, Membership, Plan, Payment, PaymentMethod, ISODate, Paise } from '@/domain/types'
import type { MemberFormValues } from '@/domain/validation'
import { insertMember } from './members'
import { membershipEndDate, addDays, compareDates, formatDate, formatSpan, todayInTz, DEFAULT_TIMEZONE } from '@/domain/dates'
import { formatINR } from '@/domain/money'
import { DomainError } from '../errors'
import { buildInvoice, nextInvoiceNumber } from './invoicing'
import { nowIso } from '@/domain/ids'

export interface AssignMembershipInput {
  memberId: string
  planId: string
  startDate: ISODate
  discountPaise: Paise
  initialPaymentPaise: Paise
  paymentMethod: PaymentMethod
  note?: string
  renewalOfId?: string
  requestKey?: string
  /** The gym's current date; the invoice is issued on the day of sale, not the start date. */
  issueDate?: ISODate
}

export interface AssignMembershipResult {
  membership: Membership
  invoiceId: string
  invoiceNumber: string
  payment?: Payment
}

export async function listMembershipsForMember(memberId: string): Promise<Membership[]> {
  return readTx(['memberships'], (tx) => tx.objectStore('memberships').index('memberId').getAll(memberId))
}

/** Where a renewal would start, given the member's latest end date. */
export function renewalStartOptions(latestEnd: ISODate | undefined, today: ISODate): { afterCurrent?: ISODate; today: ISODate } {
  if (!latestEnd) return { today }
  const afterCurrent = addDays(latestEnd, 1)
  // If the current membership already lapsed, "after current" is in the past; still offered, but today is the default.
  return { afterCurrent, today }
}

const SALE_STORES = ['members', 'plans', 'memberships', 'invoices', 'payments', 'counters', 'settings', 'activity'] as const

type SaleInput = Omit<AssignMembershipInput, 'memberId' | 'requestKey'>

/** The sale itself, inside the caller's transaction (needs every store in SALE_STORES). */
async function sellInTx(tx: AnyWriteTx, member: Member, input: SaleInput): Promise<AssignMembershipResult> {
  if (member.status === 'archived') throw new DomainError('member-archived', 'Restore this member before selling a membership.')
  const plan: Plan | undefined = await tx.objectStore('plans').get(input.planId)
  if (!plan) throw new DomainError('plan-missing', 'Plan not found.')
  if (plan.archived) throw new DomainError('plan-archived', 'This plan is archived. Choose an active plan.')
  if (input.discountPaise < 0 || input.discountPaise > plan.pricePaise) {
    throw new DomainError('discount', `Discount must be between ₹0 and ${formatINR(plan.pricePaise)}.`)
  }
  const netPaise = plan.pricePaise - input.discountPaise
  if (input.initialPaymentPaise < 0 || input.initialPaymentPaise > netPaise) {
    throw new DomainError('payment', `Initial payment cannot exceed the net price of ${formatINR(netPaise)}.`)
  }
  const endDate = membershipEndDate(input.startDate, plan.durationValue, plan.durationUnit)
  if (compareDates(endDate, input.startDate) < 0) throw new DomainError('dates', 'End date is before start date.')

  const number = await nextInvoiceNumber(tx)
  const membershipId = stampNew('ms', {}).id
  const invoice = buildInvoice({
    number,
    memberId: member.id,
    membershipId,
    issueDate: input.issueDate ?? todayInTz((await tx.objectStore('settings').get('settings'))?.timezone ?? DEFAULT_TIMEZONE),
    lines: [
      {
        description: `${plan.name} membership (${formatSpan(plan.durationValue, plan.durationUnit)}) · ${formatDate(input.startDate)} to ${formatDate(endDate)}`,
        quantity: 1,
        unitPricePaise: plan.pricePaise,
        amountPaise: plan.pricePaise,
      },
    ],
    discountPaise: input.discountPaise,
    note: input.note,
  })
  const membership: Membership = {
    ...stampNew('ms', {}),
    id: membershipId,
    memberId: member.id,
    planId: plan.id,
    planName: plan.name,
    durationValue: plan.durationValue,
    durationUnit: plan.durationUnit,
    startDate: input.startDate,
    endDate,
    listPricePaise: plan.pricePaise,
    discountPaise: input.discountPaise,
    pricePaise: netPaise,
    invoiceId: invoice.id,
    renewalOfId: input.renewalOfId,
    note: input.note,
  }
  await tx.objectStore('invoices').put(invoice)
  await tx.objectStore('memberships').put(membership)
  let payment: Payment | undefined
  if (input.initialPaymentPaise > 0) {
    payment = stampNew('pay', {
      memberId: member.id,
      invoiceId: invoice.id,
      amountPaise: input.initialPaymentPaise,
      method: input.paymentMethod,
      receivedAt: nowIso(),
      status: 'recorded' as const,
      note: 'Paid at membership sale',
    }) as Payment
    await tx.objectStore('payments').put(payment)
  }
  await logActivity(tx, {
    kind: 'membership',
    message: `${input.renewalOfId ? 'Renewed' : 'Sold'} ${plan.name} to ${member.name} (${input.startDate} → ${endDate}), invoice ${number}`,
    memberId: member.id,
    refType: 'membership',
    refId: membership.id,
  })
  if (payment) {
    await logActivity(tx, {
      kind: 'payment',
      message: `Recorded ${formatINR(payment.amountPaise)} ${payment.method.toUpperCase()} from ${member.name} for ${number}`,
      memberId: member.id,
      refType: 'payment',
      refId: payment.id,
    })
  }
  return { membership, invoiceId: invoice.id, invoiceNumber: number, payment }
}

/**
 * Sell a membership: membership + invoice (+ optional first payment) in one
 * transaction. Plan details are snapshotted so later plan edits never change
 * what was sold.
 */
export async function assignMembership(input: AssignMembershipInput): Promise<AssignMembershipResult> {
  return withIdempotency(input.requestKey, () =>
    writeTx([...SALE_STORES], async (tx) => {
      const member = await tx.objectStore('members').get(input.memberId)
      if (!member) throw new DomainError('member-missing', 'Member not found.')
      return sellInTx(tx, member, input)
    }),
  )
}

/** What the Add member page collects when a plan is chosen there. */
export type FirstMembershipInput = Pick<AssignMembershipInput, 'planId' | 'startDate' | 'discountPaise' | 'initialPaymentPaise' | 'paymentMethod' | 'issueDate'>

/**
 * Add a member and sell their first membership in one transaction: if the sale is refused
 * (archived plan, discount above the price…) the member is not created either, so a retry never leaves a duplicate.
 */
export async function createMemberWithMembership(values: MemberFormValues, sale: FirstMembershipInput, opts: { requestKey?: string } = {}): Promise<AssignMembershipResult & { member: Member }> {
  return withIdempotency(opts.requestKey, () =>
    writeTx([...SALE_STORES], async (tx) => {
      const member = await insertMember(tx, values)
      return { member, ...(await sellInTx(tx, member, sale)) }
    }),
  )
}
