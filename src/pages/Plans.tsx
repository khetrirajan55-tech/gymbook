import { useMemo, useState } from 'react'
import { Plus, Pencil, Archive, ArchiveRestore, CreditCard } from 'lucide-react'
import { usePage } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { loadSnapshotWithoutVisits, SNAPSHOT_STORES_WITHOUT_VISITS } from '@/data/snapshot'
import { createPlan, updatePlan, setPlanArchived } from '@/data/services/plans'
import { planForm, type PlanFormValues } from '@/domain/validation'
import { useForm } from '@/lib/forms'
import type { Plan } from '@/domain/types'
import { formatINR, paiseToInput } from '@/domain/money'
import { membershipEndDate, formatDate, formatSpan } from '@/domain/dates'
import { useApp } from '@/app/AppContext'
import { Card, CardHeader } from '@/components/ui/Card'
import { PageActions } from '@/components/ui/PageActions'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select, Textarea, MoneyInput, FormError } from '@/components/ui/Field'
import { Badge, SampleBadge } from '@/components/ui/Badge'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { FormModal } from '@/components/domain/FormModal'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/data/errors'

export function PlansPage() {
  usePage('Membership plans', 'Create and edit the plans you sell')
  const snap = useLiveQuery(loadSnapshotWithoutVisits, [...SNAPSHOT_STORES_WITHOUT_VISITS])
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const toast = useToast()

  const usage = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of snap.data?.memberships ?? []) map.set(m.planId, (map.get(m.planId) ?? 0) + 1)
    return map
  }, [snap.data])

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />

  const plans = snap.data.plans.filter((p) => showArchived || !p.archived).sort((a, b) => a.name.localeCompare(b.name))
  const archivedCount = snap.data.plans.filter((p) => p.archived).length

  const toggleArchive = async (p: Plan) => {
    try {
      await setPlanArchived(p.id, p.rev, !p.archived)
      toast.success(p.archived ? 'Plan restored' : 'Plan archived', p.archived ? undefined : 'Existing memberships keep their original price and dates.')
    } catch (err) {
      toast.error('Could not update plan', errorMessage(err))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Editing a plan changes future sales only. Memberships already sold keep the price and duration they were sold with.</p>
        <div className="flex flex-wrap items-center gap-2">
          {archivedCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setShowArchived((s) => !s)}>
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </Button>
          ) : null}
        </div>
      </div>
      <PageActions>
        <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing('new')}>
          New plan
        </Button>
      </PageActions>
      {plans.length === 0 ? (
        <Card>
          <EmptyState icon={<CreditCard className="h-5 w-5" aria-hidden />} title="No plans yet" description="Create a plan such as “Monthly · ₹1,500” before selling memberships" action={<Button onClick={() => setEditing('new')} icon={<Plus className="h-4 w-4" aria-hidden />}>New plan</Button>} />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.id} className={p.archived ? 'opacity-70' : ''}>
              <CardHeader
                title={<span className="flex flex-wrap items-center gap-2">{p.name}{p.sample ? <SampleBadge /> : null}{p.archived ? <Badge tone="muted">Archived</Badge> : null}</span>}
                description={`${formatSpan(p.durationValue, p.durationUnit)}${p.description ? ` · ${p.description}` : ''}`}
              />
              <div className="px-4 pb-4 pt-3 sm:px-5">
                <p className="tabular text-2xl font-medium">{formatINR(p.pricePaise)}</p>
                <p className="text-xs text-muted">{usage.get(p.id) ?? 0} membership{(usage.get(p.id) ?? 0) === 1 ? '' : 's'} sold</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" icon={<Pencil className="h-4 w-4" aria-hidden />} onClick={() => setEditing(p)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={p.archived ? <ArchiveRestore className="h-4 w-4" aria-hidden /> : <Archive className="h-4 w-4" aria-hidden />} onClick={() => toggleArchive(p)}>
                    {p.archived ? 'Restore' : 'Archive'}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing ? <PlanDialog plan={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function PlanDialog({ plan, onClose }: { plan?: Plan; onClose: () => void }) {
  const toast = useToast()
  const { today } = useApp()
  const form = useForm<{ name: string; durationValue: string; durationUnit: 'days' | 'months'; price: string; description: string }, PlanFormValues>(
    { name: plan?.name ?? '', durationValue: String(plan?.durationValue ?? 1), durationUnit: plan?.durationUnit ?? 'months', price: plan ? paiseToInput(plan.pricePaise) : '', description: plan?.description ?? '' },
    planForm,
    async (values) => {
      if (plan) {
        await updatePlan(plan.id, plan.rev, values)
        toast.success('Plan updated', 'Already-sold memberships are unchanged.')
      } else {
        await createPlan(values)
        toast.success('Plan created')
      }
      onClose()
    },
  )
  const dv = Number(form.values.durationValue)
  const preview = Number.isInteger(dv) && dv > 0 ? membershipEndDate(today, dv, form.values.durationUnit) : null
  return (
    <FormModal open onClose={onClose} dirty={form.dirty} saving={form.saving} title={plan ? `Edit ${plan.name}` : 'New plan'} description="Price is in rupees. Duration determines the inclusive end date."
      footer={(requestClose) => <><Button variant="secondary" onClick={requestClose} disabled={form.saving}>Cancel</Button><Button onClick={() => form.submit()} loading={form.saving} data-primary>{plan ? 'Save changes' : 'Create plan'}</Button></>}
    >
      <form onSubmit={form.submit} noValidate className="flex flex-col gap-4">
        <Field label="Plan name" required error={form.errors.name}>
          {({ id, invalid }) => <Input id={id} aria-invalid={invalid} value={form.values.name} onChange={(e) => form.set('name', e.target.value)} placeholder="e.g. Quarterly" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Duration" required error={form.errors.durationValue}>
            {({ id, invalid }) => <Input id={id} type="number" inputMode="numeric" min={1} aria-invalid={invalid} value={form.values.durationValue} onChange={(e) => form.set('durationValue', e.target.value)} />}
          </Field>
          <Field label="Unit" error={form.errors.durationUnit}>
            {({ id }) => (
              <Select id={id} value={form.values.durationUnit} onChange={(e) => form.set('durationUnit', e.target.value as 'days' | 'months')}>
                <option value="months">Months</option>
                <option value="days">Days</option>
              </Select>
            )}
          </Field>
        </div>
        {preview ? <p className="text-xs text-muted">Example: starting {formatDate(today)} this plan would end on {formatDate(preview)} (inclusive).</p> : null}
        <Field label="Price" required error={form.errors.price} hint="₹0 is allowed for free or trial plans">
          {({ id, invalid, describedBy }) => <MoneyInput id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.price} onChange={(e) => form.set('price', e.target.value)} />}
        </Field>
        <Field label="Description" error={form.errors.description}>
          {({ id }) => <Textarea id={id} rows={2} value={form.values.description} onChange={(e) => form.set('description', e.target.value)} />}
        </Field>
        <FormError message={form.formError} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </FormModal>
  )
}
