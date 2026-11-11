import { subscribe as subscribeToData, dataRevision } from '../events'
import { downloadText } from '@/domain/csv'
import { GOOGLE_CLIENT_ID, requestGoogleToken, revokeGoogleAccess, SignInError, type GoogleToken } from '@/lib/google'
import { createDriveClient, DriveError, type DriveAccount, type DriveClient, type DriveFile } from './driveApi'
import { assessSignIn, BackupBlocked, changedSinceBackup, findRemoteBackup, isBackupOverdue, loadRemoteBackup, restoreFromDrive, runBackup, takeSnapshot, type BlockReason, type RemotePreview, type SignInSituation } from './driveBackup'
import { clearLink, loadLink, saveLink, subscribeLink, type DriveLink } from './driveState'

/**
 * The one place the interface talks to for Google Drive backup: who is signed in, what state the
 * backup is in, and the actions (sign in, back up, restore). It also runs the automatic backup
 * while the app is open. It holds the access token in memory only.
 */

export interface DriveNotice {
  tone: 'success' | 'info' | 'danger'
  title: string
  detail?: string
  at: string
}

export interface DriveState {
  /** False when the site was built without a Google client ID: the feature is switched off. */
  configured: boolean
  account: DriveAccount | null
  link: DriveLink | null
  /** What signing in means for this device's data. Set after sign-in; drives the offers the interface shows. */
  situation: SignInSituation | null
  busy: 'signing-in' | 'checking' | 'backup' | 'restore' | null
  /** A backup that was stopped and needs the person's decision. */
  blocked: { reason: BlockReason; message: string; remote: DriveFile | null; localMembers: number } | null
  notice: DriveNotice | null
  /** The data here changed since the last backup this device knows of. */
  changed: boolean
  /** Changed, automatic backup is on, and the last backup is at least a day old. */
  overdue: boolean
}

/**
 * Google's browser sign-in gives a token that lasts about an hour and no way to renew it without a
 * window. Kept only in memory it was lost on every reload, which on a phone looked like being logged
 * out all the time and stopped the automatic backup. So the token is remembered on this device until
 * it expires (it can reach nothing but GymBook's own hidden Drive folder).
 */
const TOKEN_KEY = 'gymbook-drive-token'
function loadToken(): GoogleToken | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as GoogleToken | null
    return t && typeof t.token === 'string' && typeof t.expiresAt === 'number' && t.expiresAt > Date.now() ? t : null
  } catch {
    return null
  }
}
function setToken(next: GoogleToken | null): void {
  token = next
  try {
    if (next) localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage blocked: the session simply lasts until the page is reloaded
  }
}

let token: GoogleToken | null = loadToken()
let state: DriveState = { configured: Boolean(GOOGLE_CLIENT_ID), account: null, link: loadLink(), situation: null, busy: null, blocked: null, notice: null, changed: false, overdue: false }
const listeners = new Set<() => void>()

export const getDriveState = (): DriveState => state
export function subscribeDrive(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function set(patch: Partial<DriveState>): void {
  const next = { ...state, ...patch }
  next.overdue = isBackupOverdue(next.link, next.changed)
  state = next
  for (const l of listeners) l()
}
subscribeLink(() => set({ link: loadLink() }))

const tokenValid = () => token !== null && token.expiresAt > Date.now()
const notice = (tone: DriveNotice['tone'], title: string, detail?: string): DriveNotice => ({ tone, title, detail, at: new Date().toISOString() })
const explain = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Every action that talks to Drive runs alone, also across tabs, so two uploads never race. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T | 'busy-elsewhere'> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('gymbook-drive', { ifAvailable: true }, async (lock) => (lock ? fn() : ('busy-elsewhere' as const)))
  }
  return fn()
}

function client(): DriveClient {
  if (!token) throw new DriveError('auth', 'Sign in with Google first.')
  return createDriveClient(token.token)
}

/** An expired or revoked token ends the session; the link to the account stays. */
function handleFailure(err: unknown, title: string): void {
  if (err instanceof DriveError && err.kind === 'auth') {
    setToken(null)
    set({ account: null, situation: null, busy: null, notice: notice('danger', title, err.message) })
    return
  }
  set({ busy: null, notice: notice('danger', title, explain(err)) })
}

/**
 * Work out, when the app opens, whether there is anything to back up. The revision counter answers
 * without touching the database; reading and fingerprinting everything froze the app for seconds
 * on a large gym, on every start.
 */
async function refreshChanged(): Promise<void> {
  const link = loadLink()
  const known = changedSinceBackup(link)
  if (known !== undefined || !link) {
    set({ changed: known ?? false })
    return
  }
  // A link saved before the counter existed: compare the data once and remember the answer.
  try {
    const revision = dataRevision()
    const snapshot = await takeSnapshot()
    const same = snapshot.hash === link.lastBackupHash
    if (same) saveLink({ ...link, lastBackupRev: revision })
    set({ changed: !same })
  } catch {
    // The database could not be read; other parts of the app report that.
  }
}

