import { readTx, writeTx } from '../db'
import { logActivity, stampNew, updateRecord, withIdempotency, type AnyWriteTx } from '../repo'
import type { Member } from '@/domain/types'
import type { MemberFormValues } from '@/domain/validation'
import { normalizePhone } from '@/domain/validation'
import { nowIso } from '@/domain/ids'
import { DomainError } from '../errors'
import { preparePhoto, putPhotoInTx, type PreparedPhoto } from './photos'

export async function listMembers(): Promise<Member[]> {
  return readTx(['members'], (tx) => tx.objectStore('members').getAll())
}

export async function getMember(id: string): Promise<Member | undefined> {
  return readTx(['members'], (tx) => tx.objectStore('members').get(id))
}

/** Members sharing a normalised phone or an exact name; informational, never blocking. */
export function findPossibleDuplicates(all: Member[], values: { phone: string; name?: string }, excludeId?: string): Member[] {
  const phone = normalizePhone(values.phone)
  const name = values.name?.trim().toLowerCase()
  return all.filter((m) => {
    if (m.id === excludeId) return false
    if (m.status === 'archived' && !phone) return false
    if (phone && normalizePhone(m.phone) === phone) return true
    if (name && name.length > 3 && m.name.trim().toLowerCase() === name) return true
    return false
  })
}

/**
 * Insert a member inside the caller's transaction (needs the members, photos, counters and activity
 * stores). `photo` is the picture from the form, prepared beforehand with `preparePhoto`.
 */
export async function insertMember(tx: AnyWriteTx, values: MemberFormValues, photo?: PreparedPhoto): Promise<Member> {
  const counters = tx.objectStore('counters')
  const next = ((await counters.get('member'))?.value ?? 0) + 1
  await counters.put({ key: 'member', value: next })
  const member = stampNew<Omit<Member, keyof import('@/domain/types').BaseRecord>>('mem', {
    name: values.name,
    phone: values.phone,
    joiningDate: values.joiningDate,
    status: 'active',
    notes: values.notes,
    photoDataUrl: photo?.thumb,
    photoHash: photo?.hash,
    memberCode: `GB-${String(next).padStart(4, '0')}`,
    dateOfBirth: values.dateOfBirth,
    gender: values.gender,
    heightCm: values.heightCm,
    weightKg: values.weightKg,
    goal: values.goal,
    healthNotes: values.healthNotes,
  })
  await tx.objectStore('members').put(member)
  if (photo) await putPhotoInTx(tx, member.id, photo)
  await logActivity(tx, { kind: 'member', message: `Added member ${member.name}`, memberId: member.id, refType: 'member', refId: member.id })
  return member
}

export async function createMember(values: MemberFormValues, opts: { requestKey?: string } = {}): Promise<Member> {
  const photo = values.photoDataUrl ? await preparePhoto(values.photoDataUrl) : undefined
  return withIdempotency(opts.requestKey, () => writeTx(['members', 'photos', 'counters', 'activity'], (tx) => insertMember(tx as unknown as AnyWriteTx, values, photo)))
}

export async function updateMember(id: string, expectedRev: number, values: MemberFormValues): Promise<Member> {
  // The form hands back the thumbnail it was given when the photo was left alone; anything else is a new picture.
  const before = await getMember(id)
  const photoChanged = values.photoDataUrl !== before?.photoDataUrl
  const photo = photoChanged && values.photoDataUrl ? await preparePhoto(values.photoDataUrl) : undefined
  return writeTx(['members', 'photos', 'activity'], async (tx) => {
    if (photoChanged) await putPhotoInTx(tx as unknown as AnyWriteTx, id, photo)
    const next = await updateRecord(tx, 'members', id, expectedRev, (m) => ({
      ...m,
      name: values.name,
      phone: values.phone,
      joiningDate: values.joiningDate,
      notes: values.notes,
      photoDataUrl: photoChanged ? photo?.thumb : m.photoDataUrl,
      photoHash: photoChanged ? photo?.hash : m.photoHash,
      dateOfBirth: values.dateOfBirth,
      gender: values.gender,
      heightCm: values.heightCm,
      weightKg: values.weightKg,
      goal: values.goal,
      healthNotes: values.healthNotes,
    }))
    await logActivity(tx, { kind: 'member', message: `Updated member ${next.name}`, memberId: id, refType: 'member', refId: id })
    return next
  })
}

/** Set or clear just the photo, from the member's page. The same size limit as the form applies. */
export async function setMemberPhoto(id: string, expectedRev: number, photoDataUrl: string | undefined): Promise<Member> {
  if (photoDataUrl !== undefined && (!photoDataUrl.startsWith('data:image/') || photoDataUrl.length > 1_500_000)) {
    throw new DomainError('invalid-photo', 'Photo is too large or not an image; use a smaller image.')
  }
  const photo = photoDataUrl ? await preparePhoto(photoDataUrl) : undefined
  return writeTx(['members', 'photos', 'activity'], async (tx) => {
    const next = await updateRecord(tx, 'members', id, expectedRev, (m) => ({ ...m, photoDataUrl: photo?.thumb, photoHash: photo?.hash }))
    await putPhotoInTx(tx as unknown as AnyWriteTx, id, photo)
    await logActivity(tx, { kind: 'member', message: photoDataUrl ? `Changed photo of ${next.name}` : `Removed photo of ${next.name}`, memberId: id, refType: 'member', refId: id })
    return next
  })
}

export async function setMemberArchived(id: string, expectedRev: number, archived: boolean): Promise<Member> {
  return writeTx(['members', 'attendance', 'activity'], async (tx) => {
    if (archived) {
      const open = (await tx.objectStore('attendance').index('memberId').getAll(id)).some((a) => a.checkOutAt === null)
      if (open) throw new DomainError('open-checkin', 'This member is currently checked in. Check them out before archiving.')
    }
    const next = await updateRecord(tx, 'members', id, expectedRev, (m) => ({
      ...m,
      status: archived ? 'archived' : 'active',
      archivedAt: archived ? nowIso() : undefined,
    }))
    await logActivity(tx, {
      kind: 'member',
      message: archived ? `Archived member ${next.name}` : `Restored member ${next.name}`,
      memberId: id,
      refType: 'member',
      refId: id,
    })
    return next
  })
}
