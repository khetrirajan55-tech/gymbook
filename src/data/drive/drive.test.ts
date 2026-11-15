import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createHash } from 'node:crypto'
import { closeDb, getDb } from '../db'
import { createMember, updateMember, listMembers, setMemberPhoto } from '../services/members'
import { getPhotoRecord } from '../services/photos'
import { createPlan } from '../services/plans'
import { createMemberWithMembership } from '../services/memberships'
import { exportBackup, validateBackup } from '../backup'
import { FakeDrive } from '@/test/fakeDrive'
import { createDriveClient, DriveError, SINGLE_REQUEST_LIMIT } from './driveApi'
import { assessSignIn, BackupBlocked, BACKUP_FILE_NAME, PHOTO_PACK_NAME, changedSinceBackup, decodeBackupBytes, encodeForUpload, findRemoteBackup, isBackupOverdue, loadRemoteBackup, restoreFromDrive, runBackup, takeSnapshot } from './driveBackup'
import { clearLink, loadLink, saveLink } from './driveState'
import { md5Hex, sha256Hex } from './md5'
import { canGzip, gunzip, gzip, isGzip } from './gzip'
import { dataRevision } from '../events'
import { gunzipSync, gzipSync } from 'node:zlib'

const today = '2026-11-06'
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

let drive: FakeDrive
const noWait = () => Promise.resolve()
/** The backup's data file(s) in an account, without the photo packs that sit beside it. */
const dataFiles = (accountId: string) => drive.files(accountId).filter((f) => f.name === BACKUP_FILE_NAME)
const packFiles = (accountId: string) => drive.files(accountId).filter((f) => f.name === PHOTO_PACK_NAME)
const clientFor = (token: string) => createDriveClient(token, { fetch: drive.fetch, sleep: noWait })
const A = { id: 'acct-a', email: 'owner.a@example.com' }
const B = { id: 'acct-b', email: 'owner.b@example.com' }

async function freshDatabase() {
  await closeDb()
  indexedDB = new IDBFactory()
  await getDb()
}

/** One member with a photo, a plan, a membership, an invoice and a part payment. */
async function seedGym(name = 'Rahul Patil') {
  const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
  return createMemberWithMembership({ name, phone: '9820012345', joiningDate: today, photoDataUrl: PHOTO, heightCm: 172, weightKg: 68.5 }, { planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 50000, paymentMethod: 'upi', issueDate: today })
}

beforeEach(async () => {
  await freshDatabase()
  localStorage.clear()
  clearLink()
  drive = new FakeDrive()
  drive.addAccount('token-a', A)
  drive.addAccount('token-b', B)
})

