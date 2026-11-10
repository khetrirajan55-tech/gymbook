import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { closeDb, getDb } from './db'
import { createMember, setMemberArchived, setMemberPhoto, updateMember, listMembers, getMember } from './services/members'
import { createPlan } from './services/plans'
import { assignMembership, createMemberWithMembership } from './services/memberships'
import { recordPayment, listInvoices, listPayments, listAdjustments, voidPayment, voidInvoice, addAdjustment } from './services/payments'
import { checkIn, checkOut, listAttendanceForMember, MembershipRequiredError } from './services/attendance'
import { invoiceBalance, memberBalance } from '@/domain/membership'
import { exportBackup, validateBackup, importBackup } from './backup'
import { seedSampleData, removeSampleRecords } from './sample'
import { armSaveFailure } from './failpoint'
import { StorageError } from './errors'

const TZ = 'Asia/Kolkata'
const today = '2026-10-28'

beforeEach(async () => {
  await closeDb()
  indexedDB = new IDBFactory()
  await getDb()
})

async function memberAndPlan() {
  const member = await createMember({ name: 'Test Person', phone: '9876543210', joiningDate: today })
  const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
  return { member, plan }
}

describe('membership sale → partial payment → settle → invoice', () => {
  it('creates membership, invoice and payments transactionally and derives balance', async () => {
    const { member, plan } = await memberAndPlan()
    const sale = await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 10000, initialPaymentPaise: 50000, paymentMethod: 'upi' })
    expect(sale.membership.endDate).toBe('2026-11-27')
    expect(sale.invoiceNumber).toBe('RK-00001')
    expect(sale.membership.pricePaise).toBe(140000)
    const inv = (await listInvoices())[0]
    expect(inv.totalPaise).toBe(140000)
    let bal = invoiceBalance(inv, await listPayments(), await listAdjustments())
    expect(bal.status).toBe('partial')
    expect(bal.balancePaise).toBe(90000)

    await expect(recordPayment({ memberId: member.id, invoiceId: inv.id, amountPaise: 100000, method: 'cash', receivedAt: new Date().toISOString() })).rejects.toThrow(/outstanding/)

    await recordPayment({ memberId: member.id, invoiceId: inv.id, amountPaise: 90000, method: 'cash', receivedAt: new Date().toISOString() })
    bal = invoiceBalance(inv, await listPayments(), await listAdjustments())
    expect(bal.status).toBe('paid')
    expect(bal.balancePaise).toBe(0)
    expect(memberBalance(await listInvoices(), await listPayments(), await listAdjustments()).balancePaise).toBe(0)
  })

  it('allocates invoice numbers sequentially and never reuses them', async () => {
    const { member, plan } = await memberAndPlan()
    const a = await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    const b = await assignMembership({ memberId: member.id, planId: plan.id, startDate: '2026-11-28', discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash', renewalOfId: a.membership.id })
    expect(a.invoiceNumber).toBe('RK-00001')
    expect(b.invoiceNumber).toBe('RK-00002')
    expect(b.membership.startDate).toBe('2026-11-28')
    expect(b.membership.endDate).toBe('2026-12-27')
    expect(b.membership.renewalOfId).toBe(a.membership.id)
  })

  it('snapshots plan details so later plan edits do not change the sale', async () => {
    const { member, plan } = await memberAndPlan()
    const sale = await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    const { updatePlan } = await import('./services/plans')
    await updatePlan(plan.id, plan.rev, { name: 'Monthly Plus', durationValue: 2, durationUnit: 'months', price: 250000 })
    expect(sale.membership.planName).toBe('Monthly')
    expect(sale.membership.listPricePaise).toBe(150000)
  })

  it('idempotency key prevents double submission', async () => {
    const { member, plan } = await memberAndPlan()
    const key = 'req-1'
    const [a, b] = await Promise.all([
      assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash', requestKey: key }),
      assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash', requestKey: key }),
    ])
    expect(a.invoiceId).toBe(b.invoiceId)
    expect((await listInvoices()).length).toBe(1)
  })

  it('void and adjustments keep history', async () => {
    const { member, plan } = await memberAndPlan()
    const sale = await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 50000, paymentMethod: 'cash' })
    const pay = sale.payment!
    await voidPayment(pay.id, pay.rev, 'entered twice')
    const payments = await listPayments()
    expect(payments.length).toBe(1)
    expect(payments[0].status).toBe('void')
    await addAdjustment({ invoiceId: sale.invoiceId, amountPaise: -50000, reason: 'goodwill' })
    const bal = invoiceBalance((await listInvoices())[0], payments, await listAdjustments())
    expect(bal.duePaise).toBe(100000)
    expect(bal.balancePaise).toBe(100000)
  })
})

