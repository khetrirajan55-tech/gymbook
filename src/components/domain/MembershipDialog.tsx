import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Member, Membership, Plan } from '@/domain/types'
import { useForm } from '@/lib/forms'
import { membershipForm, type MembershipFormValues } from '@/domain/validation'
import { assignMembership, renewalStartOptions } from '@/data/services/memberships'
import { membershipEndDate, formatDate, formatSpan, addDays, compareDates } from '@/domain/dates'
import { formatINR, parseRupees } from '@/domain/money'
import { latestEndDate } from '@/domain/membership'
import { FormModal } from './FormModal'
import { Field, Select, Input, MoneyInput, Textarea, FormError } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useApp } from '@/app/AppContext'
import { PAYMENT_METHODS } from '@/domain/types'
import { cn } from '@/lib/cn'

type StartChoice = 'after' | 'today' | 'custom'

export function MembershipDialog({ open, onClose, member, plans, memberships }: { open: boolean; onClose: () => void; member: Member; plans: Plan[]; memberships: Membership[] }) {
  const { today } = useApp()
  const toast = useToast()
  const navigate = useNavigate()
  const activePlans = [...plans].filter((p) => !p.archived).sort((a, b) => a.pricePaise - b.pricePaise || a.name.localeCompare(b.name))
  const latestEnd = latestEndDate(memberships)
  const options = renewalStartOptions(latestEnd, today)
  const isRenewal = memberships.some((m) => !m.cancelledAt)
  const afterIsFuture = options.afterCurrent ? compareDates(options.afterCurrent, today) >= 0 : false
  const [startChoice, setStartChoice] = useState<StartChoice>(afterIsFuture ? 'after' : 'today')

  const form = useForm<{ planId: string; startDate: string; discount: string; initialPayment: string; paymentMethod: 'cash' | 'upi' | 'bank' | 'card'; note: string }, MembershipFormValues>(
    { planId: activePlans[0]?.id ?? '', startDate: afterIsFuture && options.afterCurrent ? options.afterCurrent : today, discount: '', initialPayment: '', paymentMethod: 'cash', note: '' },
    membershipForm,
    async (values, { requestKey }) => {
      const latest = memberships.filter((m) => !m.cancelledAt).sort((a, b) => compareDates(b.endDate, a.endDate))[0]
      const result = await assignMembership({
        memberId: member.id,
        planId: values.planId,
        startDate: values.startDate,
        discountPaise: values.discount,
        initialPaymentPaise: values.initialPayment,
        paymentMethod: values.paymentMethod,
        note: values.note,
        renewalOfId: isRenewal ? latest?.id : undefined,
        requestKey: requestKey,
        issueDate: today,
      })
      toast.success(`${isRenewal ? 'Renewed' : 'Membership sold'}: ${result.membership.planName}`, `Invoice ${result.invoiceNumber} created${result.payment ? ` · ${formatINR(result.payment.amountPaise)} recorded` : ''}`)
      onClose()
      navigate(`/invoices/${result.invoiceId}`)
    },
  )

  const plan = activePlans.find((p) => p.id === form.values.planId)
  const endDate = plan ? membershipEndDate(form.values.startDate, plan.durationValue, plan.durationUnit) : undefined
  const discountPaise = parseRupees(form.values.discount || '0') ?? 0
  const netPaise = plan ? Math.max(0, plan.pricePaise - discountPaise) : 0
  const payPaise = parseRupees(form.values.initialPayment || '0') ?? 0
  const balancePaise = netPaise - payPaise

  const overlap = useMemo(() => {
    if (!endDate) return null
    return memberships.find((m) => !m.cancelledAt && compareDates(m.startDate, endDate) <= 0 && compareDates(m.endDate, form.values.startDate) >= 0)
  }, [memberships, endDate, form.values.startDate])

  const pickStart = (choice: StartChoice) => {
    setStartChoice(choice)
    if (choice === 'after' && options.afterCurrent) form.set('startDate', options.afterCurrent)
    if (choice === 'today') form.set('startDate', today)
  }

  return (
    <FormModal open={open} onClose={onClose} dirty={form.dirty} saving={form.saving} title={isRenewal ? `Renew membership · ${member.name}` : `Sell membership · ${member.name}`} description="Creates the membership and its invoice together. Any amount received now is recorded as the first payment." size="lg"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose} disabled={form.saving}>Cancel</Button>
          <Button onClick={() => form.submit()} loading={form.saving} disabled={activePlans.length === 0} data-primary>
            {isRenewal ? 'Renew and create invoice' : 'Sell and create invoice'}
          </Button>
        </>
      )}
    >
      {activePlans.length === 0 ? (
        <FormError message="No active plans yet. Create a plan under Plans first." />
      ) : (
        <form onSubmit={form.submit} className="flex flex-col gap-4" noValidate>
          <Field label="Plan" required error={form.errors.planId}>
            {({ id, invalid }) => (
              <Select id={id} aria-invalid={invalid} value={form.values.planId} onChange={(e) => form.set('planId', e.target.value)}>
                {activePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {formatSpan(p.durationValue, p.durationUnit)} · {formatINR(p.pricePaise)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Starts</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {options.afterCurrent ? (
                <ChoiceCard active={startChoice === 'after'} onClick={() => pickStart('after')} title={afterIsFuture ? 'After current plan' : 'Right after last plan'} detail={`${formatDate(options.afterCurrent)}${afterIsFuture ? '' : ' (in the past)'}`} />
              ) : null}
              <ChoiceCard active={startChoice === 'today'} onClick={() => pickStart('today')} title="Today" detail={formatDate(today)} />
              <ChoiceCard active={startChoice === 'custom'} onClick={() => pickStart('custom')} title="Pick a date" detail="Any start date" />
            </div>
            {startChoice === 'custom' ? (
              <div className="mt-2">
                <Field label="Start date" required error={form.errors.startDate}>
                  {({ id, invalid }) => <Input id={id} type="date" aria-invalid={invalid} value={form.values.startDate} onChange={(e) => form.set('startDate', e.target.value)} />}
                </Field>
              </div>
            ) : null}
          </fieldset>

          {plan && endDate ? (
            <div className="rounded-xl bg-sunken/70 px-3.5 py-3 text-sm">
              <p>
                <strong>{formatDate(form.values.startDate)}</strong> to <strong>{formatDate(endDate)}</strong> (last day of access).
              </p>
              <p className="mt-1 text-muted">
                A {plan.durationValue}-{plan.durationUnit === 'months' ? 'month' : 'day'} plan ends the day before the same date {plan.durationUnit === 'months' ? `${plan.durationValue} month${plan.durationValue === 1 ? '' : 's'}` : `${plan.durationValue} days`} later, so {formatDate(form.values.startDate)} → {formatDate(addDays(endDate, 1))} exclusive.
              </p>
              {overlap ? <p className="mt-1 font-medium text-warn">Overlaps the existing {overlap.planName} membership ({formatDate(overlap.startDate)} – {formatDate(overlap.endDate)}). You can still proceed.</p> : null}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Discount" hint={plan ? `Plan price ${formatINR(plan.pricePaise)}` : undefined} error={form.errors.discount}>
              {({ id, invalid, describedBy }) => <MoneyInput id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.discount} onChange={(e) => form.set('discount', e.target.value)} placeholder="0" />}
            </Field>
            <div className="rounded-xl border border-line px-3.5 py-2.5">
              <p className="text-xs font-medium text-muted">Net price</p>
              <p className="tabular text-lg font-medium">{formatINR(netPaise)}</p>
            </div>
            <Field label="Received now" hint="Leave empty if nothing was paid yet. Partial amounts are fine." error={form.errors.initialPayment}>
              {({ id, invalid, describedBy }) => <MoneyInput id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.initialPayment} onChange={(e) => form.set('initialPayment', e.target.value)} placeholder="0" />}
            </Field>
            <Field label="Payment method" error={form.errors.paymentMethod}>
              {({ id }) => (
                <Select id={id} value={form.values.paymentMethod} onChange={(e) => form.set('paymentMethod', e.target.value as MembershipFormValues['paymentMethod'])} disabled={payPaise <= 0}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <p className={cn('text-sm', balancePaise > 0 ? 'text-warn' : 'text-muted')}>
            {balancePaise > 0 ? `${formatINR(balancePaise)} will remain outstanding on the invoice.` : payPaise > 0 ? 'Invoice will be fully paid.' : 'Nothing recorded as paid yet; the full amount stays outstanding.'}
          </p>
          <Field label="Note" error={form.errors.note}>
            {({ id }) => <Textarea id={id} value={form.values.note} onChange={(e) => form.set('note', e.target.value)} rows={2} placeholder="Shown on the invoice" />}
          </Field>
          <FormError message={form.formError} />
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      )}
    </FormModal>
  )
}

function ChoiceCard({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn('pressable flex min-h-14 flex-col items-start rounded-xl border px-3 py-2 text-left', active ? 'border-accent bg-accent-soft/50 ring-[3px] ring-accent/20' : 'border-line hover:border-line-strong hover:bg-sunken/60')}>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted">{detail}</span>
    </button>
  )
}
