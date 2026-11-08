import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Download, Upload, Trash2, RotateCcw, Camera, AlertTriangle } from 'lucide-react'
import { usePage, useApp } from '@/app/AppContext'
import { updateSettings } from '@/data/services/settings'
import { exportBackup, validateBackup, importBackup, type ImportPreview } from '@/data/backup'
import { removeSampleRecords, seedSampleData } from '@/data/sample'
import { deleteDatabase } from '@/data/db'
import { appUrl } from '@/lib/appUrl'
import { settingsForm, type SettingsFormValues } from '@/domain/validation'
import { useForm } from '@/lib/forms'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { fileToSmallDataUrl } from '@/lib/image'
import { isValidTimezone, formatDateTime } from '@/domain/dates'
import { downloadText } from '@/domain/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, Input, Textarea, FormError, Select } from '@/components/ui/Field'
import { Banner, Section } from '@/components/ui/misc'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Modal } from '@/components/ui/Modal'
import { DiscardGuard } from '@/components/domain/DiscardGuard'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/data/errors'
import { DriveBackupSection } from '@/components/domain/DriveBackupSection'
import { forgetDriveLink } from '@/data/drive/driveController'

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo', 'Asia/Karachi', 'Europe/London', 'America/New_York', 'Australia/Sydney', 'UTC']

/** Sections that were removed from the app. A backup may still carry their records; they are listed only when present. */
/** Just under the longest string a browser can hold, which is what limits reading a backup file. */
const MAX_BACKUP_FILE_BYTES = 500 * 1_048_576
const RETIRED_STORES = ['trainers', 'expenses', 'sessions', 'equipment', 'incidents']

export function SettingsPage() {
  usePage('Settings', 'Gym details, invoice settings, backup and data management')
  const { settings, refreshSettings } = useApp()
  const location = useLocation()
  useEffect(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [location.hash])
  return (
    <div className="flex flex-col">
      <GymDetailsForm key={settings.rev} />
      <DriveBackupSection />
      <BackupSection />
      <DataSection onChanged={refreshSettings} />
    </div>
  )
}

