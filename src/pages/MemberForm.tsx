import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Camera, ImageUp, Trash2 } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { listMembers, createMember, updateMember, findPossibleDuplicates, getMember } from '@/data/services/members'
import { createMemberWithMembership } from '@/data/services/memberships'
import { listPlans } from '@/data/services/plans'
import { newMemberForm, type NewMemberValues } from '@/domain/validation'
import { membershipEndDate, formatDate, formatSpan, isISODate } from '@/domain/dates'
import { formatINR, parseRupees } from '@/domain/money'
import { useForm } from '@/lib/forms'
import { fileToSmallDataUrl } from '@/lib/image'
import { GENDERS, PAYMENT_METHODS, type Member, type PaymentMethod } from '@/domain/types'
import { Card, CardBody } from '@/components/ui/Card'
import { Field, Input, MoneyInput, Select, Textarea, FormError } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Avatar, Banner, PageHeader } from '@/components/ui/misc'
import { PageLoading } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { DiscardGuard } from '@/components/domain/DiscardGuard'
import { CameraDialog } from '@/components/domain/CameraDialog'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/data/errors'

type Values = { name: string; phone: string; joiningDate: string; notes: string; photoDataUrl?: string; dateOfBirth: string; gender: '' | 'female' | 'male' | 'other'; heightCm: string; weightKg: string; goal: string; healthNotes: string
  /** Add member only: an empty planId means no plan is sold with the new member. */
  planId: string; planStartDate: string; planDiscount: string; planReceived: string; planPaymentMethod: PaymentMethod }

export function MemberFormPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams()
  const existing = useLiveQuery(() => (mode === 'edit' && id ? getMember(id) : Promise.resolve(undefined)), ['members'], [id, mode])
  usePage(mode === 'new' ? 'Add member' : existing.data ? `Edit ${existing.data.name}` : 'Edit member', mode === 'new' ? 'Create a new member record' : 'Update member details', { header: false })

  if (mode === 'edit') {
    if (existing.error) return <ErrorState message={existing.error} />
    if (existing.loading && !existing.data) return <PageLoading />
    if (!existing.data) return <ErrorState title="Member not found" message="This member does not exist in this browser’s data." action={<Link to="/members" className="font-medium underline">Back to members</Link>} />
    return <MemberFormInner key={existing.data.id} mode="edit" member={existing.data} />
  }
  return <MemberFormInner mode="new" />
}

