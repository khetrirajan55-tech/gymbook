import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity as ActivityIcon } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { readTx } from '@/data/db'
import type { Activity, ActivityKind } from '@/domain/types'
import { formatDateTime, instantToDateInTz, formatDate } from '@/domain/dates'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Field'
import { SearchInput } from '@/components/ui/misc'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'

/** `retired` kinds belong to features that were removed: old log rows keep their label, the filter no longer offers them. */
const KINDS: { value: ActivityKind; label: string; tone: Tone; retired?: true }[] = [
  { value: 'member', label: 'Members', tone: 'neutral' },
  { value: 'membership', label: 'Memberships', tone: 'success' },
  { value: 'payment', label: 'Payments', tone: 'success' },
  { value: 'invoice', label: 'Invoices', tone: 'info' },
  { value: 'attendance', label: 'Attendance', tone: 'info' },
  { value: 'workout', label: 'Workouts', tone: 'neutral' },
  { value: 'followup', label: 'Follow-ups', tone: 'neutral' },
  { value: 'system', label: 'System', tone: 'muted' },
  { value: 'session', label: 'PT sessions', tone: 'muted', retired: true },
  { value: 'expense', label: 'Expenses', tone: 'muted', retired: true },
  { value: 'trainer', label: 'Trainers', tone: 'muted', retired: true },
  { value: 'equipment', label: 'Equipment', tone: 'muted', retired: true },
]
const PAGE_SIZE = 50

export function ActivityPage() {
  usePage('Activity', 'Everything recorded in this browser, newest first. Useful for checking who changed what.')
  const { timezone } = useApp()
  const all = useLiveQuery(() => readTx(['activity'], (tx) => tx.objectStore('activity').getAll()), ['activity'])
  const [kind, setKind] = useState<'all' | ActivityKind>('all')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (all.data ?? [])
      .filter((a) => (kind === 'all' || a.kind === kind) && (!t || a.message.toLowerCase().includes(t)))
      .sort((a, b) => b.at.localeCompare(a.at))
  }, [all.data, kind, q])
  const { slice, pageCount, page: safePage } = paginate(list, page, PAGE_SIZE)
  const groups = useMemo(() => {
    const m = new Map<string, Activity[]>()
    for (const a of slice) {
      const d = instantToDateInTz(a.at, timezone)
      m.set(d, [...(m.get(d) ?? []), a])
    }
    return [...m.entries()]
  }, [slice, timezone])

  if (all.error) return <ErrorState message={all.error} />
  if (!all.data) return <PageLoading />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search activity" className="sm:w-80" />
        <Select aria-label="Kind" value={kind} onChange={(e) => { setKind(e.target.value as 'all' | ActivityKind); setPage(1) }} className="w-full text-sm sm:w-auto">
          <option value="all">All kinds</option>
          {KINDS.filter((k) => !k.retired).map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </Select>
      </div>
      <Card>
        {list.length === 0 ? (
          <EmptyState compact icon={<ActivityIcon className="h-5 w-5" aria-hidden />} title="Nothing here yet" description={q || kind !== 'all' ? 'Try a different filter.' : 'Every change you make is recorded here.'} />
        ) : (
          groups.map(([date, items]) => (
            <div key={date}>
              <p className="sticky top-14 z-[1] border-b border-line bg-surface px-5 py-1.5 text-xs text-muted">{formatDate(date, 'long')}</p>
              <ul className="divide-y divide-line">
                {items.map((a) => {
                  const k = KINDS.find((x) => x.value === a.kind)
                  return (
                    <li key={a.id} className="flex items-start gap-3 px-5 py-2.5">
                      <Badge tone={k?.tone ?? 'neutral'} className="mt-0.5 shrink-0">{k?.label ?? a.kind}</Badge>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm">{a.memberId ? <Link to={`/members/${a.memberId}`} className="hover:underline">{a.message}</Link> : a.message}</p>
                        <p className="text-xs text-muted">{formatDateTime(a.at, timezone)}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
        <Pagination page={safePage} pageCount={pageCount} total={list.length} pageSize={PAGE_SIZE} onChange={setPage} />
      </Card>
    </div>
  )
}
