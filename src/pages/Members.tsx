import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { UserPlus, Users } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { loadSnapshot, SNAPSHOT_STORES } from '@/data/snapshot'
import { memberRows, type MemberRow } from '@/domain/metrics'
import { formatDate, compareDates, diffDays, instantToDateInTz } from '@/domain/dates'
import { formatINR } from '@/domain/money'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/Card'
import { LinkButton } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { SearchInput, Avatar, Tabs } from '@/components/ui/misc'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { MembershipStateBadge } from '@/components/domain/MembershipBadge'
import { SampleBadge, Badge } from '@/components/ui/Badge'
import { filterMembers } from '@/components/domain/MemberPicker'

type Filter = 'all' | 'active' | 'expiring' | 'expired' | 'none' | 'balance' | 'archived'
type SortKey = 'name' | 'joined' | 'expiry' | 'balance' | 'lastVisit'
const PAGE_SIZE = 20

export function MembersPage() {
  usePage('Members', 'Search, filter and manage gym members')
  const { today, timezone } = useApp()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const filter = (params.get('filter') as Filter) || 'all'
  const sort = (params.get('sort') as SortKey) || 'name'
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc'
  const page = Number(params.get('page') ?? '1') || 1
  const snap = useLiveQuery(loadSnapshot, [...SNAPSHOT_STORES])

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    if (!('page' in patch)) next.delete('page')
    setParams(next, { replace: true })
  }

  // Keep the search box local so fast typing never races the URL round-trip; the URL follows after a short pause.
  const [qLocal, setQLocal] = useState(q)
  useEffect(() => {
    setQLocal(q)
  }, [q])

  const rows = useMemo(() => (snap.data ? memberRows(snap.data, today) : []), [snap.data, today])
  const counts = useMemo(() => {
    const live = rows.filter((r) => r.member.status !== 'archived')
    return {
      all: live.length,
      active: live.filter((r) => r.state === 'active' || r.state === 'expiring').length,
      expiring: live.filter((r) => r.state === 'expiring').length,
      expired: live.filter((r) => r.state === 'expired').length,
      none: live.filter((r) => !r.current).length,
      balance: live.filter((r) => r.balancePaise > 0).length,
      archived: rows.filter((r) => r.member.status === 'archived').length,
    }
  }, [rows])

  const filtered = useMemo(() => {
    let list = rows
    if (filter === 'archived') list = list.filter((r) => r.member.status === 'archived')
    else {
      list = list.filter((r) => r.member.status !== 'archived')
      if (filter === 'active') list = list.filter((r) => r.state === 'active' || r.state === 'expiring')
      if (filter === 'expiring') list = list.filter((r) => r.state === 'expiring')
      if (filter === 'expired') list = list.filter((r) => r.state === 'expired')
      if (filter === 'none') list = list.filter((r) => !r.current)
      if (filter === 'balance') list = list.filter((r) => r.balancePaise > 0)
    }
    list = filterMembers(list, q)
    const cmp = (a: MemberRow, b: MemberRow): number => {
      switch (sort) {
        case 'joined':
          return compareDates(a.member.joiningDate, b.member.joiningDate)
        case 'expiry':
          return (a.current?.endDate ?? '').localeCompare(b.current?.endDate ?? '')
        case 'balance':
          return a.balancePaise - b.balancePaise
        case 'lastVisit':
          return (a.lastVisitAt ?? '').localeCompare(b.lastVisitAt ?? '')
        default:
          return a.member.name.localeCompare(b.member.name)
      }
    }
    return [...list].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)))
  }, [rows, filter, q, sort, dir])

  const { slice, pageCount, page: safePage } = paginate(filtered, page, PAGE_SIZE)

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />

  const noMembersAtAll = rows.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={qLocal} onChange={(v) => { setQLocal(v); update({ q: v }) }} placeholder="Search name or phone" className="sm:w-80" />
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Sort by" value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(':'); update({ sort: s, dir: d }) }} className="w-full text-sm sm:w-auto">
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="joined:desc">Newest first</option>
            <option value="joined:asc">Oldest first</option>
            <option value="expiry:asc">Expiry soonest</option>
            <option value="balance:desc">Highest balance</option>
            <option value="lastVisit:desc">Recent visit</option>
          </Select>
        </div>
      </div>
      <Tabs
        value={filter}
        onChange={(f) => update({ filter: f === 'all' ? null : f })}
        items={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'active', label: 'Active', count: counts.active },
          { value: 'expiring', label: 'Expiring', count: counts.expiring },
          { value: 'expired', label: 'Expired', count: counts.expired },
          { value: 'none', label: 'No plan', count: counts.none },
          { value: 'balance', label: 'Owing', count: counts.balance },
          { value: 'archived', label: 'Archived', count: counts.archived },
        ]}
      />
      {noMembersAtAll ? (
        <Card>
          <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No members yet" description="Add your first member to start selling memberships and recording attendance" action={<LinkButton to="/members/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>Add member</LinkButton>} />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState title="No members match" description={q ? `Nothing matches “${q}” in this filter.` : 'Try another filter.'} />
        </Card>
      ) : (
        <>
          <ul aria-label="Members" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {slice.map((r) => (
              <MemberCard key={r.member.id} row={r} today={today} timezone={timezone} />
            ))}
          </ul>
          <Card>
            <Pagination page={safePage} pageCount={pageCount} total={filtered.length} pageSize={PAGE_SIZE} onChange={(p) => update({ page: String(p) })} />
          </Card>
        </>
      )}
    </div>
  )
}