describe('checksums', () => {
  it('md5Hex matches the published test vectors and Node for awkward lengths', () => {
    const enc = new TextEncoder()
    expect(md5Hex(enc.encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex(enc.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6')
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 255)
      expect(md5Hex(bytes), `length ${n}`).toBe(createHash('md5').update(bytes).digest('hex'))
    }
  })
  it('sha256Hex matches Node, including non-ASCII text', async () => {
    for (const text of ['', 'abc', 'नमस्कार 👋 ₹1,500']) expect(await sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
  })
})

describe('backing up', () => {
  it('the first backup creates one verified file holding every record and the photo', async () => {
    const sold = await seedGym()
    const account = await clientFor('token-a').account()
    expect(account).toMatchObject(A)
    const result = await runBackup(clientFor('token-a'), account)
    expect(result).toMatchObject({ status: 'uploaded', created: true })

    const files = dataFiles(A.id)
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe(BACKUP_FILE_NAME)
    const stored = validateBackup(await decodeBackupBytes(files[0].content))
    expect(stored.ok).toBe(true)
    expect(stored.counts).toMatchObject({ members: 1, plans: 1, memberships: 1, invoices: 1, payments: 1 })
    // The data file names the photo by its fingerprint; the picture itself is in one pack beside it, stored once.
    const photoHash = createHash('sha256').update(PHOTO).digest('hex')
    expect(stored.backup!.data.members[0]).toMatchObject({ id: sold.member.id, name: 'Rahul Patil', photoHash, heightCm: 172, weightKg: 68.5 })
    expect(stored.backup!.data.members[0].photoDataUrl).toBeUndefined()
    expect(files[0].appProperties).toMatchObject({ format: 'gymbook-backup', formatVersion: '1', members: '1', photos: 'packs', photoCount: '1' })
    const packs = packFiles(A.id)
    expect(packs).toHaveLength(1)
    expect(JSON.parse(await decodeBackupBytes(packs[0].content))).toMatchObject({ format: 'gymbook-photos', photos: { [photoHash]: PHOTO } })
    expect(JSON.parse(await decodeBackupBytes(files[0].content)).photoPacks).toEqual([{ id: packs[0].id, size: packs[0].content.length, hashes: [photoHash] }])

    const link = loadLink()!
    expect(link).toMatchObject({ accountId: A.id, email: A.email, fileId: files[0].id, lastBackupAt: files[0].modifiedTime, lastBackupMembers: 1, auto: true })
    expect(link.lastBackupSize).toBe(files[0].content.length + packs[0].content.length)
    expect(link.lastBackupHash).toBe(files[0].appProperties.contentHash)
    // nothing about the Google session is kept
    expect(JSON.stringify(localStorage)).not.toContain('token-a')
  })

  it('a later backup sends only what changed: the data file again, and only a photo Drive does not hold yet', async () => {
    const sold = await seedGym()
    const client = clientFor('token-a')
    const account = await client.account()
    await runBackup(client, account)
    expect(drive.uploads(PHOTO_PACK_NAME)).toBe(1)
    const firstPack = packFiles(A.id)[0]

    // A record changes, the photo does not: no photo travels again.
    await createMember({ name: 'No Photo', phone: '9811100020', joiningDate: today })
    await runBackup(client, account)
    expect(drive.uploads()).toBe(2)
    expect(drive.uploads(PHOTO_PACK_NAME)).toBe(1)
    expect(packFiles(A.id).map((f) => f.id)).toEqual([firstPack.id])

    // A second member gets a different photo: one new pack with just that photo.
    const other = 'data:image/jpeg;base64,' + 'B'.repeat(400)
    const second = await createMember({ name: 'New Photo', phone: '9811100021', joiningDate: today, photoDataUrl: other })
    await runBackup(client, account)
    expect(drive.uploads(PHOTO_PACK_NAME)).toBe(2)
    expect(packFiles(A.id)).toHaveLength(2)
    const newest = packFiles(A.id).find((f) => f.id !== firstPack.id)!
    expect(Object.values(JSON.parse(await decodeBackupBytes(newest.content)).photos)).toEqual([other])

    // The first member's photo is replaced: its old pack holds nothing live any more and is deleted after the upload.
    const m = (await listMembers()).find((x) => x.id === sold.member.id)!
    await setMemberPhoto(m.id, m.rev, 'data:image/jpeg;base64,' + 'C'.repeat(500))
    await runBackup(client, account)
    expect(packFiles(A.id).some((f) => f.id === firstPack.id)).toBe(false)
    expect(packFiles(A.id)).toHaveLength(2)

    // Everything comes back on an empty device, each photo with its member.
    await freshDatabase()
    clearLink()
    const preview = await loadRemoteBackup(client, (await findRemoteBackup(client, null))!)
    expect(preview.packs).toHaveLength(2)
    expect(await restoreFromDrive(account, preview, () => undefined, client)).toEqual({ safetyCopySaved: false, mismatches: [], missingPhotos: 0 })
    const back = await listMembers()
    expect(back).toHaveLength(3)
    expect((await getPhotoRecord(sold.member.id))?.dataUrl).toBe('data:image/jpeg;base64,' + 'C'.repeat(500))
    expect((await getPhotoRecord(second.id))?.dataUrl).toBe(other)
    expect(back.find((x) => x.name === 'No Photo')?.photoDataUrl).toBeUndefined()
  })

  it('a photo pack missing from Drive costs that photo only: the records are restored and the loss is reported', async () => {
    const sold = await seedGym()
    const client = clientFor('token-a')
    const account = await client.account()
    await runBackup(client, account)
    const preview = await loadRemoteBackup(client, (await findRemoteBackup(client, null))!)
    packFiles(A.id)[0].content = new TextEncoder().encode(JSON.stringify({ format: 'gymbook-photos', version: 1, photos: {} }))
    await freshDatabase()
    clearLink()
    expect(await restoreFromDrive(account, preview, () => undefined, client)).toEqual({ safetyCopySaved: false, mismatches: [], missingPhotos: 1 })
    const [back] = await listMembers()
    expect(back).toMatchObject({ id: sold.member.id, name: 'Rahul Patil' })
    expect(back.photoDataUrl).toBeUndefined()
  })

  it('unchanged data is not uploaded again; a change replaces the same file instead of adding one', async () => {
    const sold = await seedGym()
    const client = clientFor('token-a')
    const account = await client.account()
    const first = await runBackup(client, account)
    expect(drive.uploads()).toBe(1)

    const again = await runBackup(client, account)
    expect(again.status).toBe('unchanged')
    expect(drive.uploads()).toBe(1)
    expect(loadLink()!.lastBackupAt).toBe(first.file.modifiedTime)

    const member = (await listMembers())[0]
    await updateMember(member.id, member.rev, { name: 'Rahul S. Patil', phone: member.phone, joiningDate: member.joiningDate, photoDataUrl: PHOTO })
    const second = await runBackup(client, account)
    expect(second).toMatchObject({ status: 'uploaded', created: false })
    expect(second.file.id).toBe(first.file.id)
    expect(second.file.modifiedTime > first.file.modifiedTime).toBe(true)
    expect(dataFiles(A.id)).toHaveLength(1)
    expect(validateBackup(await decodeBackupBytes(dataFiles(A.id)[0].content)).backup!.data.members[0]).toMatchObject({ id: sold.member.id, name: 'Rahul S. Patil' })
    expect(loadLink()!.lastBackupAt).toBe(second.file.modifiedTime)
  })

  it('a backup larger than the single-request limit goes through an upload session and is still verified', async () => {
    await seedGym()
    // Photos that do not compress, as real ones do not, so the file stays large after gzip.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let seed = 12345
    const noise = (length: number) => {
      let out = ''
      for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        out += alphabet[seed >>> 26]
      }
      return out
    }
    for (let i = 0; i < 24; i++) await createMember({ name: `Member ${i}`, phone: `98200${String(10000 + i)}`, joiningDate: today, photoDataUrl: `data:image/jpeg;base64,${noise(390_000)}` })
    const client = clientFor('token-a')
    const result = await runBackup(client, await client.account())
    expect(result.status).toBe('uploaded')
    // The photos, not the data file, are what is large now. They go up in several packs, each small enough for one request.
    const packs = packFiles(A.id)
    expect(packs.length).toBeGreaterThan(1)
    expect(Math.max(...packs.map((f) => f.content.length))).toBeLessThanOrEqual(SINGLE_REQUEST_LIMIT)
    // A file over the single-request limit still goes through an upload session and comes back whole.
    const big = Uint8Array.from({ length: SINGLE_REQUEST_LIMIT + 4096 }, (_, i) => (i * 7) & 255)
    const stored = await client.upload({ name: 'big.bin', bytes: big, appProperties: {} })
    expect(drive.log.some((l) => l.method === 'PUT' && l.path.startsWith('/upload/'))).toBe(true)
    expect(stored.size).toBe(big.length)
    expect(stored.md5Checksum).toBe(createHash('md5').update(big).digest('hex'))
    expect(dataFiles(A.id)[0].content.length).toBe(result.file.size)
    expect(result.file.size).toBeLessThan(100_000)
    expect(Number(result.file.appProperties.photoBytes)).toBe(packs.reduce((sum, f) => sum + f.content.length, 0))
    expect(validateBackup(await decodeBackupBytes(dataFiles(A.id)[0].content)).counts.members).toBe(25)
  })
})

describe('keeping Google accounts apart', () => {
  it('another account sees no backup, and this device’s data is not uploaded to it', async () => {
    await seedGym()
    const a = clientFor('token-a')
    await runBackup(a, await a.account())
    const fileA = dataFiles(A.id)[0]

    const b = clientFor('token-b')
    const accountB = await b.account()
    expect(await b.list(BACKUP_FILE_NAME)).toEqual([])
    expect(await b.get(fileA.id)).toBeNull()
    await expect(b.download(fileA.id)).rejects.toMatchObject({ kind: 'not-found' })
    // the file id remembered for account A is not used to look in account B
    expect(await findRemoteBackup(b, null)).toBeNull()
    expect(assessSignIn(loadLink(), accountB, null, false)).toEqual({ kind: 'other-account', linkedEmail: A.email, remote: null })

    const before = drive.uploads()
    await expect(runBackup(b, accountB)).rejects.toMatchObject({ name: 'BackupBlocked', reason: 'other-account' })
    expect(drive.uploads()).toBe(before)
    expect(dataFiles(B.id)).toEqual([])
    expect(loadLink()!.accountId).toBe(A.id)
  })

  it('only an explicit yes moves this device to the other account, and the first account’s file is left alone', async () => {
    await seedGym()
    const a = clientFor('token-a')
    await runBackup(a, await a.account())
    const fileA = { ...dataFiles(A.id)[0] }
    const b = clientFor('token-b')
    const result = await runBackup(b, await b.account(), { replace: true })
    expect(result).toMatchObject({ status: 'uploaded', created: true })
    expect(dataFiles(B.id)).toHaveLength(1)
    expect(dataFiles(A.id)[0]).toEqual(fileA)
    expect(loadLink()).toMatchObject({ accountId: B.id, email: B.email, fileId: dataFiles(B.id)[0].id })
  })

  it('signing in to an account that already has a backup offers a restore; it never uploads or restores by itself', async () => {
    await seedGym('First Gym Member')
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const remote = dataFiles(A.id)[0]

    // a new browser: different records, no link
    await freshDatabase()
    clearLink()
    expect(assessSignIn(loadLink(), account, await findRemoteBackup(a, null), true)).toMatchObject({ kind: 'restore-offer', localEmpty: true })
    await createMember({ name: 'Someone Else', phone: '9811100000', joiningDate: today })
    expect(assessSignIn(loadLink(), account, await findRemoteBackup(a, null), false)).toMatchObject({ kind: 'restore-offer', localEmpty: false })

    const before = drive.uploads()
    const blocked = await runBackup(a, account).catch((e) => e)
    expect(blocked).toBeInstanceOf(BackupBlocked)
    expect(blocked).toMatchObject({ reason: 'remote-exists', localMembers: 1 })
    expect(drive.uploads()).toBe(before)
    expect(dataFiles(A.id)[0].modifiedTime).toBe(remote.modifiedTime)
    expect(loadLink()).toBeNull()
    expect((await listMembers()).map((m) => m.name)).toEqual(['Someone Else'])
  })

  it('a backup replaced by another device is not overwritten silently', async () => {
    await seedGym()
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const mine = loadLink()!

    // another device, same account, different data
    await freshDatabase()
    clearLink()
    await createMember({ name: 'Other Device', phone: '9811100001', joiningDate: today })
    await runBackup(a, account, { replace: true })
    const theirs = dataFiles(A.id)[0].modifiedTime

    // back on the first device, with a change of its own
    await freshDatabase()
    saveLink(mine)
    await createMember({ name: 'First Device Again', phone: '9811100002', joiningDate: today })
    expect(assessSignIn(mine, account, await findRemoteBackup(a, mine), false).kind).toBe('remote-changed')
    await expect(runBackup(a, account)).rejects.toMatchObject({ reason: 'remote-changed' })
    expect(dataFiles(A.id)[0].modifiedTime).toBe(theirs)
  })

  it('a device with far fewer members than the backup is stopped, then allowed on request', async () => {
    const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
    for (let i = 0; i < 6; i++) await createMember({ name: `Member ${i}`, phone: `98200${String(20000 + i)}`, joiningDate: today })
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const link = loadLink()!

    await freshDatabase()
    saveLink(link)
    await createMember({ name: 'Only One', phone: '9811100003', joiningDate: today })
    expect(plan.id).toBeTruthy()
    const stopped = await runBackup(a, account).catch((e) => e)
    expect(stopped).toMatchObject({ reason: 'shrink', localMembers: 1 })
    expect(stopped.message).toContain('has 1 member but the backup in Google Drive has 6')
    expect(validateBackup(await decodeBackupBytes(dataFiles(A.id)[0].content)).counts.members).toBe(6)
    await runBackup(a, account, { replace: true })
    expect(validateBackup(await decodeBackupBytes(dataFiles(A.id)[0].content)).counts.members).toBe(1)
  })
})

describe('restoring', () => {
  it('after local data is cleared, the same account brings back the member, the membership and the photo', async () => {
    const sold = await seedGym()
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)

    await freshDatabase()
    clearLink()
    expect(await listMembers()).toEqual([])
    const remote = (await findRemoteBackup(a, null))!
    const preview = await loadRemoteBackup(a, remote)
    expect(preview.preview.ok).toBe(true)
    const copies: string[] = []
    const result = await restoreFromDrive(account, preview, (name) => copies.push(name), a)
    expect(result).toEqual({ safetyCopySaved: false, mismatches: [], missingPhotos: 0 })
    expect(copies).toEqual([])

    const [member] = await listMembers()
    expect(member).toMatchObject({ id: sold.member.id, name: 'Rahul Patil', phone: '9820012345', photoDataUrl: PHOTO, heightCm: 172, weightKg: 68.5, memberCode: 'GB-0001' })
    const db = await getDb()
    expect(await db.getAll('memberships')).toMatchObject([{ memberId: sold.member.id, planName: 'Monthly', endDate: '2026-12-05' }])
    expect(await db.getAll('invoices')).toMatchObject([{ number: 'RK-00001', totalPaise: 150000 }])
    expect(await db.getAll('payments')).toMatchObject([{ amountPaise: 50000, method: 'upi' }])
    expect(loadLink()).toMatchObject({ accountId: A.id, fileId: remote.id, lastBackupHash: remote.appProperties.contentHash })
    // the restored device and Drive agree, so the next backup is not treated as a conflict
    expect(assessSignIn(loadLink(), account, remote, false).kind).toBe('ready')
    await expect(runBackup(a, account)).resolves.toMatchObject({ status: 'uploaded', created: false })
    expect(dataFiles(A.id)).toHaveLength(1)
  })

  it('data already on the device is handed over as a valid backup before it is replaced', async () => {
    await seedGym('In Drive')
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)

    await freshDatabase()
    clearLink()
    await createMember({ name: 'Local Only', phone: '9811100004', joiningDate: today })
    const preview = await loadRemoteBackup(a, (await findRemoteBackup(a, null))!)
    const copies: { name: string; json: string }[] = []
    const result = await restoreFromDrive(account, preview, (name, json) => copies.push({ name, json }), a)
    expect(result).toEqual({ safetyCopySaved: true, mismatches: [], missingPhotos: 0 })
    expect(copies).toHaveLength(1)
    expect(copies[0].name).toMatch(/^gymbook-before-restore-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/)
    const saved = validateBackup(copies[0].json)
    expect(saved.ok).toBe(true)
    expect(saved.backup!.data.members.map((m) => m.name)).toEqual(['Local Only'])
    expect((await listMembers()).map((m) => m.name)).toEqual(['In Drive'])
  })

  it('a damaged or foreign file in Drive is refused and the device keeps its data', async () => {
    await createMember({ name: 'Keep Me', phone: '9811100005', joiningDate: today })
    const a = clientFor('token-a')
    const account = await a.account()
    const cases: [string, RegExp][] = [
      ['{ not json', /not valid JSON/],
      [JSON.stringify({ format: 'something-else', version: 1, exportedAt: 'x', data: {} }), /not a GymBook backup/],
      [JSON.stringify({ format: 'gymbook-backup', version: 99, exportedAt: 'x', data: {} }), /not a GymBook backup/],
    ]
    for (const [content, message] of cases) {
      const file = drive.seed(A.id, BACKUP_FILE_NAME, content)
      const preview = await loadRemoteBackup(a, (await a.get(file.id))!)
      expect(preview.preview.ok).toBe(false)
      expect(preview.preview.errors[0]).toMatch(message)
      await expect(restoreFromDrive(account, preview, () => undefined, a)).rejects.toMatchObject({ kind: 'verify' })
    }
    // records that point at each other wrongly are caught too
    const good = (await takeSnapshot()).backup
    const broken = { ...good, data: { ...good.data, payments: [{ id: 'pay_x', createdAt: 'x', updatedAt: 'x', rev: 1, memberId: 'mem_missing', amountPaise: 100, method: 'cash', receivedAt: 'x', status: 'recorded' }] } }
    const file = drive.seed(A.id, BACKUP_FILE_NAME, JSON.stringify(broken))
    const preview = await loadRemoteBackup(a, (await a.get(file.id))!)
    expect(preview.preview.ok).toBe(false)
    expect(preview.preview.errors.join(' ')).toMatch(/missing member/)
    expect((await listMembers()).map((m) => m.name)).toEqual(['Keep Me'])
    expect(loadLink()).toBeNull()
  })
})