describe('attendance', () => {
  it('rejects duplicate open check-ins and expired memberships, allows override with reason', async () => {
    const { member, plan } = await memberAndPlan()
    await expect(checkIn({ memberId: member.id, today })).rejects.toBeInstanceOf(MembershipRequiredError)
    const forced = await checkIn({ memberId: member.id, today, overrideReason: 'owner approved' })
    expect(forced.overrideReason).toBe('owner approved')
    await checkOut(forced.id, forced.rev)
    await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    const visit = await checkIn({ memberId: member.id, today })
    expect(visit.overrideReason).toBeUndefined()
    await expect(checkIn({ memberId: member.id, today })).rejects.toThrow(/already checked in/)
    const out = await checkOut(visit.id, visit.rev)
    expect(out.checkOutAt).toBeTruthy()
    await expect(checkOut(visit.id, visit.rev)).rejects.toBeInstanceOf(StorageError) // stale rev → conflict
    expect((await listAttendanceForMember(member.id)).length).toBe(2)
  })
})

describe('archive keeps history', () => {
  it('archives without deleting invoices/payments', async () => {
    const { member, plan } = await memberAndPlan()
    await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 150000, paymentMethod: 'cash' })
    const m = (await getMember(member.id))!
    const archived = await setMemberArchived(m.id, m.rev, true)
    expect(archived.status).toBe('archived')
    expect((await listInvoices()).length).toBe(1)
    expect((await listPayments()).length).toBe(1)
    await expect(assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })).rejects.toThrow(/Restore/)
  })
})

describe('member photo', () => {
  it('sets and clears only the photo, checks the revision and refuses anything that is not a small image', async () => {
    const m = await createMember({ name: 'Photo Person', phone: '9876500000', joiningDate: today, notes: 'keep me' })
    const photo = 'data:image/jpeg;base64,/9j/4AAQ'
    const withPhoto = await setMemberPhoto(m.id, m.rev, photo)
    expect(withPhoto).toMatchObject({ photoDataUrl: photo, notes: 'keep me', name: 'Photo Person', rev: m.rev + 1 })
    await expect(setMemberPhoto(m.id, m.rev, photo)).rejects.toThrow()
    await expect(setMemberPhoto(m.id, withPhoto.rev, 'https://example.com/a.jpg')).rejects.toThrow(/image/)
    await expect(setMemberPhoto(m.id, withPhoto.rev, 'data:image/jpeg;base64,' + 'A'.repeat(400_000))).rejects.toThrow(/large/)
    const cleared = await setMemberPhoto(m.id, withPhoto.rev, undefined)
    expect(cleared.photoDataUrl).toBeUndefined()
    expect((await getMember(m.id))?.notes).toBe('keep me')
  })
})

describe('concurrency', () => {
  it('refuses writes based on a stale revision (simulates another tab)', async () => {
    const { member } = await memberAndPlan()
    await updateMember(member.id, member.rev, { name: 'Tab A', phone: member.phone, joiningDate: today })
    await expect(updateMember(member.id, member.rev, { name: 'Tab B', phone: member.phone, joiningDate: today })).rejects.toMatchObject({ kind: 'conflict' })
    expect((await getMember(member.id))!.name).toBe('Tab A')
  })
})

describe('failure handling', () => {
  it('a simulated storage failure writes nothing', async () => {
    const { member, plan } = await memberAndPlan()
    armSaveFailure()
    await expect(assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })).rejects.toMatchObject({ kind: 'simulated' })
    expect((await listInvoices()).length).toBe(0)
    const ok = await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    expect(ok.invoiceNumber).toBe('RK-00001')
  })
})

