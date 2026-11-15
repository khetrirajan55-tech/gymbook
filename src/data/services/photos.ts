import { readTx, writeTx } from '../db'
import type { AnyWriteTx } from '../repo'
import type { Member, MemberPhoto } from '@/domain/types'
import { makeThumb } from '@/lib/image'
import { sha256Hex } from '../drive/md5'
import { nowIso } from '@/domain/ids'

/**
 * Member photos are stored in two pieces. The member record carries a small thumbnail, which is all
 * a list or card needs; the full picture sits in the `photos` store and is read only when someone
 * opens it. Before this split every page loaded every full picture, which made a gym with a few
 * hundred photos slow to open, and every backup re-sent them all.
 */
export interface PreparedPhoto {
  thumb: string
  full: string
  hash: string
}

/** Work that cannot happen inside a database transaction (drawing, hashing), done before one. */
export async function preparePhoto(dataUrl: string): Promise<PreparedPhoto> {
  return { thumb: await makeThumb(dataUrl), full: dataUrl, hash: await sha256Hex(dataUrl) }
}

/** Store or remove a member's full picture inside the caller's transaction (which must include `photos`). */
export async function putPhotoInTx(tx: AnyWriteTx, memberId: string, photo: PreparedPhoto | undefined): Promise<void> {
  const store = tx.objectStore('photos')
  if (photo) await store.put({ id: memberId, dataUrl: photo.full, hash: photo.hash, updatedAt: nowIso() })
  else await store.delete(memberId)
}

/** The full picture, or the thumbnail when no full one was ever stored. */
export async function getMemberPhoto(member: Pick<Member, 'id' | 'photoDataUrl'>): Promise<string | undefined> {
  const full = await readTx(['photos'], (tx) => tx.objectStore('photos').get(member.id))
  return full?.dataUrl ?? member.photoDataUrl
}

export async function getPhotoRecord(memberId: string): Promise<MemberPhoto | undefined> {
  return readTx(['photos'], (tx) => tx.objectStore('photos').get(memberId))
}

let splitting: Promise<number> | null = null

/**
 * Move full pictures out of member records made before the split (or restored from an older backup):
 * each such member gets a thumbnail in the record and the original in the `photos` store. Safe to
 * call any time; it does nothing once every photo has been moved. Returns how many were moved.
 */
export function splitMemberPhotos(): Promise<number> {
  if (!splitting) splitting = doSplit().finally(() => { splitting = null })
  return splitting
}

async function doSplit(): Promise<number> {
  const pending = (await readTx(['members'], (tx) => tx.objectStore('members').getAll())).filter((m) => m.photoDataUrl && !m.photoHash)
  let moved = 0
  for (let i = 0; i < pending.length; i += 20) {
    const batch = await Promise.all(pending.slice(i, i + 20).map(async (m) => ({ m, photo: await preparePhoto(m.photoDataUrl!) })))
    await writeTx(['members', 'photos'], async (tx) => {
      for (const { m, photo } of batch) {
        const current = await tx.objectStore('members').get(m.id)
        // Changed since it was read: leave it for the next run rather than overwrite someone's edit.
        if (!current || current.rev !== m.rev || current.photoDataUrl !== m.photoDataUrl) continue
        await putPhotoInTx(tx as unknown as AnyWriteTx, m.id, photo)
        await tx.objectStore('members').put({ ...current, photoDataUrl: photo.thumb, photoHash: photo.hash })
        moved += 1
      }
    })
  }
  return moved
}
