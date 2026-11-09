import { test as base, expect, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { onboard, addMember, createPlan, sellMembership, readStore } from '../helpers'
import { todayInTz, formatDate } from '../../src/domain/dates'

/* ------------------------------------------------------------------------ */
/* Fixture: every test fails on console errors / page errors.                */
/* ------------------------------------------------------------------------ */
type Problems = { errors: string[] }
const test = base.extend<{ problems: Problems }>({
  problems: async ({ page }, use) => {
    const problems: Problems = { errors: [] }
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.errors.push(`console.error: ${msg.text()}`)
    })
    page.on('pageerror', (err) => problems.errors.push(`pageerror: ${err.message}`))
    await use(problems)
    expect(problems.errors, 'console errors / page errors').toEqual([])
  },
})
test.beforeEach(async ({ problems }) => void problems)
test.setTimeout(120_000)

const log = (type: string, description: string) => {
  test.info().annotations.push({ type, description })
  console.log(`[${type}] ${description}`)
}

const ROUTES = ['/', '/members', '/members/new', '/plans', '/attendance', '/payments', '/payments?tab=invoices', '/follow-ups', '/workouts', '/activity', '/reports', '/settings']
const STORES = ['members', 'plans', 'memberships', 'invoices', 'adjustments', 'payments', 'attendance', 'trainers', 'schedules', 'expenses', 'followups', 'sessions', 'equipment', 'incidents', 'workouts', 'settings', 'activity', 'counters'] as const

type Settings = { rev: number; gymName: string; timezone: string; invoicePrefix: string; logoDataUrl?: string; dataMode: string; address: string }
const settingsRow = async (page: Page) => (await readStore<Settings>(page, 'settings'))[0]

/** Minimal valid 2x2 RGBA PNG, built in-process (no fixtures on disk). */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 255])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function exportBackupJson(page: Page): Promise<{ text: string; json: any; name: string }> {
  await page.goto('/settings')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup (JSON)' }).click()])
  const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
  return { text, json: JSON.parse(text), name: download.suggestedFilename() }
}

async function importFile(page: Page, name: string, content: string | Buffer) {
  await page.goto('/settings')
  await page.locator('input[type=file][accept*=json]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

const counts = async (page: Page) => {
  const out: Record<string, number> = {}
  for (const s of STORES) out[s] = (await readStore(page, s)).length
  return out
}

/* ======================================================================== */
test.describe('1. onboarding', () => {
  test('blank name falls back to the branded default, timezone is kept, Start empty gives empty states with live CTAs, never shown again', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Set up RK Gym' })).toBeVisible()
    await expect(page.getByLabel('Gym name')).toBeFocused()
    await page.getByLabel('Gym name').fill('   ')
    await page.getByLabel('Timezone').selectOption('Asia/Dubai')
    await page.getByRole('button', { name: /Start empty/ }).click()
    await expect(page.getByRole('button', { name: /Start empty/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /Labelled sample data/ })).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: 'Open GymBook', exact: true }).click()
    await expect(page).toHaveTitle(/Dashboard · GymBook/)

    const s = await settingsRow(page)
    expect(s.gymName).toBe('R.K. Gym Fitness Centre')
    expect(s.timezone).toBe('Asia/Dubai')
    expect(s.dataMode).toBe('empty')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toContainText('R.K. Gym Fitness Centre')
    for (const store of STORES) if (store !== 'settings') expect((await readStore(page, store)).length, store).toBe(0)

    // Empty states and their CTAs on every list page.
    await page.goto('/members')
    await expect(page.getByRole('heading', { name: 'No members yet' })).toBeVisible()
    await page.getByRole('main').getByRole('link', { name: 'Add member' }).click()
    await expect(page).toHaveURL(/\/members\/new$/)

    await page.goto('/plans')
    await expect(page.getByRole('heading', { name: 'No plans yet' })).toBeVisible()
    await page.getByRole('main').getByRole('button', { name: 'New plan' }).last().click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: /New plan/ })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.goto('/follow-ups')
    await expect(page.getByRole('heading', { name: 'Nothing to follow up' })).toBeVisible()
    await page.goto('/payments')
    await expect(page.getByRole('heading', { name: 'No payments in this period' })).toBeVisible()
    await page.goto('/payments?tab=invoices')
    await expect(page.getByRole('heading', { name: /No outstanding invoices|No invoices here/ })).toBeVisible()
    await page.goto('/attendance')
    await expect(page.getByRole('heading', { name: 'Nobody checked in' })).toBeVisible()
    await page.goto('/reports')
    await expect(page.getByText('No data for this period').first()).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'No activity yet' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Nothing expiring this week' })).toBeVisible()

    // Every button in the main area of each empty page should do something (no dead buttons): check that none is disabled without reason.
    for (const route of ['/members', '/plans', '/follow-ups']) {
      await page.goto(route)
      const disabled = await page.getByRole('main').locator('button[disabled]').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()))
      expect(disabled, `${route} has disabled buttons`).toEqual([])
    }

    // Onboarding never shows again.
    await page.goto('/')
    await page.reload()
    await expect(page).toHaveTitle(/Dashboard · GymBook/)
    await expect(page.getByRole('heading', { name: 'Set up RK Gym' })).toHaveCount(0)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Set up RK Gym' })).toHaveCount(0)
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  })

  test('sample mode seeds, sets the gym name and labels records', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Labelled sample data/ }).click()
    await page.getByRole('button', { name: /Load sample data and open GymBook/ }).click()
    await expect(page).toHaveTitle(/Dashboard · GymBook/)
    const s = await settingsRow(page)
    expect(s.gymName).toBe('R.K. Gym Fitness Centre') // sample data keeps the gym's own name
    expect(s.dataMode).toBe('sample')
    const members = await readStore<{ sample?: boolean; name: string }>(page, 'members')
    expect(members).toHaveLength(12)
    expect(members.every((m) => m.sample && m.name.startsWith('Sample '))).toBe(true)
    await expect(page.getByRole('link', { name: 'Sample data' })).toBeVisible()
  })
})

