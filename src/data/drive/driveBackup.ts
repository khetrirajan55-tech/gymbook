import { exportBackup, importBackup, validateBackup, BACKUP_FORMAT, BACKUP_VERSION, type Backup, type ImportPreview } from '../backup'
import { DriveError, type DriveAccount, type DriveClient, type DriveFile } from './driveApi'
import { md5Hex, sha256Hex } from './md5'
import { canGzip, gunzip, gzip, isGzip, sameBytes } from './gzip'
import { loadLink, saveLink, type DriveLink } from './driveState'
import { dataRevision } from '../events'
import { getPhotoRecord, splitMemberPhotos } from '../services/photos'
import { makeThumb } from '@/lib/image'

/**
 * Backup and restore rules for Google Drive.
 *
 * - One data file per Google account, replaced in place. Older versions are not kept.
 * - Member photos are not in the data file. They sit beside it in "packs", each photo stored once
 *   under its fingerprint; a backup uploads only the photos Drive does not hold yet. So a day's
 *   changes cost about a megabyte to back up, however many photos the gym has.
 * - Nothing is uploaded when the data has not changed.
 * - A backup is reported as done only after Drive's size and checksum match what was sent.
 * - The file is gzip-compressed where the browser can do it, and only after the compressed copy has
 *   been opened again and found identical. Plain JSON backups from before are still read.
 * - This device's data is never uploaded over a backup it does not belong to without the person saying so.
 * - A restore validates the file first, saves a copy of the current data, replaces everything in one
 *   transaction, then reads the result back and compares it with the backup.
 */

export const BACKUP_FILE_NAME = 'gymbook-backup.json'

export const PHOTO_PACK_NAME = 'gymbook-photos.json'
/** Photos are grouped into packs of about this many characters, so one upload stays a manageable size. */
const PACK_CHARS = 6_000_000

/** A file in Drive holding some photos, and which ones (by fingerprint). Listed in the data file. */
export interface PhotoPack {
  id: string
  size: number
  hashes: string[]
}

export interface LocalSnapshot {
  /** Every record, without the full-size photos and without the thumbnails that can be remade from them. */
  backup: Backup
  /** Fingerprint of the records only, so the export time does not make identical data look new. */
  hash: string
  members: number
  /** The photos this data needs: fingerprint → the member whose picture it is. */
  photos: Map<string, string>
  /** Nothing a gym would miss: no members, plans, invoices, payments or visits. */
  empty: boolean
}

export async function takeSnapshot(): Promise<LocalSnapshot> {
  // Pictures still inside member records (older data) are moved out first, so they are never sent in the data file.
  await splitMemberPhotos().catch(() => 0)
  const full = await exportBackup({ photos: false })
  const photos = new Map<string, string>()
  const members = full.data.members.map((m) => {
    if (!m.photoHash) return m
    photos.set(m.photoHash, m.id)
    return { ...m, photoDataUrl: undefined }
  })
  const backup: Backup = { ...full, data: { ...full.data, members, photos: [] } }
  const d = backup.data
  return {
    backup,
    hash: await sha256Hex(JSON.stringify(d)),
    members: d.members.length,
    photos,
    empty: d.members.length + d.plans.length + d.invoices.length + d.payments.length + d.attendance.length === 0,
  }
}

const PACK_CACHE_KEY = 'gymbook-drive-photo-packs'
function cachedPacks(contentHash: string | undefined): PhotoPack[] | null {
  try {
    const c = JSON.parse(localStorage.getItem(PACK_CACHE_KEY) ?? 'null') as { contentHash?: string; packs?: PhotoPack[] } | null
    return c && contentHash && c.contentHash === contentHash && Array.isArray(c.packs) ? c.packs : null
  } catch {
    return null
  }
}
function rememberPacks(contentHash: string, packs: PhotoPack[]): void {
  try {
    localStorage.setItem(PACK_CACHE_KEY, JSON.stringify({ contentHash, packs }))
  } catch {
    // storage blocked or full: the list is simply read from Drive next time
  }
}

const isPack = (p: unknown): p is PhotoPack => typeof p === 'object' && p !== null && typeof (p as PhotoPack).id === 'string' && Array.isArray((p as PhotoPack).hashes)

/** Total bytes a backup takes in Drive: the data file plus its photo packs. */
export const backupBytes = (file: DriveFile): number => file.size + (Number(file.appProperties.photoBytes) || 0)