/** One member as a card: who they are, where their membership stands, and the three facts the desk asks about. */
function MemberCard({ row: r, today, timezone }: { row: MemberRow; today: string; timezone: string }) {
  const m = r.member
  const archived = m.status === 'archived'
  const daysLeft = r.current && r.state !== 'upcoming' ? diffDays(today, r.current.endDate) : null
  const planLine = !r.current
    ? 'No plan yet'
    : r.state === 'upcoming'
      ? `${r.current.planName} · starts ${formatDate(r.current.startDate)}`
      : r.state === 'expired'
        ? `${r.current.planName} · ended ${formatDate(r.current.endDate)}`
        : daysLeft === 0
          ? `${r.current.planName} · ends today`
          : `${r.current.planName} · ends ${formatDate(r.current.endDate)} (${daysLeft} day${daysLeft === 1 ? '' : 's'})`
  const balanceCls = r.balancePaise > 0 ? 'font-medium text-danger' : r.balancePaise < 0 ? 'text-info' : 'text-muted'
  return (
    <li className={cn('surface-card pressable relative flex min-w-0 flex-col rounded-2xl p-4 hover:border-line-strong focus-within:border-line-strong', archived && 'opacity-80')}>
      <div className="flex items-start gap-3">
        <Avatar name={m.name} src={m.photoDataUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 leading-5">
            {/* The name is the link; its ::after stretches over the whole card so anywhere on it opens the member. */}
            <Link to={`/members/${m.id}`} className="truncate font-medium text-ink outline-none hover:underline after:absolute after:inset-0 after:rounded-2xl">
              {m.name}
            </Link>
            {m.sample ? <SampleBadge /> : null}
            {archived ? <Badge tone="muted">Archived</Badge> : null}
          </p>
          <p className="tabular mt-0.5 text-sm text-muted">{m.phone}</p>
        </div>
        <MembershipStateBadge state={r.state} />
      </div>
      <p className={cn('mt-3 text-sm', r.current ? 'text-ink' : 'text-muted')}>{planLine}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Balance</dt>
          <dd className={cn('tabular mt-0.5 truncate text-sm', balanceCls)}>{r.balancePaise === 0 ? '—' : formatINR(r.balancePaise)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Last visit</dt>
          <dd className="mt-0.5 truncate text-sm">{r.lastVisitAt ? formatDate(instantToDateInTz(r.lastVisitAt, timezone)) : '—'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Joined</dt>
          <dd className="mt-0.5 truncate text-sm">{formatDate(m.joiningDate)}</dd>
        </div>
      </dl>
    </li>
  )
}