/* ======================================================================== */
test.describe('2. settings form', () => {
  test('every field is validated; prefix auto-uppercases', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/settings')
    await page.getByLabel('Gym name').fill('   ')
    await page.getByLabel('Support phone').fill('abc')
    await page.getByLabel('Support email').fill('not-an-email')
    await page.getByLabel('Invoice prefix').fill('in v!')
    await expect(page.getByLabel('Invoice prefix')).toHaveValue('IN V!')
    await page.getByLabel('Address').fill('x'.repeat(301))
    await page.getByRole('button', { name: 'Other' }).click()
    await page.getByLabel('Timezone').fill('Mars/Olympus_Mons')
    const rev0 = (await settingsRow(page)).rev
    await page.getByRole('button', { name: 'Save settings' }).click()

    await expect(page.getByText('Gym name is required')).toBeVisible()
    await expect(page.getByText('Enter a valid phone number')).toBeVisible()
    await expect(page.getByText('Enter a valid email address')).toBeVisible()
    await expect(page.getByText('Letters, numbers and dashes only')).toBeVisible()
    await expect(page.getByText('Unknown timezone')).toBeVisible()
    const addressErr = page.getByLabel('Address').locator('xpath=..').getByRole('alert')
    await expect(addressErr).toBeVisible()
    expect(await addressErr.innerText()).toMatch(/300/)
    // Values are preserved after a failed validation
    await expect(page.getByLabel('Support phone')).toHaveValue('abc')
    expect((await settingsRow(page)).rev).toBe(rev0)
    const invalid = await page.locator('[aria-invalid="true"]').count()
    expect(invalid).toBeGreaterThanOrEqual(5)

    // Lowercase prefix with dashes becomes uppercase and is accepted; 'List' restores a known timezone.
    await page.getByLabel('Gym name').fill('Iron Temple')
    await page.getByLabel('Support phone').fill('+91 98200 11223')
    await page.getByLabel('Support email').fill('hello@example.com')
    await page.getByLabel('Invoice prefix').fill('it-2026')
    await expect(page.getByLabel('Invoice prefix')).toHaveValue('IT-2026')
    await page.getByLabel('Address').fill('12 Street')
    await page.getByRole('button', { name: 'List' }).click()
    await expect(page.getByLabel('Timezone')).toHaveValue('Asia/Kolkata')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    const s = await settingsRow(page)
    expect(s).toMatchObject({ gymName: 'Iron Temple', invoicePrefix: 'IT-2026', timezone: 'Asia/Kolkata', rev: rev0 + 1 })
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toContainText('Iron Temple')
  })

  test('a valid custom timezone via Other is accepted and moves "today"', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Other' }).click()
    await page.getByLabel('Timezone').fill('Pacific/Kiritimati')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    expect((await settingsRow(page)).timezone).toBe('Pacific/Kiritimati')
    await page.goto('/attendance')
    await expect(page.getByText(`on ${formatDate(todayInTz('Pacific/Kiritimati'))}`)).toBeVisible()

    await page.goto('/settings')
    // Custom timezone that is not in the list must still show as the current value.
    await expect(page.getByLabel('Timezone')).toHaveValue('Pacific/Kiritimati')
    await page.getByLabel('Timezone').fill('Pacific/Pago_Pago')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    await page.goto('/attendance')
    const expected = formatDate(todayInTz('Pacific/Pago_Pago'))
    expect(expected).not.toBe(formatDate(todayInTz('Pacific/Kiritimati')))
    await expect(page.getByText(`on ${expected}`)).toBeVisible()
  })

  test('logo upload and removal', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/settings')
    const rev0 = (await settingsRow(page)).rev
    await expect(page.getByRole('button', { name: 'Change logo' })).toBeVisible() // the branded default logo
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: tinyPng() })
    const img = page.getByRole('main').locator('img[src^="data:image/"]').first()
    await expect(img).toBeVisible()
    await expect(page.getByRole('button', { name: 'Change logo' })).toBeVisible()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    let s = await settingsRow(page)
    expect(s.logoDataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(s.rev).toBe(rev0 + 1)
    // logo appears in the sidebar
    await expect(page.getByRole('complementary', { name: 'Sidebar' }).locator('img[src^="data:image/"]')).toBeVisible()

    // Non-image file is refused with a message, value unchanged
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByRole('alert').filter({ hasText: /Choose an image file/ })).toBeVisible()

    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('No logo')).toBeVisible()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' }).last()).toBeVisible()
    s = await settingsRow(page)
    expect(s.logoDataUrl).toBeUndefined()
    expect(s.rev).toBe(rev0 + 2)
  })

  test('save increments rev, Discard resets, unsaved-change guard on navigation', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/settings')
    const rev0 = (await settingsRow(page)).rev
    const save = page.getByRole('button', { name: 'Save settings' })
    const discard = page.getByRole('button', { name: 'Discard' })
    await expect(save).toBeDisabled()
    await expect(discard).toBeDisabled()
    await page.getByLabel('Gym name').fill('Changed')
    await expect(save).toBeEnabled()
    await discard.click()
    await expect(page.getByLabel('Gym name')).toHaveValue('Test Gym')
    await expect(save).toBeDisabled()

    await page.getByLabel('Invoice footer').fill('See you soon')
    await save.click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    expect((await settingsRow(page)).rev).toBe(rev0 + 1)
    await expect(save).toBeDisabled()

    // Guard
    await page.getByLabel('Gym name').fill('Half typed')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members' }).click()
    const guard = page.getByRole('dialog')
    await expect(guard.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible()
    await guard.getByRole('button', { name: 'Keep editing' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByLabel('Gym name')).toHaveValue('Half typed')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
    await expect(page).toHaveURL(/\/members$/)
    expect((await settingsRow(page)).gymName).toBe('Test Gym')

    // The guard must not fire after a successful save.
    await page.goto('/settings')
    await page.getByLabel('Gym name').fill('Saved Name')
    await save.click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plans', exact: true }).click()
    await expect(page).toHaveURL(/\/plans$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('invoice prefix change affects only new invoice numbers and keeps numbering', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1000')
    await addMember(page, 'Ravi Kumar', '98200 11223')
    await sellMembership(page, { receivedNow: '1000' })
    await expect(page.getByRole('article')).toContainText('RK-00001')
    await page.goto('/settings')
    await page.getByLabel('Invoice prefix').fill('gym')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    await addMember(page, 'Asha Rao', '98200 11224')
    await sellMembership(page, { receivedNow: '1000' })
    await expect(page.getByRole('article')).toContainText('GYM-00002')
    const numbers = (await readStore<{ number: string }>(page, 'invoices')).map((i) => i.number).sort()
    expect(numbers).toEqual(['GYM-00002', 'RK-00001'])
    expect((await readStore<{ key: string; value: number }>(page, 'counters')).find((c) => c.key === 'invoice')?.value).toBe(2)
  })
})

/* ======================================================================== */
test.describe('3. backup', () => {
  test('export matches IndexedDB, re-import restores counts', async ({ page }) => {
    await onboard(page, 'sample')
    const before = await counts(page)
    const { json, name } = await exportBackupJson(page)
    expect(name).toMatch(/^gymbook-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/)
    await expect(page.getByRole('status').filter({ hasText: 'Backup exported' })).toBeVisible()
    expect(json.format).toBe('gymbook-backup')
    expect(json.version).toBe(1)
    expect(json.dbVersion).toBe(2)
    expect(typeof json.exportedAt).toBe('string')
    expect(Object.keys(json.data).sort()).toEqual([...STORES].sort())
    for (const s of STORES) {
      if (s === 'settings') expect(json.data.settings.gymName).toBe('Test Gym')
      else expect(json.data[s].length, s).toBe(before[s])
    }

    await addMember(page, 'Extra Person', '98200 99999')
    expect((await counts(page)).members).toBe(before.members + 1)

    const dialog = await importFile(page, 'backup.json', JSON.stringify(json))
    await expect(dialog.getByRole('heading', { name: 'Replace all data with this backup?' })).toBeVisible()
    await expect(dialog).toContainText('Backup of Test Gym')
    for (const k of ['members', 'plans', 'memberships', 'invoices', 'payments', 'attendance', 'followups', 'workouts']) {
      await expect(dialog.locator('li').filter({ has: page.locator('span', { hasText: new RegExp(`^${k}$`) }) })).toContainText(String(before[k]))
    }
    // Sections that were removed are only listed when the backup still carries their records.
    for (const k of ['trainers', 'expenses', 'sessions', 'equipment', 'incidents']) {
      await expect(dialog.locator('li').filter({ has: page.locator('span', { hasText: new RegExp(`^${k}$`) }) })).toHaveCount(0)
    }
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Replace my data' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Backup restored' })).toBeVisible()
    await expect(dialog).toBeHidden()
    const after = await counts(page)
    for (const s of STORES) {
      if (s === 'activity') expect(after.activity).toBe(before.activity + 1) // restore log entry
      else expect(after[s], s).toBe(before[s])
    }
    expect((await readStore<{ name: string }>(page, 'members')).some((m) => m.name === 'Extra Person')).toBe(false)
    // The UI reflects the restored data without a reload.
    await page.goto('/members')
    await expect(page.getByRole('link', { name: /Extra Person/ })).toHaveCount(0)
  })

  test('tampered counter is warned about and raised on import', async ({ page }) => {
    await onboard(page, 'sample')
    const { json } = await exportBackupJson(page)
    const maxSeq = Math.max(...json.data.invoices.map((i: { number: string }) => Number(i.number.split('-').pop())))
    expect(maxSeq).toBeGreaterThan(1)
    json.data.counters = json.data.counters.map((c: { key: string; value: number }) => (c.key === 'invoice' ? { ...c, value: 1 } : c))
    const dialog = await importFile(page, 'tampered.json', JSON.stringify(json))
    await expect(dialog).toContainText(`invoice counter (1) is behind the highest invoice number (${maxSeq}); it will be raised to ${maxSeq}`)
    await dialog.getByRole('button', { name: 'Replace my data' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Backup restored' })).toBeVisible()
    expect((await readStore<{ key: string; value: number }>(page, 'counters')).find((c) => c.key === 'invoice')?.value).toBe(maxSeq)

    // Missing counter row entirely → created at max
    json.data.counters = []
    const d2 = await importFile(page, 'nocounter.json', JSON.stringify(json))
    await d2.getByRole('button', { name: 'Replace my data' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Backup restored' }).last()).toBeVisible()
    expect((await readStore<{ key: string; value: number }>(page, 'counters')).find((c) => c.key === 'invoice')?.value).toBe(maxSeq)
  })

  test('duplicate invoice numbers, wrong format and huge invalid files are rejected; data untouched', async ({ page }) => {
    await onboard(page, 'sample')
    const { json } = await exportBackupJson(page)
    await addMember(page, 'Keep Me', '98200 77777')
    const before = await counts(page)

    json.data.invoices[1].number = json.data.invoices[0].number
    let dialog = await importFile(page, 'dupes.json', JSON.stringify(json))
    await expect(dialog.getByRole('heading', { name: /can’t be imported/ })).toBeVisible()
    await expect(dialog).toContainText(`duplicate invoice number ${json.data.invoices[0].number}`)
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).first().click()
    await expect(dialog).toBeHidden()
    expect(await counts(page)).toEqual(before)

    dialog = await importFile(page, 'wrong.json', JSON.stringify({ hello: 'world', format: 'something-else', version: 9 }))
    await expect(dialog).toContainText('not a GymBook backup file')
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Right format, missing every data store → invalid records, not a crash
    dialog = await importFile(page, 'empty-data.json', JSON.stringify({ format: 'gymbook-backup', version: 1, exportedAt: 'x', data: {} }))
    await expect(dialog).toContainText(/invalid records|not a GymBook backup/)
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Huge invalid files (5 MB garbage, 5 MB valid JSON array)
    const t0 = Date.now()
    dialog = await importFile(page, 'huge.json', Buffer.alloc(5 * 1024 * 1024, 'x'))
    await expect(dialog).toContainText('not valid JSON')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    dialog = await importFile(page, 'huge-array.json', '[' + Array.from({ length: 600_000 }, (_, i) => i).join(',') + ']')
    await expect(dialog).toContainText(/not a GymBook backup|invalid records/)
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(await counts(page)).toEqual(before)
    expect((await readStore<{ name: string }>(page, 'members')).some((m) => m.name === 'Keep Me')).toBe(true)
  })

  test('backup with unknown timezone or a membership that ends before it starts is rejected', async ({ page }) => {
    await onboard(page, 'sample')
    const { json } = await exportBackupJson(page)
    json.data.settings.timezone = 'Nowhere/Land'
    let dialog = await importFile(page, 'tz.json', JSON.stringify(json))
    await expect(dialog).toContainText('unknown timezone')
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    json.data.settings.timezone = 'Asia/Kolkata'
    json.data.memberships[0].endDate = '2000-01-01'
    dialog = await importFile(page, 'ms.json', JSON.stringify(json))
    await expect(dialog).toContainText('ends before it starts')
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
  })
})

/* ======================================================================== */
test.describe('4. sample data', () => {
  test('load sample on an empty gym, remove keeps real records, reload sample keeps numbers unique', async ({ page }) => {
    await onboard(page, 'empty')
    await addMember(page, 'Real Person', '98200 12345')
    await page.goto('/settings')
    await expect(page.getByRole('button', { name: 'Remove sample records' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Load sample data' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Load sample data?' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Load sample data' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Sample data loaded' })).toBeVisible()
    await expect(dialog).toBeHidden()
    const c1 = await counts(page)
    expect(c1.members).toBe(13)
    expect(c1.plans).toBe(4)
    expect(c1.invoices).toBe(14)
    expect(c1.memberships).toBe(14)
    for (const s of ['trainers', 'schedules', 'expenses', 'sessions', 'equipment', 'incidents']) expect(c1[s], s).toBe(0)
    expect(c1.followups).toBe(4)
    expect((await settingsRow(page)).dataMode).toBe('sample')
    expect((await settingsRow(page)).gymName).toBe('Test Gym') // custom name is kept
    await expect(page.getByRole('link', { name: 'Sample data' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove sample records' })).toBeVisible()

    const numbersUnique = (list: { number: string }[]) => new Set(list.map((i) => i.number)).size === list.length
    expect(numbersUnique(await readStore(page, 'invoices'))).toBe(true)
    const counter = () => readStore<{ key: string; value: number }>(page, 'counters').then((c) => c.find((x) => x.key === 'invoice')?.value)
    expect(await counter()).toBe(14)

    // Remove
    await page.getByRole('button', { name: 'Remove sample records' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove sample records' }).click()
    await expect(page.getByRole('status').filter({ hasText: /Removed \d+ sample records/ })).toBeVisible()
    const c2 = await counts(page)
    expect(c2.members).toBe(1)
    expect((await readStore<{ name: string }>(page, 'members'))[0].name).toBe('Real Person')
    for (const s of ['plans', 'memberships', 'invoices', 'payments', 'attendance', 'trainers', 'schedules', 'expenses', 'followups']) expect(c2[s], s).toBe(0)
    expect((await settingsRow(page)).dataMode).toBe('empty')
    expect(await counter()).toBe(14) // numbers are never reused

    // Load again
    await page.getByRole('button', { name: 'Load sample data' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Load sample data' }).click()
    // The earlier "Sample data loaded" toast may still be on screen, so wait for the mode switch instead.
    await expect(page.getByRole('button', { name: 'Remove sample records' })).toBeVisible()
    const c3 = await counts(page)
    expect(c3.members).toBe(13)
    expect(c3.invoices).toBe(14)
    expect(numbersUnique(await readStore(page, 'invoices'))).toBe(true)
    expect(await counter()).toBeGreaterThanOrEqual(14)
  })

  test('loading sample data when real invoices already exist must not collide with their numbers', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1000')
    await addMember(page, 'Real Person', '98200 12345')
    await sellMembership(page, { receivedNow: '1000' }) // RK-00001
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Load sample data' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Load sample data' }).click()
    // Either succeeds with unique numbers, or shows an honest error. It must not partially write.
    const toast = page.getByRole('status').filter({ hasText: 'Sample data loaded' })
    const err = dialog.getByRole('alert')
    await expect(toast.or(err)).toBeVisible()
    const invoices = await readStore<{ number: string; sample?: boolean }>(page, 'invoices')
    expect(new Set(invoices.map((i) => i.number)).size).toBe(invoices.length)
    if (await toast.count()) {
      expect(invoices.length).toBe(15)
      const counter = (await readStore<{ key: string; value: number }>(page, 'counters')).find((c) => c.key === 'invoice')?.value
      expect(counter).toBeGreaterThanOrEqual(15)
    } else {
      log('bug', `Load sample data failed with: ${await err.innerText()}`)
      expect(invoices.length).toBe(1)
      expect.soft(await err.count(), 'Load sample data must succeed when real invoices exist').toBe(0)
    }
  })

  test('after removing sample data and selling a real membership, reloading sample must not rewind the invoice counter', async ({ page }) => {
    await onboard(page, 'sample')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Remove sample records' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove sample records' }).click()
    await expect(page.getByRole('status').filter({ hasText: /Removed \d+ sample records/ })).toBeVisible()
    await createPlan(page, 'Monthly', 1, 'months', '1000')
    await addMember(page, 'Real Person', '98200 12345')
    await sellMembership(page, { receivedNow: '1000' })
    await expect(page.getByRole('article')).toContainText('RK-00015')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Load sample data' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Load sample data' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Sample data loaded' })).toBeVisible()
    const counter = (await readStore<{ key: string; value: number }>(page, 'counters')).find((c) => c.key === 'invoice')?.value
    expect.soft(counter, 'invoice counter rewound below the highest real invoice number').toBeGreaterThanOrEqual(15)
    // Selling again must produce a fresh unique number, never a constraint error.
    await addMember(page, 'Second Real', '98200 12346')
    await page.getByRole('button', { name: /Sell membership/ }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Plan').selectOption({ index: 0 })
    await dlg.getByRole('button', { name: /Sell and create invoice/ }).click()
    const alert = dlg.getByRole('alert')
    await expect(page.locator('article').or(alert)).toBeVisible()
    if (await alert.count()) log('bug', `Sale after reloading sample failed: ${await alert.innerText()}`)
    expect.soft(await alert.count(), 'sale after reloading sample data failed').toBe(0)
    const invoices = await readStore<{ number: string }>(page, 'invoices')
    expect(new Set(invoices.map((i) => i.number)).size).toBe(invoices.length)
  })

  test('Reset requires typing RESET exactly and lands on onboarding with an empty database', async ({ page }) => {
    await onboard(page, 'sample')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Reset everything…' }).click()
    const dialog = page.getByRole('dialog')
    const confirm = dialog.getByRole('button', { name: 'Delete all data' })
    await expect(confirm).toBeDisabled()
    const input = dialog.getByLabel('Type RESET to confirm')
    await expect(input).toBeFocused()
    await input.fill('reset')
    await expect(confirm).toBeDisabled()
    await input.fill('RESE')
    await expect(confirm).toBeDisabled()
    await input.fill('RESET')
    await expect(confirm).toBeEnabled()
    // Cancel clears the typed word
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Reset everything…' }).click()
    const typedAfterCancel = await page.getByRole('dialog').getByLabel('Type RESET to confirm').inputValue()
    if (typedAfterCancel) log('bug', `Reset dialog reopened with confirmation word pre-filled: "${typedAfterCancel}"; Delete all data enabled=${await page.getByRole('dialog').getByRole('button', { name: 'Delete all data' }).isEnabled()}`)
    expect.soft(typedAfterCancel, 'Cancel should clear the typed confirmation word').toBe('')
    await page.getByRole('dialog').getByLabel('Type RESET to confirm').fill('RESET')
    await page.getByRole('dialog').getByRole('button', { name: 'Delete all data' }).click()
    await expect(page.getByRole('heading', { name: 'Set up RK Gym' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(await readStore(page, 'members')).toEqual([])
    expect(await readStore(page, 'settings')).toEqual([])
    await expect(page.getByLabel('Gym name')).toHaveValue('R.K. Gym Fitness Centre')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Set up RK Gym' })).toBeVisible()
  })
})

/* ======================================================================== */
test.describe('5. simulated save failure', () => {
  test('armed failure: settings save shows error, values preserved, retry works', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/settings')
    const rev0 = (await settingsRow(page)).rev
    await expect(page.getByText('Developer tools')).toHaveCount(0)
    await page.evaluate(() => sessionStorage.setItem('gymbook-fail-next-save', '1'))
    await page.getByLabel('Gym name').fill('Failing Gym')
    await page.getByLabel('Invoice footer').fill('Footer text')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Simulated storage failure' })).toBeVisible()
    await expect(page.getByLabel('Gym name')).toHaveValue('Failing Gym')
    await expect(page.getByLabel('Invoice footer')).toHaveValue('Footer text')
    expect((await settingsRow(page)).gymName).toBe('Test Gym')
    expect((await settingsRow(page)).rev).toBe(rev0)
    await expect(page.getByRole('button', { name: 'Save settings' })).toBeEnabled()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Simulated storage failure' })).toHaveCount(0)
    const s = await settingsRow(page)
    expect(s.gymName).toBe('Failing Gym')
    expect(s.rev).toBe(rev0 + 1)
    // The flag is single-use: a further save goes through.
    expect(await page.evaluate(() => sessionStorage.getItem('gymbook-fail-next-save'))).toBeNull()
  })
})

/* ======================================================================== */
test.describe('6. shell', () => {
  test('sidebar collapse persists across reload and toggles with [', async ({ page }) => {
    await onboard(page, 'empty')
    const aside = page.getByRole('complementary', { name: 'Sidebar' })
    expect((await aside.boundingBox())!.width).toBe(240)
    await page.getByRole('button', { name: /Collapse/ }).click()
    expect(await page.evaluate(() => localStorage.getItem('gymbook-sidebar'))).toBe('collapsed')
    await expect.poll(async () => (await aside.boundingBox())!.width).toBe(64)
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false')
    await page.reload()
    await expect(page).toHaveTitle(/Dashboard/)
    expect((await aside.boundingBox())!.width).toBe(64)
    await page.keyboard.press('[')
    await expect.poll(async () => (await aside.boundingBox())!.width).toBe(240)
    expect(await page.evaluate(() => localStorage.getItem('gymbook-sidebar'))).toBe('open')
  })

  test('theme toggle sets data-theme and persists; system dark is honoured without a preference', async ({ page, browser }) => {
    await onboard(page, 'empty')
    const html = page.locator('html')
    await expect(html).not.toHaveAttribute('data-theme', /.+/)
    await page.getByRole('button', { name: 'Dark theme' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect(await page.evaluate(() => localStorage.getItem('gymbook-theme'))).toBe('dark')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 20, 21)')
    expect(await page.locator('meta[name=theme-color]').getAttribute('content')).toBe('#141415')
    await page.reload()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 20, 21)')
    const metaBoot = await page.locator('meta[name=theme-color]').getAttribute('content')
    if (metaBoot !== '#141415') log('bug', `stored dark theme after reload: meta theme-color is ${metaBoot}`)
    expect.soft(metaBoot, 'meta theme-color should match stored dark theme after reload').toBe('#141415')
    await page.getByRole('button', { name: 'Light theme' }).click()
    await expect(html).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate(() => localStorage.getItem('gymbook-theme'))).toBe('light')

    // Command palette theme command
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox').fill('theme')
    await page.keyboard.press('Enter')
    await expect(html).toHaveAttribute('data-theme', 'dark')

    // System dark, no stored preference → dark without data-theme
    const ctx = await browser.newContext({ colorScheme: 'dark' })
    const p2 = await ctx.newPage()
    await onboard(p2, 'empty')
    await expect(p2.locator('html')).not.toHaveAttribute('data-theme', /.+/)
    expect(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 20, 21)')
    await expect(p2.getByRole('button', { name: 'Light theme' })).toBeVisible()
    const metaSys = await p2.locator('meta[name=theme-color]').getAttribute('content')
    if (metaSys !== '#141415') log('bug', `system-dark without preference: meta theme-color is ${metaSys}, body is dark`)
    expect.soft(metaSys, 'meta theme-color should follow system dark at boot').toBe('#141415')
    // A stored light preference beats system dark
    await p2.getByRole('button', { name: 'Light theme' }).click()
    expect(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 250)')
    await p2.reload()
    expect(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 250)')
    // Live media change while on 'system'
    await p2.getByRole('button', { name: 'Dark theme' }).click()
    await p2.evaluate(() => localStorage.removeItem('gymbook-theme'))
    await p2.reload()
    await expect(p2.locator('html')).not.toHaveAttribute('data-theme', /.+/)
    await p2.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => p2.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 250)')
    await expect(p2.getByRole('button', { name: 'Dark theme' })).toBeVisible()
    await ctx.close()
  })

  test('command palette: open with ⌘K and /, phone search, keyboard navigation, Escape, focus return', async ({ page }) => {
    await onboard(page, 'sample')
    const opener = page.getByRole('button', { name: 'Search members and commands' })
    await opener.click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    const box = palette.getByRole('combobox')
    await expect(box).toBeFocused()
    await expect(palette.getByRole('option')).toHaveCount(14) // 4 actions + 10 pages
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await page.waitForTimeout(400)
    const focusedAfter = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()} ${a.getAttribute('aria-label') ?? a.innerText?.slice(0, 20) ?? ''}` : 'none' })
    if (!/Search members and commands/.test(focusedAfter)) log('bug', `after Escape the command palette focus is on: ${focusedAfter} (expected the search button)`)
    expect.soft(focusedAfter, 'focus returns to the opener after closing the palette').toMatch(/Search members and commands/)

    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k') // toggles closed
    await expect(palette).toBeHidden()

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('/')
    await expect(palette).toBeVisible()
    await expect(box).toHaveValue('')
    await box.fill('00013')
    const kabir = palette.getByRole('option', { name: /Sample Kabir Singh/ })
    await expect(kabir).toBeVisible()
    await expect(kabir).toHaveAttribute('aria-selected', 'true')
    await expect(box).toHaveAttribute('aria-activedescendant', 'cmd-0')
    await box.fill('98100-000-14')
    await expect(palette.getByRole('option', { name: /Sample Ananya Iyer/ })).toBeVisible()
    // members no longer carry an email address, so it is not searched
    await box.fill('kabir.sample@')
    await expect(palette.getByText(/No members or commands match/)).toBeVisible()
    await box.fill('zzzz')
    await expect(palette.getByText(/No members or commands match/)).toBeVisible()

    await box.fill('')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(box).toHaveAttribute('aria-activedescendant', 'cmd-2')
    await page.keyboard.press('ArrowUp')
    await expect(palette.getByRole('option', { name: /Check in a member/ })).toHaveAttribute('aria-selected', 'true')
    // ArrowUp at top stays at 0, ArrowDown clamps at last
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(box).toHaveAttribute('aria-activedescendant', 'cmd-0')
    for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowDown')
    await expect(box).toHaveAttribute('aria-activedescendant', 'cmd-13')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/settings$/)
    await expect(palette).toBeHidden()

    await page.keyboard.press('ControlOrMeta+k')
    await box.fill('kabir')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/members\/mem_/)
    await expect(page).toHaveTitle(/Kabir/)

    // Click on an option
    await page.keyboard.press('ControlOrMeta+k')
    await palette.getByRole('option', { name: /Reports/ }).click()
    await expect(page).toHaveURL(/\/reports$/)

    // Typing letters in the palette must not trigger G shortcuts or N
    await page.keyboard.press('ControlOrMeta+k')
    await box.pressSequentially('gn')
    await expect(page).toHaveURL(/\/reports$/)
    await expect(box).toHaveValue('gn')
    await page.keyboard.press('Escape')
  })

  test('keyboard shortcuts: G+letter for every page, N, ?, and not inside inputs or dialogs', async ({ page }) => {
    await onboard(page, 'sample')
    const pages: [string, RegExp][] = [['m', /\/members$/], ['p', /\/plans$/], ['a', /\/attendance$/], ['y', /\/payments$/], ['w', /\/workouts$/], ['l', /\/activity$/], ['f', /\/follow-ups$/], ['r', /\/reports$/], ['s', /\/settings$/], ['d', /\/$/]]
    for (const [key, url] of pages) {
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(150)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('g')
      await page.keyboard.press(key)
      await expect(page, `g ${key}`).toHaveURL(url)
    }
    // Uppercase (as printed in the help dialog: "G M") — the Shift keydown itself cancels the pending G
    await page.keyboard.press('Shift+G')
    await page.keyboard.press('Shift+M')
    await page.waitForTimeout(300)
    if (!/\/members$/.test(page.url())) log('bug', `Shift+G then Shift+M did not navigate (url ${page.url()}); the Shift keydown clears pendingG in Shell.tsx onKey`)
    expect.soft(page.url(), 'Shift+G, Shift+M should open Members').toMatch(/\/members$/)
    await page.goto('/members')
    await page.waitForLoadState('networkidle')
    // G then an unmapped key does nothing; G chord times out after 1.5s
    await page.keyboard.press('g')
    await page.keyboard.press('x')
    await expect(page).toHaveURL(/\/members$/)
    await page.keyboard.press('g')
    await page.waitForTimeout(1700)
    await page.keyboard.press('p')
    await expect(page).toHaveURL(/\/members$/)

    await page.keyboard.press('n')
    await expect(page).toHaveURL(/\/members\/new$/)
    // The form focuses its first field on mount; shortcuts are for outside text fields, so step out of it first.
    await page.getByLabel('Full name').waitFor()
    await page.waitForTimeout(200)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expect(page.getByLabel('Full name')).not.toBeFocused()
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toBeVisible()
    await expect(help).toContainText('Shortcuts work anywhere except inside text fields')
    // Dialog open: g+m must not navigate, n must not navigate
    await page.keyboard.press('g')
    await page.keyboard.press('m')
    await page.keyboard.press('n')
    await expect(page).toHaveURL(/\/members\/new$/)
    await expect(help).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()

    // Inside an input: letters go to the field, no navigation
    await page.goto('/members')
    const search = page.getByRole('searchbox').first()
    await search.click()
    await search.pressSequentially('gpn?/[')
    await page.waitForTimeout(300)
    const fast = await search.inputValue()
    if (fast !== 'gpn?/[') log('bug', `members search dropped keystrokes when typed quickly: typed "gpn?/[" but input holds "${fast}" (URL-synced controlled input, Members.tsx setParams per keystroke)`)
    expect.soft(fast, 'fast typing into the members search keeps every character').toBe('gpn?/[')
    await expect(page).toHaveURL(/\/members(\?q=.*)?$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await page.getByRole('complementary', { name: 'Sidebar' }).boundingBox())!.width).toBe(240)
    // A plain controlled input (settings gym name): every shortcut character lands in the field, nothing fires
    await page.goto('/settings')
    const gym = page.getByLabel('Gym name')
    await gym.click()
    await gym.pressSequentially('gpn?/[', { delay: 30 })
    await expect(gym).toHaveValue('Test Gymgpn?/[')
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await page.getByRole('complementary', { name: 'Sidebar' }).boundingBox())!.width).toBe(240)
    await page.getByRole('button', { name: 'Discard' }).click()
    // Inside a select and a textarea
    await page.goto('/settings')
    await page.getByLabel('Timezone').focus()
    await page.keyboard.press('g')
    await page.keyboard.press('m')
    await expect(page).toHaveURL(/\/settings$/)
    await page.getByLabel('Address').focus()
    await page.keyboard.press('n')
    await expect(page).toHaveURL(/\/settings$/)

    // ⌘K while a form dialog is open stacks a second dialog (should it?)
    await page.goto('/plans')
    await page.getByRole('button', { name: 'New plan' }).first().click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+k')
    const stacked = await page.getByRole('dialog').count()
    log('note', `dialogs open after ⌘K over a form dialog: ${stacked}`)
    expect.soft(stacked, '⌘K opened the command palette on top of an open form dialog').toBe(1)
  })

  test('bottom tab bar at 390px: tabs, More drawer, page actions inline under the header', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await onboard(page, 'sample')
    const bar = page.getByRole('navigation', { name: 'Quick navigation' })
    await expect(bar).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden()
    for (const [label, url] of [['Members', /\/members$/], ['Check in', /\/attendance$/], ['Payments', /\/payments$/], ['Home', /\/$/]] as const) {
      await bar.getByRole('link', { name: label }).click()
      await expect(page).toHaveURL(url)
      await expect(bar.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
    }
    const more = bar.getByRole('button', { name: 'Open navigation' })
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await more.click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused()
    await drawer.getByRole('link', { name: 'Plans', exact: true }).click()
    await expect(page).toHaveURL(/\/plans$/)
    await expect(drawer).toBeHidden()
    // Escape closes the drawer, backdrop click closes it
    await more.click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await more.click()
    await page.getByRole('button', { name: 'Close navigation' }).first().click()
    await expect(drawer).toBeHidden()
    // Theme toggle inside the drawer
    await more.click()
    await drawer.getByRole('button', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.keyboard.press('Escape')

    // Page actions are in the flow under the title: never fixed over content, never under the tab bar
    const actions = page.locator('#page-header-actions')
    await expect(actions.getByRole('button', { name: 'New plan' })).toBeVisible()
    const a = (await actions.boundingBox())!
    const b = (await bar.boundingBox())!
    expect(await actions.evaluate((el) => getComputedStyle(el).position)).toBe('static')
    const h1 = (await page.getByRole('heading', { level: 1 }).boundingBox())!
    expect(a.y, 'actions sit below the page title').toBeGreaterThanOrEqual(h1.y + h1.height)
    expect(a.y + a.height, 'actions overlap the tab bar').toBeLessThanOrEqual(b.y)
    expect(a.x + a.width).toBeLessThanOrEqual(390)
    // Toast vs tab bar vs page actions at phone width
    await actions.getByRole('button', { name: 'New plan' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Plan name').fill('Phone plan')
    await dialog.getByLabel('Duration').fill('1')
    await dialog.getByLabel('Price').fill('100')
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    const toast = page.getByRole('status').filter({ hasText: /Plan created|created/ })
    await expect(toast).toBeVisible()
    const t = (await toast.boundingBox())!
    const overlapsBar = t.y < b.y + b.height && t.y + t.height > b.y
    const a2 = (await actions.boundingBox())!
    const overlapsActions = t.y < a2.y + a2.height && t.y + t.height > a2.y && t.x < a2.x + a2.width && t.x + t.width > a2.x
    log('layout', `toast ${JSON.stringify(t)} bar ${JSON.stringify(b)} actions ${JSON.stringify(a2)}`)
    expect.soft(overlapsBar, 'toast overlaps the bottom tab bar').toBe(false)
    expect.soft(overlapsActions, 'toast overlaps the page actions').toBe(false)
  })
})

/* ======================================================================== */
test.describe('7. accessibility', () => {
  test.setTimeout(180_000)
  test('names, labels, single h1, dialog labelling, palette focus trap, contrast', async ({ page }) => {
    await onboard(page, 'sample')
    const kabir = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name.includes('Kabir'))!
    const inv = (await readStore<{ id: string }>(page, 'invoices'))[0]
    const routes = [...ROUTES, `/members/${kabir.id}`, `/members/${kabir.id}?tab=payments`, `/members/${kabir.id}/edit`, `/invoices/${inv.id}`, '/nope']
    const findings: string[] = []
    for (const route of routes) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const r = await page.evaluate(() => {
        const name = (el: Element) => {
          const h = el as HTMLElement
          const txt = (h.innerText || '').trim()
          const aria = h.getAttribute('aria-label') || h.getAttribute('title') || ''
          const labelled = h.getAttribute('aria-labelledby')
          const labelledText = labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim() : ''
          const img = h.querySelector('img[alt]:not([alt=""])')
          return txt || aria || labelledText || (img ? 'img' : '')
        }
        const unnamed: string[] = []
        for (const el of Array.from(document.querySelectorAll('button, a[href], [role=button], [role=link]'))) {
          if ((el as HTMLElement).hidden) continue
          if (!name(el)) unnamed.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 40)}`)
        }
        const unlabeled: string[] = []
        for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
          const i = el as HTMLInputElement
          if (i.type === 'hidden' || i.type === 'file' || i.type === 'submit' || i.type === 'button') continue
          const has = i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) || i.closest('label')
          if (!has) unlabeled.push(`${i.tagName.toLowerCase()}[type=${i.type}] placeholder="${i.placeholder}" name="${i.name}"`)
        }
        const h1 = document.querySelectorAll('h1').length
        return { unnamed, unlabeled, h1 }
      })
      if (r.unnamed.length) findings.push(`${route}: unnamed controls ${r.unnamed.join(', ')}`)
      if (r.unlabeled.length) findings.push(`${route}: unlabeled inputs ${r.unlabeled.join(', ')}`)
      if (r.h1 !== 1) findings.push(`${route}: ${r.h1} h1 elements`)
    }

    // Dialogs: labelled by aria-labelledby (or aria-label)
    const checkDialog = async (what: string) => {
      const d = page.getByRole('dialog').first()
      await expect(d).toBeVisible()
      const labelledby = await d.getAttribute('aria-labelledby')
      const label = await d.getAttribute('aria-label')
      const modal = await d.getAttribute('aria-modal')
      if (!labelledby && !label) findings.push(`${what}: dialog has neither aria-labelledby nor aria-label`)
      if (labelledby && !(await page.locator(`[id="${labelledby}"]`).count())) findings.push(`${what}: aria-labelledby points nowhere`)
      const backgroundHidden = await page.evaluate(() => !!document.querySelector('main')?.closest('[aria-hidden="true"]'))
      if (modal !== 'true' && !backgroundHidden) findings.push(`${what}: aria-modal is ${modal} and the page <main> is not inside an aria-hidden subtree`)
      else if (modal !== 'true') log('note', `${what}: no aria-modal attribute, but background content is aria-hidden while open (Radix pattern)`)
      return { labelledby, label }
    }
    await page.goto('/plans')
    await page.getByRole('button', { name: 'New plan' }).first().click()
    const plan = await checkDialog('plan form')
    expect(plan.labelledby).toBeTruthy()
    await page.keyboard.press('Escape')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Reset everything…' }).click()
    const reset = await checkDialog('reset confirm')
    expect(reset.labelledby).toBeTruthy()
    await page.keyboard.press('Escape')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('?')
    await checkDialog('shortcuts help')
    await page.keyboard.press('Escape')
    await page.keyboard.press('ControlOrMeta+k')
    const pal = await checkDialog('command palette')
    if (!pal.labelledby) findings.push('command palette: uses aria-label instead of aria-labelledby (Dialog.Title is sr-only and present)')
    // Focus trap in the palette
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `Tab ${i} escaped the palette`).toBe(true)
    }
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `Shift+Tab ${i} escaped the palette`).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // Contrast
    const contrast = async (theme: 'light' | 'dark') => {
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t)
      }, theme)
      return page.evaluate(() => {
        const lum = (rgb: number[]) => {
          const [r, g, b] = rgb.map((v) => {
            const c = v / 255
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const ratio = (a: number[], b: number[]) => {
          const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
          return (l1 + 0.05) / (l2 + 0.05)
        }
        const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().split(/\s+/).map(Number)
        const canvas = v('--c-canvas'), surface = v('--c-surface'), sunken = v('--c-sunken')
        const ink = v('--c-ink'), muted = v('--c-muted'), faint = v('--c-faint'), accentInk = v('--c-accent-ink'), accent = v('--c-accent'), accentFg = v('--c-accent-fg'), danger = v('--c-danger'), warn = v('--c-warn'), info = v('--c-info'), dangerSoft = v('--c-danger-soft'), warnSoft = v('--c-warn-soft'), infoSoft = v('--c-info-soft'), success = v('--c-success'), successSoft = v('--c-success-soft')
        const out: Record<string, number> = {
          'ink/canvas': ratio(ink, canvas),
          'ink/surface': ratio(ink, surface),
          'muted/canvas': ratio(muted, canvas),
          'muted/surface': ratio(muted, surface),
          'muted/sunken': ratio(muted, sunken),
          'faint/canvas': ratio(faint, canvas),
          'faint/surface': ratio(faint, surface),
          'accent-ink/canvas': ratio(accentInk, canvas),
          'accent-fg/accent (primary button)': ratio(accentFg, accent),
          'danger/canvas': ratio(danger, canvas),
          'danger/danger-soft': ratio(danger, dangerSoft),
          'warn/canvas': ratio(warn, canvas),
          'warn/warn-soft': ratio(warn, warnSoft),
          'info/info-soft': ratio(info, infoSoft),
          'success/canvas': ratio(success, canvas),
          'success/success-soft': ratio(success, successSoft),
        }
        for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100
        return out
      })
    }
    const light = await contrast('light')
    const dark = await contrast('dark')
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
    const low: string[] = []
    for (const [theme, table] of [['light', light], ['dark', dark]] as const) for (const [k, r] of Object.entries(table)) if (r < 4.5) low.push(`${theme} ${k} = ${r}:1`)
    log('contrast-light', JSON.stringify(light))
    log('contrast-dark', JSON.stringify(dark))
    if (low.length) findings.push(`contrast below 4.5:1 → ${low.join('; ')}`)

    // Where is faint text actually used for content?
    await page.goto('/')
    const faintUses = await page.evaluate(() => Array.from(document.querySelectorAll('.text-faint')).filter((e) => ((e as HTMLElement).innerText ?? '').trim()).map((e) => `${e.tagName.toLowerCase()}:"${(e as HTMLElement).innerText.trim().slice(0, 30)}"`).slice(0, 12))
    log('faint-text-uses', faintUses.join(' | '))

    for (const f of findings) log('a11y', f)
    expect.soft(findings, 'accessibility findings').toEqual([])
  })
})