/** Which photo packs the backup in Drive lists. Read from this device's memory of it when that is still current. */
async function remotePacks(client: DriveClient, remote: DriveFile | null): Promise<PhotoPack[]> {
  if (!remote || remote.appProperties.photos !== 'packs') return []
  const cached = cachedPacks(remote.appProperties.contentHash)
  if (cached) return cached
  const parsed = JSON.parse(await decodeBackupBytes(await client.download(remote.id))) as { photoPacks?: unknown }
  return Array.isArray(parsed.photoPacks) ? parsed.photoPacks.filter(isPack) : []
}

/** Trust Drive's own account of what it stored, not the fact that the request did not fail. */
async function confirmStored(client: DriveClient, file: DriveFile, bytes: Uint8Array): Promise<void> {
  const expected = md5Hex(bytes)
  if (file.size !== bytes.length || (file.md5Checksum !== undefined && file.md5Checksum !== expected)) {
    throw new DriveError('verify', 'Google Drive stored something different from what was sent, so this backup cannot be trusted. Try again.')
  }
  if (file.md5Checksum === undefined) {
    const check = await client.get(file.id)
    if (!check || check.size !== bytes.length || check.md5Checksum !== expected) throw new DriveError('verify', 'The backup could not be confirmed in Google Drive. Try again.')
  }
}

/**
 * Make sure Drive holds every photo the data needs, uploading only the ones it lacks, and return
 * the packs the new data file should list. Packs that have become mostly dead weight (photos since
 * replaced or removed) are left out, so their few live photos travel again in a fresh pack and the
 * old pack can be deleted afterwards.
 */
async function syncPhotoPacks(client: DriveClient, known: PhotoPack[], need: Map<string, string>): Promise<{ packs: PhotoPack[]; uploaded: number }> {
  const live = (p: PhotoPack) => p.hashes.filter((h) => need.has(h)).length
  let kept = known.filter((p) => live(p) > 0 && live(p) * 2 >= p.hashes.length)
  // Many small packs (one per day a photo was added) are folded together once they pile up.
  if (kept.length > 30) {
    const smallest = new Set([...kept].sort((a, b) => a.size - b.size).slice(0, 12).map((p) => p.id))
    kept = kept.filter((p) => !smallest.has(p.id))
  }
  const have = new Set(kept.flatMap((p) => p.hashes))
  const fresh: PhotoPack[] = []
  let batch: Record<string, string> = {}
  let chars = 0
  let uploaded = 0
  const flush = async () => {
    const hashes = Object.keys(batch)
    if (hashes.length === 0) return
    const payload = await encodeForUpload(new TextEncoder().encode(JSON.stringify({ format: 'gymbook-photos', version: 1, photos: batch })))
    const file = await client.upload({ name: PHOTO_PACK_NAME, bytes: payload.bytes, contentType: payload.contentType, appProperties: { format: 'gymbook-photos', encoding: payload.encoding, count: String(hashes.length) } })
    await confirmStored(client, file, payload.bytes)
    fresh.push({ id: file.id, size: file.size, hashes })
    uploaded += hashes.length
    batch = {}
    chars = 0
  }
  for (const [hash, memberId] of need) {
    if (have.has(hash)) continue
    const photo = await getPhotoRecord(memberId)
    // Replaced while the backup was running: the next backup carries the new picture.
    if (!photo || photo.hash !== hash) continue
    if (chars > 0 && chars + photo.dataUrl.length > PACK_CHARS) await flush()
    batch[hash] = photo.dataUrl
    chars += photo.dataUrl.length
  }
  await flush()
  return { packs: [...kept, ...fresh], uploaded }
}

export interface UploadPayload {
  bytes: Uint8Array
  encoding: 'gzip' | 'identity'
  contentType: string
}

/**
 * What is actually sent to Drive. The compressed copy is used only if opening it again gives back
 * exactly the bytes that went in; otherwise the plain JSON is sent, which is always readable.
 */
export async function encodeForUpload(json: Uint8Array): Promise<UploadPayload> {
  const plain: UploadPayload = { bytes: json, encoding: 'identity', contentType: 'application/json' }
  if (!canGzip()) return plain
  try {
    const packed = await gzip(json)
    if (!isGzip(packed) || !sameBytes(await gunzip(packed), json)) return plain
    return { bytes: packed, encoding: 'gzip', contentType: 'application/gzip' }
  } catch {
    return plain
  }
}

/** Turn a downloaded backup file into text, whether it was stored compressed or not. Rejects if it is damaged gzip. */
export async function decodeBackupBytes(bytes: Uint8Array): Promise<string> {
  const raw = isGzip(bytes) ? await gunzip(bytes) : bytes
  return new TextDecoder().decode(raw)
}

