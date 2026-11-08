import { useMemo } from 'react'
import type { Adjustment, Invoice, Member, Payment } from '@/domain/types'
import { PAYMENT_METHODS } from '@/domain/types'
import { useForm } from '@/lib/forms'
import { paymentForm, type PaymentFormValues } from '@/domain/validation'
import { recordPayment } from '@/data/services/payments'
import { invoiceBalance } from '@/domain/membership'
import { formatINR, paiseToInput } from '@/domain/money'
import { FormModal } from './FormModal'
import { Field, Select, Input, MoneyInput, Textarea, FormError } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useApp } from '@/app/AppContext'
import { formatDate } from '@/domain/dates'

function localDateTimeNow(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date())
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
}

/** Interpret a datetime-local string as wall-clock time in the gym timezone. */
export function localDateTimeToInstant(value: string, timezone: string): string {
  const [date, time] = value.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = (time ?? '00:00').split(':').map(Number)
  let guess = Date.UTC(y, m - 1, d, hh, mm)
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess))
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const seen = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'))
    const diff = Date.UTC(y, m - 1, d, hh, mm) - seen
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess).toISOString()
}

export function PaymentDialog({ open, onClose, member, invoices, payments, adjustments, preferredInvoiceId }: { open: boolean; onClose: () => void; member: Member; invoices: Invoice[]; payments: Payment[]; adjustments: Adjustment[]; preferredInvoiceId?: string }) {
  const { timezone } = useApp()
  const toast = useToast()
  const openInvoices = useMemo(
    () =>
      invoices
        .filter((i) => i.memberId === member.id && i.status === 'issued')
        .map((i) => ({ invoice: i, bal: invoiceBalance(i, payments, adjustments) }))
        .filter((x) => x.bal.balancePaise > 0)
        .sort((a, b) => (a.invoice.issueDate < b.invoice.issueDate ? -1 : 1)),
    [invoices, payments, adjustments, member.id],
  )
  const defaultInvoice = openInvoices.find((x) => x.invoice.id === preferredInvoiceId) ?? openInvoices[0]

  const form = useForm<{ amount: string; method: 'cash' | 'upi' | 'bank' | 'card'; receivedAt: string; invoiceId: string; reference: string; note: string }, PaymentFormValues>(
    { amount: defaultInvoice ? paiseToInput(defaultInvoice.bal.balancePaise) : '', method: 'cash', receivedAt: localDateTimeNow(timezone), invoiceId: defaultInvoice?.invoice.id ?? '', reference: '', note: '' },
    paymentForm,
    async (values, { requestKey }) => {
      const p = await recordPayment({
        memberId: member.id,
        invoiceId: values.invoiceId || undefined,
        amountPaise: values.amount,
        method: values.method,
        receivedAt: localDateTimeToInstant(values.receivedAt, timezone),
        reference: values.reference,
        note: values.note,
        requestKey: requestKey,
      })
      toast.success(`Recorded ${formatINR(p.amountPaise)}`, values.invoiceId ? 'Applied to the selected invoice.' : 'Recorded as an unlinked credit for this member.')
      onClose()
    },
  )

  const selected = openInvoices.find((x) => x.invoice.id === form.values.invoiceId)

  return (
    <FormModal open={open} onClose={onClose} dirty={form.dirty} saving={form.saving} title={`Record payment · ${member.name}`} description="This records money you have already received (cash, UPI, bank or card). GymBook does not process payments."
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose} disabled={form.saving}>Cancel</Button>
          <Button onClick={() => form.submit()} loading={form.saving} data-primary>Record payment</Button>
        </>
      )}
    >
      <form onSubmit={form.submit} className="flex flex-col gap-4" noValidate>
        <Field label="Apply to invoice" hint={openInvoices.length === 0 ? 'No invoices with a balance. The payment will be kept as a credit on the member.' : undefined} error={form.errors.invoiceId}>
          {({ id }) => (
            <Select
              id={id}
              value={form.values.invoiceId}
              onChange={(e) => {
                const inv = openInvoices.find((x) => x.invoice.id === e.target.value)
                form.set('invoiceId', e.target.value)
                if (inv) form.set('amount', paiseToInput(inv.bal.balancePaise))
              }}
            >
              <option value="">Unlinked credit (no invoice)</option>
              {openInvoices.map(({ invoice, bal }) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.number} · {formatDate(invoice.issueDate)} · {formatINR(bal.balancePaise)} due
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount received" required hint={selected ? <>{formatINR(selected.bal.balancePaise)} outstanding on <span className="whitespace-nowrap">{selected.invoice.number}</span></> : undefined} error={form.errors.amount}>
            {({ id, invalid, describedBy }) => <MoneyInput id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.amount} onChange={(e) => form.set('amount', e.target.value)} autoFocus />}
          </Field>
          <Field label="Method" required error={form.errors.method}>
            {({ id }) => (
              <Select id={id} value={form.values.method} onChange={(e) => form.set('method', e.target.value as PaymentFormValues['method'])}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Received at" required error={form.errors.receivedAt} className="sm:col-span-2">
            {({ id, invalid }) => <Input id={id} type="datetime-local" aria-invalid={invalid} value={form.values.receivedAt} onChange={(e) => form.set('receivedAt', e.target.value)} />}
          </Field>
          <Field label="Reference" hint="UPI ID, transaction no., cheque no" error={form.errors.reference}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.values.reference} onChange={(e) => form.set('reference', e.target.value)} />}
          </Field>
        </div>
        <Field label="Note" error={form.errors.note}>
          {({ id }) => <Textarea id={id} rows={2} value={form.values.note} onChange={(e) => form.set('note', e.target.value)} />}
        </Field>
        <FormError message={form.formError} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </FormModal>
  )
}
