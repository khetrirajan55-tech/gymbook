import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { UserPlus, Users, Phone, MessageCircle, ClipboardCheck, CreditCard } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { loadSnapshot, SNAPSHOT_STORES } from '@/data/snapshot'
import { memberRows, type MemberRow } from '@/domain/metrics'
import { formatDate, compareDates, diffDays } from '@/domain/dates'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/Card'
import { LinkButton } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { SearchInput, Avatar, Tabs } from '@/components/ui/misc'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { SampleBadge, Badge } from '@/components/ui/Badge'
import { filterMembers } from '@/components/domain/MemberPicker'
import { useCheckIn } from '@/components/domain/CheckInDialog'
import { expiryMessage, whatsappUrl } from '@/domain/whatsapp'

type Filter = 'all' | 'active' | 'expiring' | 'expired' | 'none' | 'archived'
type SortKey = 'name' | 'joined' | 'expiry' | 'lastVisit'
const PAGE_SIZE = 20
// A collator sorts a thousand names in a few milliseconds; String.localeCompare took tens of times longer.
const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const cmpStr = (a: string | undefined, b: string | undefined) => (a === b ? 0 : (a ?? '') < (b ?? '') ? -1 : 1)

export function MembersPage() {
  usePage('Members', 'Search, filter and manage gym members')
  const { today, settings } = useApp()
  const { checkIn, dialog: checkInDialog } = useCheckIn()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const filter = (params.get('filter') as Filter) || 'all'
  const sort = (params.get('sort') as SortKey) || 'name'
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc'
  const snap = useLiveQuery(loadSnapshot, [...SNAPSHOT_STORES])

  const update = (patch: Record<string, string | null>) => {
    // Start from the address bar, not the router's copy: the search box writes q there directly (see `search`).
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    if (!('page' in patch)) next.delete('page')
    setParams(next, { replace: true })
  }

  // The list follows every keystroke from local state. The address bar is kept current too (so reload and back
  // keep the search), but with replaceState rather than a router navigation, which re-renders the whole app.
  const [qLocal, setQLocal] = useState(q)
  useEffect(() => {
    setQLocal(q)
  }, [q])
  const search = (v: string) => {
    setQLocal(v)
    const next = new URLSearchParams(window.location.search)
    if (v) next.set('q', v)
    else next.delete('q')
    next.delete('page')
    const qs = next.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }
  // A search typed since the last router navigation starts from page 1 (the URL's page belonged to the old list).
  const page = qLocal === q ? Number(params.get('page') ?? '1') || 1 : 1

  const rows = useMemo(() => (snap.data ? memberRows(snap.data, today) : []), [snap.data, today])
  const counts = useMemo(() => {
    const live = rows.filter((r) => r.member.status !== 'archived')
    return {
      all: live.length,
      active: live.filter((r) => r.state === 'active' || r.state === 'expiring').length,
      expiring: live.filter((r) => r.state === 'expiring').length,
      expired: live.filter((r) => r.state === 'expired').length,
      none: live.filter((r) => !r.current).length,
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
    }
    list = filterMembers(list, qLocal)
    const cmp = (a: MemberRow, b: MemberRow): number => {
      switch (sort) {
        case 'joined':
          return compareDates(a.member.joiningDate, b.member.joiningDate)
        case 'expiry':
          return cmpStr(a.current?.endDate, b.current?.endDate)
        case 'lastVisit':
          return cmpStr(a.lastVisitAt, b.lastVisitAt)
        default:
          return byName.compare(a.member.name, b.member.name)
      }
    }
    return [...list].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)))
  }, [rows, filter, qLocal, sort, dir])

  const { slice, pageCount, page: safePage } = paginate(filtered, page, PAGE_SIZE)

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />

  const noMembersAtAll = rows.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={qLocal} onChange={search} placeholder="Search name or phone" className="sm:w-80" />
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Sort by" value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(':'); update({ sort: s, dir: d }) }} className="w-full text-sm sm:w-auto">
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="joined:desc">Newest first</option>
            <option value="joined:asc">Oldest first</option>
            <option value="expiry:asc">Expiry soonest</option>
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
          { value: 'archived', label: 'Archived', count: counts.archived },
        ]}
      />
      {checkInDialog}
      {noMembersAtAll ? (
        <Card>
          <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No members yet" description="Add your first member to start selling memberships and recording attendance" action={<LinkButton to="/members/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>Add member</LinkButton>} />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState title="No members match" description={qLocal ? `Nothing matches “${qLocal}” in this filter.` : 'Try another filter.'} />
        </Card>
      ) : (
        <>
          <ul aria-label="Members" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {slice.map((r) => (
              <MemberCard key={r.member.id} row={r} today={today} gym={{ name: settings.gymName, phone: settings.phone }} onCheckIn={(m) => void checkIn(m)} />
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

/**
 * One member as a card, laid out like the desk's old app: photo, name, member ID and mobile, the plan's
 * expiry in its status colour, and the four things done most from the list. Expired cards carry red
 * corners, cards about to expire amber ones, so a screen of members can be read by colour alone.
 */
function MemberCard({ row: r, today, gym, onCheckIn }: { row: MemberRow; today: string; gym: { name: string; phone: string }; onCheckIn: (m: MemberRow['member']) => void }) {
  const m = r.member
  const archived = m.status === 'archived'
  const daysLeft = r.current && r.state !== 'upcoming' ? diffDays(today, r.current.endDate) : null
  const status = !r.current
    ? 'No plan yet'
    : r.state === 'upcoming'
      ? `Starts ${formatDate(r.current.startDate)}`
      : r.state === 'expired'
        ? 'Expired'
        : daysLeft === 0
          ? 'Ends today'
          : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
  const tone = r.state === 'expired' ? 'danger' : r.state === 'expiring' ? 'warn' : null
  const corner = tone === 'danger' ? 'border-danger' : 'border-warn'
  const toneText = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : undefined
  // A plan that has ended or is about to: WhatsApp opens with the renewal reminder written; otherwise an empty chat.
  const waText = r.current && tone ? expiryMessage({ gymName: gym.name, gymPhone: gym.phone, memberName: m.name, planName: r.current.planName, endDate: r.current.endDate, today }) : ''
  const action = 'pressable relative z-[1] flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-xs text-muted hover:bg-sunken hover:text-ink'
  return (
    <li className={cn('surface-card relative flex min-w-0 flex-col overflow-hidden rounded-2xl p-4 hover:border-line-strong focus-within:border-line-strong', archived && 'opacity-80')}>
      {tone ? (
        <>
          <span aria-hidden className={cn('pointer-events-none absolute -right-px -top-px h-11 w-11 rounded-tr-2xl border-r-[5px] border-t-[5px]', corner)} />
          <span aria-hidden className={cn('pointer-events-none absolute -bottom-px -left-px h-11 w-11 rounded-bl-2xl border-b-[5px] border-l-[5px]', corner)} />
        </>
      ) : null}
      <div className="flex items-start gap-3.5">
        <Avatar name={m.name} src={m.photoDataUrl} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 pr-6">
            <h3 className="min-w-0 truncate text-md font-medium leading-6">
              {/* The name is the link; its ::after stretches over the whole card so anywhere on it opens the member. */}
              <Link to={`/members/${m.id}`} className="text-ink outline-none hover:underline after:absolute after:inset-0 after:rounded-2xl">
                {m.name}
              </Link>
            </h3>
            {m.sample ? <SampleBadge /> : null}
            {archived ? <Badge tone="muted">Archived</Badge> : null}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted">Member ID</dt>
              <dd className="tabular truncate text-sm">{m.memberCode ?? '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Mobile</dt>
              <dd className="tabular truncate text-sm">{m.phone || '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Plan expiry</dt>
              <dd className={cn('truncate text-sm font-medium', toneText)}>{r.current ? formatDate(r.current.endDate) : '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="truncate text-xs text-muted">{r.current ? r.current.planName : 'Plan'}</dt>
              <dd className={cn('truncate text-sm font-medium', toneText ?? (r.current ? 'text-success' : 'text-muted'))}>{status}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-4 gap-1 border-t border-line pt-2.5">
        {m.phone ? (
          <a className={action} href={`tel:${m.phone.replace(/[^\d+]/g, '')}`}><Phone className="h-5 w-5" aria-hidden />Call</a>
        ) : <span />}
        {m.phone ? (
          <a className={action} href={whatsappUrl(m.phone, waText)} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-5 w-5" aria-hidden />WhatsApp</a>
        ) : <span />}
        {!archived ? (
          <button type="button" className={action} onClick={() => onCheckIn(m)}><ClipboardCheck className="h-5 w-5" aria-hidden />Check in</button>
        ) : <span />}
        {!archived ? (
          <Link className={action} to={`/members/${m.id}?action=renew`}><CreditCard className="h-5 w-5" aria-hidden />{r.current ? 'Renew' : 'Sell plan'}</Link>
        ) : <span />}
      </div>
    </li>
  )
}
