import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Phone, Mail, MessageCircle, Check, RotateCcw, CalendarClock, Pencil, Trash2, BellRing } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { loadSnapshotWithoutVisits, SNAPSHOT_STORES_WITHOUT_VISITS } from '@/data/snapshot'
import { createFollowUp, updateFollowUp, setFollowUpStatus, rescheduleFollowUp, deleteFollowUp } from '@/data/services/followups'
import { followUpForm, type FollowUpFormValues } from '@/domain/validation'
import { useForm } from '@/lib/forms'
import { FOLLOWUP_TYPES, labelFor, type FollowUp, type FollowUpType, type Member } from '@/domain/types'
import { formatDate, addDays, diffDays, compareDates, isISODate, instantToDateInTz } from '@/domain/dates'
import { formatINR } from '@/domain/money'
import { memberRows, upcomingExpiries } from '@/domain/metrics'
import { Card, CardHeader } from '@/components/ui/Card'
import { PageActions } from '@/components/ui/PageActions'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select, Textarea, FormError } from '@/components/ui/Field'
import { Tabs, Avatar } from '@/components/ui/misc'
import { Badge, SampleBadge, type Tone } from '@/components/ui/Badge'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { FormModal } from '@/components/domain/FormModal'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { MemberPicker } from '@/components/domain/MemberPicker'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/data/errors'
import { expiryMessage, whatsappUrl, type MessageLang } from '@/domain/whatsapp'

const typeTone: Record<FollowUpType, Tone> = { expiry: 'warn', payment: 'danger', lead: 'info', other: 'neutral' }

const EXPIRY_WINDOWS = ['7', '15', '30'] as const
type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]
/** Rows shown before "Show all". */
const EXPIRY_PREVIEW = 6