describe('failures are reported and leave the last good backup in place', () => {
  const isUpload = (r: { method: string; url: string }) => r.url.includes('/upload/')

  async function backedUpThenChanged() {
    await seedGym()
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const good = { ...dataFiles(A.id)[0] }
    const link = loadLink()!
    await createMember({ name: 'Added Later', phone: '9811100006', joiningDate: today })
    return { a, account, good, link }
  }

  it('offline: nothing is uploaded and the previous backup and its record stay', async () => {
    const { a, account, good, link } = await backedUpThenChanged()
    drive.failNext(isUpload, 'network', 99)
    const err = await runBackup(a, account).catch((e) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect(err).toMatchObject({ kind: 'offline' })
    expect(dataFiles(A.id)[0]).toEqual(good)
    expect(loadLink()).toMatchObject({ lastBackupAt: link.lastBackupAt, lastBackupHash: link.lastBackupHash })
  })

  it('a connection that drops once is retried and the backup completes', async () => {
    const { a, account, good } = await backedUpThenChanged()
    drive.failNext(isUpload, 'network', 1)
    const result = await runBackup(a, account)
    expect(result).toMatchObject({ status: 'uploaded', created: false })
    expect(dataFiles(A.id)).toHaveLength(1)
    expect(dataFiles(A.id)[0].modifiedTime > good.modifiedTime).toBe(true)
  })

  it('an expired or revoked sign-in is reported as such', async () => {
    const { a, account, good } = await backedUpThenChanged()
    drive.revoke('token-a')
    await expect(runBackup(a, account)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(dataFiles(A.id)[0]).toEqual(good)
  })

  it('a missing Drive permission is reported as a permission problem', async () => {
    const { a, account } = await backedUpThenChanged()
    drive.accounts.get(A.id)!.noDrivePermission = true
    await expect(runBackup(a, account)).rejects.toMatchObject({ kind: 'permission', status: 403 })
  })

  it('a full Google account is reported as full, and the previous backup survives', async () => {
    const { a, account, good, link } = await backedUpThenChanged()
    drive.accounts.get(A.id)!.limit = good.content.length + 10
    const err = await runBackup(a, account).catch((e) => e)
    expect(err).toMatchObject({ kind: 'quota' })
    expect(err.message).toMatch(/storage is full/)
    expect(dataFiles(A.id)[0]).toEqual(good)
    expect(loadLink()!.lastBackupHash).toBe(link.lastBackupHash)
  })

  it('a busy Google server is retried; one that stays down is reported', async () => {
    const { a, account } = await backedUpThenChanged()
    drive.failNext(isUpload, { status: 503 }, 2)
    await expect(runBackup(a, account)).resolves.toMatchObject({ status: 'uploaded' })
    await createMember({ name: 'One More', phone: '9811100007', joiningDate: today })
    drive.failNext(isUpload, { status: 503 }, 99)
    await expect(runBackup(a, account)).rejects.toMatchObject({ kind: 'server' })
  })

  it('a checksum that does not match is never reported as a successful backup', async () => {
    const { a, account, link } = await backedUpThenChanged()
    drive.corruptNextUpload = true
    await expect(runBackup(a, account)).rejects.toMatchObject({ kind: 'verify' })
    expect(loadLink()).toMatchObject({ lastBackupAt: link.lastBackupAt, lastBackupHash: link.lastBackupHash })
  })

  it('a backup file deleted from Drive is created again rather than failing', async () => {
    const { a, account, good } = await backedUpThenChanged()
    drive.folders.get(A.id)!.delete(good.id)
    const result = await runBackup(a, account)
    expect(result).toMatchObject({ status: 'uploaded', created: true })
    expect(dataFiles(A.id)).toHaveLength(1)
    expect(loadLink()!.fileId).toBe(result.file.id)
  })
})

describe('compression', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('this test environment can compress, so the tests below exercise the compressed path', () => {
    expect(canGzip()).toBe(true)
  })

  it('gzip and gunzip agree with Node in both directions, for empty, small, non-ASCII and multi-megabyte data', async () => {
    const enc = new TextEncoder()
    const big = enc.encode(JSON.stringify(Array.from({ length: 60_000 }, (_, i) => ({ id: `att_${i}`, memberId: `mem_${i % 500}`, checkInAt: '2026-11-06T04:30:00.000Z', note: 'नमस्कार' }))))
    expect(big.length).toBeGreaterThan(4_000_000)
    for (const bytes of [new Uint8Array(), enc.encode('abc'), enc.encode('₹1,500 नमस्कार 👋'), big]) {
      const packed = await gzip(bytes)
      expect(isGzip(packed)).toBe(true)
      expect(Buffer.from(gunzipSync(packed)).equals(Buffer.from(bytes))).toBe(true)
      expect(Buffer.from(await gunzip(new Uint8Array(gzipSync(bytes)))).equals(Buffer.from(bytes))).toBe(true)
    }
    expect((await gzip(big)).length).toBeLessThan(big.length / 10)
    expect(isGzip(enc.encode('{"format":"gymbook-backup"}'))).toBe(false)
  })

  it('the backup is stored compressed, marked as such, verified against Drive, and restores to identical records', async () => {
    const sold = await seedGym()
    const a = clientFor('token-a')
    const account = await a.account()
    const result = await runBackup(a, account)
    const [file] = dataFiles(A.id)
    expect(isGzip(file.content)).toBe(true)
    expect(file.appProperties.encoding).toBe('gzip')
    expect(result.file.size).toBe(file.content.length)
    expect(result.file.md5Checksum).toBe(createHash('md5').update(file.content).digest('hex'))
    const plain = gunzipSync(file.content)
    expect(file.content.length).toBeLessThan(plain.length)
    // What Drive holds, opened by Node's own gzip, is a valid backup with the member; the photo is in its pack, also gzip.
    const stored = validateBackup(plain.toString('utf8'))
    expect(stored.ok).toBe(true)
    expect(stored.backup!.data.members[0]).toMatchObject({ id: sold.member.id, photoHash: createHash('sha256').update(PHOTO).digest('hex') })
    expect(isGzip(packFiles(A.id)[0].content)).toBe(true)

    await freshDatabase()
    clearLink()
    const preview = await loadRemoteBackup(a, (await findRemoteBackup(a, null))!)
    expect(preview.preview.ok).toBe(true)
    expect(await restoreFromDrive(account, preview, () => undefined, a)).toEqual({ safetyCopySaved: false, mismatches: [], missingPhotos: 0 })
    expect((await listMembers())[0]).toMatchObject({ id: sold.member.id, name: 'Rahul Patil', photoDataUrl: PHOTO })
  })

  it('a plain JSON backup made before compression existed is still found and restored', async () => {
    const sold = await seedGym('Made Before')
    // As the app wrote it before photos were stored apart: the full picture inside the member record, no packs.
    const everything = await exportBackup()
    const legacy = { ...everything, data: { ...everything.data, photos: [], members: everything.data.members.map((m) => ({ ...m, photoHash: undefined })) } }
    drive.seed(A.id, BACKUP_FILE_NAME, JSON.stringify(legacy), { contentHash: 'made-by-an-older-version', members: '1' })
    await freshDatabase()
    clearLink()
    const a = clientFor('token-a')
    const account = await a.account()
    const remote = (await findRemoteBackup(a, null))!
    expect(isGzip(dataFiles(A.id)[0].content)).toBe(false)
    const preview = await loadRemoteBackup(a, remote)
    expect(preview.preview.ok).toBe(true)
    expect(await restoreFromDrive(account, preview, () => undefined, a)).toEqual({ safetyCopySaved: false, mismatches: [], missingPhotos: 0 })
    expect((await listMembers())[0]).toMatchObject({ id: sold.member.id, name: 'Made Before', photoDataUrl: PHOTO })
    // The next backup replaces that same file, now compressed.
    await updateMember(sold.member.id, sold.member.rev, { name: 'Made Before, Renamed', phone: '9820012345', joiningDate: today })
    await expect(runBackup(a, account)).resolves.toMatchObject({ status: 'uploaded', created: false })
    expect(dataFiles(A.id)).toHaveLength(1)
    expect(isGzip(dataFiles(A.id)[0].content)).toBe(true)
  })

  it('a compressed backup that was cut short or damaged is refused and nothing is restored', async () => {
    await seedGym('In Drive')
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const [file] = dataFiles(A.id)
    await freshDatabase()
    clearLink()
    await createMember({ name: 'Keep Me', phone: '9811100005', joiningDate: today })
    const whole = file.content
    const flipped = whole.slice()
    flipped[Math.floor(flipped.length / 2)] ^= 0xff
    for (const damaged of [whole.slice(0, Math.floor(whole.length / 2)), flipped]) {
      file.content = damaged
      const preview = await loadRemoteBackup(a, (await a.get(file.id))!)
      expect(preview.preview.ok).toBe(false)
      expect(preview.preview.errors[0]).toMatch(/damaged|not valid JSON|invalid/i)
      await expect(restoreFromDrive(account, preview, () => undefined, a)).rejects.toMatchObject({ kind: 'verify' })
    }
    expect((await listMembers()).map((m) => m.name)).toEqual(['Keep Me'])
  })

  it('a browser that cannot compress uploads plain JSON, which is read back the same way', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    expect(canGzip()).toBe(false)
    const json = new TextEncoder().encode('{"a":1}')
    expect(await encodeForUpload(json)).toMatchObject({ encoding: 'identity', contentType: 'application/json', bytes: json })
    await seedGym()
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const [file] = dataFiles(A.id)
    expect(isGzip(file.content)).toBe(false)
    expect(file.appProperties.encoding).toBe('identity')
    expect(validateBackup(await decodeBackupBytes(file.content)).ok).toBe(true)
  })

  it('a compressor that produces something it cannot read back is not trusted: the plain copy is sent', async () => {
    class Broken {
      readable: ReadableStream<Uint8Array>
      writable: WritableStream<Uint8Array>
      constructor() {
        // Looks like gzip, but is not.
        const t = new TransformStream<Uint8Array, Uint8Array>({ transform: (_chunk, c) => c.enqueue(Uint8Array.from([0x1f, 0x8b, 8, 0, 1, 2, 3])) })
        this.readable = t.readable
        this.writable = t.writable
      }
    }
    vi.stubGlobal('CompressionStream', Broken)
    const json = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    expect(await encodeForUpload(json)).toMatchObject({ encoding: 'identity', bytes: json })
  })
})

