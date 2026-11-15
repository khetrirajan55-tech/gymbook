import { useState } from 'react'
import { AlertTriangle, CloudUpload, CloudDownload, LogIn, LogOut } from 'lucide-react'
import { useApp } from '@/app/AppContext'
import { backupNow, disconnect, dismissBlocked, previewRestore, restore, setAutoBackup, signIn, signOut } from '@/data/drive/driveController'
import { useDriveState } from '@/hooks/useDriveState'
import { backupBytes, remoteMembers, type RemotePreview } from '@/data/drive/driveBackup'
import type { DriveFile } from '@/data/drive/driveApi'
import { formatDateTime } from '@/domain/dates'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner, KeyValue, Section } from '@/components/ui/misc'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'

const fmtMB = (bytes: number) => (bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`)

/** Sections removed from the app; a backup lists them only when it still carries their records. */
const RETIRED_STORES = ['trainers', 'expenses', 'sessions', 'equipment', 'incidents']

export function DriveBackupSection() {
  const { settings } = useApp()
  const drive = useDriveState()
  const [preview, setPreview] = useState<RemotePreview | null>(null)
  const [offerDismissed, setOfferDismissed] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const when = (iso?: string) => (iso ? formatDateTime(iso, settings.timezone) : 'unknown time')

  const { account, link, situation, busy } = drive
  const working = busy !== null

  const describe = (file: DriveFile) => {
    const members = remoteMembers(file)
    return [file.appProperties.gymName || null, members !== undefined ? `${members} member${members === 1 ? '' : 's'}` : null, `saved ${when(file.modifiedTime)}`, fmtMB(backupBytes(file))].filter(Boolean).join(' · ')
  }

  const openRestore = async () => {
    const loaded = await previewRestore()
    if (loaded) setPreview(loaded)
  }

  const status = !link
    ? 'Not backed up to Google Drive yet'
    : drive.overdue
      ? 'Changes on this device are not backed up, and the last backup is more than a day old'
      : drive.changed
        ? 'Changes on this device are not backed up yet'
        : 'Up to date'

  return (
    <Section id="drive" title="Google Drive backup" description="Keep a copy of everything in your own Google Drive, so a lost phone or a cleared browser does not lose the gym’s records.">
      {!drive.configured ? (
        <Banner tone="info">
          <strong className="font-medium">Not set up for this site yet.</strong> Google Drive backup needs a Google client ID, which the site owner creates once in Google Cloud Console. The steps are in <code className="font-mono text-xs">docs/GOOGLE-DRIVE-SETUP.md</code>. Until then, use “Export backup” below.
        </Banner>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <KeyValue
              items={[
                { label: 'Google account', value: account ? account.email : link ? <span>{link.email} <span className="text-sm text-muted">(signed out)</span></span> : 'Not signed in' },
                {
                  label: 'Last successful backup',
                  value: link?.lastBackupAt ? (
                    <span>
                      {when(link.lastBackupAt)}
                      <span className="block text-sm text-muted">{[link.lastBackupMembers !== undefined ? `${link.lastBackupMembers} member${link.lastBackupMembers === 1 ? '' : 's'}` : null, link.lastBackupSize ? fmtMB(link.lastBackupSize) : null].filter(Boolean).join(' · ')}</span>
                    </span>
                  ) : (
                    'Never'
                  ),
                },
                { label: 'Status', value: <span className={cn(drive.overdue ? 'text-danger' : drive.changed && link ? 'text-warn' : undefined)}>{busy === 'backup' ? 'Backing up…' : busy === 'restore' ? 'Restoring…' : busy === 'checking' ? 'Checking Google Drive…' : busy === 'signing-in' ? 'Waiting for Google sign-in…' : status}</span> },
              ]}
            />

            {account && situation?.kind === 'other-account' ? (
              <Banner tone="warn">
                <strong className="font-medium">Different Google account.</strong> The data on this device was backed up to {situation.linkedEmail}, and you are signed in as {account.email}. Nothing was uploaded.
                {situation.remote ? ` ${account.email} has its own backup: ${describe(situation.remote)}.` : ` ${account.email} has no GymBook backup.`}
              </Banner>
            ) : null}
            {account && situation?.kind === 'remote-changed' ? (
              <Banner tone="warn">
                <strong className="font-medium">Another device backed up after this one.</strong> Google Drive now holds: {describe(situation.remote)}. Nothing was uploaded from here. Restore that backup to continue from it, or replace it with this device’s data.
              </Banner>
            ) : null}
            {account && situation?.kind === 'restore-offer' && offerDismissed ? (
              <Banner tone="info">
                <strong className="font-medium">This account already has a backup.</strong> {describe(situation.remote)}. It has not been restored, and this device’s data has not been uploaded.
              </Banner>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {!account ? (
                <Button icon={<LogIn className="h-4 w-4" aria-hidden />} onClick={() => { setOfferDismissed(false); void signIn() }} loading={busy === 'signing-in' || busy === 'checking'}>Sign in with Google</Button>
              ) : (
                <>
                  <Button icon={<CloudUpload className="h-4 w-4" aria-hidden />} onClick={() => void backupNow()} loading={busy === 'backup'} disabled={working}>Back up now</Button>
                  <Button variant="secondary" icon={<CloudDownload className="h-4 w-4" aria-hidden />} onClick={() => void openRestore()} loading={busy === 'checking'} disabled={working}>Restore…</Button>
                  <Button variant="ghost" icon={<LogOut className="h-4 w-4" aria-hidden />} onClick={signOut} disabled={working}>Sign out</Button>
                </>
              )}
              {account || link ? <Button variant="ghost" onClick={() => { setOfferDismissed(false); void signIn({ chooseAccount: true }) }} disabled={working}>Use another account</Button> : null}
              {link ? <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} disabled={working}>Disconnect</Button> : null}
            </div>

            {drive.notice ? (
              <div role={drive.notice.tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-xl border px-4 py-3 text-sm', drive.notice.tone === 'danger' ? 'border-danger/25 bg-danger-soft text-danger' : drive.notice.tone === 'success' ? 'border-success/25 bg-success-soft text-success' : 'border-line bg-sunken/60 text-ink')}>
                <p className="font-medium">{drive.notice.title}</p>
                {drive.notice.detail ? <p className="mt-0.5">{drive.notice.detail}</p> : null}
              </div>
            ) : null}

            {link ? (
              <label className="flex items-start gap-2.5 text-sm">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--c-accent))]" checked={link.auto} onChange={(e) => setAutoBackup(e.target.checked)} />
                <span>
                  <span className="font-medium">Back up automatically while GymBook is open</span>
                  <span className="block text-muted">Runs a couple of minutes after a change, when you are signed in. A browser cannot back up while GymBook is closed, so there is no backup on days it is not opened. If Google asks you to sign in again, a reminder appears at the top of the page.</span>
                </span>
              </label>
            ) : null}

            <div className="border-t border-line pt-3 text-sm text-muted">
              <p><span className="font-medium text-ink">What is saved:</span> every member with their photo, plans, memberships, invoices, payments, visits, follow-ups, workout plans and settings.</p>
              <p className="mt-1"><span className="font-medium text-ink">Where:</span> a hidden GymBook folder in your own Google Drive. GymBook cannot see any other file there, and only someone signed in to that Google account can restore it.</p>
              <p className="mt-1"><span className="font-medium text-ink">One backup is kept:</span> each backup replaces the one before, which saves space but means older versions cannot be brought back.</p>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Signing in found a backup that this device's data did not come from: offer, never assume. */}
      <Modal
        open={Boolean(account && situation?.kind === 'restore-offer' && !offerDismissed && !preview && !confirmReplace)}
        onClose={() => setOfferDismissed(true)}
        title="This Google account already has a backup"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOfferDismissed(true)}>Not now</Button>
            {situation?.kind === 'restore-offer' && !situation.localEmpty ? <Button variant="secondary" onClick={() => setConfirmReplace(true)}>Keep this device’s data</Button> : null}
            <Button data-primary onClick={() => { setOfferDismissed(true); void openRestore() }}>Review and restore</Button>
          </>
        }
      >
        {situation?.kind === 'restore-offer' ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="rounded-xl bg-sunken/70 px-3.5 py-3">{describe(situation.remote)}</p>
            <p>{situation.localEmpty ? 'This device has no gym records yet. You can restore the backup, or leave it and start fresh.' : 'This device has its own records, which are not part of that backup. Nothing has been uploaded or replaced. Choose what should happen.'}</p>
          </div>
        ) : null}
      </Modal>

      {/* A backup was stopped because it would overwrite something this device's data did not come from. */}
      <Modal
        open={Boolean(drive.blocked) || confirmReplace}
        onClose={() => { dismissBlocked(); setConfirmReplace(false) }}
        title="Replace the backup in Google Drive?"
        footer={
          <>
            <Button variant="secondary" onClick={() => { dismissBlocked(); setConfirmReplace(false) }}>Cancel</Button>
            <Button variant="danger" data-primary onClick={() => { setConfirmReplace(false); setOfferDismissed(true); void backupNow({ replace: true }) }}>Replace with this device’s data</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          {drive.blocked ? <p>{drive.blocked.message}</p> : null}
          {(drive.blocked?.remote ?? (situation && 'remote' in situation ? situation.remote : null)) ? <p className="rounded-xl bg-sunken/70 px-3.5 py-3">In Google Drive now: {describe((drive.blocked?.remote ?? (situation && 'remote' in situation ? situation.remote : null))!)}</p> : null}
          <p className="flex items-start gap-1.5 text-danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Only one backup is kept. Replacing it removes the one in Google Drive for {account?.email ?? 'this account'}, and it cannot be brought back.</p>
        </div>
      </Modal>

      <Modal
        open={preview !== null}
        onClose={() => busy !== 'restore' && setPreview(null)}
        title={preview?.preview.ok ? 'Replace all data on this device with this backup?' : 'This backup can’t be restored'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPreview(null)} disabled={busy === 'restore'}>{preview?.preview.ok ? 'Cancel' : 'Close'}</Button>
            {preview?.preview.ok ? <Button variant="danger" data-primary loading={busy === 'restore'} onClick={async () => { const p = preview; await restore(p); setPreview(null) }}>Replace my data</Button> : null}
          </>
        }
      >
        {preview ? (
          <div className="flex flex-col gap-3 text-sm">
            {preview.preview.ok ? (
              <>
                <p>Backup of <strong className="font-medium">{preview.preview.gymName ?? 'unnamed gym'}</strong> from {account?.email}, saved {when(preview.file.modifiedTime)}.</p>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-sunken/70 px-3.5 py-3">
                  {Object.entries(preview.preview.counts).filter(([k, v]) => v > 0 || !RETIRED_STORES.includes(k)).map(([k, v]) => (
                    <li key={k} className="flex justify-between"><span className="capitalize text-muted">{k}</span><span className="tabular font-medium">{v}</span></li>
                  ))}
                </ul>
                <p className="flex items-start gap-1.5 text-danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Everything stored on this device will be replaced. A copy of the current data is downloaded to this device first, so it can be imported again if this was a mistake.</p>
              </>
            ) : (
              <>
                <p>Nothing was changed on this device. The file in Google Drive did not pass its checks:</p>
                <ul className="list-disc space-y-1 rounded-xl bg-danger-soft px-3.5 py-3 pl-8 text-danger">
                  {preview.preview.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </>
            )}
            {preview.preview.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 rounded-xl bg-warn-soft px-3.5 py-3 pl-8 text-warn">
                {preview.preview.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title="Disconnect Google Drive?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
            <Button data-primary onClick={() => { setConfirmDisconnect(false); void disconnect() }}>Disconnect</Button>
          </>
        }
      >
        <p className="text-sm">This device will stop backing up and GymBook’s access to the Google account is removed. The backup file stays in Google Drive and nothing on this device is deleted. To delete the file itself, open Google Drive → Settings → Manage apps → GymBook → Delete hidden app data.</p>
      </Modal>
    </Section>
  )
}