/** Look at the signed-in account and work out what it means for this device. Uploads and restores nothing. */
async function inspect(): Promise<void> {
  const drive = client()
  const account = await drive.account()
  const link = loadLink()
  const remote = await findRemoteBackup(drive, link?.accountId === account.id ? link : null)
  const snapshot = await takeSnapshot()
  set({ account, situation: assessSignIn(link, account, remote, snapshot.empty), changed: !link?.lastBackupHash || snapshot.hash !== link.lastBackupHash })
}

export async function signIn(options: { chooseAccount?: boolean } = {}): Promise<void> {
  if (state.busy) return
  set({ busy: 'signing-in', notice: null, blocked: null })
  try {
    setToken(await requestGoogleToken({ interactive: true, chooseAccount: options.chooseAccount, hint: options.chooseAccount ? undefined : state.link?.email }))
    silentRefused = false
    set({ busy: 'checking' })
    await inspect()
    set({ busy: null })
  } catch (err) {
    if (err instanceof SignInError && err.kind === 'cancelled') set({ busy: null })
    else handleFailure(err, 'Could not sign in')
  }
}

/** Forget the session on this device. The backup in Drive and the link to the account are kept. */
export function signOut(): void {
  setToken(null)
  set({ account: null, situation: null, blocked: null, notice: null })
}

/** Remove GymBook's access to the Google account and forget which account this device backs up to. The Drive file is not deleted. */
export async function disconnect(): Promise<void> {
  const current = token
  setToken(null)
  clearLink()
  set({ account: null, situation: null, blocked: null, changed: false, notice: notice('info', 'Disconnected from Google Drive', 'The backup file stays in that Google account. Nothing on this device was deleted.') })
  if (current) await revokeGoogleAccess(current.token).catch(() => undefined)
}

export function setAutoBackup(auto: boolean): void {
  const link = loadLink()
  if (link) saveLink({ ...link, auto })
}

/**
 * Back up now. `replace` is the person's explicit yes to overwriting a backup this device's data
 * did not come from; without it such a backup stops and is reported as blocked.
 */
export async function backupNow(options: { replace?: boolean; automatic?: boolean } = {}): Promise<void> {
  if (state.busy || !state.account) return
  const account = state.account
  set({ busy: 'backup', blocked: null, notice: options.automatic ? state.notice : null })
  try {
    const result = await exclusive(() => runBackup(client(), account, { replace: options.replace }))
    if (result === 'busy-elsewhere') {
      set({ busy: null, notice: options.automatic ? state.notice : notice('info', 'A backup is already running in another tab') })
      return
    }
    const size = result.file.size < 1_048_576 ? `${Math.max(1, Math.round(result.file.size / 1024))} KB` : `${(result.file.size / 1_048_576).toFixed(1)} MB`
    set({
      busy: null,
      // Something saved while the backup was running is not in it.
      changed: changedSinceBackup(loadLink()) ?? false,
      situation: { kind: 'ready', remote: result.file },
      notice: result.status === 'uploaded' ? notice('success', 'Backup saved to Google Drive', `${size}, checked against what Google Drive stored.`) : options.automatic ? state.notice : notice('info', 'Already up to date', 'Nothing has changed since the last backup, so nothing was uploaded.'),
    })
  } catch (err) {
    if (err instanceof BackupBlocked) {
      set({ busy: null, blocked: { reason: err.reason, message: err.message, remote: err.remote, localMembers: err.localMembers } })
      return
    }
    handleFailure(err, options.automatic ? 'Automatic backup failed' : 'Backup failed; nothing was changed in Google Drive')
  }
}

export function dismissBlocked(): void {
  set({ blocked: null })
}

/** Download and check the account's backup so it can be shown before anything is replaced. */
export async function previewRestore(): Promise<RemotePreview | null> {
  if (state.busy || !state.account) return null
  set({ busy: 'checking', notice: null })
  try {
    const drive = client()
    const remote = await findRemoteBackup(drive, state.link?.accountId === state.account.id ? state.link : null)
    if (!remote) {
      set({ busy: null, notice: notice('info', 'No backup found', `${state.account.email} has no GymBook backup in Google Drive yet.`) })
      return null
    }
    const preview = await loadRemoteBackup(drive, remote)
    set({ busy: null })
    return preview
  } catch (err) {
    handleFailure(err, 'Could not read the backup')
    return null
  }
}

