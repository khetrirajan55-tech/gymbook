import { test, expect, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { onboard, createPlan, addMember, sellMembership, readStore } from '../helpers'
import { todayInTz, addDays, formatDate, membershipEndDate } from '../../src/domain/dates'
import { membershipMessage, invoiceMessage, expiryMessage } from '../../src/domain/whatsapp'

const TZ = 'Asia/Kolkata'

type MemberRec = {
  id: string
  name: string
  phone: string
  email?: string
  joiningDate: string
  status: string
  notes?: string
  photoDataUrl?: string
  heightCm?: number
  weightKg?: number
  trainerId?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
  rev: number
}

// ---------- console watcher (requirement 8) ----------
type ConsoleLog = { errors: string[] }
function watchConsole(page: Page): ConsoleLog {
  const log: ConsoleLog = { errors: [] }
  page.on('console', (msg) => {
    if (msg.type() === 'error') log.errors.push(`[console.error] ${msg.text()}`)
  })
  page.on('pageerror', (err) => log.errors.push(`[pageerror] ${err.message}`))
  return log
}
const base = test.extend<{ consoleLog: ConsoleLog }>({
  consoleLog: async ({ page }, use) => {
    const log = watchConsole(page)
    await use(log)
    expect(log.errors, 'browser console must be clean').toEqual([])
  },
})
const it = base

// ---------- helpers ----------
function makePng(w = 2, h = 2): Buffer {
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc32 = (buf: Buffer) => {
    let c = -1
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc((1 + w * 3) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3
      raw[o] = 200
      raw[o + 1] = 50
      raw[o + 2] = 50
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Seed many members straight into IndexedDB (same shape as createMember) and reload. */
async function seedMembers(page: Page, members: Partial<MemberRec>[] & { name: string; phone: string }[]) {
  await page.evaluate(
    (list) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('gymbook')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('members', 'readwrite')
          const os = tx.objectStore('members')
          const now = new Date().toISOString()
          list.forEach((m, i) => {
            os.put({
              id: `mem_seed_${String(i).padStart(3, '0')}`,
              createdAt: now,
              updatedAt: now,
              rev: 1,
              status: 'active',
              joiningDate: '2026-01-01',
              ...m,
            })
          })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    members,
  )
}

async function fillAdd(page: Page, v: { name?: string; phone?: string; height?: string; weight?: string; joiningDate?: string; notes?: string }) {
  if (v.name !== undefined) await page.getByLabel('Full name').fill(v.name)
  if (v.phone !== undefined) await page.getByLabel(/^Phone/).fill(v.phone)
  if (v.height !== undefined) await page.getByLabel('Height (cm)').fill(v.height)
  if (v.weight !== undefined) await page.getByLabel('Weight (kg)').fill(v.weight)
  if (v.joiningDate !== undefined) await page.getByLabel(/^Joining date/).fill(v.joiningDate)
  if (v.notes !== undefined) await page.getByLabel('Notes', { exact: true }).fill(v.notes)
}

async function submitAdd(page: Page) {
  await page.getByRole('button', { name: 'Add member' }).click()
}

// =====================================================================
// 1. Validation edge cases
// =====================================================================
test.describe('1. add-form validation', () => {
  it('empty name and empty phone are refused with alerts; nothing stored', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await submitAdd(page)
    const alerts = page.getByRole('alert')
    await expect(alerts.filter({ hasText: /at least 2 characters/ })).toBeVisible()
    await expect(alerts.filter({ hasText: /Phone number is required/ })).toBeVisible()
    await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(/^Phone/)).toHaveAttribute('aria-invalid', 'true')
    await expect(page).toHaveURL(/\/members\/new$/)
    expect(await readStore(page, 'members')).toHaveLength(0)
  })

  it('1-char name is refused', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'A', phone: '98200 00001' })
    await submitAdd(page)
    await expect(page.getByRole('alert').filter({ hasText: /at least 2 characters/ })).toBeVisible()
    expect(await readStore(page, 'members')).toHaveLength(0)
  })

  it('FIXED: 81-char name error leaks zod default message', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'N'.repeat(81), phone: '98200 00001' })
    await submitAdd(page)
    const alert = page.getByRole('alert').first()
    await expect(alert).toBeVisible()
    const text = (await alert.textContent()) ?? ''
    expect(await readStore(page, 'members')).toHaveLength(0)
    // BUG PROBE: zod default max() message leaks ("Too big: expected string to have <=80 characters")
    expect(text, `name-too-long error should be human readable, got: ${text}`).not.toMatch(/Too big|expected string/i)
  })

  it('exactly 80-char name is accepted and stored untrimmed-length', async ({ page }) => {
    await onboard(page, 'empty')
    const name = 'M'.repeat(80)
    await page.goto('/members/new')
    await fillAdd(page, { name, phone: '98200 00001' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    const [m] = await readStore<MemberRec>(page, 'members')
    expect(m.name).toBe(name)
  })

  it('emoji, Devanagari and apostrophe names are accepted and shown', async ({ page }) => {
    await onboard(page, 'empty')
    const names = ['Rahul 🏋️ Sharma', 'राहुल शर्मा', "D'Souza O'Brien"]
    for (const [i, name] of names.entries()) {
      await page.goto('/members/new')
      await fillAdd(page, { name, phone: `98200 0000${i + 1}` })
      await submitAdd(page)
      await expect(page).toHaveURL(/\/members\/mem_/)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
    }
    const stored = await readStore<MemberRec>(page, 'members')
    expect(stored.map((m) => m.name).sort()).toEqual([...names].sort())
    await page.goto('/members')
    for (const name of names) await expect(page.getByRole('link', { name })).toBeVisible()
  })

  it('phone formats: +91 accepted; short/letters/16+ digits refused', async ({ page }) => {
    await onboard(page, 'empty')
    const cases: { phone: string; ok: boolean; error?: RegExp }[] = [
      { phone: '+91 98100 00011', ok: true },
      { phone: '12345', ok: false, error: /valid phone|8 to 15 digits/ },
      { phone: 'abcdefghij', ok: false, error: /valid phone/ },
      { phone: '1234567890123456', ok: false, error: /8 to 15 digits/ },
    ]
    const failures: string[] = []
    for (const [i, c] of cases.entries()) {
      await page.goto('/members/new')
      await fillAdd(page, { name: `Phone Case ${i}`, phone: c.phone })
      await submitAdd(page)
      if (c.ok) {
        try {
          await expect(page).toHaveURL(/\/members\/mem_/, { timeout: 3000 })
        } catch {
          const txt = await page.getByRole('alert').allTextContents()
          failures.push(`"${c.phone}" expected to be accepted but got: ${txt.join(' | ')}`)
        }
      } else {
        try {
          await expect(page.getByRole('alert').filter({ hasText: c.error! })).toBeVisible({ timeout: 3000 })
          await expect(page).toHaveURL(/\/members\/new$/)
        } catch {
          failures.push(`"${c.phone}" expected error ${c.error} but url=${page.url()} alerts=${(await page.getByRole('alert').allTextContents()).join(' | ')}`)
        }
      }
    }
    const stored = await readStore<MemberRec>(page, 'members')
    const storedPhones = stored.map((m) => m.phone).sort()
    expect(failures, failures.join('\n')).toEqual([])
    expect(storedPhones).toEqual(cases.filter((c) => c.ok).map((c) => c.phone).sort())
  })

  it('FIXED: phone starting with a parenthesis "(0120) 4567890" is refused', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Landline Person', phone: '(0120) 4567890' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/, { timeout: 3000 })
    expect((await readStore<MemberRec>(page, 'members'))[0].phone).toBe('(0120) 4567890')
  })

  it('height and weight: bad values refused, blank stored as undefined, good values stored as numbers', async ({ page }) => {
    await onboard(page, 'empty')
    const bad: [string, string, RegExp][] = [
      ['abc', '', /Enter a number in cm, like 172/],
      ["5'8", '', /Enter a number in cm, like 172/],
      ['172cm', '', /Enter a number in cm, like 172/],
      ['-172', '', /Enter a number in cm, like 172/],
      ['49', '', /Enter between 50 and 250 cm/],
      ['251', '', /Enter between 50 and 250 cm/],
      ['', '68.55', /Enter a number in kg, like 68\.5/],
      ['', '19', /Enter between 20 and 300 kg/],
      ['', '301', /Enter between 20 and 300 kg/],
    ]
    for (const [height, weight, message] of bad) {
      await page.goto('/members/new')
      await fillAdd(page, { name: 'Measure Case', phone: '98200 00001', height, weight })
      await submitAdd(page)
      const alerts = await page.getByRole('alert').allTextContents()
      expect(alerts.join(' | '), `height "${height}" weight "${weight}" should be refused`).toMatch(message)
      await expect(page).toHaveURL(/\/members\/new$/)
    }
    expect(await readStore(page, 'members')).toHaveLength(0)
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Blank Measures', phone: '98200 00002', height: '   ', weight: '' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Edge Measures', phone: '98200 00003', height: ' 250 ', weight: '20.0' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    await expect(page.getByRole('main')).toContainText('250 cm')
    await expect(page.getByRole('main')).toContainText('20 kg')
    const stored = await readStore<MemberRec>(page, 'members')
    const blank = stored.find((m) => m.name === 'Blank Measures')!
    expect(blank.heightCm).toBeUndefined()
    expect(blank.weightKg).toBeUndefined()
    const edge = stored.find((m) => m.name === 'Edge Measures')!
    expect(edge.heightCm).toBe(250)
    expect(edge.weightKg).toBe(20)
  })

  it('FIXED: joining date far in the future / far past is accepted', async ({ page }) => {
    await onboard(page, 'empty')
    const results: Record<string, string> = {}
    for (const [i, date] of ['2999-12-31', '1900-01-01'].entries()) {
      await page.goto('/members/new')
      await fillAdd(page, { name: `Date Case ${i}`, phone: `98200 0000${i + 1}`, joiningDate: date })
      await expect(page.getByLabel(/^Joining date/)).toHaveValue(date)
      await submitAdd(page)
      const accepted = await page
        .waitForURL(/\/members\/mem_/, { timeout: 3000 })
        .then(() => true)
        .catch(() => false)
      results[date] = accepted ? 'accepted' : `refused: ${(await page.getByRole('alert').allTextContents()).join(' | ')}`
    }
    const stored = await readStore<MemberRec>(page, 'members')
    // BUG PROBE: a joining date 970 years in the future or 126 years in the past should not be accepted silently.
    expect(results, `joining date bounds: ${JSON.stringify(results)} stored=${stored.map((m) => m.joiningDate)}`).toEqual({ '2999-12-31': expect.stringMatching(/^refused/), '1900-01-01': expect.stringMatching(/^refused/) })
  })

  it('FIXED: 1200-char note error leaks zod default message', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Long Note', phone: '98200 00001', notes: 'x'.repeat(1200) })
    await submitAdd(page)
    const alert = page.getByRole('alert').first()
    await expect(alert).toBeVisible()
    const text = (await alert.textContent()) ?? ''
    expect(await readStore(page, 'members')).toHaveLength(0)
    expect(text, `notes-too-long error should be human readable, got: ${text}`).not.toMatch(/Too big|expected string/i)
  })
})