/** The newest backup file in this account's app folder, if any. */
export async function findRemoteBackup(client: DriveClient, link: DriveLink | null): Promise<DriveFile | null> {
  if (link?.fileId) {
    const known = await client.get(link.fileId)
    if (known) return known
  }
  return (await client.list(BACKUP_FILE_NAME))[0] ?? null
}

export type SignInSituation =
  /** This device already backs up to this account and nothing else changed the backup. */
  | { kind: 'ready'; remote: DriveFile | null }
  /** Nothing in Drive yet and this device is not tied to another account: a first backup can be made. */
  | { kind: 'first-backup' }
  /** Drive has a backup and this device's data was never tied to this account: offer restore, never assume it. */
  | { kind: 'restore-offer'; remote: DriveFile; localEmpty: boolean }
  /** The data here belongs to a different Google account. */
  | { kind: 'other-account'; linkedEmail: string; remote: DriveFile | null }
  /** Another device replaced the backup since this one last backed up. */
  | { kind: 'remote-changed'; remote: DriveFile }

/** What signing in means for the data on this device. Deciding is separate from doing: nothing here uploads or restores. */
export function assessSignIn(link: DriveLink | null, account: DriveAccount, remote: DriveFile | null, localEmpty: boolean): SignInSituation {
  if (link && link.accountId !== account.id) return { kind: 'other-account', linkedEmail: link.email, remote }
  if (!link) return remote ? { kind: 'restore-offer', remote, localEmpty } : { kind: 'first-backup' }
  if (remote && link.lastBackupHash && remote.appProperties.contentHash && remote.appProperties.contentHash !== link.lastBackupHash) return { kind: 'remote-changed', remote }
  return { kind: 'ready', remote }
}

export type BlockReason =
  /** The data here was backed up to another Google account. */
  | 'other-account'
  /** This account already has a backup that this device's data did not come from. */
  | 'remote-exists'
  /** Another device replaced the backup since this one last backed up. */
  | 'remote-changed'
  /** This device has far fewer members than the backup it would replace. */
  | 'shrink'

/** A backup that was stopped because going ahead could destroy data. The person can allow it explicitly. */
export class BackupBlocked extends Error {
  reason: BlockReason
  remote: DriveFile | null
  localMembers: number
  constructor(reason: BlockReason, remote: DriveFile | null, localMembers: number, message: string) {
    super(message)
    this.name = 'BackupBlocked'
    this.reason = reason
    this.remote = remote
    this.localMembers = localMembers
  }
}

export interface BackupOptions {
  /**
   * The person has confirmed that this device's data should replace whatever the signed-in account
   * holds. Lifts every block. Automatic backups never pass it.
   */
  replace?: boolean
}

export type BackupOutcome = { status: 'uploaded'; file: DriveFile; created: boolean } | { status: 'unchanged'; file: DriveFile }

export const remoteMembers = (file: DriveFile | null): number | undefined => {
  const n = Number(file?.appProperties.members)
  return file && Number.isFinite(n) ? n : undefined
}

