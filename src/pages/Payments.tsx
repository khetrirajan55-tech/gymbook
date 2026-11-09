import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Receipt, FileText } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { groupBy, loadSnapshotWithoutVisits, SNAPSHOT_STORES_WITHOUT_VISITS } from '@/data/snapshot'
import { memberRows, periodPreset, type Period } from '@/domain/metrics'
import { invoiceBalance } from '@/domain/membership'
import { formatINR } from '@/domain/money'
import { formatDate, formatDateTime, instantToDateInTz } from '@/domain/dates'
import { labelFor, PAYMENT_METHODS, type Member } from '@/domain/types'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { Tabs, Stat, Avatar } from '@/components/ui/misc'
import { Table, Th, Td, Tr, RowCard } from '@/components/ui/Table'
import { Pagination, paginate } from '@/components/ui/Pagination'
import { PageLoading } from '@/components/ui/Spinner'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { Badge, SampleBadge } from '@/components/ui/Badge'
import { MemberPicker } from '@/components/domain/MemberPicker'
import { PaymentDialog } from '@/components/domain/PaymentDialog'
import { PaymentStatusBadge } from '@/components/domain/MembershipBadge'
import { PeriodPicker, type PresetName } from '@/components/domain/PeriodPicker'

type Tab = 'payments' | 'invoices'
const PAGE_SIZE = 25