// =====================================================================
// 2. Duplicate detection
// =====================================================================
test.describe('2. duplicate detection', () => {
  it('phone with spaces / +91 prefix and same name warn but allow save', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Original Person', phone: '9820000011' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)

    const probe = async (label: string, v: { name: string; phone: string }) => {
      await page.goto('/members/new')
      await fillAdd(page, v)
      const banner = page.getByText('Possible duplicate')
      await expect(banner, `${label} should warn`).toBeVisible()
      await expect(page.getByRole('link', { name: 'Original Person' })).toBeVisible()
      await submitAdd(page)
      await expect(page, `${label} should still save`).toHaveURL(/\/members\/mem_/)
    }
    await probe('spaced phone', { name: 'Dup One', phone: '98200 00011' })
    await probe('+91 phone', { name: 'Dup Two', phone: '+91 98200 00011' })
    await probe('same name', { name: 'original person', phone: '98200 00098' })

    const stored = await readStore<MemberRec>(page, 'members')
    expect(stored).toHaveLength(4)
    // a totally different person must not warn
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Unrelated', phone: '91111 11111' })
    await expect(page.getByText('Possible duplicate')).toHaveCount(0)
  })
})

// =====================================================================
// 3. Photo upload
// =====================================================================
test.describe('3. photo upload', () => {
  it('non-image shows an alert; a 2x2 PNG is stored as a data URL', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Photo Person', phone: '98200 00001' })
    const input = page.locator('input#member-photo')
    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByRole('alert').filter({ hasText: /Choose an image file/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upload photo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)

    await input.setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: makePng() })
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible()
    // previous non-image error should be cleared after a successful pick
    await expect(page.getByRole('alert').filter({ hasText: /Choose an image file/ })).toHaveCount(0)
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    const [m] = await readStore<MemberRec>(page, 'members')
    expect(m.photoDataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(m.photoDataUrl!.length).toBeLessThan(400_000)
    await expect(page.getByRole('main').locator('img').first()).toHaveAttribute('src', m.photoDataUrl!)

    // junk bytes claiming to be an image are refused and nothing is set
    await page.goto('/members/new')
    await input.setInputFiles({ name: 'junk.png', mimeType: 'image/png', buffer: Buffer.from('not a png at all') })
    await expect(page.getByRole('alert').filter({ hasText: /Could not read this image/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  })

  it('removing the photo on edit clears photoDataUrl', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Pic Remove', '98200 00002')
    await page.goto(url + '/edit')
    await page.locator('input#member-photo').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: makePng() })
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(url)
    expect((await readStore<MemberRec>(page, 'members'))[0].photoDataUrl).toMatch(/^data:image/)
    await page.goto(url + '/edit')
    await page.getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(url)
    expect((await readStore<MemberRec>(page, 'members'))[0].photoDataUrl).toBeUndefined()
  })
})