function GymDetailsForm() {
  const { settings } = useApp()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [customTz, setCustomTz] = useState(!TIMEZONES.includes(settings.timezone))
  const form = useForm<{ gymName: string; address: string; phone: string; email: string; timezone: string; invoicePrefix: string; invoiceFooter: string; gstin: string; logoDataUrl?: string }, SettingsFormValues>(
    { gymName: settings.gymName, address: settings.address, phone: settings.phone, email: settings.email, timezone: settings.timezone, invoicePrefix: settings.invoicePrefix, invoiceFooter: settings.invoiceFooter, gstin: settings.gstin ?? '', logoDataUrl: settings.logoDataUrl },
    settingsForm,
    async (values) => {
      await updateSettings({ ...values, gstin: values.gstin }, settings.rev)
      toast.success('Settings saved')
    },
  )
  const { blocker } = useUnsavedChanges(form.dirty)
  const onLogo = async (file: File | undefined) => {
    if (!file) return
    setLogoError(null)
    try {
      form.set('logoDataUrl', await fileToSmallDataUrl(file, 192))
    } catch (err) {
      setLogoError(errorMessage(err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  return (
    <form onSubmit={form.submit} noValidate>
      <DiscardGuard blocker={blocker} />
      <Section title="Gym details" description="Shown in the header and on printed invoices">
        <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            {form.values.logoDataUrl ? <img src={form.values.logoDataUrl} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-sunken text-xs text-muted">No logo</span>}
            <div className="flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={(e) => onLogo(e.target.files?.[0])} />
              <Button type="button" size="sm" variant="secondary" icon={<Camera className="h-4 w-4" aria-hidden />} onClick={() => fileRef.current?.click()}>{form.values.logoDataUrl ? 'Change logo' : 'Add logo'}</Button>
              {form.values.logoDataUrl ? <Button type="button" size="sm" variant="outline" onClick={() => form.set('logoDataUrl', undefined)}>Remove</Button> : null}
            </div>
          </div>
          {logoError ? <p role="alert" className="text-xs font-medium text-danger">{logoError}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Gym name" required error={form.errors.gymName}>
              {({ id, invalid }) => <Input id={id} aria-invalid={invalid} value={form.values.gymName} onChange={(e) => form.set('gymName', e.target.value)} />}
            </Field>
            <Field label="Timezone" required hint="Used for “today”, expiry checks and report dates" error={form.errors.timezone}>
              {({ id, invalid }) =>
                customTz ? (
                  <div className="flex gap-2">
                    <Input id={id} aria-invalid={invalid} value={form.values.timezone} onChange={(e) => form.set('timezone', e.target.value)} placeholder="e.g. Asia/Kolkata" />
                    <Button type="button" variant="outline" size="sm" onClick={() => { setCustomTz(false); if (!isValidTimezone(form.values.timezone)) form.set('timezone', 'Asia/Kolkata') }}>List</Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Select id={id} value={form.values.timezone} onChange={(e) => form.set('timezone', e.target.value)}>
                      {[...new Set([form.values.timezone, ...TIMEZONES])].map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </Select>
                    <Button type="button" variant="outline" size="sm" onClick={() => setCustomTz(true)}>Other</Button>
                  </div>
                )
              }
            </Field>
            <Field label="Support phone" hint="Your gym’s own number, shown on invoices. Leave empty to hide." error={form.errors.phone}>
              {({ id, invalid }) => <Input id={id} type="tel" aria-invalid={invalid} value={form.values.phone} onChange={(e) => form.set('phone', e.target.value)} />}
            </Field>
            <Field label="Support email" hint="Leave empty to hide" error={form.errors.email}>
              {({ id, invalid }) => <Input id={id} type="email" aria-invalid={invalid} value={form.values.email} onChange={(e) => form.set('email', e.target.value)} />}
            </Field>
            <Field label="Address" hint="One line per row; printed on invoices" error={form.errors.address} className="sm:col-span-2">
              {({ id }) => <Textarea id={id} rows={3} value={form.values.address} onChange={(e) => form.set('address', e.target.value)} />}
            </Field>
          </div>
        </CardBody>
        </Card>
      </Section>
      <Section title="Invoices" description="Invoice numbers are sequential and never reused, even after voiding. Currency is fixed to INR in this version.">
        <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Invoice prefix" required hint="Numbers look like PREFIX-00042. Changing the prefix does not reset numbering." error={form.errors.invoicePrefix}>
            {({ id, invalid }) => <Input id={id} aria-invalid={invalid} value={form.values.invoicePrefix} onChange={(e) => form.set('invoicePrefix', e.target.value.toUpperCase())} />}
          </Field>
          <Field label="GSTIN" hint="Optional, printed under the gym name" error={form.errors.gstin}>
            {({ id }) => <Input id={id} value={form.values.gstin} onChange={(e) => form.set('gstin', e.target.value)} />}
          </Field>
          <Field label="Invoice footer" error={form.errors.invoiceFooter} className="sm:col-span-2">
            {({ id }) => <Textarea id={id} rows={2} value={form.values.invoiceFooter} onChange={(e) => form.set('invoiceFooter', e.target.value)} />}
          </Field>
          <div className="sm:col-span-2"><FormError message={form.formError} /></div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="secondary" onClick={() => form.reset()} disabled={!form.dirty || form.saving}>Discard</Button>
            <Button type="submit" loading={form.saving} disabled={!form.dirty}>Save settings</Button>
          </div>
        </CardBody>
        </Card>
      </Section>
    </form>
  )
}

function BackupSection() {
  const { settings } = useApp()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 })).catch(() => {})
  }, [])

  const doExport = async () => {
    setExporting(true)
    try {
      const b = await exportBackup()
      downloadText(`gymbook-backup-${b.exportedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(b, null, 2), 'application/json')
      toast.success('Backup exported', 'Keep the file somewhere safe; it contains all member and payment data.')
    } catch (err) {
      toast.error('Export failed', errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    // A browser holds a file's text as one string, and a string has a hard size limit (about 500 MB).
    // Beyond it the read comes back empty, which used to be reported as "not valid JSON".
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setPreview({ ok: false, errors: [`This file is ${fmtMB(file.size)}, which is too large for a browser to read in one piece (the limit is about ${fmtMB(MAX_BACKUP_FILE_BYTES)}). The file itself may be fine.`], warnings: [], counts: {} })
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    try {
      const text = await file.text()
      setPreview(validateBackup(text))
    } catch (err) {
      setPreview({ ok: false, errors: [errorMessage(err)], warnings: [], counts: {} })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const doImport = async () => {
    if (!preview?.ok || !preview.backup || busy) return
    setBusy(true)
    try {
      await importBackup(preview.backup)
      toast.success('Backup restored', 'All data was replaced with the backup contents.')
      setPreview(null)
    } catch (err) {
      toast.error('Restore failed; your current data is unchanged', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const fmtMB = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`

  return (
    <Section title="Backup file" description="Save everything to a file on this device, or bring a saved file back. Works without a Google account.">
      <Card>
      <CardBody className="flex flex-col gap-4">
        <Banner tone="info">Browser-local storage does <strong>not</strong> sync between devices, browsers or private windows. To move GymBook, export here and import on the other device.</Banner>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} onClick={doExport} loading={exporting}>Export backup (JSON)</Button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          <Button variant="secondary" icon={<Upload className="h-4 w-4" aria-hidden />} onClick={() => fileRef.current?.click()}>Import backup…</Button>
        </div>
        {estimate && estimate.quota > 0 ? <p className="text-xs text-muted">Storage used by this site: {fmtMB(estimate.usage)} of about {fmtMB(estimate.quota)} available.</p> : null}
      </CardBody>
      </Card>
      <Modal open={preview !== null} onClose={() => !busy && setPreview(null)} title={preview?.ok ? 'Replace all data with this backup?' : 'This backup can’t be imported'} size="md"
        footer={<><Button variant="secondary" onClick={() => setPreview(null)} disabled={busy}>{preview?.ok ? 'Cancel' : 'Close'}</Button>{preview?.ok ? <Button variant="danger" onClick={doImport} loading={busy} data-primary>Replace my data</Button> : null}</>}
      >
        {preview ? (
          <div className="flex flex-col gap-3 text-sm">
            {preview.ok ? (
              <>
                <p>Backup of <strong>{preview.gymName ?? 'unnamed gym'}</strong> exported {preview.exportedAt ? formatDateTime(preview.exportedAt, settings.timezone) : 'unknown time'}.</p>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-sunken/70 px-3.5 py-3">
                  {Object.entries(preview.counts).filter(([k, v]) => v > 0 || !RETIRED_STORES.includes(k)).map(([k, v]) => (
                    <li key={k} className="flex justify-between"><span className="capitalize text-muted">{k}</span><span className="tabular font-medium">{v}</span></li>
                  ))}
                </ul>
                <p className="flex items-start gap-1.5 text-danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Everything currently stored in this browser will be deleted and replaced. Export a backup of the current data first if you might need it.</p>
              </>
            ) : (
              <>
                <p>Nothing was changed. Fix the file or choose another backup.</p>
                <ul className="list-disc space-y-1 rounded-xl bg-danger-soft px-3.5 py-3 pl-8 text-danger">
                  {preview.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </>
            )}
            {preview.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 rounded-xl bg-warn-soft px-3.5 py-3 pl-8 text-warn">
                {preview.warnings.slice(0, 6).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </Section>
  )
}

function DataSection({ onChanged }: { onChanged: () => Promise<void> }) {
  const { settings } = useApp()
  const toast = useToast()
  const [confirm, setConfirm] = useState<'removeSample' | 'loadSample' | 'reset' | null>(null)
  return (
    <Section id="data" title="Data" description={settings.dataMode === 'sample' ? 'Sample data is loaded. Every sample record is marked and can be removed without touching records you added.' : 'Manage sample records and resets.'}>
      <Card>
      <CardBody className="flex flex-wrap gap-2">
        {settings.dataMode === 'sample' ? (
          <Button variant="secondary" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirm('removeSample')}>Remove sample records</Button>
        ) : (
          <Button variant="secondary" onClick={() => setConfirm('loadSample')}>Load sample data</Button>
        )}
        <Button variant="danger" icon={<RotateCcw className="h-4 w-4" aria-hidden />} onClick={() => setConfirm('reset')}>Reset everything…</Button>
      </CardBody>
      </Card>
      <ConfirmDialog open={confirm === 'removeSample'} onClose={() => setConfirm(null)} title="Remove all sample records?" description="Deletes every record marked “Sample”: members, plans, memberships, invoices, payments, visits, workout plans and follow-ups. Records you created yourself are kept." confirmLabel="Remove sample records" danger
        onConfirm={async () => { const n = await removeSampleRecords(); await onChanged(); toast.success(`Removed ${n} sample records`) }} />
      <ConfirmDialog open={confirm === 'loadSample'} onClose={() => setConfirm(null)} title="Load sample data?" description="Adds a labelled set of fictional members, plans, payments and visits alongside your existing records. You can remove them again later." confirmLabel="Load sample data"
        onConfirm={async () => { await seedSampleData(settings.timezone); await onChanged(); toast.success('Sample data loaded') }} />
      <ConfirmDialog open={confirm === 'reset'} onClose={() => setConfirm(null)} title="Reset everything?" description="Permanently deletes all GymBook data in this browser, including settings. Export a backup first. This cannot be undone. A backup in Google Drive is not deleted." confirmLabel="Delete all data" danger typeToConfirm="RESET"
        onConfirm={async () => { await deleteDatabase(); forgetDriveLink(); window.location.assign(appUrl('/')) }} />
    </Section>
  )
}