/* ======================================================================== */
test.describe('8. responsive', () => {
  test.setTimeout(180_000)
  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`no overflow and no overlapping fixed elements at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await onboard(page, 'sample')
      const kabir = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name.includes('Kabir'))!
      const inv = (await readStore<{ id: string }>(page, 'invoices'))[0]
      const routes = [...ROUTES, `/members/${kabir.id}`, `/members/${kabir.id}?tab=payments`, `/members/${kabir.id}/edit`, `/invoices/${inv.id}`]
      const findings: string[] = []
      for (const route of routes) {
        await page.goto(route)
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(150)
        const r = await page.evaluate(() => {
          const inner = window.innerWidth
          const scrollW = document.documentElement.scrollWidth
          const wide: string[] = []
          const isScrollContainer = (el: Element | null): boolean => {
            while (el && el !== document.body) {
              const s = getComputedStyle(el)
              if (/(auto|scroll)/.test(s.overflowX) || /(auto|scroll)/.test(s.overflow) || s.overflowX === 'hidden' || s.overflow === 'hidden') return true
              el = el.parentElement
            }
            return false
          }
          for (const el of Array.from(document.querySelectorAll('body *'))) {
            const h = el as HTMLElement
            if (h.closest('.sr-only') || h.classList.contains('sr-only')) continue
            const rect = h.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) continue
            const s = getComputedStyle(h)
            if (s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed' && s.transform !== 'none') continue
            if (rect.right > inner + 0.5 && !isScrollContainer(h.parentElement)) wide.push(`${h.tagName.toLowerCase()}.${(h.className || '').toString().split(' ').slice(0, 3).join('.')} right=${Math.round(rect.right)}`)
          }
          const fixed = Array.from(document.querySelectorAll('body *')).filter((el) => getComputedStyle(el).position === 'fixed').map((el) => {
            const r = el.getBoundingClientRect()
            return { tag: `${el.tagName.toLowerCase()}#${el.id}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}`, x: r.x, y: r.y, w: r.width, h: r.height }
          }).filter((f) => f.w > 0 && f.h > 0)
          const overlaps: string[] = []
          for (let i = 0; i < fixed.length; i++)
            for (let j = i + 1; j < fixed.length; j++) {
              const a = fixed[i], b = fixed[j]
              const ov = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
              if (ov) overlaps.push(`${a.tag} ∩ ${b.tag}`)
            }
          return { inner, scrollW, wide: wide.slice(0, 5), overlaps }
        })
        if (r.scrollW > r.inner) findings.push(`${route}: scrollWidth ${r.scrollW} > innerWidth ${r.inner}`)
        if (r.wide.length) findings.push(`${route}: elements past the viewport: ${r.wide.join(' | ')}`)
        if (r.overlaps.length) findings.push(`${route}: fixed overlaps ${r.overlaps.join(' | ')}`)
      }
      for (const f of findings) log('responsive', f)
      expect(findings).toEqual([])
    })
  }
})

/* ======================================================================== */
test.describe('9. console hygiene', () => {
  test.setTimeout(180_000)
  test('no console errors or page errors on any route (empty and sample)', async ({ page, problems }) => {
    await onboard(page, 'empty')
    for (const r of ROUTES) {
      await page.goto(r)
      await page.waitForLoadState('networkidle')
    }
    await page.goto('/nope')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Load sample data' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Load sample data' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Sample data loaded' })).toBeVisible()
    const kabir = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name.includes('Kabir'))!
    const inv = (await readStore<{ id: string }>(page, 'invoices'))[0]
    for (const r of [...ROUTES, `/members/${kabir.id}`, `/members/${kabir.id}/edit`, `/invoices/${inv.id}`]) {
      await page.goto(r)
      await page.waitForLoadState('networkidle')
    }
    expect(problems.errors).toEqual([])
  })
})
