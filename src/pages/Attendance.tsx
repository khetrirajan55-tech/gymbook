import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ClipboardCheck, LogOut, Info } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { loadSnapshot, SNAPSHOT_STORES } from '@/data/snapshot'
import { checkOut } from '@/data/services/attendance'
import { memberRows } from '@/domain/metrics'
import { instantToDateInTz, formatTime, formatDuration, formatDate, addDays, isISODate, formatDateTime } from '@/domain/dates'
import type { Member } from '@/domain/types'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Field'
import { Avatar, Stat } from '@/components/ui/misc'
import { Badge, SampleBadge } from '@/components/ui/Badge'
import { Table, Th, Td, Tr, RowCard } from '@/components/ui/Table'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { MemberPicker } from '@/components/domain/MemberPicker'
import { MembershipStateBadge } from '@/components/domain/MembershipBadge'
import { useCheckIn } from '@/components/domain/CheckInDialog'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/data/errors'

export function AttendancePage() {
  usePage('Attendance', 'Check members in and out, and review visit history')
  const { today, timezone } = useApp()
  const toast = useToast()
  const isDesktop = useIsDesktop()
  const [params, setParams] = useSearchParams()
  const snap = useLiveQuery(loadSnapshot, [...SNAPSHOT_STORES])
  const [selected, setSelected] = useState<Member | null>(null)
  const from = isISODate(params.get('from') ?? '') ? params.get('from')! : today
  const toRaw = isISODate(params.get('to') ?? '') ? params.get('to')! : from
  const to = toRaw < from ? from : toRaw
  const pickerRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => (snap.data ? memberRows(snap.data, today).filter((r) => r.member.status !== 'archived') : []), [snap.data, today])
  const pickerRows = useMemo(() => rows.map((r) => ({ member: r.member, state: r.state })), [rows])
  const selectedRow = selected ? rows.find((r) => r.member.id === selected.id) : undefined
  const { checkIn: doCheckIn, dialog: checkInDialog, busy } = useCheckIn(() => setSelected(null))

  useEffect(() => {
    if (params.get('action') === 'checkin') {
      pickerRef.current?.querySelector<HTMLInputElement>('input')?.focus()
      const next = new URLSearchParams(params)
      next.delete('action')
      setParams(next, { replace: true })
    }
  }, [params, setParams])

  const memberById = useMemo(() => new Map((snap.data?.members ?? []).map((m) => [m.id, m])), [snap.data])

  const open = useMemo(() => (snap.data?.attendance ?? []).filter((a) => a.checkOutAt === null).sort((a, b) => (a.checkInAt < b.checkInAt ? 1 : -1)), [snap.data])
  const history = useMemo(
    () =>
      (snap.data?.attendance ?? [])
        .map((a) => ({ a, date: instantToDateInTz(a.checkInAt, timezone) }))
        .filter((x) => x.date >= from && x.date <= to)
        .sort((x, y) => (x.a.checkInAt < y.a.checkInAt ? 1 : -1)),
    [snap.data, from, to, timezone],
  )
  const dailyTotals = useMemo(() => {
    const map = new Map<string, number>()
    for (const h of history) map.set(h.date, (map.get(h.date) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [history])
  const todayCount = useMemo(() => (snap.data?.attendance ?? []).filter((a) => instantToDateInTz(a.checkInAt, timezone) === today).length, [snap.data, today, timezone])

  const setRange = (f: string, tIn: string) => {
    const t = tIn < f ? f : tIn
    const next = new URLSearchParams(params)
    next.set('from', f)
    next.set('to', t)
    setParams(next, { replace: true })
  }

  const onCheckOut = async (id: string, rev: number, name: string) => {
    try {
      await checkOut(id, rev)
      toast.success(`${name} checked out`)
    } catch (err) {
      toast.error('Could not check out', errorMessage(err))
    }
  }

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title="Check in" description="Find the member, confirm their membership status, then check them in" />
          <CardBody className="flex flex-col gap-3">
            <div ref={pickerRef}>
              <MemberPicker rows={pickerRows} value={selected} onChange={setSelected} autoFocus={isDesktop} />
            </div>
            {selectedRow ? (
              <div className="flex flex-col gap-2 rounded-xl bg-sunken/70 px-3.5 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <MembershipStateBadge state={selectedRow.state} />
                  {selectedRow.current ? (
                    <span className="text-muted">{selectedRow.current.planName} · {selectedRow.state === 'upcoming' ? `starts ${formatDate(selectedRow.current.startDate)}` : `${selectedRow.state === 'expired' ? 'ended' : 'ends'} ${formatDate(selectedRow.current.endDate)}`}</span>
                  ) : (
                    <span className="text-muted">No membership on record</span>
                  )}
                  {selectedRow.balancePaise > 0 ? <Badge tone="danger">Owes money</Badge> : null}
                </div>
                {selectedRow.state === 'expired' || selectedRow.state === 'upcoming' || !selectedRow.current ? (
                  <p className="text-warn">No active membership today. You can <Link to={`/members/${selectedRow.member.id}`} className="font-medium underline">renew first</Link>, or allow entry with a reason that is kept on the visit record.</p>
                ) : null}
                {open.some((a) => a.memberId === selectedRow.member.id) ? <p className="text-danger">Already checked in; check them out below first.</p> : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={<ClipboardCheck className="h-4 w-4" aria-hidden />} disabled={!selected} loading={busy} onClick={() => selected && doCheckIn(selected)}>
                Check in
              </Button>
              {selected ? <Link to={`/members/${selected.id}`} className="text-sm text-accent-ink hover:underline">Open profile</Link> : null}
            </div>
            <p className="flex items-start gap-1.5 text-xs text-muted"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Check-ins are recorded manually by staff. This version has no QR or card scanner; search by name or phone instead.</p>
          </CardBody>
        </Card>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="In the gym now" value={open.length} />
            <Stat label="Visits today" value={todayCount} />
          </div>
          <Card>
            <CardHeader title="Currently inside" />
            {open.length === 0 ? <EmptyState compact title="Nobody checked in" /> : (
              <ul className="max-h-72 divide-y divide-line overflow-y-auto">
                {open.map((a) => {
                  const m = memberById.get(a.memberId)
                  return (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                      <Avatar name={m?.name ?? '?'} src={m?.photoDataUrl} size="sm" />
                      <span className="min-w-0 flex-1">
                        <Link to={`/members/${a.memberId}`} className="block truncate text-sm font-medium hover:underline">{m?.name ?? 'Unknown member'}</Link>
                        <span className="text-xs text-muted">since {formatTime(a.checkInAt, timezone)}{instantToDateInTz(a.checkInAt, timezone) !== today ? ` (${formatDate(instantToDateInTz(a.checkInAt, timezone))})` : ''}</span>
                      </span>
                      <Button size="sm" variant="secondary" icon={<LogOut className="h-4 w-4" aria-hidden />} onClick={() => onCheckOut(a.id, a.rev, m?.name ?? 'Member')}>Out</Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader
          title="History"
          description={`${history.length} visit${history.length === 1 ? '' : 's'} ${from === to ? `on ${formatDate(from)}` : `from ${formatDate(from)} to ${formatDate(to)}`}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setRange(today, today)}>Today</Button>
              <Button size="sm" variant="outline" onClick={() => setRange(addDays(today, -6), today)}>7 days</Button>
              <Input type="date" aria-label="From date" value={from} max={to} onChange={(e) => isISODate(e.target.value) && setRange(e.target.value, e.target.value > to ? e.target.value : to)} className="w-auto" />
              <span className="text-sm text-muted">to</span>
              <Input type="date" aria-label="To date" value={to} min={from} onChange={(e) => isISODate(e.target.value) && setRange(from, e.target.value)} className="w-auto" />
            </div>
          }
        />
        {dailyTotals.length > 1 ? (
          <div className="flex flex-wrap gap-2 px-4 pt-3 sm:px-5">
            {dailyTotals.map(([d, n]) => (
              <button key={d} type="button" onClick={() => setRange(d, d)} className="pressable rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-sunken">
                {formatDate(d)} · <span className="tabular font-medium">{n}</span>
              </button>
            ))}
          </div>
        ) : null}
        {history.length === 0 ? (
          <EmptyState compact title="No visits in this range" description="Check someone in above, or widen the date range" />
        ) : isDesktop ? (
          <div className="mt-3">
            <Table>
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th>Date</Th>
                  <Th>In</Th>
                  <Th>Out</Th>
                  <Th>Duration</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 200).map(({ a, date }) => {
                  const m = memberById.get(a.memberId)
                  return (
                    <Tr key={a.id}>
                      <Td><Link to={`/members/${a.memberId}`} className="flex items-center gap-2 font-medium hover:underline">{m?.name ?? 'Unknown'}{m?.sample ? <SampleBadge /> : null}</Link></Td>
                      <Td className="text-muted">{formatDate(date)}</Td>
                      <Td className="tabular">{formatTime(a.checkInAt, timezone)}</Td>
                      <Td className="tabular">{a.checkOutAt ? formatTime(a.checkOutAt, timezone) : <Badge tone="success" dot>Inside</Badge>}</Td>
                      <Td className="text-muted">{a.checkOutAt ? formatDuration(a.checkInAt, a.checkOutAt) : '—'}</Td>
                      <Td className="max-w-[16rem] truncate text-muted">{a.overrideReason ? <span className="text-warn">Override: {a.overrideReason}</span> : a.note ?? ''}</Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
        ) : (
          <div className="mt-2">
            {history.slice(0, 200).map(({ a }) => {
              const m = memberById.get(a.memberId)
              return (
                <RowCard key={a.id}>
                  <div className="flex items-center gap-3">
                    <Avatar name={m?.name ?? '?'} src={m?.photoDataUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <Link to={`/members/${a.memberId}`} className="block truncate text-sm font-medium hover:underline">{m?.name ?? 'Unknown'}</Link>
                      <p className="text-xs text-muted">{formatDateTime(a.checkInAt, timezone)}{a.checkOutAt ? ` → ${formatTime(a.checkOutAt, timezone)} (${formatDuration(a.checkInAt, a.checkOutAt)})` : ''}</p>
                      {a.overrideReason ? <p className="text-xs text-warn">Override: {a.overrideReason}</p> : null}
                    </div>
                    {!a.checkOutAt ? <Badge tone="success" dot>Inside</Badge> : null}
                  </div>
                </RowCard>
              )
            })}
          </div>
        )}
      </Card>
      {checkInDialog}
    </div>
  )
}