describe('backup', () => {
  it('round-trips and rejects invalid files without touching data', async () => {
    const { member, plan } = await memberAndPlan()
    await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    const backup = await exportBackup()
    const bad = validateBackup('{"format":"gymbook-backup","version":1,"exportedAt":"x","data":{}}')
    expect(bad.ok).toBe(false)
    const broken = structuredClone(backup)
    broken.data.payments.push({ ...broken.data.invoices[0], id: 'pay_x', memberId: 'missing', amountPaise: 100, method: 'cash', receivedAt: 'x', status: 'recorded' } as never)
    const brokenPreview = validateBackup(JSON.stringify(broken))
    expect(brokenPreview.ok).toBe(false)
    expect(brokenPreview.errors.join(' ')).toMatch(/missing member/)
    expect((await listMembers()).length).toBe(1)

    await createMember({ name: 'Extra', phone: '9999999999', joiningDate: today })
    expect((await listMembers()).length).toBe(2)
    const good = validateBackup(JSON.stringify(backup))
    expect(good.ok).toBe(true)
    await importBackup(good.backup!)
    expect((await listMembers()).length).toBe(1)
    const next = await assignMembership({ memberId: member.id, planId: plan.id, startDate: '2026-11-28', discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    expect(next.invoiceNumber).toBe('RK-00002')
  })
})

describe('sample data', () => {
  it('seeds labelled records and removes only them', async () => {
    await createMember({ name: 'Real Person', phone: '9123456789', joiningDate: today })
    await seedSampleData(TZ)
    const all = await listMembers()
    expect(all.filter((m) => m.sample).length).toBeGreaterThan(5)
    const invoices = await listInvoices()
    expect(new Set(invoices.map((i) => i.number)).size).toBe(invoices.length)
    const removed = await removeSampleRecords()
    expect(removed).toBeGreaterThan(0)
    const after = await listMembers()
    expect(after.length).toBe(1)
    expect(after[0].name).toBe('Real Person')
  })
})

describe('voiding an invoice cancels its membership', () => {
  it('marks the membership cancelled, hides it from current/renewal logic and blocks check-in', async () => {
    const { member, plan } = await memberAndPlan()
    const sale = await assignMembership({ memberId: member.id, planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    const inv = (await listInvoices())[0]
    await voidInvoice(inv.id, inv.rev, 'sold by mistake')
    const { listMembershipsForMember } = await import('./services/memberships')
    const { pickCurrentMembership, membershipState } = await import('@/domain/membership')
    const list = await listMembershipsForMember(member.id)
    expect(list).toHaveLength(1)
    expect(list[0].cancelledAt).toBeTruthy()
    expect(list[0].rev).toBe(sale.membership.rev + 1)
    expect(membershipState(list[0], today)).toBe('cancelled')
    expect(pickCurrentMembership(list, today)).toBeUndefined()
    await expect(checkIn({ memberId: member.id, today })).rejects.toBeInstanceOf(MembershipRequiredError)
  })
})

describe('member codes, measurements and workouts', () => {
  it('assigns sequential member codes and finds members by code', async () => {
    const a = await createMember({ name: 'Code One', phone: '9000000001', joiningDate: today })
    const b = await createMember({ name: 'Code Two', phone: '9000000002', joiningDate: today })
    expect(a.memberCode).toBe('GB-0001')
    expect(b.memberCode).toBe('GB-0002')
    const { filterMembers } = await import('@/components/domain/MemberPicker')
    expect(filterMembers([{ member: a }, { member: b }], 'gb-0002').map((r) => r.member.name)).toEqual(['Code Two'])
    expect(filterMembers([{ member: a }, { member: b }], 'GB0001').map((r) => r.member.name)).toEqual(['Code One'])
  })

  it('copies a library template and assigns it to a member', async () => {
    const { createWorkoutFromTemplate, assignWorkout, listWorkouts, setWorkoutArchived } = await import('./services/workouts')
    const m = await createMember({ name: 'Plan Person', phone: '9000000005', joiningDate: today })
    const w = await createWorkoutFromTemplate('beginner-full-body')
    expect(w.source).toBe('library')
    expect(w.days.length).toBe(3)
    await assignWorkout(m.id, m.rev, w.id)
    expect((await getMember(m.id))!.workoutPlanId).toBe(w.id)
    const archived = await setWorkoutArchived(w.id, w.rev, true)
    const m2 = (await getMember(m.id))!
    await expect(assignWorkout(m2.id, m2.rev, archived.id)).rejects.toThrow(/archived/)
    expect((await listWorkouts()).length).toBe(1)
  })

  it('stores height and weight, updates them and clears them', async () => {
    const m = await createMember({ name: 'Measured Person', phone: '9000000006', joiningDate: today, heightCm: 172, weightKg: 68.5 })
    expect(m.heightCm).toBe(172)
    expect(m.weightKg).toBe(68.5)
    const next = await updateMember(m.id, m.rev, { name: m.name, phone: m.phone, joiningDate: today, heightCm: 173, weightKg: undefined })
    expect(next.heightCm).toBe(173)
    expect(next.weightKg).toBeUndefined()
    const b = await exportBackup()
    const preview = validateBackup(JSON.stringify(b))
    expect(preview.ok).toBe(true)
    await importBackup(preview.backup!)
    expect((await getMember(m.id))!.heightCm).toBe(173)
  })

  it('editing a member made by an earlier version keeps its email, trainer and emergency contact', async () => {
    const m = await createMember({ name: 'Older Record', phone: '9000000007', joiningDate: today })
    const db = await getDb()
    await db.put('members', { ...m, email: 'old@example.com', trainerId: 'tr_old', emergencyName: 'Kin', emergencyPhone: '98200 00009' })
    const next = await updateMember(m.id, m.rev, { name: 'Older Record Edited', phone: m.phone, joiningDate: today, heightCm: 180 })
    expect(next).toMatchObject({ name: 'Older Record Edited', heightCm: 180, email: 'old@example.com', trainerId: 'tr_old', emergencyName: 'Kin', emergencyPhone: '98200 00009' })
  })

  it('records of removed sections survive a backup round trip', async () => {
    const { createWorkoutFromTemplate } = await import('./services/workouts')
    const stamp = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', rev: 1 }
    const db = await getDb()
    await db.put('equipment', { ...stamp, id: 'eq_1', name: 'Rack', category: 'Strength', status: 'ok', archived: false })
    await db.put('expenses', { ...stamp, id: 'exp_1', date: today, category: 'rent', amountPaise: 4500000, method: 'bank' })
    await db.put('trainers', { ...stamp, id: 'tr_1', name: 'Coach', phone: '9000000010', specialty: 'Strength', status: 'active' })
    await createWorkoutFromTemplate('fat-loss-circuit')
    const b = await exportBackup()
    expect(b.data.equipment.length).toBe(1)
    expect(b.data.expenses.length).toBe(1)
    expect(b.data.trainers.length).toBe(1)
    expect(b.data.workouts.length).toBe(1)
    const preview = validateBackup(JSON.stringify(b))
    expect(preview.ok).toBe(true)
    await importBackup(preview.backup!)
    const again = await exportBackup()
    expect(again.data.equipment[0].name).toBe('Rack')
    expect(again.data.expenses[0].amountPaise).toBe(4500000)
    expect(again.data.trainers[0].name).toBe('Coach')
    expect(again.data.workouts[0].name).toBe('Fat-loss circuits')
  })
})

describe('add member with a plan in one step', () => {
  const person = { name: 'Walk In', phone: '9811122233', joiningDate: today }
  const countOf = async (store: 'members' | 'memberships' | 'invoices' | 'payments') => (await (await getDb()).getAll(store)).length

  it('creates the member, membership, invoice and first payment together', async () => {
    const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
    const r = await createMemberWithMembership(person, { planId: plan.id, startDate: today, discountPaise: 10000, initialPaymentPaise: 50000, paymentMethod: 'upi', issueDate: today })
    expect(r.member.memberCode).toBe('GB-0001')
    expect(r.membership).toMatchObject({ memberId: r.member.id, planName: 'Monthly', startDate: today, endDate: '2026-11-27', pricePaise: 140000 })
    expect(r.membership.renewalOfId).toBeUndefined()
    expect(r.invoiceNumber).toBe('RK-00001')
    expect(r.payment).toMatchObject({ memberId: r.member.id, amountPaise: 50000, method: 'upi', status: 'recorded' })
    const inv = (await listInvoices())[0]
    expect(inv).toMatchObject({ memberId: r.member.id, issueDate: today, totalPaise: 140000 })
    expect(invoiceBalance(inv, await listPayments(), await listAdjustments()).balancePaise).toBe(90000)
    expect((await getMember(r.member.id))?.name).toBe('Walk In')
  })

  it('a refused sale saves nothing: no member, no invoice number used', async () => {
    const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
    await expect(createMemberWithMembership(person, { planId: plan.id, startDate: today, discountPaise: 200000, initialPaymentPaise: 0, paymentMethod: 'cash' })).rejects.toThrow(/Discount must be between/)
    await expect(createMemberWithMembership(person, { planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 150001, paymentMethod: 'cash' })).rejects.toThrow(/Initial payment cannot exceed/)
    await expect(createMemberWithMembership(person, { planId: 'plan_missing', startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })).rejects.toThrow(/Plan not found/)
    expect(await countOf('members')).toBe(0)
    expect(await countOf('memberships')).toBe(0)
    expect(await countOf('invoices')).toBe(0)
    // the next successful save still gets the first member code and invoice number
    const ok = await createMemberWithMembership(person, { planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    expect(ok.member.memberCode).toBe('GB-0001')
    expect(ok.invoiceNumber).toBe('RK-00001')
    expect(ok.payment).toBeUndefined()
    expect(await countOf('payments')).toBe(0)
  })

  it('a double submit with the same request key writes once', async () => {
    const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
    const sale = { planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' as const }
    const [a, b] = await Promise.all([createMemberWithMembership(person, sale, { requestKey: 'k1' }), createMemberWithMembership(person, sale, { requestKey: 'k1' })])
    expect(a.member.id).toBe(b.member.id)
    expect(await countOf('members')).toBe(1)
    expect(await countOf('memberships')).toBe(1)
    expect(await countOf('invoices')).toBe(1)
  })

  it('a storage failure leaves nothing behind and can be retried', async () => {
    const plan = await createPlan({ name: 'Monthly', durationValue: 1, durationUnit: 'months', price: 150000 })
    armSaveFailure()
    await expect(createMemberWithMembership(person, { planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })).rejects.toMatchObject({ kind: 'simulated' })
    expect(await countOf('members')).toBe(0)
    const ok = await createMemberWithMembership(person, { planId: plan.id, startDate: today, discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    expect(ok.invoiceNumber).toBe('RK-00001')
  })
})