export async function runBackup(client: DriveClient, account: DriveAccount, options: BackupOptions = {}): Promise<BackupOutcome> {
  const link = loadLink()
  const sameAccount = link?.accountId === account.id
  // Read before the data: a change that lands while the backup runs then still counts as not backed up.
  const revision = dataRevision()
  const snapshot = await takeSnapshot()
  // A file id remembered for another account means nothing here.
  const remote = await findRemoteBackup(client, sameAccount ? link : null)

  if (!options.replace) {
    if (link && !sameAccount) throw new BackupBlocked('other-account', remote, snapshot.members, `The data on this device was backed up to ${link.email}. It was not uploaded to ${account.email}.`)
    if (!link && remote && remote.appProperties.contentHash !== snapshot.hash) throw new BackupBlocked('remote-exists', remote, snapshot.members, `${account.email} already has a GymBook backup that this device’s data did not come from. Nothing was uploaded.`)
    if (link && remote && link.lastBackupHash && remote.appProperties.contentHash && remote.appProperties.contentHash !== link.lastBackupHash && remote.appProperties.contentHash !== snapshot.hash) {
      throw new BackupBlocked('remote-changed', remote, snapshot.members, 'Another device has replaced the backup since this device last backed up. Nothing was uploaded.')
    }
    const before = remoteMembers(remote)
    if (before !== undefined && before > 0 && snapshot.members < before / 2) {
      throw new BackupBlocked('shrink', remote, snapshot.members, `This device has ${snapshot.members} member${snapshot.members === 1 ? '' : 's'} but the backup in Google Drive has ${before}. Nothing was uploaded.`)
    }
  }

  const linked = (file: DriveFile, uploaded: boolean): DriveLink => ({
    accountId: account.id,
    email: account.email,
    fileId: file.id,
    lastBackupAt: uploaded || !sameAccount ? file.modifiedTime : (link?.lastBackupAt ?? file.modifiedTime),
    lastBackupHash: snapshot.hash,
    lastBackupRev: revision,
    lastBackupSize: backupBytes(file),
    lastBackupMembers: snapshot.members,
    lastCheckedAt: new Date().toISOString(),
    auto: link?.auto ?? true,
  })

  if (remote && remote.appProperties.contentHash === snapshot.hash) {
    saveLink(linked(remote, false))
    return { status: 'unchanged', file: remote }
  }

  // Photos first, the data file last: if anything fails on the way, the old backup still stands whole.
  const { packs } = await syncPhotoPacks(client, await remotePacks(client, remote), snapshot.photos)
  const photoBytes = packs.reduce((sum, p) => sum + p.size, 0)
  const payload = await encodeForUpload(new TextEncoder().encode(JSON.stringify({ ...snapshot.backup, photoPacks: packs })))
  const file = await client.upload({
    name: BACKUP_FILE_NAME,
    bytes: payload.bytes,
    contentType: payload.contentType,
    existingId: remote?.id,
    appProperties: {
      format: BACKUP_FORMAT,
      formatVersion: String(BACKUP_VERSION),
      encoding: payload.encoding,
      contentHash: snapshot.hash,
      exportedAt: snapshot.backup.exportedAt,
      members: String(snapshot.members),
      gymName: (snapshot.backup.data.settings?.gymName ?? '').slice(0, 60),
      photos: 'packs',
      photoCount: String(snapshot.photos.size),
      photoBytes: String(photoBytes),
    },
  })
  await confirmStored(client, file, payload.bytes)
  rememberPacks(snapshot.hash, packs)

  // Only now, with the new data file safely stored, remove packs it no longer lists.
  try {
    const listed = new Set(packs.map((p) => p.id))
    for (const stale of await client.list(PHOTO_PACK_NAME)) if (!listed.has(stale.id)) await client.remove(stale.id)
  } catch {
    // Left-over packs cost a little space and are cleared by a later backup.
  }

  saveLink(linked(file, true))
  return { status: 'uploaded', file, created: !remote }
}

export interface RemotePreview {
  file: DriveFile
  preview: ImportPreview
  /** Photo packs this backup lists. Empty for a backup made before photos were stored apart. */
  packs: PhotoPack[]
}

/** Download the account's backup data and check it. Never touches the data on this device; photos are fetched only on restore. */
export async function loadRemoteBackup(client: DriveClient, file: DriveFile): Promise<RemotePreview> {
  const bytes = await client.download(file.id)
  let text: string
  try {
    text = await decodeBackupBytes(bytes)
  } catch {
    return { file, packs: [], preview: { ok: false, errors: ['The backup file in Google Drive is damaged and could not be opened.'], warnings: [], counts: {} } }
  }
  let packs: PhotoPack[] = []
  try {
    const parsed = JSON.parse(text) as { photoPacks?: unknown }
    if (Array.isArray(parsed.photoPacks)) packs = parsed.photoPacks.filter(isPack)
  } catch {
    // validateBackup reports unreadable JSON
  }
  return { file, packs, preview: validateBackup(text) }
}

/** Fetch the photos a backup needs from its packs and put them back with their members. */
async function attachPhotos(client: DriveClient, backup: Backup, packs: PhotoPack[]): Promise<{ backup: Backup; missing: number }> {
  const wanted = new Set(backup.data.members.map((m) => m.photoHash).filter((h): h is string => Boolean(h)))
  const found = new Map<string, string>()
  for (const pack of packs) {
    if (!pack.hashes.some((h) => wanted.has(h) && !found.has(h))) continue
    const parsed = JSON.parse(await decodeBackupBytes(await client.download(pack.id))) as { photos?: Record<string, unknown> }
    for (const [hash, url] of Object.entries(parsed.photos ?? {})) if (wanted.has(hash) && typeof url === 'string') found.set(hash, url)
  }
  let missing = 0
  const photos: Backup['data']['photos'] = []
  const members: Backup['data']['members'] = []
  for (const m of backup.data.members) {
    if (!m.photoHash) {
      members.push(m)
      continue
    }
    const full = found.get(m.photoHash)
    // A picture that is absent or does not match its fingerprint is left out; the member's record is still restored.
    if (!full || (await sha256Hex(full)) !== m.photoHash) {
      missing += 1
      members.push({ ...m, photoDataUrl: undefined, photoHash: undefined })
      continue
    }
    photos.push({ id: m.id, dataUrl: full, hash: m.photoHash, updatedAt: m.updatedAt })
    members.push({ ...m, photoDataUrl: await makeThumb(full) })
  }
  return { backup: { ...backup, data: { ...backup.data, members, photos } }, missing }
}