export function PaymentsPage() {
  usePage('Payments & invoices', 'Record received payments and review invoices')
  const { today, timezone } = useApp()
  const isDesktop = useIsDesktop()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'payments'
  const page = Number(params.get('page') ?? '1') || 1
  const snap = useLiveQuery(loadSnapshotWithoutVisits, [...SNAPSHOT_STORES_WITHOUT_VISITS])
  const [picked, setPicked] = useState<Member | null>(null)
  const [dialogMember, setDialogMember] = useState<Member | null>(null)
  const [preset, setPreset] = useState<PresetName>('30d')
  const [period, setPeriod] = useState<Period>(() => periodPreset('30d', today))
  const [method, setMethod] = useState<string>('all')
  const [invoiceFilter, setInvoiceFilter] = useState<'open' | 'all' | 'paid' | 'void'>('open')

  const [wantFocus, setWantFocus] = useState(false)
  useEffect(() => {
    if (params.get('action') === 'record') {
      const next = new URLSearchParams(params)
      next.delete('action')
      setParams(next, { replace: true })
      setWantFocus(true)
    }
  }, [params, setParams])
  useEffect(() => {
    if (!wantFocus || !snap.data) return
    const id = requestAnimationFrame(() => document.getElementById('payment-member-picker')?.focus())
    setWantFocus(false)
    return () => cancelAnimationFrame(id)
  }, [wantFocus, snap.data])

  const rows = useMemo(() => (snap.data ? memberRows(snap.data, today).filter((r) => r.member.status !== 'archived') : []), [snap.data, today])
  const pickerRows = useMemo(() => rows.map((r) => ({ member: r.member, state: r.state })), [rows])
  const memberById = useMemo(() => new Map((snap.data?.members ?? []).map((m) => [m.id, m])), [snap.data])
  const invoiceById = useMemo(() => new Map((snap.data?.invoices ?? []).map((i) => [i.id, i])), [snap.data])

  const payments = useMemo(
    () =>
      (snap.data?.payments ?? [])
        .filter((p) => {
          const d = instantToDateInTz(p.receivedAt, timezone)
          return d >= period.start && d <= period.end && (method === 'all' || p.method === method)
        })
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
    [snap.data, period, method, timezone],
  )
  const paymentsTotal = payments.filter((p) => p.status === 'recorded').reduce((s, p) => s + p.amountPaise, 0)

  const invoices = useMemo(() => {
    if (!snap.data) return []
    // Group once. Searching every payment for every invoice froze this page for seconds on a large gym.
    const paymentsByInvoice = groupBy(snap.data.payments, (p) => p.invoiceId)
    const adjustmentsByInvoice = groupBy(snap.data.adjustments, (a) => a.invoiceId)
    return snap.data.invoices
      .map((inv) => ({ inv, bal: invoiceBalance(inv, paymentsByInvoice.get(inv.id) ?? [], adjustmentsByInvoice.get(inv.id) ?? []) }))
      .filter(({ inv, bal }) => {
        if (invoiceFilter === 'open') return inv.status === 'issued' && bal.balancePaise > 0
        if (invoiceFilter === 'paid') return inv.status === 'issued' && bal.balancePaise <= 0
        if (invoiceFilter === 'void') return inv.status === 'void'
        return true
      })
      .sort((a, b) => (a.inv.number < b.inv.number ? 1 : -1))
  }, [snap.data, invoiceFilter])

  const list = tab === 'payments' ? payments : invoices
  const { slice, pageCount, page: safePage } = paginate(list as unknown[], page, PAGE_SIZE)
  const setPage = (p: number) => {
    const next = new URLSearchParams(params)
    next.set('page', String(p))
    setParams(next, { replace: true })
  }
  const setTab = (t: Tab) => setParams(t === 'payments' ? {} : { tab: t }, { replace: true })

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data) return <PageLoading />

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Record a payment" description="For money already received at the desk or by UPI/bank. GymBook records payments; it does not collect them." />
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <MemberPicker id="payment-member-picker" rows={pickerRows} value={picked} onChange={setPicked} placeholder="Who paid? Search name or phone" />
          </div>
          <Button icon={<Receipt className="h-4 w-4" aria-hidden />} disabled={!picked} onClick={() => picked && setDialogMember(picked)}>
            Record payment
          </Button>
        </CardBody>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={`Received · ${preset === 'custom' ? 'custom range' : preset === 'month' ? 'this month' : preset === 'year' ? 'this year' : `last ${preset.replace('d', ' days')}`}`} value={formatINR(paymentsTotal)} hint={`${payments.filter((p) => p.status === 'recorded').length} recorded payment${payments.filter((p) => p.status === 'recorded').length === 1 ? '' : 's'}`} />
      </div>

      <Tabs value={tab} onChange={setTab} items={[{ value: 'payments', label: 'Payments' }, { value: 'invoices', label: 'Invoices' }]} />

      {tab === 'payments' ? (
        <Card>
          <CardHeader
            title="Payments"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <PeriodPicker preset={preset} period={period} today={today} onChange={(p, per) => { setPreset(p); setPeriod(per); setPage(1) }} />
                <Select aria-label="Method" value={method} onChange={(e) => { setMethod(e.target.value); setPage(1) }} className="h-9 w-auto text-sm">
                  <option value="all">All methods</option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              </div>
            }
          />
          {payments.length === 0 ? (
            <EmptyState compact title="No payments in this period" description="Recorded payments appear here with their method and invoice" />
          ) : isDesktop ? (
            <div className="mt-3">
              <Table>
                <thead>
                  <tr>
                    <Th>Received</Th>
                    <Th>Member</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Method</Th>
                    <Th>Invoice</Th>
                    <Th>Reference / note</Th>
                  </tr>
                </thead>
                <tbody>
                  {(slice as typeof payments).map((p) => {
                    const m = memberById.get(p.memberId)
                    const inv = p.invoiceId ? invoiceById.get(p.invoiceId) : undefined
                    return (
                      <Tr key={p.id} className={p.status === 'void' ? 'opacity-60' : ''}>
                        <Td className="text-muted">{formatDateTime(p.receivedAt, timezone)}</Td>
                        <Td><Link to={`/members/${p.memberId}?tab=payments`} className="flex items-center gap-2 font-medium hover:underline">{m?.name ?? 'Unknown'}{p.sample ? <SampleBadge /> : null}</Link></Td>
                        <Td className={`tabular text-right font-medium ${p.status === 'void' ? 'line-through' : ''}`}>{formatINR(p.amountPaise)}</Td>
                        <Td>{labelFor(PAYMENT_METHODS, p.method)}{p.status === 'void' ? <Badge tone="muted" className="ml-2">Void</Badge> : null}</Td>
                        <Td>{inv ? <Link to={`/invoices/${inv.id}`} className="inline-flex items-center gap-1.5 font-medium hover:underline"><FileText className="h-4 w-4 text-muted" aria-hidden />{inv.number}</Link> : <span className="text-muted">Credit</span>}</Td>
                        <Td className="max-w-[14rem] truncate text-muted">{[p.reference, p.note, p.voidReason ? `Void: ${p.voidReason}` : ''].filter(Boolean).join(' · ')}</Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </div>
          ) : (
            <div className="mt-2">
              {(slice as typeof payments).map((p) => {
                const m = memberById.get(p.memberId)
                const inv = p.invoiceId ? invoiceById.get(p.invoiceId) : undefined
                return (
                  <RowCard key={p.id}>
                    <div className="flex items-start gap-3">
                      <Avatar name={m?.name ?? '?'} src={m?.photoDataUrl} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link to={`/members/${p.memberId}?tab=payments`} className="block truncate text-sm font-medium hover:underline">{m?.name ?? 'Unknown'}</Link>
                        <p className="text-xs text-muted">{formatDateTime(p.receivedAt, timezone)} · {labelFor(PAYMENT_METHODS, p.method)} · {inv ? <span className="whitespace-nowrap">{inv.number}</span> : 'credit'}</p>
                        {p.status === 'void' ? <p className="text-xs text-danger">Void: {p.voidReason}</p> : null}
                      </div>
                      <span className={`tabular text-sm font-medium ${p.status === 'void' ? 'text-muted line-through' : ''}`}>{formatINR(p.amountPaise)}</span>
                    </div>
                  </RowCard>
                )
              })}
            </div>
          )}
          <Pagination page={safePage} pageCount={pageCount} total={list.length} pageSize={PAGE_SIZE} onChange={setPage} />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Invoices"
            action={
              <Tabs value={invoiceFilter} onChange={(v) => { setInvoiceFilter(v); setPage(1) }} items={[{ value: 'open', label: 'Outstanding' }, { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }, { value: 'all', label: 'All' }]} />
            }
          />
          {invoices.length === 0 ? (
            <EmptyState compact title={invoiceFilter === 'open' ? 'No outstanding invoices' : 'No invoices here'} description="Invoices are created automatically when a membership is sold or renewed" />
          ) : isDesktop ? (
            <div className="mt-3">
              <Table>
                <thead>
                  <tr>
                    <Th>Invoice</Th>
                    <Th>Member</Th>
                    <Th>Issued</Th>
                    <Th className="text-right">Total</Th>
                    <Th className="text-right">Paid</Th>
                    <Th className="text-right">Balance</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {(slice as typeof invoices).map(({ inv, bal }) => {
                    const m = memberById.get(inv.memberId)
                    return (
                      <Tr key={inv.id}>
                        <Td><Link to={`/invoices/${inv.id}`} className="inline-flex items-center gap-1.5 font-medium hover:underline"><FileText className="h-4 w-4 text-muted" aria-hidden />{inv.number}</Link></Td>
                        <Td><Link to={`/members/${inv.memberId}?tab=payments`} className="font-medium hover:underline">{m?.name ?? 'Unknown'}</Link></Td>
                        <Td className="text-muted">{formatDate(inv.issueDate)}</Td>
                        <Td className="tabular text-right">{formatINR(bal.duePaise)}</Td>
                        <Td className="tabular text-right text-muted">{formatINR(bal.paidPaise)}</Td>
                        <Td className={`tabular text-right font-medium ${bal.balancePaise > 0 ? 'text-danger' : ''}`}>{formatINR(Math.max(0, bal.balancePaise))}</Td>
                        <Td><PaymentStatusBadge status={bal.status} /></Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </div>
          ) : (
            <div className="mt-2">
              {(slice as typeof invoices).map(({ inv, bal }) => {
                const m = memberById.get(inv.memberId)
                return (
                  <RowCard key={inv.id}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <Link to={`/invoices/${inv.id}`} className="block text-sm font-medium hover:underline">{inv.number}</Link>
                        <p className="text-xs text-muted"><span className="truncate">{m?.name ?? 'Unknown'}</span> · {formatDate(inv.issueDate)} · <span className="whitespace-nowrap">{formatINR(bal.duePaise)}</span></p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <PaymentStatusBadge status={bal.status} />
                        {bal.balancePaise > 0 ? <span className="tabular text-sm font-medium text-danger">{formatINR(bal.balancePaise)}</span> : null}
                      </div>
                    </div>
                  </RowCard>
                )
              })}
            </div>
          )}
          <Pagination page={safePage} pageCount={pageCount} total={list.length} pageSize={PAGE_SIZE} onChange={setPage} />
        </Card>
      )}

      {dialogMember ? (
        <PaymentDialog
          open
          onClose={() => {
            setDialogMember(null)
            setPicked(null)
          }}
          member={dialogMember}
          invoices={snap.data.invoices}
          payments={snap.data.payments}
          adjustments={snap.data.adjustments}
        />
      ) : null}
    </div>
  )
}