// =====================================================================
// 4. Edit flow
// =====================================================================
test.describe('4. edit flow', () => {
  it('change every field, save; stored values, updatedAt and rev move', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Before Edit', '98200 00001')
    const [before] = await readStore<MemberRec>(page, 'members')
    expect(before.rev).toBe(1)

    await page.goto(url + '/edit')
    await expect(page).toHaveTitle(/Edit Before Edit/)
    await page.getByLabel('Full name').fill('After Edit')
    await page.getByLabel(/^Phone/).fill('+91 98200 00002')
    await page.getByLabel('Height (cm)').fill('181.5')
    await page.getByLabel('Weight (kg)').fill('90')
    await page.getByLabel(/^Joining date/).fill('2026-02-15')
    await page.getByLabel('Notes', { exact: true }).fill('  Prefers mornings  ')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('status').filter({ hasText: 'Member updated' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('After Edit')
    await expect(page.getByText('Prefers mornings')).toBeVisible()
    await expect(page.getByRole('main')).toContainText('181.5 cm')
    await expect(page.getByRole('main')).toContainText('90 kg')

    const [after] = await readStore<MemberRec>(page, 'members')
    expect(after).toMatchObject({ id: before.id, name: 'After Edit', phone: '+91 98200 00002', heightCm: 181.5, weightKg: 90, joiningDate: '2026-02-15', notes: 'Prefers mornings', status: 'active' })
    expect(after.rev).toBe(2)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.updatedAt > before.updatedAt).toBe(true)
    const activity = await readStore<{ message: string }>(page, 'activity')
    expect(activity.some((a) => a.message === 'Updated member After Edit')).toBe(true)

    // Second edit bumps rev again
    await page.goto(url + '/edit')
    await page.getByLabel('Notes', { exact: true }).fill('Second edit')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(url)
    expect((await readStore<MemberRec>(page, 'members'))[0].rev).toBe(3)
  })

  it('Cancel with unsaved changes shows discard dialog; keep editing retains values', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Cancel Me', '98200 00003')
    await page.goto(url + '/edit')
    await page.getByLabel('Full name').fill('Cancel Me Changed')
    await page.getByRole('button', { name: 'Cancel' }).click()
    const guard = page.getByRole('dialog')
    await expect(guard.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible()
    await guard.getByRole('button', { name: 'Keep editing' }).click()
    await expect(guard).toBeHidden()
    await expect(page).toHaveURL(url + '/edit')
    await expect(page.getByLabel('Full name')).toHaveValue('Cancel Me Changed')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
    await expect(page).toHaveURL(url)
    expect((await readStore<MemberRec>(page, 'members'))[0].name).toBe('Cancel Me')
    expect((await readStore<MemberRec>(page, 'members'))[0].rev).toBe(1)
  })

  it('Cancel with no changes leaves without a dialog', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Clean Cancel', '98200 00004')
    await page.goto(url + '/edit')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  it('FIXED: browser back + Discard changes does not leave the page', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Back Direct', '98200 00006')
    await page.goto(url)
    await page.getByRole('link', { name: 'Edit' }).click()
    await expect(page).toHaveURL(url + '/edit')
    await page.getByLabel('Notes', { exact: true }).fill('typed but not saved')
    await page.goBack()
    const guard = page.getByRole('dialog')
    await expect(guard.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible()
    await guard.getByRole('button', { name: 'Discard changes' }).click()
    // BUG: dialog re-opens and the URL stays on /edit (DiscardGuard resets a stale blocker after proceed())
    await expect(page).toHaveURL(url)
    expect((await readStore<MemberRec>(page, 'members'))[0].notes).toBeUndefined()
  })

  it('FIXED: browser back + Keep editing + back + Discard does not leave the page', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Back Guard', '98200 00005')
    await page.goto(url)
    await page.getByRole('link', { name: 'Edit' }).click()
    await expect(page).toHaveURL(url + '/edit')
    await page.getByLabel('Notes', { exact: true }).fill('typed but not saved')
    await page.goBack()
    const guard = page.getByRole('dialog')
    await expect(guard.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible()
    await guard.getByRole('button', { name: 'Keep editing' }).click()
    await expect(page).toHaveURL(url + '/edit')
    await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('typed but not saved')
    await page.goBack()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
    await expect(page).toHaveURL(url)
    expect((await readStore<MemberRec>(page, 'members'))[0].notes).toBeUndefined()
  })

  it('edit form for a non-existent id shows not found', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/mem_does_not_exist/edit')
    await expect(page.getByText('Member not found')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to members' })).toBeVisible()
  })
})

// =====================================================================
// 5. List behaviour with 45 members
// =====================================================================
test.describe('5. list with 45 members', () => {
  const seed = () =>
    Array.from({ length: 45 }, (_, i) => ({
      name: `Member ${String(i + 1).padStart(2, '0')}`,
      phone: `9${String(100000000 + i * 7919).slice(0, 9)}`,
      email: i % 5 === 0 ? `m${i + 1}@example.com` : undefined,
      joiningDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      status: i >= 40 ? 'archived' : 'active',
    }))

  it('pagination boundaries and ?page= in URL', async ({ page }) => {
    await onboard(page, 'empty')
    await seedMembers(page, seed())
    await page.goto('/members')
    const main = page.getByRole('main')
    const tabAll = page.getByRole('tab', { name: /^All/ })
    await expect(tabAll).toContainText('40')
    await expect(page.getByRole('tab', { name: /^Archived/ })).toContainText('5')
    const pager = page.getByRole('navigation', { name: 'Pagination' })
    await expect(pager).toContainText('1–20 of 40')
    await expect(pager).toContainText('1 / 2')
    await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await expect(main.getByRole('link', { name: 'Member 01' })).toBeVisible()
    await expect(main.getByRole('link', { name: 'Member 20' })).toBeVisible()
    await expect(main.getByRole('link', { name: 'Member 21' })).toHaveCount(0)
    await expect(main.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(20)

    await pager.getByRole('button', { name: 'Next page' }).click()
    await expect(page).toHaveURL(/page=2/)
    await expect(pager).toContainText('21–40 of 40')
    await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled()
    await expect(main.getByRole('link', { name: 'Member 21' })).toBeVisible()
    await expect(main.getByRole('link', { name: 'Member 40' })).toBeVisible()
    await expect(main.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(20)

    // reload keeps page 2
    await page.reload()
    await expect(pager).toContainText('21–40 of 40')

    // out-of-range page is clamped
    await page.goto('/members?page=99')
    await expect(pager).toContainText('21–40 of 40')
    await page.goto('/members?page=0')
    await expect(pager).toContainText('1–20 of 40')
    await page.goto('/members?page=-3')
    await expect(pager).toContainText('1–20 of 40')
    await page.goto('/members?page=abc')
    await expect(pager).toContainText('1–20 of 40')

    // Changing the search resets the page
    await page.goto('/members?page=2')
    await page.getByLabel('Search name or phone').fill('Member')
    await expect(page).not.toHaveURL(/page=/)
    await expect(pager).toContainText('1–20 of 40')
  })

  it('search by partial phone digits and name; empty result state', async ({ page }) => {
    await onboard(page, 'empty')
    const data = seed()
    await seedMembers(page, data)
    await page.goto('/members')
    const search = page.getByLabel('Search name or phone')
    const main = page.getByRole('main')
    const pager = page.getByRole('navigation', { name: 'Pagination' })

    // partial phone digits of Member 03 (phone of index 2)
    const p3 = data[2].phone
    await search.fill(p3.slice(3, 8))
    await expect(page).toHaveURL(new RegExp(`q=${p3.slice(3, 8)}`))
    const expected = data.filter((m) => m.status === 'active' && m.phone.includes(p3.slice(3, 8)))
    await expect(main.getByRole('link', { name: 'Member 03' })).toBeVisible()
    await expect(pager).toContainText(`of ${expected.length}`)

    // phone typed with spaces/dashes still matches
    await search.fill(`${p3.slice(0, 5)} ${p3.slice(5)}`)
    await expect(main.getByRole('link', { name: 'Member 03' })).toBeVisible()
    await search.fill(`+91-${p3}`)
    await expect(main.getByRole('link', { name: 'Member 03' })).toBeVisible()

    // an email kept on a record from an earlier version is not searched any more
    await search.fill('M11@EXAMPLE')
    await expect(page.getByText('No members match')).toBeVisible()

    // empty result state
    await search.fill('zzzz-nobody')
    await expect(page.getByText('No members match')).toBeVisible()
    await expect(page.getByText(/Nothing matches “zzzz-nobody”/)).toBeVisible()
    await expect(pager).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(search).toHaveValue('')
    await expect(pager).toContainText('1–20 of 40')

    // search persists after reload
    await search.fill('Member 4')
    await page.reload()
    await expect(search).toHaveValue('Member 4')
    await expect(pager).toContainText('of 1') // only Member 40 (41–45 archived)
  })

  it('each filter tab count matches the list length; filter persists in URL after reload', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await createPlan(page, 'Short', 3, 'days', '300')
    await seedMembers(page, seed())
    // Give a few members real memberships / balances through the UI
    const members = await readStore<MemberRec>(page, 'members')
    const byName = (n: string) => members.find((m) => m.name === n)!
    await page.goto(`/members/${byName('Member 01').id}`)
    await sellMembership(page, { planLabel: /Monthly/, receivedNow: '1500' }) // active, paid
    await page.goto(`/members/${byName('Member 02').id}`)
    await sellMembership(page, { planLabel: /Monthly/, receivedNow: '500' }) // active, owing
    await page.goto(`/members/${byName('Member 03').id}`)
    await sellMembership(page, { planLabel: /Short/, receivedNow: '300' }) // expiring (3 days)

    await page.goto('/members')
    const pager = page.getByRole('navigation', { name: 'Pagination' })
    const tabs = ['All', 'Active', 'Expiring', 'Expired', 'No plan', 'Archived'] as const
    const mismatches: string[] = []
    for (const label of tabs) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${label}`) })
      const count = Number((await tab.textContent())!.replace(label, '').trim())
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      if (label === 'All') await expect(page).not.toHaveURL(/filter=/)
      else await expect(page).toHaveURL(new RegExp(`filter=${encodeURIComponent(label === 'No plan' ? 'none' : label.toLowerCase())}`))
      let listed = 0
      if (count === 0) {
        await expect(page.getByText('No members match')).toBeVisible()
      } else {
        const txt = await pager.locator('span').first().textContent()
        listed = Number(/of (\d+)/.exec(txt ?? '')?.[1])
      }
      if (listed !== count) mismatches.push(`${label}: tab says ${count}, list has ${listed}`)
    }
    expect(mismatches, mismatches.join('; ')).toEqual([])
    const tabCounts = Object.fromEntries(await Promise.all(tabs.map(async (l) => [l, Number((await page.getByRole('tab', { name: new RegExp(`^${l}`) }).textContent())!.replace(l, '').trim())])))
    expect(tabCounts).toEqual({ All: 40, Active: 3, Expiring: 1, Expired: 0, 'No plan': 37, Archived: 5 })

    // filter persists in URL after reload
    await page.goto('/members?filter=expiring')
    await page.reload()
    await expect(page).toHaveURL(/filter=expiring/)
    await expect(page.getByRole('tab', { name: /^Expiring/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('main').getByRole('link', { name: 'Member 03' })).toBeVisible()
    await expect(pager).toContainText('1–1 of 1')

    // unknown filter value does not crash
    await page.goto('/members?filter=bogus')
    await expect(pager).toContainText('of 40')
  })

  it('archived filter shows only archived members with a badge; archived never appear in other tabs', async ({ page }) => {
    await onboard(page, 'empty')
    await seedMembers(page, seed())
    await page.goto('/members?filter=archived')
    const main = page.getByRole('main')
    const pager = page.getByRole('navigation', { name: 'Pagination' })
    await expect(pager).toContainText('1–5 of 5')
    for (const n of [41, 42, 43, 44, 45]) await expect(main.getByRole('link', { name: `Member ${n}` })).toBeVisible()
    await expect(main.getByText('Archived', { exact: true })).toHaveCount(5)
    await page.goto('/members?filter=none')
    await expect(main.getByRole('link', { name: 'Member 41' })).toHaveCount(0)
    await page.goto('/members?q=Member%204')
    await expect(main.getByRole('link', { name: 'Member 40' })).toBeVisible()
    await expect(main.getByRole('link', { name: 'Member 41' })).toHaveCount(0)
    // searching within archived filter works
    await page.goto('/members?filter=archived&q=Member%2044')
    await expect(pager).toContainText('1–1 of 1')
  })

  it('sort directions: name, joined, via the Sort by control', async ({ page }) => {
    await onboard(page, 'empty')
    const data = seed()
    await seedMembers(page, data)
    await page.goto('/members')
    const main = page.getByRole('main')
    const cards = main.getByRole('list', { name: 'Members' }).getByRole('listitem')
    const names = async () => {
      await expect(cards.first()).toBeVisible()
      return cards.getByRole('heading').allTextContents()
    }
    const sortSel = page.getByLabel('Sort by')

    const first3 = () => expect.poll(async () => (await names()).slice(0, 3))
    await first3().toEqual(['Member 01', 'Member 02', 'Member 03'])
    await sortSel.selectOption('name:desc')
    await expect(page).toHaveURL(/sort=name&dir=desc|dir=desc/)
    await first3().toEqual(['Member 40', 'Member 39', 'Member 38'])

    const active = data.filter((m) => m.status === 'active')
    const byJoinAsc = [...active].sort((a, b) => a.joiningDate.localeCompare(b.joiningDate) || a.name.localeCompare(b.name))
    await sortSel.selectOption('joined:asc')
    await expect(page).toHaveURL(/sort=joined/)
    const joinDates = (list: string[]) => list.map((n) => active.find((m) => m.name === n)!.joiningDate)
    await expect.poll(async () => joinDates(await names())[0]).toBe(byJoinAsc[0].joiningDate)
    const jd = joinDates(await names())
    expect([...jd].sort()).toEqual(jd) // non-decreasing

    await sortSel.selectOption('joined:desc')
    await expect.poll(async () => joinDates(await names())[0]).toBe(byJoinAsc[byJoinAsc.length - 1].joiningDate)
    const jdDesc = joinDates(await names())
    expect([...jdDesc].sort().reverse()).toEqual(jdDesc)

    // back to the default order
    await sortSel.selectOption('name:asc')
    await expect(page).toHaveURL(/dir=asc/)
    await first3().toEqual(['Member 01', 'Member 02', 'Member 03'])

    // sort persists across reload and page param is dropped when sort changes
    await page.goto('/members?page=2')
    await sortSel.selectOption('name:desc')
    await expect(page).not.toHaveURL(/page=/)
    await page.reload()
    await expect(sortSel).toHaveValue('name:desc')
  })
})

// =====================================================================
// 6. Archive / restore and pickers
// =====================================================================
test.describe('6. archive and restore', () => {
  it('archive from detail, hidden from attendance/payment pickers, restore works', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Archie Veda', '98200 00001')
    await addMember(page, 'Stays Active', '98200 00002')
    await page.goto(url)
    await page.getByRole('button', { name: 'Archive' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Archive Archie Veda?' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Archive' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Member archived' })).toBeVisible()
    await expect(page.getByText('This member is archived')).toBeVisible()
    await expect(page.getByRole('button', { name: /Sell membership|Renew|Record payment|Check in/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible()
    let [m] = (await readStore<MemberRec>(page, 'members')).filter((x) => x.name === 'Archie Veda')
    expect(m.status).toBe('archived')
    expect(m.archivedAt).toBeTruthy()
    expect(m.rev).toBe(2)

    // list
    await page.goto('/members')
    await expect(page.getByRole('main').getByRole('link', { name: 'Archie Veda' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /^All/ })).toContainText('1')
    await expect(page.getByRole('tab', { name: /^Archived/ })).toContainText('1')

    // attendance picker
    await page.goto('/attendance')
    const box = page.getByRole('combobox')
    await box.fill('Archie')
    await expect(page.getByRole('listbox')).toContainText('No members match')
    await expect(page.getByRole('option', { name: /Archie/ })).toHaveCount(0)
    await box.fill('Stays')
    await expect(page.getByRole('option', { name: /Stays Active/ })).toBeVisible()

    // payments picker
    await page.goto('/payments')
    const pbox = page.getByRole('combobox', { name: 'Who paid? Search name or phone' })
    await pbox.fill('Archie')
    await expect(page.getByRole('option', { name: /Archie/ })).toHaveCount(0)
    await pbox.fill('98200 00001')
    await expect(page.getByRole('option', { name: /Archie/ })).toHaveCount(0)

    // restore
    await page.goto(url)
    await page.getByRole('button', { name: 'Restore' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Member restored' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sell membership' })).toBeVisible()
    ;[m] = (await readStore<MemberRec>(page, 'members')).filter((x) => x.name === 'Archie Veda')
    expect(m.status).toBe('active')
    expect(m.archivedAt).toBeUndefined()
    expect(m.rev).toBe(3)
    await page.goto('/attendance')
    await page.getByRole('combobox').fill('Archie')
    await expect(page.getByRole('option', { name: /Archie/ })).toBeVisible()
  })

  it('a checked-in member cannot be archived', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const url = await addMember(page, 'Inside Now', '98200 00003')
    await sellMembership(page, { receivedNow: '1500' })
    await page.goto(url)
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByText('In the gym now')).toBeVisible()
    await page.getByRole('button', { name: 'Archive' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Archive' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/currently checked in/)
    expect((await readStore<MemberRec>(page, 'members'))[0].status).toBe('active')
  })

  it('void payment and void invoice from the payments tab', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const url = await addMember(page, 'Void Case', '98200 00004')
    await sellMembership(page, { receivedNow: '500' })
    await page.goto(url + '?tab=payments')
    await expect(page.getByRole('tab', { name: /Payments & invoices/ })).toHaveAttribute('aria-selected', 'true')
    // void the payment first (invoice can only be voided when nothing is paid)
    await page.getByRole('button', { name: 'Void', exact: true }).last().click()
    let dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: /Void payment of ₹500.00/ })).toBeVisible()
    await dialog.getByLabel('Reason').fill('Entered twice')
    await dialog.getByRole('button', { name: 'Void' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Voided: Entered twice')).toBeVisible()
    const pays = await readStore<{ status: string; voidReason?: string }>(page, 'payments')
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ status: 'void', voidReason: 'Entered twice' })
    await expect(page.getByText('₹1,500.00').first()).toBeVisible()

    await page.getByRole('button', { name: 'Void', exact: true }).first().click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: /Void invoice RK-00001/ })).toBeVisible()
    await dialog.getByLabel('Reason').fill('Wrong plan')
    await dialog.getByRole('button', { name: 'Void' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Voided: Wrong plan')).toBeVisible()
    const inv = await readStore<{ status: string; voidReason?: string }>(page, 'invoices')
    expect(inv[0]).toMatchObject({ status: 'void', voidReason: 'Wrong plan' })
  })

  it('detail tabs switch with ?tab= and unknown tab does not crash', async ({ page }) => {
    await onboard(page, 'empty')
    const url = await addMember(page, 'Tab Person', '98200 00005')
    await page.goto(url)
    for (const [name, param] of [
      ['Memberships', 'memberships'],
      ['Attendance', 'attendance'],
      ['Payments & invoices', 'payments'],
    ] as const) {
      await page.getByRole('tab', { name: new RegExp(`^${name.replace('&', '&')}`) }).click()
      await expect(page).toHaveURL(new RegExp(`tab=${param}`))
    }
    await page.getByRole('tab', { name: /^Overview/ }).click()
    await expect(page).toHaveURL(url)
    await page.goto(url + '?tab=bogus')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tab Person')
  })
})

// =====================================================================
// 7. Non-existent member
// =====================================================================
test.describe('7. missing member', () => {
  it('direct link to a non-existent id shows not-found and the back link works', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/mem_nope')
    await expect(page.getByText('Member not found')).toBeVisible()
    await expect(page.getByText(/does not exist in this browser/)).toBeVisible()
    await page.getByRole('link', { name: 'Back to members' }).click()
    await expect(page).toHaveURL(/\/members$/)
    await page.goto('/members/%20')
    await expect(page.getByText('Member not found')).toBeVisible()
    await page.goto('/members/<script>alert(1)</script>')
    // decoded path has an extra segment so the catch-all route answers; must not execute or crash
    await expect(page).toHaveTitle(/Page not found/)
    await page.goto('/members/%3Cb%3Ebold%3C%2Fb%3E')
    await expect(page.getByText('Member not found')).toBeVisible()
  })
})

// =====================================================================
// 8. Console check across pages (plus additional sanity)
// =====================================================================
test.describe('8. console clean on member pages', () => {
  it('visiting every member page with sample data produces no console errors', async ({ page }) => {
    await onboard(page, 'sample')
    const members = await readStore<MemberRec>(page, 'members')
    const m = members[0]
    for (const route of ['/members', '/members?filter=archived', '/members?filter=expired&sort=expiry&dir=desc', '/members/new', `/members/${m.id}`, `/members/${m.id}?tab=memberships`, `/members/${m.id}?tab=attendance`, `/members/${m.id}?tab=payments`, `/members/${m.id}/edit`, '/members/mem_missing']) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveTitle(/· GymBook$/)
    }
  })

  it('ISO date typed in the far future still renders the list/detail without crashing', async ({ page }) => {
    await onboard(page, 'empty')
    await seedMembers(page, [{ name: 'Future Joiner', phone: '9820000001', joiningDate: '2999-12-31' }])
    await page.goto('/members')
    await expect(page.getByRole('main').getByRole('link', { name: 'Future Joiner' })).toBeVisible()
    await page.getByRole('main').getByRole('link', { name: 'Future Joiner' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Future Joiner')
  })

  it('today default joining date equals today in the gym timezone', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await expect(page.getByLabel(/^Joining date/)).toHaveValue(todayInTz(TZ))
    void addDays
  })
})

// =====================================================================
// 9. Add member with a plan
// =====================================================================
test.describe('9. add member with a plan', () => {
  type Ms = { memberId: string; planName: string; startDate: string; endDate: string; pricePaise: number; discountPaise: number; renewalOfId?: string }
  type Inv = { memberId: string; number: string; issueDate: string; totalPaise: number }
  type Pay = { memberId: string; amountPaise: number; method: string; status: string }

  it('with no plans the section points to Plans and the member still saves without one', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await expect(page.getByRole('heading', { name: 'Membership plan' })).toBeVisible()
    await expect(page.getByRole('main').getByRole('link', { name: 'Create a plan' })).toHaveAttribute('href', '/plans')
    await expect(page.getByLabel('Plan', { exact: true })).toHaveCount(0)
    await fillAdd(page, { name: 'No Plan Yet', phone: '98200 00020' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    expect(await readStore(page, 'memberships')).toHaveLength(0)
  })

  it('plan, discount and part payment: member, membership, invoice and payment are saved together', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await createPlan(page, 'Quarterly', 3, 'months', '4000')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Plan Person', phone: '98200 00021' })
    const today = todayInTz(TZ)
    const plan = page.getByLabel('Plan', { exact: true })
    await expect(plan).toHaveValue('')
    await expect(plan.locator('option')).toHaveText(['No plan for now', 'Monthly · 1 month · ₹1,500.00', 'Quarterly · 3 months · ₹4,000.00'])
    await expect(page.getByLabel('Plan starts')).toHaveCount(0)
    await expect(page.getByLabel('Received now')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeVisible()

    await plan.selectOption({ label: 'Monthly · 1 month · ₹1,500.00' })
    await expect(page.getByRole('button', { name: 'Add member and create invoice' })).toBeVisible()
    await expect(page.getByLabel('Plan starts')).toHaveValue(today)
    // the plan start follows the joining date until it is set on its own
    const start = addDays(today, -3)
    await page.getByLabel(/^Joining date/).fill(start)
    await expect(page.getByLabel('Plan starts')).toHaveValue(start)
    const end = membershipEndDate(start, 1, 'months')
    await expect(page.getByText(`${formatDate(start)} to ${formatDate(end)} (last day of access).`)).toBeVisible()

    await expect(page.getByLabel('Payment method')).toBeDisabled()
    await expect(page.getByText('₹1,500.00 will remain outstanding on the invoice.')).toBeVisible()
    await page.getByLabel('Discount').fill('100')
    await expect(page.getByText('₹1,400.00', { exact: true })).toBeVisible()
    await page.getByLabel('Received now').fill('500')
    await expect(page.getByLabel('Payment method')).toBeEnabled()
    await page.getByLabel('Payment method').selectOption('upi')
    await expect(page.getByText('₹900.00 will remain outstanding on the invoice.')).toBeVisible()

    await page.getByRole('button', { name: 'Add member and create invoice' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)
    await expect(page.getByRole('status').filter({ hasText: 'Added Plan Person' })).toContainText('Monthly sold · invoice RK-00001 created · ₹500.00 recorded')
    const [m] = await readStore<MemberRec>(page, 'members')
    const ms = await readStore<Ms>(page, 'memberships')
    const invs = await readStore<Inv>(page, 'invoices')
    const pays = await readStore<Pay>(page, 'payments')
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ memberId: m.id, planName: 'Monthly', startDate: start, endDate: end, pricePaise: 140000, discountPaise: 10000 })
    expect(ms[0].renewalOfId).toBeUndefined()
    expect(invs).toHaveLength(1)
    expect(invs[0]).toMatchObject({ memberId: m.id, number: 'RK-00001', issueDate: today, totalPaise: 140000 })
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ memberId: m.id, amountPaise: 50000, method: 'upi', status: 'recorded' })
    // the member page shows the plan; what is still owed sits on the invoice in the Payments tab
    await expect(page.getByRole('main')).toContainText('Monthly')
    await page.getByRole('tab', { name: /Payments & invoices/ }).click()
    await expect(page.getByRole('main')).toContainText('Pay ₹900.00')
  })

  it('a refused sale saves nothing, keeps what was typed, and saves once corrected', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Too Much Off', phone: '98200 00022' })
    await page.getByLabel('Plan', { exact: true }).selectOption({ label: 'Monthly · 1 month · ₹1,500.00' })
    await page.getByLabel('Discount').fill('2000')
    await page.getByRole('button', { name: 'Add member and create invoice' }).click()
    await expect(page.getByRole('alert').filter({ hasText: /Discount must be between/ })).toBeVisible()
    await expect(page).toHaveURL(/\/members\/new$/)
    expect(await readStore(page, 'members')).toHaveLength(0)
    expect(await readStore(page, 'invoices')).toHaveLength(0)
    await expect(page.getByLabel('Full name')).toHaveValue('Too Much Off')

    // field mistakes in the plan part are shown beside the fields, together with member mistakes
    await page.getByLabel('Full name').fill('T')
    await page.getByLabel('Discount').fill('abc')
    await page.getByLabel('Received now').fill('-5')
    await page.getByRole('button', { name: 'Add member and create invoice' }).click()
    await expect(page.getByText('Name must be at least 2 characters')).toBeVisible()
    await expect(page.getByText('Enter a valid discount in rupees')).toBeVisible()
    await expect(page.getByText(/Enter a valid payment in rupees|Amount cannot be negative/)).toBeVisible()
    expect(await readStore(page, 'members')).toHaveLength(0)

    await page.getByLabel('Full name').fill('Too Much Off')
    await page.getByLabel('Discount').fill('')
    await page.getByLabel('Received now').fill('')
    await page.getByRole('button', { name: 'Add member and create invoice' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)
    expect(await readStore(page, 'members')).toHaveLength(1)
    expect((await readStore<Inv>(page, 'invoices')).map((i) => i.number)).toEqual(['RK-00001'])
    expect(await readStore(page, 'payments')).toHaveLength(0)
  })

  it('choosing a plan and then going back to no plan adds the member only; the edit page has no plan section', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Changed Mind', phone: '98200 00023' })
    const plan = page.getByLabel('Plan', { exact: true })
    await plan.selectOption({ label: 'Monthly · 1 month · ₹1,500.00' })
    await page.getByLabel('Received now').fill('500')
    await plan.selectOption('')
    await expect(page.getByLabel('Received now')).toHaveCount(0)
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    expect(await readStore(page, 'memberships')).toHaveLength(0)
    expect(await readStore(page, 'payments')).toHaveLength(0)
    await page.goto(page.url() + '/edit')
    await expect(page.getByLabel('Full name')).toHaveValue('Changed Mind')
    await expect(page.getByRole('heading', { name: 'Membership plan' })).toHaveCount(0)
  })
})

// =====================================================================
// 10. WhatsApp message after adding a member
// =====================================================================
test.describe('10. WhatsApp message after adding a member', () => {
  const waText = async (link: ReturnType<Page['getByRole']>) => {
    const url = new URL((await link.getAttribute('href'))!)
    expect(url.origin + url.pathname).toBe('https://api.whatsapp.com/send')
    return { to: url.searchParams.get('phone'), text: url.searchParams.get('text') }
  }
  const gymPhone = async (page: Page) => (await readStore<{ phone?: string }>(page, 'settings'))[0].phone

  it('member with a plan: welcome, invoice and expiry messages carry the name, plan, expiry and amounts', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Rahul Patil', phone: '98200 12345' })
    await page.getByLabel('Plan', { exact: true }).selectOption({ label: 'Monthly · 1 month · ₹1,500.00' })
    await page.getByLabel('Discount').fill('100')
    await page.getByLabel('Received now').fill('500')
    await page.getByRole('button', { name: 'Add member and create invoice' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)

    const today = todayInTz(TZ)
    const end = membershipEndDate(today, 1, 'months')
    const gym = { gymName: 'Test Gym', gymPhone: await gymPhone(page), memberName: 'Rahul Patil' }
    const money = { invoiceNumber: 'RK-00001', duePaise: 140000, paidPaise: 50000, balancePaise: 90000 }

    const banner = page.getByRole('status').filter({ hasText: 'New member saved.' })
    await expect(banner).toContainText('the plan, expiry date and amount paid')
    await banner.getByRole('button', { name: 'Send on WhatsApp' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send on WhatsApp' })
    await expect(dialog).toContainText('Rahul Patil (98200 12345)')
    const open = dialog.getByRole('link', { name: 'Open WhatsApp' })
    await expect(open).toBeFocused()
    await expect(open).toHaveAttribute('target', '_blank')
    await expect(open).toHaveAttribute('rel', /noopener/)
    const kinds = dialog.getByRole('tablist', { name: 'Template' }).getByRole('tab')
    await expect(kinds).toHaveText(['Welcome', 'Invoice', 'Expiry reminder'])
    await expect(dialog.getByRole('tablist', { name: 'Language' }).getByRole('tab')).toHaveText(['English', 'मराठी'])
    await expect(dialog.getByRole('tab', { name: 'English' })).toHaveAttribute('aria-selected', 'true')

    const welcome = membershipMessage({ ...gym, welcome: true, plan: { planName: 'Monthly', startDate: today, endDate: end }, money, today })
    expect(await waText(open)).toEqual({ to: '919820012345', text: welcome })
    await expect(dialog.getByLabel('Message')).toHaveValue(welcome)
    for (const part of ['Hi Rahul Patil 👋', '🎉', '📋 *Plan:* Monthly', `⏳ *Valid till:* ${formatDate(end)}`, '💰 *Amount:* ₹1,400', '✅ *Paid:* ₹500']) expect(welcome).toContain(part)
    // the welcome leaves out the member ID and what is still owed
    for (const part of ['Member ID', 'GB-0001', 'Balance due', '₹900']) expect(welcome).not.toContain(part)

    await dialog.getByRole('tab', { name: 'Invoice' }).click()
    const [inv] = await readStore<{ lines: { description: string; amountPaise: number }[] }>(page, 'invoices')
    expect((await waText(open)).text).toBe(invoiceMessage({ ...gym, issueDate: today, lines: inv.lines, discountPaise: 10000, adjustmentsPaise: 0, money }))
    await dialog.getByRole('tab', { name: 'Expiry reminder' }).click()
    expect((await waText(open)).text).toBe(expiryMessage({ ...gym, planName: 'Monthly', endDate: end, today }))

    // an edit goes into the link, and is kept while looking at another message
    await dialog.getByRole('tab', { name: 'Welcome' }).click()
    await dialog.getByLabel('Message').fill('Hi Rahul 👋 see you at 6 am')
    expect((await waText(open)).text).toBe('Hi Rahul 👋 see you at 6 am')
    await dialog.getByRole('tab', { name: 'Invoice' }).click()
    await dialog.getByRole('tab', { name: 'Welcome' }).click()
    await expect(dialog.getByLabel('Message')).toHaveValue('Hi Rahul 👋 see you at 6 am')

    // closing the offer removes the banner for good; the header button stays
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await expect(dialog).toBeHidden()
    await expect(banner).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rahul Patil')
    await expect(banner).toHaveCount(0)
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
    await expect(kinds).toHaveText(['Membership', 'Invoice', 'Expiry reminder'])
    expect((await waText(open)).text).toBe(membershipMessage({ ...gym, plan: { planName: 'Monthly', startDate: today, endDate: end }, money, today }))
    expect((await waText(open)).text).toContain('Here are your membership details:')
  })

  it('member without a plan: a short welcome, and "Not now" dismisses the offer', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Only Name', phone: '+44 20 7946 0958' })
    await submitAdd(page)
    await expect(page).toHaveURL(/\/members\/mem_/)
    const banner = page.getByRole('status').filter({ hasText: 'New member saved.' })
    await expect(banner).toContainText('Send a welcome message on WhatsApp?')
    await banner.getByRole('button', { name: 'Send on WhatsApp' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send on WhatsApp' })
    await expect(dialog.getByRole('tablist', { name: 'Template' })).toHaveCount(0)
    const got = await waText(dialog.getByRole('link', { name: 'Open WhatsApp' }))
    expect(got.to).toBe('442079460958')
    expect(got.text).toBe(membershipMessage({ gymName: 'Test Gym', gymPhone: await gymPhone(page), memberName: 'Only Name', welcome: true, today: todayInTz(TZ) }))
    expect(got.text).not.toContain('Member ID')
    await page.keyboard.press('Escape')
    await expect(banner).toHaveCount(0)

    // the offer shows only right after adding: a second member gets it, opening an older member does not
    const first = page.url()
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Second One', phone: '98200 00031' })
    await submitAdd(page)
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Not now' }).click()
    await expect(banner).toHaveCount(0)
    await page.goto(first)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Only Name')
    await expect(banner).toHaveCount(0)
  })

  it('मराठी: every message switches language, edits are kept per language, and the choice is remembered', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await page.goto('/members/new')
    await fillAdd(page, { name: 'Sneha Jadhav', phone: '98200 54321' })
    await page.getByLabel('Plan', { exact: true }).selectOption({ label: 'Monthly · 1 month · ₹1,500.00' })
    await page.getByLabel('Received now').fill('1500')
    await page.getByRole('button', { name: 'Add member and create invoice' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)
    const today = todayInTz(TZ)
    const end = membershipEndDate(today, 1, 'months')
    const gym = { gymName: 'Test Gym', gymPhone: await gymPhone(page), memberName: 'Sneha Jadhav' }
    const money = { invoiceNumber: 'RK-00001', duePaise: 150000, paidPaise: 150000, balancePaise: 0 }
    const planFacts = { planName: 'Monthly', startDate: today, endDate: end }

    await page.getByRole('status').filter({ hasText: 'New member saved.' }).getByRole('button', { name: 'Send on WhatsApp' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send on WhatsApp' })
    const open = dialog.getByRole('link', { name: 'Open WhatsApp' })
    const english = membershipMessage({ ...gym, welcome: true, plan: planFacts, money, today })
    expect((await waText(open)).text).toBe(english)

    await dialog.getByRole('tab', { name: 'मराठी' }).click()
    const marathi = membershipMessage({ ...gym, welcome: true, plan: planFacts, money, today, lang: 'mr' })
    expect(await waText(open)).toEqual({ to: '919820054321', text: marathi })
    await expect(dialog.getByLabel('Message')).toHaveValue(marathi)
    await expect(dialog.getByLabel('Message')).toHaveAttribute('lang', 'mr')
    for (const part of ['नमस्कार Sneha Jadhav 👋', 'Test Gym मध्ये आपले स्वागत आहे! 🎉', '📋 *प्लॅन:* Monthly', '⏳ *वैधता:*', '✅ *भरलेली रक्कम:* ₹1,500 (पूर्ण भरले)', 'धन्यवाद 🙏']) expect(marathi).toContain(part)
    expect(marathi).not.toContain('Welcome')

    const [inv] = await readStore<{ lines: { description: string; amountPaise: number }[] }>(page, 'invoices')
    await dialog.getByRole('tab', { name: 'Invoice' }).click()
    expect((await waText(open)).text).toBe(invoiceMessage({ ...gym, issueDate: today, lines: inv.lines, discountPaise: 0, adjustmentsPaise: 0, money, lang: 'mr' }))
    await dialog.getByRole('tab', { name: 'Expiry reminder' }).click()
    expect((await waText(open)).text).toBe(expiryMessage({ ...gym, planName: 'Monthly', endDate: end, today, lang: 'mr' }))

    // an edit in one language does not touch the other
    await dialog.getByRole('tab', { name: 'Welcome' }).click()
    await dialog.getByLabel('Message').fill('नमस्कार Sneha 👋 उद्या सकाळी 6 वाजता या')
    await dialog.getByRole('tab', { name: 'English' }).click()
    await expect(dialog.getByLabel('Message')).toHaveValue(english)
    await dialog.getByRole('tab', { name: 'मराठी' }).click()
    await expect(dialog.getByLabel('Message')).toHaveValue('नमस्कार Sneha 👋 उद्या सकाळी 6 वाजता या')
    expect((await waText(open)).text).toBe('नमस्कार Sneha 👋 उद्या सकाळी 6 वाजता या')

    // Marathi stays selected the next time the dialog opens, also after a reload and on an invoice
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await page.reload()
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
    await expect(dialog.getByRole('tab', { name: 'मराठी' })).toHaveAttribute('aria-selected', 'true')
    expect((await waText(open)).text).toBe(membershipMessage({ ...gym, plan: planFacts, money, today, lang: 'mr' }))
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: /Payments/ }).click()
    await page.getByRole('link', { name: 'RK-00001' }).first().click()
    await expect(page).toHaveURL(/\/invoices\/inv_/)
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
    await expect(dialog.getByRole('tab', { name: 'मराठी' })).toHaveAttribute('aria-selected', 'true')
    expect((await waText(open)).text).toContain('आपले बिल खालीलप्रमाणे:')
  })

  it('invoice page: WhatsApp sends the invoice as text', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Invoice Person', '98200 00032')
    await page.getByRole('button', { name: 'Not now' }).click()
    await sellMembership(page, { receivedNow: '1500' })
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Send on WhatsApp' })
    await expect(dialog.getByRole('tablist', { name: 'Template' })).toHaveCount(0)
    const got = await waText(dialog.getByRole('link', { name: 'Open WhatsApp' }))
    expect(got.to).toBe('919820000032')
    for (const part of ['Hi Invoice Person 👋', '🧾 *Invoice:* RK-00001', '▪ Monthly membership', '💰 *Amount:* ₹1,500', '✅ *Paid:* ₹1,500 (fully paid)', 'Thank you 🙏']) expect(got.text).toContain(part)
    expect(got.text).not.toContain('Balance due')
  })
})
