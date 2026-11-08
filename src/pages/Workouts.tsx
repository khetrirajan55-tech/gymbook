import { useMemo, useState } from 'react'
import { appUrl } from '@/lib/appUrl'
import { Plus, Pencil, Archive, ArchiveRestore, Dumbbell, Copy, ChevronDown, ChevronUp, Trash2, Printer } from 'lucide-react'
import { usePage } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { loadSnapshotWithoutVisits, SNAPSHOT_STORES_WITHOUT_VISITS } from '@/data/snapshot'
import { createWorkout, createWorkoutFromTemplate, updateWorkout, setWorkoutArchived } from '@/data/services/workouts'
import { WORKOUT_LIBRARY } from '@/domain/workoutLibrary'
import { workoutForm, type WorkoutFormValues } from '@/domain/validation'
import { useForm } from '@/lib/forms'
import type { WorkoutPlan, WorkoutDay } from '@/domain/types'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, Input, Textarea, FormError } from '@/components/ui/Field'
import { Badge, SampleBadge } from '@/components/ui/Badge'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { PageActions } from '@/components/ui/PageActions'
import { FormModal } from '@/components/domain/FormModal'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/data/errors'
import { cn } from '@/lib/cn'

export function WorkoutsPage() {
  usePage('Workout plans', 'Reusable training programmes you can assign to members, from the library or your own')
  const toast = useToast()
  const snap = useLiveQuery(loadSnapshotWithoutVisits, [...SNAPSHOT_STORES_WITHOUT_VISITS])
  const [editing, setEditing] = useState<WorkoutPlan | 'new' | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const mem of snap.data?.members ?? []) if (mem.workoutPlanId && mem.status !== 'archived') m.set(mem.workoutPlanId, (m.get(mem.workoutPlanId) ?? 0) + 1)
    return m
  }, [snap.data])

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />
  const plans = snap.data.workouts.filter((w) => showArchived || !w.archived).sort((a, b) => a.name.localeCompare(b.name))
  const archivedCount = snap.data.workouts.filter((w) => w.archived).length

  const copyTemplate = async (key: string) => {
    try {
      const w = await createWorkoutFromTemplate(key)
      toast.success(`Added “${w.name}” to your plans`, 'Edit it freely; the library copy stays unchanged.')
    } catch (err) {
      toast.error('Could not add plan', errorMessage(err))
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageActions>
        <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing('new')}>New plan</Button>
      </PageActions>

      <Card>
        <CardHeader title="Your plans" description="Assign a plan from a member’s profile. Archived plans stay on members who already have them." action={archivedCount > 0 ? <Button variant="ghost" size="sm" onClick={() => setShowArchived((s) => !s)}>{showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}</Button> : undefined} />
        {plans.length === 0 ? (
          <EmptyState compact icon={<Dumbbell className="h-5 w-5" aria-hidden />} title="No plans yet" description="Start from a library template below or build your own" action={<Button size="sm" onClick={() => setEditing('new')} icon={<Plus className="h-4 w-4" aria-hidden />}>New plan</Button>} />
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {plans.map((w) => {
              const open = expanded === w.id
              const exerciseCount = w.days.reduce((s, d) => s + d.exercises.length, 0)
              return (
                <li key={w.id} className={cn('px-5 py-3', w.archived && 'opacity-70')}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <button type="button" onClick={() => setExpanded(open ? null : w.id)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {w.name}
                          {open ? <ChevronUp className="h-4 w-4 text-faint" aria-hidden /> : <ChevronDown className="h-4 w-4 text-faint" aria-hidden />}
                        </span>
                        <Badge tone={w.source === 'library' ? 'info' : 'neutral'}>{w.source === 'library' ? 'From library' : 'Custom'}</Badge>
                        {w.sample ? <SampleBadge /> : null}
                        {w.archived ? <Badge tone="muted">Archived</Badge> : null}
                      </p>
                      <p className="text-sm text-muted">{w.goal} · {w.days.length} day{w.days.length === 1 ? '' : 's'} · {exerciseCount} exercises · {usage.get(w.id) ?? 0} member{(usage.get(w.id) ?? 0) === 1 ? '' : 's'}</p>
                      {w.description ? <p className="mt-0.5 text-sm text-muted">{w.description}</p> : null}
                    </button>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button size="sm" variant="ghost" icon={<Printer className="h-4 w-4" aria-hidden />} onClick={() => window.open(appUrl(`/workouts/${w.id}/print`), '_blank', 'noopener')}>Print</Button>
                      <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" aria-hidden />} onClick={() => setEditing(w)}>Edit</Button>
                      <Button size="sm" variant="ghost" icon={w.archived ? <ArchiveRestore className="h-4 w-4" aria-hidden /> : <Archive className="h-4 w-4" aria-hidden />} onClick={async () => { try { await setWorkoutArchived(w.id, w.rev, !w.archived); toast.success(w.archived ? 'Plan restored' : 'Plan archived') } catch (err) { toast.error('Could not update', errorMessage(err)) } }}>{w.archived ? 'Restore' : 'Archive'}</Button>
                    </div>
                  </div>
                  {open ? <PlanDays days={w.days} className="mt-3" /> : null}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Library" description="Built-in starting points. Using one copies it into your plans so you can tailor it." />
        <div className="grid gap-3 p-5 pt-3 sm:grid-cols-2">
          {WORKOUT_LIBRARY.map((t) => (
            <div key={t.key} className="flex flex-col gap-2 rounded-xl border border-line bg-sunken/40 p-4">
              <div>
                <p className="font-medium">{t.name}</p>
                <p className="text-xs text-muted">{t.goal} · {t.days.length} days</p>
              </div>
              <p className="text-sm text-muted">{t.description}</p>
              <div className="mt-auto pt-1">
                <Button size="sm" variant="secondary" icon={<Copy className="h-4 w-4" aria-hidden />} onClick={() => copyTemplate(t.key)}>Use template</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {editing ? <WorkoutDialog plan={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

export function PlanDays({ days, className }: { days: WorkoutDay[]; className?: string }) {
  return (
    <div className={cn('grid gap-3 md:grid-cols-2', className)}>
      {days.map((d, i) => (
        <div key={i} className="rounded-xl border border-line bg-surface">
          <p className="border-b border-line px-3.5 py-2 text-sm font-medium">{d.title}</p>
          <table className="w-full text-sm">
            <tbody>
              {d.exercises.map((e, j) => (
                <tr key={j} className="border-b border-line last:border-b-0">
                  <td className="px-3.5 py-1.5">{e.name}{e.note ? <span className="block text-xs text-muted">{e.note}</span> : null}</td>
                  <td className="tabular whitespace-nowrap px-3.5 py-1.5 text-right text-muted">{e.sets} × {e.reps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

type DayInput = { title: string; exercises: { name: string; sets: string; reps: string; note: string }[] }
type Values = { name: string; goal: string; description: string; days: DayInput[] }

function WorkoutDialog({ plan, onClose }: { plan?: WorkoutPlan; onClose: () => void }) {
  const toast = useToast()
  const initial: Values = {
    name: plan?.name ?? '',
    goal: plan?.goal ?? '',
    description: plan?.description ?? '',
    days: plan ? plan.days.map((d) => ({ title: d.title, exercises: d.exercises.map((e) => ({ name: e.name, sets: String(e.sets), reps: e.reps, note: e.note ?? '' })) })) : [{ title: 'Day 1', exercises: [{ name: '', sets: '3', reps: '10', note: '' }] }],
  }
  const form = useForm<Values, WorkoutFormValues>(initial, workoutForm, async (values) => {
    if (plan) await updateWorkout(plan.id, plan.rev, values)
    else await createWorkout(values, 'custom')
    toast.success(plan ? 'Plan updated' : 'Plan created')
    onClose()
  })
  const setDays = (days: DayInput[]) => form.set('days', days)
  const days = form.values.days
  const errAt = (path: string) => form.errors[path]

  return (
    <FormModal open onClose={onClose} dirty={form.dirty} saving={form.saving} title={plan ? `Edit ${plan.name}` : 'New workout plan'} size="xl"
      footer={(requestClose) => <><Button variant="secondary" onClick={requestClose} disabled={form.saving}>Cancel</Button><Button onClick={() => form.submit()} loading={form.saving} data-primary>{plan ? 'Save plan' : 'Create plan'}</Button></>}
    >
      <form onSubmit={form.submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan name" required error={form.errors.name}>
            {({ id, invalid }) => <Input id={id} aria-invalid={invalid} value={form.values.name} onChange={(e) => form.set('name', e.target.value)} autoFocus />}
          </Field>
          <Field label="Goal" required error={form.errors.goal}>
            {({ id, invalid }) => <Input id={id} aria-invalid={invalid} list="workout-goals" value={form.values.goal} onChange={(e) => form.set('goal', e.target.value)} placeholder="Fat loss, Strength, Mobility…" />}
          </Field>
          <datalist id="workout-goals">{['Fat loss', 'Strength', 'Muscle gain', 'General fitness', 'Mobility', 'Endurance'].map((g) => <option key={g} value={g} />)}</datalist>
          <Field label="Description" error={form.errors.description} className="sm:col-span-2">
            {({ id }) => <Textarea id={id} rows={2} value={form.values.description} onChange={(e) => form.set('description', e.target.value)} />}
          </Field>
        </div>
        {form.errors.days ? <p role="alert" className="text-xs font-medium text-danger">{form.errors.days}</p> : null}
        <div className="flex flex-col gap-3">
          {days.map((d, di) => (
            <div key={di} className="rounded-xl border border-line p-3.5">
              <div className="flex items-center gap-2">
                <Input aria-label={`Day ${di + 1} title`} value={d.title} onChange={(e) => setDays(days.map((x, i) => (i === di ? { ...x, title: e.target.value } : x)))} className="font-medium" />
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove day ${di + 1}`} disabled={days.length === 1} icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setDays(days.filter((_, i) => i !== di))} />
              </div>
              {errAt(`days.${di}.title`) ? <p role="alert" className="mt-1 text-xs font-medium text-danger">{errAt(`days.${di}.title`)}</p> : null}
              {errAt(`days.${di}.exercises`) ? <p role="alert" className="mt-1 text-xs font-medium text-danger">{errAt(`days.${di}.exercises`)}</p> : null}
              <div className="mt-2 flex flex-col gap-2">
                {d.exercises.map((ex, ei) => (
                  <div key={ei} className="grid grid-cols-[minmax(0,1fr)_64px_84px_auto] items-start gap-2 sm:grid-cols-[minmax(0,2fr)_72px_96px_minmax(0,1fr)_auto]">
                    <div>
                      <Input aria-label={`Exercise ${ei + 1} name`} placeholder="Exercise" value={ex.name} onChange={(e) => setDays(days.map((x, i) => (i === di ? { ...x, exercises: x.exercises.map((y, j) => (j === ei ? { ...y, name: e.target.value } : y)) } : x)))} aria-invalid={!!errAt(`days.${di}.exercises.${ei}.name`)} />
                      {errAt(`days.${di}.exercises.${ei}.name`) ? <p role="alert" className="mt-1 text-xs text-danger">{errAt(`days.${di}.exercises.${ei}.name`)}</p> : null}
                    </div>
                    <Input aria-label="Sets" type="number" inputMode="numeric" min={1} max={50} value={ex.sets} onChange={(e) => setDays(days.map((x, i) => (i === di ? { ...x, exercises: x.exercises.map((y, j) => (j === ei ? { ...y, sets: e.target.value } : y)) } : x)))} aria-invalid={!!errAt(`days.${di}.exercises.${ei}.sets`)} />
                    <Input aria-label="Reps" placeholder="Reps" value={ex.reps} onChange={(e) => setDays(days.map((x, i) => (i === di ? { ...x, exercises: x.exercises.map((y, j) => (j === ei ? { ...y, reps: e.target.value } : y)) } : x)))} aria-invalid={!!errAt(`days.${di}.exercises.${ei}.reps`)} />
                    <Input aria-label="Note" placeholder="Note" value={ex.note} onChange={(e) => setDays(days.map((x, i) => (i === di ? { ...x, exercises: x.exercises.map((y, j) => (j === ei ? { ...y, note: e.target.value } : y)) } : x)))} className="hidden sm:block" />
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove exercise" disabled={d.exercises.length === 1} icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setDays(days.map((x, i) => (i === di ? { ...x, exercises: x.exercises.filter((_, j) => j !== ei) } : x)))} />
                  </div>
                ))}
                <div>
                  <Button type="button" size="sm" variant="outline" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setDays(days.map((x, i) => (i === di ? { ...x, exercises: [...x.exercises, { name: '', sets: '3', reps: '10', note: '' }] } : x)))}>Add exercise</Button>
                </div>
              </div>
            </div>
          ))}
          <div>
            <Button type="button" size="sm" variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} disabled={days.length >= 14} onClick={() => setDays([...days, { title: `Day ${days.length + 1}`, exercises: [{ name: '', sets: '3', reps: '10', note: '' }] }])}>Add day</Button>
          </div>
        </div>
        <FormError message={form.formError} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </FormModal>
  )
}