export function FollowUpsPage() {
  usePage('Follow-ups', 'Expiry reminders, outstanding payments and leads to contact')
  const { today, settings, timezone } = useApp()
  const toast = useToast()
  const snap = useLiveQuery(loadSnapshotWithoutVisits, [...SNAPSHOT_STORES_WITHOUT_VISITS])
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const [typeFilter, setTypeFilter] = useState<'all' | FollowUpType>('all')
  const [editing, setEditing] = useState<FollowUp | { prefill: Partial<FollowUpFormValues> } | null>(null)
  const [rescheduling, setRescheduling] = useState<FollowUp | null>(null)
  const [deleting, setDeleting] = useState<FollowUp | null>(null)
  const [expiryWindow, setExpiryWindow] = useState<ExpiryWindow>('7')
  const [showAllExpiries, setShowAllExpiries] = useState(false)

  const memberById = useMemo(() => new Map((snap.data?.members ?? []).map((m) => [m.id, m])), [snap.data])
  const rows = useMemo(() => (snap.data ? memberRows(snap.data, today).filter((r) => r.member.status !== 'archived') : []), [snap.data, today])

  const list = useMemo(
    () =>
      (snap.data?.followups ?? [])
        .filter((f) => f.status === tab && (typeFilter === 'all' || f.type === typeFilter))
        .sort((a, b) => (tab === 'open' ? compareDates(a.dueDate, b.dueDate) : (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))),
    [snap.data, tab, typeFilter],
  )
  const counts = useMemo(() => ({ open: (snap.data?.followups ?? []).filter((f) => f.status === 'open').length, done: (snap.data?.followups ?? []).filter((f) => f.status === 'done').length }), [snap.data])

  const expiries = useMemo(() => (snap.data ? upcomingExpiries(snap.data, today, Number(expiryWindow)) : []), [snap.data, today, expiryWindow])

  // Suggestions: recently lapsed members and members owing money without an open follow-up of that type.
  // Memberships that have not ended yet are listed under Upcoming expiries instead.
  const suggestions = useMemo(() => {
    const open = (snap.data?.followups ?? []).filter((f) => f.status === 'open')
    const has = (memberId: string, type: FollowUpType) => open.some((f) => f.memberId === memberId && f.type === type)
    const expiry = rows.filter((r) => r.state === 'expired' && r.current && diffDays(r.current.endDate, today) <= 14 && !has(r.member.id, 'expiry'))
    const payment = rows.filter((r) => r.balancePaise > 0 && !has(r.member.id, 'payment'))
    return { expiry, payment }
  }, [rows, snap.data, today])

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast.success(ok)
    } catch (err) {
      toast.error('Could not update', errorMessage(err))
    }
  }

  const contactFor = (f: FollowUp): { name: string; phone?: string; email?: string; member?: Member } => {
    if (f.memberId) {
      const m = memberById.get(f.memberId)
      return { name: m?.name ?? 'Unknown member', phone: m?.phone, member: m }
    }
    return { name: f.leadName ?? (f.type === 'lead' ? 'Lead' : 'No contact'), phone: f.leadPhone, email: f.leadEmail }
  }

  const whatsappHref = whatsappUrl

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'open', label: 'Open', count: counts.open }, { value: 'done', label: 'Done', count: counts.done }]} />
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as 'all' | FollowUpType)} className="w-full text-sm sm:w-auto">
            <option value="all">All types</option>
            {FOLLOWUP_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
        </div>
      </div>
      <PageActions>
        <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing({ prefill: {} })}>New follow-up</Button>
      </PageActions>

      {tab === 'open' ? (
        <Card>
          <CardHeader
            title="Upcoming expiries"
            description={`Memberships ending in the next ${expiryWindow} days, soonest first. Members who have already renewed are left out.`}
            action={<Tabs value={expiryWindow} onChange={(v) => { setExpiryWindow(v); setShowAllExpiries(false) }} items={EXPIRY_WINDOWS.map((d) => ({ value: d, label: `${d} days` }))} />}
          />
          {expiries.length === 0 ? (
            <EmptyState compact icon={<CalendarClock className="h-5 w-5" aria-hidden />} title={`No memberships end in the next ${expiryWindow} days`} description="Try a longer window to look further ahead." />
          ) : (
            <>
              <ul className="divide-y divide-line">
                {(showAllExpiries ? expiries : expiries.slice(0, EXPIRY_PREVIEW)).map((x) => {
                  const reminder = (lang: MessageLang) => expiryMessage({ gymName: settings.gymName, gymPhone: settings.phone, memberName: x.member.name, planName: x.membership.planName, endDate: x.endDate, today, lang })
                  return (
                    <li key={x.member.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                      <div className="flex items-start gap-3">
                        <Avatar name={x.member.name} src={x.member.photoDataUrl} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 text-sm">
                            <Link to={`/members/${x.member.id}`} className="font-medium hover:underline">{x.member.name}</Link>
                            <Badge tone={x.daysLeft <= 3 ? 'warn' : 'neutral'}>{x.daysLeft === 0 ? 'Ends today' : x.daysLeft === 1 ? 'Ends tomorrow' : `${x.daysLeft} days left`}</Badge>
                            {x.member.sample ? <SampleBadge /> : null}
                            {x.hasOpenFollowUp ? <Badge tone="muted">Follow-up open</Badge> : null}
                          </p>
                          <p className="text-sm text-muted">{x.membership.planName} · ends {formatDate(x.endDate)} · <span className="tabular">{x.member.phone}</span></p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pl-11">
                        <a className="pressable inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm hover:bg-sunken" href={`tel:${x.member.phone.replace(/[^\d+]/g, '')}`}><Phone className="h-4 w-4" aria-hidden />Call</a>
                        <a className="pressable inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm hover:bg-sunken" href={whatsappHref(x.member.phone, reminder('en'))} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-4 w-4" aria-hidden />WhatsApp</a>
                        <a lang="mr" title="WhatsApp reminder in Marathi" className="pressable inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm hover:bg-sunken" href={whatsappHref(x.member.phone, reminder('mr'))} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-4 w-4" aria-hidden />मराठी</a>
                        <span className="flex-1" />
                        {!x.hasOpenFollowUp ? (
                          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing({ prefill: { type: 'expiry', memberId: x.member.id, dueDate: today, note: `${x.membership.planName} ends ${formatDate(x.endDate)}; offer renewal` } })}>Add follow-up</Button>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {expiries.length > EXPIRY_PREVIEW ? (
                <div className="border-t border-line px-4 py-2 sm:px-5">
                  <Button size="sm" variant="ghost" onClick={() => setShowAllExpiries((v) => !v)}>{showAllExpiries ? 'Show fewer' : `Show all ${expiries.length}`}</Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      {tab === 'open' && (suggestions.expiry.length > 0 || suggestions.payment.length > 0) ? (
        <Card>
          <CardHeader title="Suggested" description="Members who may need a call, based on lapsed plans and balances. Nothing is created until you add it." />
          <ul className="divide-y divide-line">
            {suggestions.expiry.slice(0, 5).map((r) => (
              <li key={'e' + r.member.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <Badge tone="warn">Expiry</Badge>
                <span className="flex min-w-0 flex-1 flex-col text-sm sm:flex-row sm:items-baseline sm:gap-1"><Link to={`/members/${r.member.id}`} className="truncate font-medium hover:underline">{r.member.name}</Link>{' '}<span className="truncate text-muted"><span className="hidden sm:inline">· </span>{r.current?.planName} ended {formatDate(r.current?.endDate)}</span></span>
                <Button size="sm" variant="secondary" onClick={() => setEditing({ prefill: { type: 'expiry', memberId: r.member.id, dueDate: today, note: `${r.current?.planName} ended ${formatDate(r.current?.endDate)}; offer renewal` } })}>Add</Button>
              </li>
            ))}
            {suggestions.payment.slice(0, 5).map((r) => (
              <li key={'p' + r.member.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <Badge tone="danger">Payment</Badge>
                <span className="flex min-w-0 flex-1 flex-col text-sm sm:flex-row sm:items-baseline sm:gap-1"><Link to={`/members/${r.member.id}?tab=payments`} className="truncate font-medium hover:underline">{r.member.name}</Link>{' '}<span className="shrink-0 text-muted"><span className="hidden sm:inline">· </span>owes {formatINR(r.balancePaise)}</span></span>
                <Button size="sm" variant="secondary" onClick={() => setEditing({ prefill: { type: 'payment', memberId: r.member.id, dueDate: today, note: `Collect outstanding ${formatINR(r.balancePaise)}` } })}>Add</Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={tab === 'open' ? 'To do' : 'Completed'} description="Call, WhatsApp and email buttons open your own apps with the details filled in. GymBook never sends messages by itself." />
        {list.length === 0 ? (
          <EmptyState compact icon={<BellRing className="h-5 w-5" aria-hidden />} title={tab === 'open' ? 'Nothing to follow up' : 'No completed follow-ups'} description={tab === 'open' ? 'Add one manually, or from the lists above.' : undefined} />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((f) => {
              const c = contactFor(f)
              const overdue = f.status === 'open' && compareDates(f.dueDate, today) < 0
              const dueToday = f.status === 'open' && f.dueDate === today
              const msg = `Hi ${c.name.replace(/^Sample\s+/i, '')}, this is ${settings.gymName}. ${f.note ?? ''}`.trim()
              return (
                <li key={f.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                  <div className="flex items-start gap-3">
                    <Avatar name={c.name} src={c.member?.photoDataUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        {c.member ? <Link to={`/members/${c.member.id}`} className="font-medium hover:underline">{c.name}</Link> : <span className="font-medium">{c.name}</span>}
                        <Badge tone={typeTone[f.type]}>{labelFor(FOLLOWUP_TYPES, f.type)}</Badge>
                        {overdue ? <Badge tone="danger">Overdue</Badge> : dueToday ? <Badge tone="warn">Due today</Badge> : null}
                        {f.sample ? <SampleBadge /> : null}
                      </p>
                      <p className="text-sm text-muted">{f.note || '—'}</p>
                      <p className="text-xs text-muted">
                        {f.status === 'open' ? `Due ${formatDate(f.dueDate)}` : `Completed ${f.completedAt ? formatDate(instantToDateInTz(f.completedAt, timezone)) : '—'}`}
                        {f.assignee ? ` · ${f.assignee}` : ''}
                        {c.phone ? ` · ${c.phone}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-11">
                    {c.phone ? <a className="pressable inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm hover:bg-sunken" href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}><Phone className="h-4 w-4" aria-hidden />Call</a> : null}
                    {c.phone ? <a className="pressable inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm hover:bg-sunken" href={whatsappHref(c.phone, msg)} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-4 w-4" aria-hidden />WhatsApp</a> : null}
                    {c.email ? <a className="pressable inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm hover:bg-sunken" href={`mailto:${c.email}?subject=${encodeURIComponent(settings.gymName)}&body=${encodeURIComponent(msg)}`}><Mail className="h-4 w-4" aria-hidden />Email</a> : null}
                    <span className="flex-1" />
                    {f.status === 'open' ? (
                      <>
                        <Button size="sm" variant="secondary" icon={<CalendarClock className="h-4 w-4" aria-hidden />} onClick={() => setRescheduling(f)}>Reschedule</Button>
                        <Button size="sm" variant="secondary" icon={<Pencil className="h-4 w-4" aria-hidden />} onClick={() => setEditing(f)}>Edit</Button>
                        <Button size="sm" variant="secondary" icon={<Check className="h-4 w-4" aria-hidden />} onClick={() => act(() => setFollowUpStatus(f.id, f.rev, 'done'), 'Marked done')}>Done</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="secondary" icon={<RotateCcw className="h-4 w-4" aria-hidden />} onClick={() => act(() => setFollowUpStatus(f.id, f.rev, 'open'), 'Reopened')}>Reopen</Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setDeleting(f)}>Delete</Button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {editing ? <FollowUpDialog existing={'prefill' in editing ? undefined : editing} prefill={'prefill' in editing ? editing.prefill : undefined} rows={rows} onClose={() => setEditing(null)} /> : null}
      {rescheduling ? <RescheduleDialog followUp={rescheduling} today={today} onClose={() => setRescheduling(null)} /> : null}
      <ConfirmDialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete this follow-up?" description="Completed follow-ups can be deleted to tidy the list. This cannot be undone." confirmLabel="Delete" danger onConfirm={async () => { if (deleting) { await deleteFollowUp(deleting.id); toast.success('Deleted') } }} />
    </div>
  )
}

function FollowUpDialog({ existing, prefill, rows, onClose }: { existing?: FollowUp; prefill?: Partial<FollowUpFormValues>; rows: ReturnType<typeof memberRows>; onClose: () => void }) {
  const { today } = useApp()
  const toast = useToast()
  const initialMember = rows.find((r) => r.member.id === (existing?.memberId ?? prefill?.memberId))?.member ?? null
  const [member, setMember] = useState<Member | null>(initialMember)
  const form = useForm<{ type: FollowUpType; memberId: string; leadName: string; leadPhone: string; leadEmail: string; dueDate: string; assignee: string; note: string }, FollowUpFormValues>(
    {
      type: existing?.type ?? prefill?.type ?? 'expiry',
      memberId: existing?.memberId ?? prefill?.memberId ?? '',
      leadName: existing?.leadName ?? '',
      leadPhone: existing?.leadPhone ?? '',
      leadEmail: existing?.leadEmail ?? '',
      dueDate: existing?.dueDate ?? prefill?.dueDate ?? today,
      assignee: existing?.assignee ?? '',
      note: existing?.note ?? prefill?.note ?? '',
    },
    followUpForm,
    async (values) => {
      if (existing) {
        await updateFollowUp(existing.id, existing.rev, values)
        toast.success('Follow-up updated')
      } else {
        await createFollowUp(values)
        toast.success('Follow-up added')
      }
      onClose()
    },
  )
  const isLead = form.values.type === 'lead'
  return (
    <FormModal open onClose={onClose} dirty={form.dirty} saving={form.saving} title={existing ? 'Edit follow-up' : 'New follow-up'}
      footer={(requestClose) => <><Button variant="secondary" onClick={requestClose} disabled={form.saving}>Cancel</Button><Button onClick={() => form.submit()} loading={form.saving} data-primary>{existing ? 'Save' : 'Add follow-up'}</Button></>}
    >
      <form onSubmit={form.submit} noValidate className="flex flex-col gap-4">
        <Field label="Type" required error={form.errors.type}>
          {({ id }) => (
            <Select id={id} value={form.values.type} onChange={(e) => form.set('type', e.target.value as FollowUpType)} autoFocus>
              {FOLLOWUP_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
          )}
        </Field>
        {isLead ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Lead name" required error={form.errors.leadName} className="sm:col-span-2">
              {({ id, invalid }) => <Input id={id} aria-invalid={invalid} value={form.values.leadName} onChange={(e) => form.set('leadName', e.target.value)} />}
            </Field>
            <Field label="Phone" error={form.errors.leadPhone}>
              {({ id }) => <Input id={id} type="tel" value={form.values.leadPhone} onChange={(e) => form.set('leadPhone', e.target.value)} />}
            </Field>
            <Field label="Email" error={form.errors.leadEmail}>
              {({ id, invalid }) => <Input id={id} type="email" aria-invalid={invalid} value={form.values.leadEmail} onChange={(e) => form.set('leadEmail', e.target.value)} />}
            </Field>
          </div>
        ) : (
          <Field label="Member" required={form.values.type !== 'other'} error={form.errors.memberId}>
            {({ id, invalid, describedBy }) => (
              <MemberPicker id={id} invalid={invalid} describedBy={describedBy} rows={rows.map((r) => ({ member: r.member, state: r.state }))} value={member} onChange={(m) => { setMember(m); form.set('memberId', m?.id ?? '') }} />
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due date" required error={form.errors.dueDate}>
            {({ id, invalid }) => <Input id={id} type="date" aria-invalid={invalid} value={form.values.dueDate} onChange={(e) => form.set('dueDate', e.target.value)} />}
          </Field>
          <Field label="Assignee" hint="Who will make the call" error={form.errors.assignee}>
            {({ id }) => <Input id={id} value={form.values.assignee} onChange={(e) => form.set('assignee', e.target.value)} placeholder="e.g. Reception" />}
          </Field>
        </div>
        <Field label="Note" hint="Included in the WhatsApp / email draft" error={form.errors.note}>
          {({ id }) => <Textarea id={id} rows={2} value={form.values.note} onChange={(e) => form.set('note', e.target.value)} />}
        </Field>
        <FormError message={form.formError} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </FormModal>
  )
}

function RescheduleDialog({ followUp, today, onClose }: { followUp: FollowUp; today: string; onClose: () => void }) {
  const toast = useToast()
  const [date, setDate] = useState(compareDates(followUp.dueDate, today) < 0 ? addDays(today, 1) : addDays(followUp.dueDate, 1))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    if (!isISODate(date)) {
      setError('Enter a valid due date')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await rescheduleFollowUp(followUp.id, followUp.rev, date)
      toast.success(`Rescheduled to ${formatDate(date)}`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title="Reschedule follow-up" size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} data-primary>Reschedule</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {[1, 3, 7].map((d) => (
            <Button key={d} size="sm" variant="outline" onClick={() => setDate(addDays(today, d))}>+{d} day{d === 1 ? '' : 's'}</Button>
          ))}
        </div>
        <Field label="New due date" required>
          {({ id }) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <FormError message={error} />
      </div>
    </Modal>
  )
}
