import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardCheck, Receipt, ArrowRight, Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { PageActions } from '@/components/ui/PageActions'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { loadSnapshot, SNAPSHOT_STORES } from '@/data/snapshot'
import { listRecentActivity } from '@/data/services/activity'
import { dashboardMetrics, financeSeries, financeSummary, periodPreset, monthComparison, type Period } from '@/domain/metrics'
import { formatINRCompact, formatINR } from '@/domain/money'
import { formatDate, formatDateTime, diffDays, formatMonthKey } from '@/domain/dates'
import { Stat, Avatar, LiveDot } from '@/components/ui/misc'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { LinkButton } from '@/components/ui/Button'
import { PageLoading } from '@/components/ui/Spinner'
import { ErrorState, EmptyState } from '@/components/ui/EmptyState'
import { BarChart } from '@/components/charts/BarChart'
import { PeriodPicker, type PresetName } from '@/components/domain/PeriodPicker'
import { MembershipStateBadge } from '@/components/domain/MembershipBadge'
import { SampleBadge } from '@/components/ui/Badge'

export function Dashboard() {
  usePage('Dashboard', 'Today’s overview: active members, expiries, attendance and money')
  const { today, timezone } = useApp()
  const snap = useLiveQuery(loadSnapshot, [...SNAPSHOT_STORES])
  const activity = useLiveQuery(() => listRecentActivity(12), 'all')
  const [preset, setPreset] = useState<PresetName>('30d')
  const [period, setPeriod] = useState<Period>(() => periodPreset('30d', today))

  const metrics = useMemo(() => (snap.data ? dashboardMetrics(snap.data, today, timezone) : null), [snap.data, today, timezone])
  const finance = useMemo(() => (snap.data ? financeSummary(snap.data, period, timezone) : null), [snap.data, period, timezone])
  const series = useMemo(() => (snap.data ? financeSeries(snap.data, period, timezone) : null), [snap.data, period, timezone])
  const mom = useMemo(() => (snap.data ? monthComparison(snap.data, today, timezone) : null), [snap.data, today, timezone])

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data || !metrics || !finance || !series || !mom) return <PageLoading />

  const labels = series.points.map((p) => (series.granularity === 'day' ? p.key.slice(8) + '/' + p.key.slice(5, 7) : formatMonthKey(p.key)))

  return (
    <div className="flex flex-col gap-5">
      <PageActions>
        <LinkButton to="/attendance?action=checkin" variant="secondary" icon={<ClipboardCheck className="h-4 w-4" aria-hidden />}>
          Check in
        </LinkButton>
        <LinkButton to="/payments?action=record" variant="secondary" icon={<Receipt className="h-4 w-4" aria-hidden />}>
          Record payment
        </LinkButton>
      </PageActions>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat to="/members?filter=active" label="Active members" value={metrics.activeMembers} hint={`${metrics.totalMembers} members in total`} />
        <Stat to="/members?filter=expiring" label="Expiring in 7 days" value={metrics.expiringSoon.length} tone={metrics.expiringSoon.length ? 'warn' : undefined} hint={`${metrics.expiredRecently.length} lapsed in the last 30 days`} />
        <Stat to="/attendance" label="Attendance today" value={metrics.attendanceToday} hint={<span className="inline-flex items-center gap-1.5">{metrics.checkedInNow > 0 ? <LiveDot /> : null}{metrics.checkedInNow} in the gym now</span>} />
        <Stat to="/payments" label="Cash this month" value={formatINRCompact(mom.received[0])} hint={`last month ${formatINRCompact(mom.received[1])}`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Money"
            description="Cash received is what actually came in. Invoiced is what was billed."
            action={<PeriodPicker preset={preset} period={period} today={today} onChange={(p, per) => { setPreset(p); setPeriod(per) }} />}
          />
          <CardBody className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <MoneyCell label="Cash received" value={finance.receivedPaise} hint={`${finance.paymentsCount} payment${finance.paymentsCount === 1 ? '' : 's'}`} />
              <MoneyCell label="Invoiced" value={finance.invoicedPaise} hint={`${finance.invoicesCount} invoice${finance.invoicesCount === 1 ? '' : 's'}`} />
            </div>
            <BarChart
              labels={labels}
              series={[{ key: 'received', label: 'Cash received', color: 'rgb(var(--c-success))', values: series.points.map((p) => p.received), format: formatINR }]}
              height={280}
            />
          </CardBody>
        </Card>
        <Card className="lg:self-start">
          <CardHeader title="This month so far" description="Compared with the same days last month" />
          <ul className="divide-y divide-line">
            <Delta label="Cash received" now={mom.received[0]} prev={mom.received[1]} fmt={formatINRCompact} />
            <Delta label="New members" now={mom.newMembers[0]} prev={mom.newMembers[1]} fmt={String} />
            <Delta label="Visits" now={mom.visits[0]} prev={mom.visits[1]} fmt={String} />
          </ul>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Expiring memberships" description="Ending within the next 7 days" action={<Link to="/follow-ups" className="text-sm font-medium text-accent-ink hover:underline">Follow-ups →</Link>} />
          {metrics.expiringSoon.length === 0 ? (
            <EmptyState compact title="Nothing expiring this week" description="Members whose plan ends in the next 7 days will show here" />
          ) : (
            <ul className="divide-y divide-line">
              {metrics.expiringSoon.slice(0, 8).map((r) => (
                <li key={r.member.id}>
                  <Link to={`/members/${r.member.id}`} className="pressable flex items-center gap-3 px-4 py-2.5 hover:bg-sunken/60 sm:px-5">
                    <Avatar name={r.member.name} src={r.member.photoDataUrl} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="truncate">{r.member.name}</span>
                        {r.member.sample ? <SampleBadge /> : null}
                      </span>
                      <span className="block text-xs text-muted">
                        {r.current?.planName} · ends {formatDate(r.current?.endDate)} ({diffDays(today, r.current!.endDate)} day{diffDays(today, r.current!.endDate) === 1 ? '' : 's'})
                      </span>
                    </span>
                    <MembershipStateBadge state={r.state} />
                    <ArrowRight className="h-4 w-4 text-faint" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent activity" description="Latest changes recorded in this browser" />
          {activity.data && activity.data.length === 0 ? (
            <EmptyState compact icon={<Activity className="h-5 w-5" aria-hidden />} title="No activity yet" description="Adding members, selling memberships and recording payments will show here" />
          ) : (
            <ul className="divide-y divide-line">
              {(activity.data ?? []).map((a) => (
                <li key={a.id} className="px-4 py-2.5 sm:px-5">
                  <p className="break-words text-sm">
                    {a.memberId ? (
                      <Link to={`/members/${a.memberId}`} className="hover:underline">
                        {a.message}
                      </Link>
                    ) : (
                      a.message
                    )}
                  </p>
                  <p className="text-xs text-muted">{formatDateTime(a.at, timezone)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function Delta({ label, now, prev, fmt }: { label: string; now: number; prev: number; fmt: (v: number) => string }) {
  const pct = prev === 0 ? (now === 0 ? 0 : null) : Math.round(((now - prev) / prev) * 100)
  const up = now > prev
  const same = now === prev
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">last month {fmt(prev)}</p>
      </div>
      <div className="text-right">
        <p className="tabular text-base font-medium">{fmt(now)}</p>
        <p className={`flex items-center justify-end gap-1 text-xs ${same ? 'text-muted' : up ? 'text-success' : 'text-danger'}`}>
          {same ? <Minus className="h-3 w-3" aria-hidden /> : up ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
          {pct === null ? 'new' : `${pct > 0 ? '+' : ''}${pct}%`}
        </p>
      </div>
    </li>
  )
}

function MoneyCell({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-sunken/50 px-3.5 py-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="tabular mt-1 text-lg font-medium leading-6 [overflow-wrap:anywhere]">{formatINR(value)}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  )
}
