import { readTx, writeTx } from '../db'
import { logActivity, stampNew, updateRecord, withIdempotency } from '../repo'
import type { Adjustment, Invoice, Payment, PaymentMethod, Paise } from '@/domain/types'
import { invoiceBalance } from '@/domain/membership'
import { formatINR } from '@/domain/money'
import { DomainError } from '../errors'
import { nowIso } from '@/domain/ids'

export async function listPayments(): Promise<Payment[]> {
  return readTx(['payments'], (tx) => tx.objectStore('payments').getAll())
}
export async function listInvoices(): Promise<Invoice[]> {
  return readTx(['invoices'], (tx) => tx.objectStore('invoices').getAll())
}
export async function listAdjustments(): Promise<Adjustment[]> {
  return readTx(['adjustments'], (tx) => tx.objectStore('adjustments').getAll())
}
export async function getInvoice(id: string): Promise<Invoice | undefined> {
  return readTx(['invoices'], (tx) => tx.objectStore('invoices').get(id))
}

export interface RecordPaymentInput {
  memberId: string
  invoiceId?: string
  amountPaise: Paise
  method: PaymentMethod
  receivedAt: string
  reference?: string
  note?: string
  requestKey?: string
}

/**
 * Record (not process) a payment that was received outside the app.
 * When linked to an invoice, the amount may not exceed the invoice balance,
 * so an overpayment must be recorded deliberately as an unlinked credit.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<Payment> {
  return withIdempotency(input.requestKey, () =>
    writeTx(['members', 'invoices', 'payments', 'adjustments', 'activity'], async (tx) => {
      const member = await tx.objectStore('members').get(input.memberId)
      if (!member) throw new DomainError('member-missing', 'Member not found.')
      if (input.amountPaise <= 0) throw new DomainError('amount', 'Amount must be greater than zero.')
      let invoice: Invoice | undefined
      if (input.invoiceId) {
        invoice = await tx.objectStore('invoices').get(input.invoiceId)
        if (!invoice || invoice.memberId !== member.id) throw new DomainError('invoice-missing', 'Invoice not found for this member.')
        if (invoice.status === 'void') throw new DomainError('invoice-void', 'This invoice is void. Record the payment against another invoice or as a credit.')
        const payments = await tx.objectStore('payments').index('invoiceId').getAll(invoice.id)
        const adjustments = await tx.objectStore('adjustments').index('invoiceId').getAll(invoice.id)
        const bal = invoiceBalance(invoice, payments, adjustments)
        if (input.amountPaise > bal.balancePaise) {
          throw new DomainError(
            'overpay',
            `Only ${formatINR(bal.balancePaise)} is outstanding on ${invoice.number}. Reduce the amount, or record the extra as an unlinked credit.`,
          )
        }
      }
      const payment = stampNew('pay', {
        memberId: member.id,
        invoiceId: invoice?.id,
        amountPaise: input.amountPaise,
        method: input.method,
        receivedAt: input.receivedAt,
        reference: input.reference,
        note: input.note,
        status: 'recorded' as const,
      }) as Payment
      await tx.objectStore('payments').put(payment)
      await logActivity(tx, {
        kind: 'payment',
        message: `Recorded ${formatINR(payment.amountPaise)} ${payment.method.toUpperCase()} from ${member.name}${invoice ? ` for ${invoice.number}` : ' (unlinked credit)'}`,
        memberId: member.id,
        refType: 'payment',
        refId: payment.id,
      })
      return payment
    }),
  )
}

export async function voidPayment(id: string, expectedRev: number, reason: string): Promise<Payment> {
  if (!reason.trim()) throw new DomainError('reason', 'Give a reason for voiding this payment.')
  return writeTx(['payments', 'members', 'activity'], async (tx) => {
    const next = await updateRecord(tx, 'payments', id, expectedRev, (p) => {
      if (p.status === 'void') throw new DomainError('already-void', 'This payment is already void.')
      return { ...p, status: 'void', voidedAt: nowIso(), voidReason: reason.trim() }
    })
    const member = await tx.objectStore('members').get(next.memberId)
    await logActivity(tx, {
      kind: 'payment',
      message: `Voided payment of ${formatINR(next.amountPaise)} from ${member?.name ?? 'member'}: ${reason.trim()}`,
      memberId: next.memberId,
      refType: 'payment',
      refId: id,
    })
    return next
  })
}

export async function voidInvoice(id: string, expectedRev: number, reason: string): Promise<Invoice> {
  if (!reason.trim()) throw new DomainError('reason', 'Give a reason for voiding this invoice.')
  return writeTx(['invoices', 'payments', 'memberships', 'activity'], async (tx) => {
    const payments = (await tx.objectStore('payments').index('invoiceId').getAll(id)).filter((p) => p.status === 'recorded')
    if (payments.length > 0) {
      throw new DomainError('has-payments', 'This invoice has recorded payments. Void those payments first, or add an adjustment instead.')
    }
    const next = await updateRecord(tx, 'invoices', id, expectedRev, (inv) => {
      if (inv.status === 'void') throw new DomainError('already-void', 'This invoice is already void.')
      return { ...inv, status: 'void', voidedAt: nowIso(), voidReason: reason.trim() }
    })
    // The membership sold on this invoice is cancelled with it; the record stays for history.
    if (next.membershipId) {
      const ms = await tx.objectStore('memberships').get(next.membershipId)
      if (ms && !ms.cancelledAt) {
        await tx.objectStore('memberships').put({ ...ms, cancelledAt: nowIso(), cancelReason: `Invoice ${next.number} voided: ${reason.trim()}`, updatedAt: nowIso(), rev: ms.rev + 1 })
      }
    }
    await logActivity(tx, { kind: 'invoice', message: `Voided invoice ${next.number}: ${reason.trim()}${next.membershipId ? ' (membership cancelled)' : ''}`, memberId: next.memberId, refType: 'invoice', refId: id })
    return next
  })
}

export async function addAdjustment(input: { invoiceId: string; amountPaise: Paise; reason: string }): Promise<Adjustment> {
  if (!input.reason.trim()) throw new DomainError('reason', 'Give a reason for the adjustment.')
  if (input.amountPaise === 0) throw new DomainError('amount', 'Adjustment amount cannot be zero.')
  return writeTx(['invoices', 'adjustments', 'payments', 'activity'], async (tx) => {
    const invoice = await tx.objectStore('invoices').get(input.invoiceId)
    if (!invoice) throw new DomainError('invoice-missing', 'Invoice not found.')
    if (invoice.status === 'void') throw new DomainError('invoice-void', 'Void invoices cannot be adjusted.')
    const existing = await tx.objectStore('adjustments').index('invoiceId').getAll(invoice.id)
    const payments = await tx.objectStore('payments').index('invoiceId').getAll(invoice.id)
    const bal = invoiceBalance(invoice, payments, existing)
    if (bal.duePaise + input.amountPaise < 0) {
      throw new DomainError('too-low', `This adjustment would make the invoice total negative (currently ${formatINR(bal.duePaise)}).`)
    }
    const adj = stampNew('adj', {
      invoiceId: invoice.id,
      memberId: invoice.memberId,
      amountPaise: input.amountPaise,
      reason: input.reason.trim(),
    }) as Adjustment
    await tx.objectStore('adjustments').put(adj)
    await logActivity(tx, {
      kind: 'invoice',
      message: `Adjusted ${invoice.number} by ${input.amountPaise < 0 ? '−' : '+'}${formatINR(Math.abs(input.amountPaise))}: ${adj.reason}`,
      memberId: invoice.memberId,
      refType: 'invoice',
      refId: invoice.id,
    })
    return adj
  })
}

/**
 * Remove a payment that was entered by mistake, as if it had never been recorded. Unlike voiding,
 * it does not stay in the member's history; only the activity log keeps a line.
 */
export async function deletePayment(id: string, expectedRev: number): Promise<void> {
  await writeTx(['payments', 'invoices', 'activity'], async (tx) => {
    const p = await tx.objectStore('payments').get(id)
    if (!p) throw new DomainError('payment-missing', 'This payment no longer exists.')
    if (p.rev !== expectedRev) throw new DomainError('conflict', 'This payment was changed somewhere else. Reload and try again.')
    const invoice = p.invoiceId ? await tx.objectStore('invoices').get(p.invoiceId) : undefined
    await tx.objectStore('payments').delete(id)
    await logActivity(tx, { kind: 'payment', message: `Deleted mistaken payment of ${formatINR(p.amountPaise)}${invoice ? ` on ${invoice.number}` : ''}`, memberId: p.memberId, refType: 'member', refId: p.memberId })
  })
}
