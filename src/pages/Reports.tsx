import { useMemo, useState } from 'react'
import { Download, Info, Printer } from 'lucide-react'
import { PageActions } from '@/components/ui/PageActions'
import { usePage, useApp } from '@/app/AppContext'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { groupBy, loadSnapshot, SNAPSHOT_STORES } from '@/data/snapshot'
import { financeSummary, financeSeries, periodPreset, memberRows, outstandingSummary, type Period } from '@/domain/metrics'
import { invoiceBalance } from '@/domain/membership'
import { formatINR } from '@/domain/money'
import { formatMonthKey, instantToDateInTz, formatDate, formatIsoLocal } from '@/domain/dates'
import { labelFor, PAYMENT_METHODS, type PaymentMethod } from '@/domain/types'
import { toCsv, downloadText } from '@/domain/csv'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Stat } from '@/components/ui/misc'
import { PageLoading } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/EmptyState'
import { BarChart } from '@/components/charts/BarChart'
import { PeriodPicker, type PresetName } from '@/components/domain/PeriodPicker'
import { useToast } from '@/components/ui/Toast'

const invoiceOrder = new Intl.Collator('en', { numeric: true })

export function ReportsPage() {
  usePage('Reports', 'Revenue, outstanding balances, attendance and renewals over a period, with CSV export')
  const { today, timezone, settings } = useApp()
  const toast = useToast()
  const snap = useLiveQuery(loadSnapshot, [...SNAPSHOT_STORES])
  const [preset, setPreset] = useState<PresetName>('month')
  const [period, setPeriod] = useState<Period>(() => periodPreset('month', today))

  const finance = useMemo(() => (snap.data ? financeSummary(snap.data, period, timezone) : null), [snap.data, period, timezone])
  const series = useMemo(() => (snap.data ? financeSeries(snap.data, period, timezone) : null), [snap.data, period, timezone])
  const outstanding = useMemo(() => (snap.data ? outstandingSummary(snap.data, today) : { totalPaise: 0, members: 0 }), [snap.data, today])
  const renewals = useMemo(() => series?.points.reduce((s, p) => s + p.renewals, 0) ?? 0, [series])
  const newMemberships = useMemo(() => series?.points.reduce((s, p) => s + p.newMemberships, 0) ?? 0, [series])
  const attendanceTotal = useMemo(() => series?.points.reduce((s, p) => s + p.attendance, 0) ?? 0, [series])
  const uniqueVisitors = useMemo(() => {
    if (!snap.data) return 0
    const ids = new Set<string>()
    for (const a of snap.data.attendance) {
      const d = instantToDateInTz(a.checkInAt, timezone)
      if (d >= period.start && d <= period.end) ids.add(a.memberId)
    }
    return ids.size
  }, [snap.data, period, timezone])

  if (snap.error) return <ErrorState message={snap.error} />
  if (!snap.data || !finance || !series) return <PageLoading />

  const labels = series.points.map((p) => (series.granularity === 'day' ? p.key.slice(8) + '/' + p.key.slice(5, 7) : formatMonthKey(p.key)))
  const stamp = `${period.start}_to_${period.end}`
  const memberById = new Map(snap.data.members.map((m) => [m.id, m]))
  const inPeriod = (d: string) => d >= period.start && d <= period.end

  const localStamp = (iso: string) => formatIsoLocal(iso, timezone)
  const exportCsv = (what: 'payments' | 'invoices' | 'attendance' | 'members') => {
    try {
      let csv = ''
      if (what === 'payments') {
        const invoiceById = new Map(snap.data!.invoices.map((i) => [i.id, i]))
        const rows = snap.data!.payments.filter((p) => inPeriod(instantToDateInTz(p.receivedAt, timezone))).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
        csv = toCsv(['Received at (gym time)', 'Member', 'Phone', 'Amount (INR)', 'Method', 'Invoice', 'Status', 'Reference', 'Note'], rows.map((p) => {
          const m = memberById.get(p.memberId)
          const inv = p.invoiceId ? invoiceById.get(p.invoiceId) : undefined
          return [localStamp(p.receivedAt), m?.name ?? '', m?.phone ?? '', (p.amountPaise / 100).toFixed(2), labelFor(PAYMENT_METHODS, p.method), inv?.number ?? '', p.status, p.reference ?? '', p.note ?? '']
        }))
      } else if (what === 'invoices') {
        const rows = snap.data!.invoices.filter((i) => inPeriod(i.issueDate)).sort((a, b) => invoiceOrder.compare(a.number, b.number))
        // Group once, so a year of invoices does not search every payment for every invoice.
        const paymentsByInvoice = groupBy(snap.data!.payments, (p) => p.invoiceId)
        const adjustmentsByInvoice = groupBy(snap.data!.adjustments, (x) => x.invoiceId)
        csv = toCsv(['Invoice', 'Issued', 'Member', 'Phone', 'Subtotal (INR)', 'Discount (INR)', 'Adjustments (INR)', 'Total due (INR)', 'Paid (INR)', 'Balance (INR)', 'Status'], rows.map((i) => {
          const m = memberById.get(i.memberId)
          const b = invoiceBalance(i, paymentsByInvoice.get(i.id) ?? [], adjustmentsByInvoice.get(i.id) ?? [])
          return [i.number, i.issueDate, m?.name ?? '', m?.phone ?? '', (i.subtotalPaise / 100).toFixed(2), (i.discountPaise / 100).toFixed(2), (b.adjustmentsPaise / 100).toFixed(2), (b.duePaise / 100).toFixed(2), (b.paidPaise / 100).toFixed(2), (b.balancePaise / 100).toFixed(2), b.status]
        }))
      } else if (what === 'attendance') {
        const rows = snap.data!.attendance.filter((a) => inPeriod(instantToDateInTz(a.checkInAt, timezone))).sort((a, b) => a.checkInAt.localeCompare(b.checkInAt))
        csv = toCsv(['Check-in (gym time)', 'Check-out (gym time)', 'Member', 'Phone', 'Override reason', 'Note'], rows.map((a) => {
          const m = memberById.get(a.memberId)
          return [localStamp(a.checkInAt), a.checkOutAt ? localStamp(a.checkOutAt) : '', m?.name ?? '', m?.phone ?? '', a.overrideReason ?? '', a.note ?? '']
        }))
      } else {
        const rows = memberRows(snap.data!, today)
        csv = toCsv(['Name', 'Phone', 'Height (cm)', 'Weight (kg)', 'Joined', 'Status', 'Current plan', 'Plan start', 'Plan end', 'Membership state', 'Balance (INR)', 'Last visit (gym time)'], rows.map((r) => [r.member.name, r.member.phone, r.member.heightCm ?? '', r.member.weightKg ?? '', r.member.joiningDate, r.member.status, r.current?.planName ?? '', r.current?.startDate ?? '', r.current?.endDate ?? '', r.state ?? 'none', (r.balancePaise / 100).toFixed(2), r.lastVisitAt ? localStamp(r.lastVisitAt) : '']))
      }
      downloadText(`gymbook-${what}-${what === 'members' ? today : stamp}.csv`, csv)
      toast.success('CSV exported', 'Values that look like formulas are escaped so they open as text.')
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : String(err))
    }
  }

  const byMethod = Object.entries(finance.receivedByMethod).sort((a, b) => b[1] - a[1])

  return (
    <div className="flex flex-col gap-5">
      <PageActions>
        <Button variant="secondary" icon={<Printer className="h-4 w-4" aria-hidden />} onClick={() => window.print()}>Print summary</Button>
      </PageActions>
      <div className="print-only mb-2">
        <p className="text-xs font-medium text-muted">{settings.gymName} · report</p>
        <h2 className="text-xl font-medium">{formatDate(period.start)} – {formatDate(period.end)}</h2>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PeriodPicker preset={preset} period={period} today={today} onChange={(p, per) => { setPreset(p); setPeriod(per) }} />
        <p className="text-sm text-muted">{formatDate(period.start)} – {formatDate(period.end)} · {settings.timezone}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 [&>:last-child]:col-span-2 md:[&>:last-child]:col-span-1">
        <Stat label="Revenue received" value={formatINR(finance.receivedPaise)} hint={`${finance.paymentsCount} payment${finance.paymentsCount === 1 ? '' : 's'}`} />
        <Stat label="Invoiced" value={formatINR(finance.invoicedPaise)} hint={`${finance.invoicesCount} invoice${finance.invoicesCount === 1 ? '' : 's'} issued`} />
        <Stat label="Outstanding (all time)" value={formatINR(outstanding.totalPaise)} hint={`${outstanding.members} member${outstanding.members === 1 ? '' : 's'} owe money`} tone={outstanding.totalPaise > 0 ? 'danger' : undefined} />
      </div>

      <Card>
        <CardBody className="flex flex-col gap-1.5 text-sm text-muted">
          <p className="flex items-start gap-1.5"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span><strong className="text-ink">Revenue received</strong> counts recorded, non-void payments by the date they were received. <strong className="text-ink">Invoiced</strong> counts issued, non-void invoices by issue date; it is not income until paid. <strong className="text-ink">Outstanding</strong> is what active members still owe across all time: their invoices and adjustments minus every payment, including unlinked credits.</span></p>
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Cash received" />
          <CardBody>
            <BarChart height={280} labels={labels} series={[
              { key: 'received', label: 'Cash received', color: 'rgb(var(--c-success))', values: series.points.map((p) => p.received), format: formatINR },
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Attendance and memberships" description={`${attendanceTotal} visits by ${uniqueVisitors} member${uniqueVisitors === 1 ? '' : 's'} · ${newMemberships} new · ${renewals} renewal${renewals === 1 ? '' : 's'}`} />
          <CardBody>
            <BarChart height={220} labels={labels} series={[
              { key: 'attendance', label: 'Visits', color: 'rgb(var(--c-faint) / 0.7)', values: series.points.map((p) => p.attendance), format: (v) => String(v) },
              { key: 'new', label: 'New memberships', color: 'rgb(var(--c-success))', values: series.points.map((p) => p.newMemberships), format: (v) => String(v) },
              { key: 'renewals', label: 'Renewals', color: 'rgb(var(--c-muted))', values: series.points.map((p) => p.renewals), format: (v) => String(v) },
            ]} />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Received by method" />
          {byMethod.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">No payments in this period.</p> : (
            <ul className="divide-y divide-line">
              {byMethod.map(([k, v]) => (
                <li key={k} className="flex items-center justify-between px-4 py-2.5 text-sm sm:px-5"><span>{labelFor(PAYMENT_METHODS, k as PaymentMethod)}</span><span className="tabular font-medium">{formatINR(v)}</span></li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Export CSV" description="Filtered to the selected period (members export is the full current list). Opens in Excel, Numbers or Google Sheets." />
          <CardBody className="flex flex-wrap gap-2">
            {(['payments', 'invoices', 'attendance', 'members'] as const).map((w) => (
              <Button key={w} variant="secondary" size="sm" icon={<Download className="h-4 w-4" aria-hidden />} onClick={() => exportCsv(w)}>
                {w[0].toUpperCase() + w.slice(1)}
              </Button>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