export interface RestoreResult {
  /** A copy of the data that was on this device was handed to `saveCopy` before anything was replaced. */
  safetyCopySaved: boolean
  /** Stores whose contents, read back after the restore, differ from the backup. Empty when the restore is verified. */
  mismatches: string[]
  /** Members whose photo could not be brought back from Drive (their records were still restored). */
  missingPhotos: number
}

const VERIFIED_STORES = ['members', 'plans', 'memberships', 'invoices', 'adjustments', 'payments', 'attendance', 'followups', 'workouts', 'trainers', 'schedules', 'expenses', 'sessions', 'equipment', 'incidents'] as const

const canonical = (rows: { id: string }[]) => JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))

/**
 * Replace this device's data with a validated backup from Drive.
 * `saveCopy` receives the current data first (unless there is none), so a wrong restore can be undone from that file.
 */
export async function restoreFromDrive(account: DriveAccount, remote: RemotePreview, saveCopy: (filename: string, json: string) => void, client?: DriveClient): Promise<RestoreResult> {
  let backup = remote.preview.backup
  if (!remote.preview.ok || !backup) throw new DriveError('verify', 'This backup did not pass its checks, so nothing was restored.')

  // Photos are downloaded before anything on this device is touched: a failed download leaves the data as it was.
  let missingPhotos = 0
  if (remote.packs.length > 0) {
    if (!client) throw new DriveError('verify', 'This backup keeps its photos in separate files, which could not be reached. Nothing was restored.')
    const attached = await attachPhotos(client, backup, remote.packs)
    backup = attached.backup
    missingPhotos = attached.missing
  }

  const current = await takeSnapshot()
  let safetyCopySaved = false
  if (!current.empty) {
    const everything = await exportBackup()
    saveCopy(`gymbook-before-restore-${everything.exportedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(everything))
    safetyCopySaved = true
  }

  // One transaction: either every store is replaced or none is.
  await importBackup(backup)

  const after = (await exportBackup({ photos: false })).data
  const mismatches: string[] = []
  const workoutIds = new Set(backup.data.workouts.map((w) => w.id))
  for (const store of VERIFIED_STORES) {
    // The import clears a member's link to a workout plan the backup does not contain; mirror that before comparing.
    const expected = store === 'members' ? backup.data.members.map((m) => (m.workoutPlanId && !workoutIds.has(m.workoutPlanId) ? { ...m, workoutPlanId: undefined } : m)) : backup.data[store]
    if (canonical(expected as { id: string }[]) !== canonical(after[store] as { id: string }[])) mismatches.push(store)
  }

  const previous = loadLink()
  saveLink({
    accountId: account.id,
    email: account.email,
    fileId: remote.file.id,
    lastBackupAt: remote.file.modifiedTime,
    // The backup this device now matches, so the next comparison with Drive does not look like a conflict.
    lastBackupHash: remote.file.appProperties.contentHash,
    // Only a restore that was read back and matches counts as "nothing changed since".
    lastBackupRev: mismatches.length === 0 ? dataRevision() : undefined,
    lastBackupSize: backupBytes(remote.file),
    lastBackupMembers: backup.data.members.length,
    lastCheckedAt: new Date().toISOString(),
    auto: previous?.accountId === account.id ? previous.auto : true,
  })
  if (remote.packs.length > 0) rememberPacks(remote.file.appProperties.contentHash ?? '', remote.packs)
  // A backup from before photos were stored apart carries them inside the member records: move them out now.
  void splitMemberPhotos().catch(() => 0)
  return { safetyCopySaved, mismatches, missingPhotos }
}

/**
 * Whether the data changed since the last backup, answered from the revision counter when the link
 * has one. `undefined` means only a comparison of the data itself can tell (a link saved before
 * the counter existed).
 */
export function changedSinceBackup(link: DriveLink | null): boolean | undefined {
  if (!link?.lastBackupHash) return Boolean(link)
  if (link.lastBackupRev === undefined) return undefined
  return dataRevision() !== link.lastBackupRev
}

/** Automatic backup is due when the data changed and the last successful backup is at least a day old. */
export function isBackupOverdue(link: DriveLink | null, changed: boolean, now: Date = new Date()): boolean {
  if (!link || !link.auto || !changed) return false
  if (!link.lastBackupAt) return true
  return now.getTime() - new Date(link.lastBackupAt).getTime() >= 24 * 60 * 60 * 1000
}