function MemberFormInner({ mode, member }: { mode: 'new' | 'edit'; member?: Member }) {
  const { today } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const members = useLiveQuery(listMembers, ['members'])
  const plans = useLiveQuery(listPlans, ['plans'])
  const fileRef = useRef<HTMLInputElement>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)

  const initial = useMemo<Values>(
    () => ({
      name: member?.name ?? '',
      phone: member?.phone ?? '',
      joiningDate: member?.joiningDate ?? today,
      notes: member?.notes ?? '',
      photoDataUrl: member?.photoDataUrl,
      dateOfBirth: member?.dateOfBirth ?? '',
      gender: member?.gender ?? '',
      heightCm: member?.heightCm !== undefined ? String(member.heightCm) : '',
      weightKg: member?.weightKg !== undefined ? String(member.weightKg) : '',
      goal: member?.goal ?? '',
      healthNotes: member?.healthNotes ?? '',
      planId: '',
      planStartDate: member?.joiningDate ?? today,
      planDiscount: '',
      planReceived: '',
      planPaymentMethod: 'cash',
    }),
    [member, today],
  )

  const leaveRef = useRef<() => void>(() => {})
  /** Revision the form was loaded from; saves are checked against it so another tab's change is never overwritten. */
  const baselineRev = useRef(member?.rev ?? 0)
  const form = useForm<Values, NewMemberValues>(initial, newMemberForm, async ({ member: values, plan: sale }, { requestKey }) => {
    if (mode === 'edit' && member) {
      await updateMember(member.id, baselineRev.current, values)
      toast.success('Member updated')
      leaveRef.current()
      navigate(`/members/${member.id}`)
    } else if (sale) {
      // Member, membership, invoice and first payment are saved together or not at all.
      const sold = await createMemberWithMembership(values, { planId: sale.planId, startDate: sale.planStartDate, discountPaise: sale.planDiscount, initialPaymentPaise: sale.planReceived, paymentMethod: sale.planPaymentMethod, issueDate: today }, { requestKey })
      toast.success(`Added ${sold.member.name}`, `${sold.membership.planName} sold · invoice ${sold.invoiceNumber} created${sold.payment ? ` · ${formatINR(sold.payment.amountPaise)} recorded` : ''}`)
      leaveRef.current()
      navigate(`/members/${sold.member.id}`, { replace: true, state: { justAdded: true } })
    } else {
      const created = await createMember(values, { requestKey: requestKey })
      toast.success(`Added ${created.name}`)
      leaveRef.current()
      navigate(`/members/${created.id}`, { replace: true, state: { justAdded: true } })
    }
  })

  const { blocker, allowLeave } = useUnsavedChanges(form.dirty)
  leaveRef.current = allowLeave

  // Another tab changed this member. If nothing is being edited, refresh quietly;
  // otherwise keep the person's input and tell them, so no edit is lost silently.
  const changedElsewhere = member !== undefined && member.rev !== baselineRev.current
  const resetRef = useRef(form.reset)
  resetRef.current = form.reset
  useEffect(() => {
    if (!member || member.rev === baselineRev.current) return
    if (!form.dirty) {
      baselineRev.current = member.rev
      resetRef.current(initial)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member?.rev])
  const reloadLatest = () => {
    if (!member) return
    baselineRev.current = member.rev
    form.reset(initial)
  }

  const duplicates = useMemo(() => {
    if (!members.data) return []
    if (form.values.phone.replace(/\D/g, '').length < 8 && form.values.name.length < 4) return []
    return findPossibleDuplicates(members.data, { phone: form.values.phone, name: form.values.name }, member?.id)
  }, [members.data, form.values.phone, form.values.name, member?.id])

  const onPhoto = async (file: File | undefined) => {
    if (!file) return
    setPhotoError(null)
    try {
      const dataUrl = await fileToSmallDataUrl(file)
      form.set('photoDataUrl', dataUrl)
    } catch (err) {
      setPhotoError(errorMessage(err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const activePlans = useMemo(() => (plans.data ?? []).filter((x) => !x.archived).sort((a, b) => a.pricePaise - b.pricePaise || a.name.localeCompare(b.name)), [plans.data])
  const plan = activePlans.find((x) => x.id === form.values.planId)
  const planEnd = plan && isISODate(form.values.planStartDate) ? membershipEndDate(form.values.planStartDate, plan.durationValue, plan.durationUnit) : undefined
  const netPaise = plan ? Math.max(0, plan.pricePaise - (parseRupees(form.values.planDiscount || '0') ?? 0)) : 0
  const payPaise = parseRupees(form.values.planReceived || '0') ?? 0
  const balancePaise = netPaise - payPaise

  const onJoiningDate = (value: string) => {
    // The plan normally starts on the joining date, so it follows until someone sets a different start.
    if (form.values.planStartDate === form.values.joiningDate) form.set('planStartDate', value)
    form.set('joiningDate', value)
  }

  return (
    <form onSubmit={form.submit} noValidate className="mx-auto flex max-w-2xl flex-col gap-4">
      <PageHeader back={member ? { to: `/members/${member.id}`, label: member.name } : { to: '/members', label: 'Members' }} title={mode === 'new' ? 'Add member' : `Edit ${member?.name ?? 'member'}`} description={mode === 'new' ? 'Phone and name are required; everything else can be added later.' : 'Changes are saved to this browser only.'} />
      <DiscardGuard blocker={blocker} />
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Avatar name={form.values.name || 'New member'} src={form.values.photoDataUrl} size="lg" />
            <div className="flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept="image/*" className="sr-only" id="member-photo" onChange={(e) => onPhoto(e.target.files?.[0])} />
              <Button type="button" variant="secondary" size="sm" icon={<Camera className="h-4 w-4" aria-hidden />} onClick={() => { setPhotoError(null); setCameraOpen(true) }}>
                Take photo
              </Button>
              <Button type="button" variant="secondary" size="sm" icon={<ImageUp className="h-4 w-4" aria-hidden />} onClick={() => fileRef.current?.click()}>
                Upload photo
              </Button>
              {form.values.photoDataUrl ? (
                <Button type="button" variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => form.set('photoDataUrl', undefined)}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          {cameraOpen ? <CameraDialog onClose={() => setCameraOpen(false)} onCapture={(dataUrl) => form.set('photoDataUrl', dataUrl)} onUploadInstead={() => fileRef.current?.click()} /> : null}
          {photoError ? <p role="alert" className="text-xs font-medium text-danger">{photoError}</p> : null}
          {form.errors.photoDataUrl ? <p role="alert" className="text-xs font-medium text-danger">{form.errors.photoDataUrl}</p> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" required error={form.errors.name} className="sm:col-span-2">
              {({ id, invalid, describedBy }) => <Input id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.name} onChange={(e) => form.set('name', e.target.value)} autoComplete="off" autoFocus={mode === 'new'} />}
            </Field>
            <Field label="Phone" required error={form.errors.phone}>
              {({ id, invalid, describedBy }) => <Input id={id} type="tel" inputMode="tel" aria-invalid={invalid} aria-describedby={describedBy} value={form.values.phone} onChange={(e) => form.set('phone', e.target.value)} autoComplete="off" />}
            </Field>
            <Field label="Joining date" required error={form.errors.joiningDate}>
              {({ id, invalid }) => <Input id={id} type="date" aria-invalid={invalid} value={form.values.joiningDate} onChange={(e) => onJoiningDate(e.target.value)} />}
            </Field>
            <Field label="Notes" error={form.errors.notes} className="sm:col-span-2">
              {({ id }) => <Textarea id={id} value={form.values.notes} onChange={(e) => form.set('notes', e.target.value)} placeholder="Preferred timings, how they found the gym…" />}
            </Field>
          </div>

          {mode === 'new' ? (
            <div className="border-t border-line pt-4">
              <h2 className="text-md font-medium">Membership plan</h2>
              <p className="mb-3 text-sm text-muted">Optional. Choosing a plan sells it and creates its invoice when you save. You can also sell a plan later from the member’s page.</p>
              {plans.data && activePlans.length === 0 ? (
                <p className="text-sm text-muted">No plans yet. <Link to="/plans" className="font-medium text-ink underline">Create a plan</Link> first, then come back to add the member.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Plan" error={form.errors.planId}>
                      {({ id, invalid }) => (
                        <Select id={id} aria-invalid={invalid} value={form.values.planId} onChange={(e) => form.set('planId', e.target.value)}>
                          <option value="">No plan for now</option>
                          {activePlans.map((x) => (
                            <option key={x.id} value={x.id}>{x.name} · {formatSpan(x.durationValue, x.durationUnit)} · {formatINR(x.pricePaise)}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {form.values.planId ? (
                      <Field label="Plan starts" required error={form.errors.planStartDate}>
                        {({ id, invalid }) => <Input id={id} type="date" aria-invalid={invalid} value={form.values.planStartDate} onChange={(e) => form.set('planStartDate', e.target.value)} />}
                      </Field>
                    ) : null}
                  </div>
                  {form.values.planId ? (
                    <>
                      {plan && planEnd ? (
                        <p className="rounded-xl bg-sunken/70 px-3.5 py-3 text-sm">
                          <strong className="font-medium">{formatDate(form.values.planStartDate)}</strong> to <strong className="font-medium">{formatDate(planEnd)}</strong> (last day of access).
                        </p>
                      ) : null}
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Discount" hint={plan ? `Plan price ${formatINR(plan.pricePaise)}` : undefined} error={form.errors.planDiscount}>
                          {({ id, invalid, describedBy }) => <MoneyInput id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.planDiscount} onChange={(e) => form.set('planDiscount', e.target.value)} placeholder="0" />}
                        </Field>
                        <div className="rounded-xl border border-line px-3.5 py-2.5">
                          <p className="text-xs font-medium text-muted">Net price</p>
                          <p className="tabular text-lg font-medium">{formatINR(netPaise)}</p>
                        </div>
                        <Field label="Received now" hint="Leave empty if nothing was paid yet. Partial amounts are fine." error={form.errors.planReceived}>
                          {({ id, invalid, describedBy }) => <MoneyInput id={id} aria-invalid={invalid} aria-describedby={describedBy} value={form.values.planReceived} onChange={(e) => form.set('planReceived', e.target.value)} placeholder="0" />}
                        </Field>
                        <Field label="Payment method" error={form.errors.planPaymentMethod}>
                          {({ id }) => (
                            <Select id={id} value={form.values.planPaymentMethod} onChange={(e) => form.set('planPaymentMethod', e.target.value as PaymentMethod)} disabled={payPaise <= 0}>
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
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          <div className="border-t border-line pt-4">
            <h2 className="text-md font-medium">Profile</h2>
            <p className="mb-3 text-sm text-muted">Optional. Shown on the member’s page and used for workout sheets. Health notes are visible to staff only.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date of birth" error={form.errors.dateOfBirth}>
                {({ id, invalid }) => <Input id={id} type="date" aria-invalid={invalid} value={form.values.dateOfBirth} onChange={(e) => form.set('dateOfBirth', e.target.value)} max={today} />}
              </Field>
              <Field label="Gender" error={form.errors.gender}>
                {({ id }) => (
                  <Select id={id} value={form.values.gender} onChange={(e) => form.set('gender', e.target.value as Values['gender'])}>
                    <option value="">Not recorded</option>
                    {GENDERS.map((g) => (
                      <option key={g.value} value={g.value}>{g.label}</option>
                    ))}
                  </Select>
                )}
              </Field>
              {/* Two short number fields share a row, also on phones. */}
              <div className="grid grid-cols-2 gap-4 sm:col-span-2">
                <Field label="Height (cm)" error={form.errors.heightCm}>
                  {({ id, invalid, describedBy }) => <Input id={id} inputMode="decimal" aria-invalid={invalid} aria-describedby={describedBy} value={form.values.heightCm} onChange={(e) => form.set('heightCm', e.target.value)} placeholder="172" autoComplete="off" />}
                </Field>
                <Field label="Weight (kg)" error={form.errors.weightKg}>
                  {({ id, invalid, describedBy }) => <Input id={id} inputMode="decimal" aria-invalid={invalid} aria-describedby={describedBy} value={form.values.weightKg} onChange={(e) => form.set('weightKg', e.target.value)} placeholder="68.5" autoComplete="off" />}
                </Field>
              </div>
              <Field label="Fitness goal" error={form.errors.goal} className="sm:col-span-2">
                {({ id }) => <Input id={id} list="member-goals" value={form.values.goal} onChange={(e) => form.set('goal', e.target.value)} placeholder="Fat loss, Strength, Mobility…" />}
              </Field>
              <datalist id="member-goals">{['Fat loss', 'Strength', 'Muscle gain', 'General fitness', 'Mobility', 'Endurance'].map((g) => <option key={g} value={g} />)}</datalist>
              <Field label="Health notes" hint="Injuries, conditions, medication the staff should know about" error={form.errors.healthNotes} className="sm:col-span-2">
                {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={2} value={form.values.healthNotes} onChange={(e) => form.set('healthNotes', e.target.value)} />}
              </Field>
            </div>
          </div>

          {changedElsewhere && form.dirty ? (
            <Banner tone="warn" action={<Button type="button" size="sm" variant="secondary" onClick={reloadLatest}>Load latest and discard my edits</Button>}>
              <strong>Changed in another tab.</strong> This member was updated elsewhere while you were editing. Saving now will be refused so nothing is overwritten.
            </Banner>
          ) : null}
          {duplicates.length > 0 ? (
            <Banner tone="warn">
              <strong>Possible duplicate.</strong> {duplicates.length === 1 ? 'A member' : `${duplicates.length} members`} already use this phone or name:{' '}
              {duplicates.slice(0, 3).map((d, i) => (
                <span key={d.id}>
                  {i > 0 ? ', ' : ''}
                  <Link to={`/members/${d.id}`} className="font-medium underline">{d.name}</Link>
                </span>
              ))}
              . Family members can share a number, so you can still save.
            </Banner>
          ) : null}
          <FormError message={form.formError} />
        </CardBody>
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => navigate(member ? `/members/${member.id}` : '/members')} disabled={form.saving}>
          Cancel
        </Button>
        <Button type="submit" loading={form.saving}>
          {mode === 'new' ? (form.values.planId ? 'Add member and create invoice' : 'Add member') : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