describe('knowing whether anything changed, without reading the database', () => {
  it('the revision counter goes up with every saved change and a backup remembers the number it saw', async () => {
    expect(dataRevision()).toBe(0)
    const sold = await seedGym()
    const afterSeed = dataRevision()
    expect(afterSeed).toBeGreaterThan(0)
    const a = clientFor('token-a')
    const account = await a.account()
    expect(changedSinceBackup(null)).toBe(false)
    await runBackup(a, account)
    expect(loadLink()!.lastBackupRev).toBe(afterSeed)
    expect(changedSinceBackup(loadLink())).toBe(false)

    await updateMember(sold.member.id, sold.member.rev, { name: 'Rahul S. Patil', phone: '9820012345', joiningDate: today })
    expect(dataRevision()).toBeGreaterThan(afterSeed)
    expect(changedSinceBackup(loadLink())).toBe(true)
    await expect(runBackup(a, account)).resolves.toMatchObject({ status: 'uploaded' })
    expect(changedSinceBackup(loadLink())).toBe(false)
  })

  it('a change that is undone still triggers a check, which uploads nothing and settles the counter', async () => {
    const sold = await seedGym()
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    const renamed = await updateMember(sold.member.id, sold.member.rev, { name: 'Someone Else', phone: '9820012345', joiningDate: today })
    await updateMember(renamed.id, renamed.rev, { name: 'Rahul Patil', phone: '9820012345', joiningDate: today })
    expect(changedSinceBackup(loadLink())).toBe(true)
    const uploads = drive.uploads()
    // The member's own revision number moved, so this is a real difference and is uploaded once.
    await runBackup(a, account)
    expect(changedSinceBackup(loadLink())).toBe(false)
    await expect(runBackup(a, account)).resolves.toMatchObject({ status: 'unchanged' })
    expect(drive.uploads()).toBe(uploads + 1)
  })

  it('a link saved before the counter existed gives no answer, so the caller compares the data instead', () => {
    saveLink({ accountId: A.id, email: A.email, auto: true, lastBackupHash: 'abc' })
    expect(changedSinceBackup(loadLink())).toBeUndefined()
    saveLink({ accountId: A.id, email: A.email, auto: true })
    expect(changedSinceBackup(loadLink())).toBe(true)
  })

  it('a restore that was read back and matches leaves nothing to back up', async () => {
    await seedGym('In Drive')
    const a = clientFor('token-a')
    const account = await a.account()
    await runBackup(a, account)
    await freshDatabase()
    clearLink()
    const preview = await loadRemoteBackup(a, (await findRemoteBackup(a, null))!)
    await restoreFromDrive(account, preview, () => undefined, a)
    expect(changedSinceBackup(loadLink())).toBe(false)
    await createMember({ name: 'After Restore', phone: '9811100009', joiningDate: today })
    expect(changedSinceBackup(loadLink())).toBe(true)
  })
})