/** Replace this device's data with the previewed backup. Returns true when the restored data was read back and matches. */
export async function restore(remote: RemotePreview): Promise<boolean> {
  if (state.busy || !state.account) return false
  const account = state.account
  set({ busy: 'restore', notice: null, blocked: null })
  try {
    const result = await exclusive(() => restoreFromDrive(account, remote, (name, json) => downloadText(name, json, 'application/json')))
    if (result === 'busy-elsewhere') {
      set({ busy: null, notice: notice('info', 'Another tab is using Google Drive', 'Try again in a moment.') })
      return false
    }
    const copy = result.safetyCopySaved ? ' A copy of the data that was on this device was downloaded first.' : ''
    if (result.mismatches.length > 0) {
      set({ busy: null, changed: true, situation: { kind: 'ready', remote: remote.file }, notice: notice('danger', 'Restored, but the check found differences', `These parts do not match the backup: ${result.mismatches.join(', ')}.${copy}`) })
      return false
    }
    set({ busy: null, changed: false, situation: { kind: 'ready', remote: remote.file }, notice: notice('success', 'Restored from Google Drive', `Every record was read back and matches the backup.${copy}`) })
    return true
  } catch (err) {
    handleFailure(err, 'Restore failed; the data on this device is unchanged')
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Automatic backup, while the app is open.
//
// A browser cannot run this code when the app is closed, and the data exists nowhere else, so
// there is no true "scheduled" backup here. What does run: shortly after the data changes, and on
// a regular check, if this device is tied to the signed-in account and nothing needs a decision.
// ---------------------------------------------------------------------------------------------

const AFTER_CHANGE_MS = 2 * 60 * 1000
const CHECK_EVERY_MS = 15 * 60 * 1000
let started = false
let changeTimer: ReturnType<typeof setTimeout> | null = null
/** Google or the browser refused a sign-in without a click. Asking again would only open blocked windows, so wait for a real click. */
let silentRefused = false

const TAP_RETRY_MS = 30 * 60 * 1000
let lastTapAttempt = 0
let tapArmed = false
/**
 * A browser only lets Google's window open from a tap. So when a backup is waiting and the hour-long
 * sign-in has run out, the next tap in the app is used to renew it: Google's window opens and, since
 * permission was already given, closes by itself. Tried at most once every half hour.
 */
function armTapSignIn(): void {
  if (tapArmed || typeof window === 'undefined') return
  if (Date.now() - lastTapAttempt < TAP_RETRY_MS) return
  tapArmed = true
  const onTap = () => {
    window.removeEventListener('click', onTap, true)
    tapArmed = false
    const link = loadLink()
    if (!link?.auto || !state.changed || state.busy || tokenValid()) return
    lastTapAttempt = Date.now()
    void requestGoogleToken({ interactive: true, hint: link.email })
      .then((t) => {
        setToken(t)
        silentRefused = false
        return autoBackup()
      })
      .catch(() => undefined)
  }
  window.addEventListener('click', onTap, true)
}

async function autoBackup(): Promise<void> {
  const link = loadLink()
  if (!state.configured || !link?.auto || state.busy || !state.changed) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  if (!tokenValid()) {
    if (silentRefused) return
    // No screen may be shown without a click. If Google or the browser refuses (phones always do),
    // the next tap anywhere in the app renews the sign-in instead.
    try {
      setToken(await requestGoogleToken({ interactive: false, hint: link.email }))
    } catch {
      silentRefused = true
      armTapSignIn()
      return
    }
  }
  try {
    if (!state.account) await inspect()
  } catch (err) {
    handleFailure(err, 'Automatic backup failed')
    return
  }
  // Only the plain case is automatic. Anything that needs a decision waits for the person.
  if (state.account?.id !== link.accountId || state.situation?.kind !== 'ready') return
  await backupNow({ automatic: true })
}

/** Start watching for changes. Safe to call more than once. */
export function startAutoBackup(): void {
  if (started || !state.configured) return
  started = true
  void refreshChanged()
  // Still inside the hour after a reload: show the account as signed in without asking Google again.
  if (tokenValid() && loadLink()) void inspect().catch((err) => handleFailure(err, 'Could not reach Google Drive'))
  subscribeToData(() => {
    if (!loadLink()) return
    set({ changed: true })
    if (changeTimer) clearTimeout(changeTimer)
    changeTimer = setTimeout(() => void autoBackup(), AFTER_CHANGE_MS)
  })
  setInterval(() => {
    if (silentRefused && !tokenValid()) armTapSignIn()
    void autoBackup()
  }, CHECK_EVERY_MS)
  // The token is gone after a reload, so the first check only succeeds if Google lets it through silently.
  setTimeout(() => void autoBackup(), 5000)
}

/** One tap from the reminder: sign in if needed (the tap allows Google's window), then back up. */
export async function backupFromReminder(): Promise<void> {
  if (!tokenValid() || !state.account) await signIn()
  if (state.account && state.situation?.kind === 'ready') await backupNow()
}

/** Called when all local data is wiped: the next sign-in must offer a restore, never upload an empty app. */
export function forgetDriveLink(): void {
  setToken(null)
  clearLink()
  set({ account: null, situation: null, blocked: null, changed: false, notice: null })
}