describe('reminders and remembered state', () => {
  it('a backup is overdue only when the data changed, automatic backup is on and a day has passed', () => {
    const now = new Date('2026-11-08T10:00:00.000Z')
    const link = { accountId: 'a', email: 'a@example.com', auto: true, lastBackupAt: '2026-11-07T09:59:59.000Z' }
    expect(isBackupOverdue(link, true, now)).toBe(true)
    expect(isBackupOverdue({ ...link, lastBackupAt: '2026-11-07T10:00:01.000Z' }, true, now)).toBe(false)
    expect(isBackupOverdue(link, false, now)).toBe(false)
    expect(isBackupOverdue({ ...link, auto: false }, true, now)).toBe(false)
    expect(isBackupOverdue(null, true, now)).toBe(false)
    expect(isBackupOverdue({ ...link, lastBackupAt: undefined }, true, now)).toBe(true)
  })
  it('damaged remembered state is ignored instead of crashing', () => {
    localStorage.setItem('gymbook-drive-link', '{ nope')
    expect(loadLink()).toBeNull()
    localStorage.setItem('gymbook-drive-link', JSON.stringify({ email: 'x@example.com' }))
    expect(loadLink()).toBeNull()
    localStorage.setItem('gymbook-drive-link', JSON.stringify({ accountId: 'a', email: 'x@example.com' }))
    expect(loadLink()).toEqual({ accountId: 'a', email: 'x@example.com', auto: true })
  })
})
