import { test, expect, type Page, type Locator } from '@playwright/test'
import { onboard, createPlan, addMember, sellMembership, readStore, inr } from '../helpers'
import { addDays, todayInTz, formatDate, instantToDateInTz } from '../../src/domain/dates'
import { expiryMessage } from '../../src/domain/whatsapp'

const TZ = 'Asia/Kolkata'
const today = () => todayInTz(TZ)
const dateOf = (iso: string) => instantToDateInTz(iso, TZ)

// ---------- console / pageerror guard (requirement 6) ----------
const consoleErrors: string[] = []
test.beforeEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000)
  consoleErrors.length = 0
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`)
  })
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
})
test.afterEach(async () => {
  expect(consoleErrors, 'no console errors or page errors').toEqual([])
})

// ---------- helpers ----------
async function putStore(page: Page, store: string, rows: unknown[]) {
  await page.evaluate(
    ({ s, r }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('gymbook')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(s, 'readwrite')
          const os = tx.objectStore(s)
          for (const row of r) os.put(row)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    { s: store, r: rows },
  )
}

const stamp = (prefix: string, extra: object, i: number) => {
  const now = new Date().toISOString()
  return { id: `${prefix}_test${i}_${Math.random().toString(36).slice(2, 8)}`, createdAt: now, updatedAt: now, rev: 1, ...extra }
}

function statCard(page: Page, label: string): Locator {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.getByRole('main').locator('p', { hasText: new RegExp(`^${esc}$`) }).first().locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
}

async function pickMember(page: Page, scope: Page | Locator, name: string) {
  const clear = scope.getByRole('button', { name: 'Clear selected member' })
  if (await clear.count()) await clear.click()
  const box = scope.locator('input[role=combobox]')
  await box.fill(name)
  await scope.getByRole('option', { name: new RegExp(name) }).click()
}

/** Minimal RFC4180 parser (handles quotes, embedded commas/newlines, CRLF and BOM). */
function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\r') {
      /* skip */
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

async function downloadCsv(page: Page, button: string): Promise<{ name: string; rows: string[][]; text: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()])
  const text = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))
  return { name: download.suggestedFilename(), rows: parseCsv(text), text }
}

/** Sell a plan to the member currently open, starting on a custom date. */
async function sellWithStart(page: Page, startDate: string) {
  await page.getByRole('button', { name: /Sell membership|Renew/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /Pick a date/ }).click()
  await dialog.getByLabel(/^Start date/).fill(startDate)
  await dialog.getByRole('button', { name: /Sell and create invoice|Renew and create invoice/ }).click()
  await expect(page).toHaveURL(/\/invoices\/inv_/)
}

type Att = { id: string; memberId: string; checkInAt: string; checkOutAt: string | null; overrideReason?: string; rev: number }

// =====================================================================
// 1. ATTENDANCE
// =====================================================================
test.describe('attendance', () => {
  test('check-in by keyboard and mouse, archived not pickable, upcoming → override, counts match store', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Kiran Das', '98200 00003')
    await sellMembership(page, { receivedNow: '1500' })
    await addMember(page, 'Mona Roy', '98200 00009')
    await sellMembership(page, { receivedNow: '1500' })
    const archUrl = await addMember(page, 'Archie Old', '98200 00010')
    await page.goto(archUrl)
    await page.getByRole('button', { name: 'Archive' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByText('Archived', { exact: true }).first()).toBeVisible()
    await addMember(page, 'Futura Soon', '98200 00011')
    await sellWithStart(page, addDays(today(), 1))

    // ?action=checkin focuses the search and strips the param
    await page.goto('/attendance?action=checkin')
    await expect(page.getByRole('combobox')).toBeFocused()
    await expect(page).toHaveURL(/\/attendance$/)

    // keyboard: type, ArrowDown, Enter
    const box = page.getByRole('combobox')
    await box.fill('Kir')
    await expect(page.getByRole('option', { name: /Kiran Das/ })).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Clear selected member' })).toBeVisible()
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Kiran Das checked in' })).toBeVisible()
    // selection is cleared after check-in
    await expect(page.getByRole('combobox')).toBeVisible()

    // mouse
    await pickMember(page, page, 'Mona')
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Mona Roy checked in' })).toBeVisible()

    // archived member not pickable
    await page.getByRole('combobox').fill('Archie')
    await expect(page.getByText('No members match.')).toBeVisible()
    await expect(page.getByRole('option')).toHaveCount(0)

    // upcoming membership → override dialog, empty/whitespace reason keeps button disabled
    await pickMember(page, page, 'Futura')
    await expect(page.getByText('Starts later', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/starts/)).toBeVisible()
    await expect(page.getByText('No active membership today')).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'No active membership' })).toBeVisible()
    await expect(dialog).toContainText('Futura Soon has no active membership today')
    const allow = dialog.getByRole('button', { name: 'Allow entry anyway' })
    await expect(allow).toBeDisabled()
    await dialog.getByLabel(/^Reason for allowing entry/).fill('   ')
    await expect(allow).toBeDisabled()
    await dialog.getByLabel(/^Reason for allowing entry/).fill('  Starts tomorrow, owner OK  ')
    await expect(allow).toBeEnabled()
    await allow.click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Futura Soon checked in' })).toBeVisible()

    // store vs UI counts
    let att = await readStore<Att>(page, 'attendance')
    expect(att).toHaveLength(3)
    const futura = att.find((a) => a.overrideReason)
    expect(futura?.overrideReason).toBe('Starts tomorrow, owner OK')
    expect(att.every((a) => a.checkOutAt === null)).toBe(true)
    const inside = att.filter((a) => a.checkOutAt === null).length
    const visitsToday = att.filter((a) => dateOf(a.checkInAt) === today()).length
    await expect(statCard(page, 'In the gym now')).toContainText(String(inside))
    await expect(statCard(page, 'Visits today')).toContainText(String(visitsToday))
    await expect(page.getByText('3 visits on')).toBeVisible()
    // history shows the override reason
    await expect(page.getByText('Override: Starts tomorrow, owner OK')).toBeVisible()

    // check out from "Currently inside" (newest first → Futura)
    const insideList = page.getByRole('heading', { name: 'Currently inside' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    await expect(insideList.getByRole('listitem')).toHaveCount(3)
    await insideList.getByRole('listitem').filter({ hasText: 'Mona Roy' }).getByRole('button', { name: 'Out' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Mona Roy checked out' })).toBeVisible()
    await expect(insideList.getByRole('listitem')).toHaveCount(2)
    await expect(statCard(page, 'In the gym now')).toContainText('2')
    await expect(statCard(page, 'Visits today')).toContainText('3')
    att = await readStore<Att>(page, 'attendance')
    const mona = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name === 'Mona Roy')!
    expect(att.find((a) => a.memberId === mona.id)?.checkOutAt).not.toBeNull()

    // check out from member detail
    const kiran = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name === 'Kiran Das')!
    await page.goto(`/members/${kiran.id}`)
    await page.getByRole('button', { name: 'Check out' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Kiran Das checked out' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible()
    att = await readStore<Att>(page, 'attendance')
    expect(att.find((a) => a.memberId === kiran.id)?.checkOutAt).not.toBeNull()
    expect(att.filter((a) => a.checkOutAt === null)).toHaveLength(1)

    // check in again from member detail works after checkout (no duplicate open visit)
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Kiran Das checked in' })).toBeVisible()
    att = await readStore<Att>(page, 'attendance')
    expect(att.filter((a) => a.memberId === kiran.id)).toHaveLength(2)
    await page.goto('/attendance')
    await expect(statCard(page, 'Visits today')).toContainText('4')
    await expect(statCard(page, 'In the gym now')).toContainText('2')
  })

  test('history range: Today / 7 days, custom range, from > to, daily total chips', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Hist Member', '98200 00020')
    await sellMembership(page, { receivedNow: '1500' })
    const member = (await readStore<{ id: string }>(page, 'members'))[0]
    const t = today()
    const at = (date: string, h: number) => new Date(`${date}T${String(h).padStart(2, '0')}:00:00+05:30`).toISOString()
    const rows = [
      stamp('att', { memberId: member.id, checkInAt: at(t, 7), checkOutAt: at(t, 8), source: 'manual' }, 1),
      stamp('att', { memberId: member.id, checkInAt: at(addDays(t, -1), 7), checkOutAt: at(addDays(t, -1), 8), source: 'manual' }, 2),
      stamp('att', { memberId: member.id, checkInAt: at(addDays(t, -1), 18), checkOutAt: at(addDays(t, -1), 19), source: 'manual' }, 3),
      stamp('att', { memberId: member.id, checkInAt: at(addDays(t, -6), 7), checkOutAt: at(addDays(t, -6), 8), source: 'manual' }, 4),
      stamp('att', { memberId: member.id, checkInAt: at(addDays(t, -7), 7), checkOutAt: at(addDays(t, -7), 8), source: 'manual' }, 5),
      stamp('att', { memberId: member.id, checkInAt: at(addDays(t, -40), 7), checkOutAt: at(addDays(t, -40), 8), source: 'manual' }, 6),
    ]
    await putStore(page, 'attendance', rows)
    await page.goto('/attendance')

    // default = today
    await expect(page.getByText(`1 visit on ${formatDate(t)}`)).toBeVisible()
    await expect(statCard(page, 'Visits today')).toContainText('1')
    await expect(page.locator('button', { hasText: '·' })).toHaveCount(0) // no chips for a single day

    // 7 days
    await page.getByRole('button', { name: '7 days' }).click()
    await expect(page).toHaveURL(new RegExp(`from=${addDays(t, -6)}&to=${t}`))
    await expect(page.getByText(`4 visits from ${formatDate(addDays(t, -6))} to ${formatDate(t)}`)).toBeVisible()
    const chips = page.getByRole('button').filter({ hasText: /\d{4} · \d/ })
    await expect(chips).toHaveCount(3)
    await expect(chips.nth(0)).toHaveText(`${formatDate(t)} · 1`)
    await expect(chips.nth(1)).toHaveText(`${formatDate(addDays(t, -1))} · 2`)
    await expect(chips.nth(2)).toHaveText(`${formatDate(addDays(t, -6))} · 1`)
    // chip click narrows to that day
    await chips.nth(1).click()
    await expect(page).toHaveURL(new RegExp(`from=${addDays(t, -1)}&to=${addDays(t, -1)}`))
    await expect(page.getByText(`2 visits on ${formatDate(addDays(t, -1))}`)).toBeVisible()
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(3) // header + 2

    // Today
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(page.getByText(`1 visit on ${formatDate(t)}`)).toBeVisible()

    // custom range covering everything
    await page.getByLabel('From date').fill(addDays(t, -45))
    await expect(page.getByText(`6 visits from ${formatDate(addDays(t, -45))} to ${formatDate(t)}`)).toBeVisible()
    await page.getByLabel('To date').fill(addDays(t, -7))
    await expect(page.getByText(`2 visits from ${formatDate(addDays(t, -45))} to ${formatDate(addDays(t, -7))}`)).toBeVisible()

    // from > to: moving From past To should drag To along
    await page.getByLabel('From date').fill(addDays(t, -1))
    await expect(page).toHaveURL(new RegExp(`from=${addDays(t, -1)}&to=${addDays(t, -1)}`))
    await expect(page.getByText(`2 visits on ${formatDate(addDays(t, -1))}`)).toBeVisible()

    // to < from via the To input: the UI should not end up with an inverted range
    await page.getByLabel('To date').fill(addDays(t, -6))
    const url = new URL(page.url())
    const from = url.searchParams.get('from')!
    const to = url.searchParams.get('to')!
    expect(to >= from, `inverted range accepted via To input: from=${from} to=${to}`).toBe(true)
    // An earlier "To" collapses the range onto the From day instead of inverting it.
    await expect(page.getByText(new RegExp(`^\\d+ visits? on ${formatDate(addDays(t, -1))}$`))).toBeVisible()

    // invalid URL params fall back to today
    await page.goto('/attendance?from=2026-13-45&to=garbage')
    await expect(page.getByText(`1 visit on ${formatDate(t)}`)).toBeVisible()
    // to < from in the URL
    await page.goto(`/attendance?from=${t}&to=${addDays(t, -3)}`)
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
    await expect(page.getByText(/^\d+ visits? (on|from)/)).toBeVisible()
    await expect.soft(page.getByText(/^0 visits from/), 'inverted range from URL rendered').toHaveCount(0, { timeout: 1500 })
  })
})

// =====================================================================
// 2. TRAINERS
// =====================================================================
test.describe('follow-ups', () => {
  type FU = { id: string; type: string; memberId?: string; leadName?: string; leadPhone?: string; leadEmail?: string; dueDate: string; status: string; completedAt?: string; note?: string; assignee?: string; rev: number }

  test('validation, lifecycle (create/edit/reschedule/done/reopen/delete), badges', async ({ page }) => {
    await onboard(page, 'empty')
    await addMember(page, 'Member One', '98200 00040')
    const member = (await readStore<{ id: string }>(page, 'members'))[0]
    await page.goto('/follow-ups')
    await expect(page.getByText('Nothing to follow up')).toBeVisible()
    await page.getByRole('button', { name: 'New follow-up' }).first().click()
    let d = page.getByRole('dialog')
    const typeSel = () => d.getByLabel(/^Type/)
    await expect(typeSel()).toHaveValue('expiry')
    await expect(d.getByLabel(/^Due date/)).toHaveValue(today())
    // member types require a member
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d.getByText('Choose a member')).toBeVisible()
    await typeSel().selectOption('payment')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d.getByText('Choose a member')).toBeVisible()
    // lead requires a lead name, member picker hidden
    await typeSel().selectOption('lead')
    await expect(d.getByPlaceholder(/Search by name/)).toHaveCount(0)
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d.getByText('Enter the lead’s name')).toBeVisible()
    await d.getByLabel(/^Lead name/).fill('   ')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d.getByText('Enter the lead’s name')).toBeVisible()
    // bad lead email
    await d.getByLabel(/^Lead name/).fill('Lead Person')
    await d.getByLabel(/^Email/).fill('nope')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d.getByText('Enter a valid email address')).toBeVisible()
    await d.getByLabel(/^Email/).fill('lead@example.com')
    // due date validation
    await d.getByLabel(/^Due date/).fill('')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d.getByText('Enter a valid date')).toBeVisible()
    expect(await readStore(page, 'followups')).toHaveLength(0)
    await d.getByLabel(/^Due date/).fill(addDays(today(), -1))
    await d.getByLabel(/^Phone/).fill('98100 00099')
    await d.getByLabel(/^Assignee/).fill('Reception')
    await d.getByLabel(/^Note/).fill('Asked about timings')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Follow-up added' })).toBeVisible()
    let fus = await readStore<FU>(page, 'followups')
    expect(fus).toHaveLength(1)
    expect(fus[0]).toMatchObject({ type: 'lead', leadName: 'Lead Person', leadPhone: '98100 00099', leadEmail: 'lead@example.com', dueDate: addDays(today(), -1), status: 'open', assignee: 'Reception', note: 'Asked about timings' })
    expect(fus[0].memberId).toBeUndefined()
    const leadItem = page.getByRole('listitem').filter({ hasText: 'Lead Person' })
    await expect(leadItem.getByText('Overdue')).toBeVisible()
    await expect(leadItem).toContainText(`Due ${formatDate(addDays(today(), -1))} · Reception · 98100 00099`)
    await expect(page.getByRole('tab', { name: /Open/ })).toContainText('1')

    // "other" type needs no member; due today → badge
    await page.getByRole('button', { name: 'New follow-up' }).first().click()
    d = page.getByRole('dialog')
    await typeSel().selectOption('other')
    await d.getByLabel(/^Note/).fill('Order towels')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d).toBeHidden()
    const otherItem = page.getByRole('listitem').filter({ hasText: 'Order towels' })
    await expect(otherItem.getByText('Due today')).toBeVisible()
    await expect(otherItem.getByRole('link')).toHaveCount(0)
    // an "Other" follow-up with no member is labelled "Lead" (contactFor falls back to leadName ?? 'Lead')
    await expect.soft(otherItem.locator('p').first(), '"Other" follow-up without a member is shown with the name "Lead"').not.toContainText('Lead', { timeout: 1500 })

    // member follow-up for tomorrow → no badge
    await page.getByRole('button', { name: 'New follow-up' }).first().click()
    d = page.getByRole('dialog')
    await typeSel().selectOption('expiry')
    await pickMember(page, d, 'Member One')
    await d.getByLabel(/^Due date/).fill(addDays(today(), 1))
    await d.getByLabel(/^Note/).fill('Renew soon')
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d).toBeHidden()
    const memItem = page.getByRole('listitem').filter({ hasText: 'Renew soon' })
    await expect(memItem.getByText('Overdue')).toHaveCount(0)
    await expect(memItem.getByText('Due today')).toHaveCount(0)
    await expect(memItem.getByRole('link', { name: 'Member One' })).toBeVisible()
    fus = await readStore<FU>(page, 'followups')
    expect(fus.find((f) => f.note === 'Renew soon')).toMatchObject({ type: 'expiry', memberId: member.id, dueDate: addDays(today(), 1) })
    // sorted by due date: overdue lead first, today second, tomorrow last
    const items = page.getByRole('heading', { name: 'To do' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]').getByRole('listitem')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText('Lead Person')
    await expect(items.nth(1)).toContainText('Order towels')
    await expect(items.nth(2)).toContainText('Renew soon')

    // type filter
    await page.getByLabel('Type', { exact: true }).selectOption('lead')
    await expect(items).toHaveCount(1)
    await page.getByLabel('Type', { exact: true }).selectOption('all')

    // edit
    await leadItem.getByRole('button', { name: 'Edit' }).click()
    d = page.getByRole('dialog')
    await expect(d.getByRole('heading', { name: 'Edit follow-up' })).toBeVisible()
    await expect(d.getByLabel(/^Lead name/)).toHaveValue('Lead Person')
    await d.getByLabel(/^Note/).fill('Asked about yoga timings')
    await d.getByRole('button', { name: 'Save' }).click()
    await expect(d).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Follow-up updated' })).toBeVisible()
    fus = await readStore<FU>(page, 'followups')
    expect(fus.find((f) => f.leadName === 'Lead Person')).toMatchObject({ note: 'Asked about yoga timings', rev: 2 })

    // switching type from member → lead should not keep the stale member link
    await memItem.getByRole('button', { name: 'Edit' }).click()
    d = page.getByRole('dialog')
    await expect(d.getByRole('button', { name: 'Clear selected member' })).toBeVisible()
    await typeSel().selectOption('lead')
    await d.getByLabel(/^Lead name/).fill('Converted Lead')
    await d.getByRole('button', { name: 'Save' }).click()
    await expect(d).toBeHidden()
    fus = await readStore<FU>(page, 'followups')
    const converted = fus.find((f) => f.leadName === 'Converted Lead')!
    expect(converted.type).toBe('lead')
    expect.soft(converted.memberId, 'lead follow-up still carries memberId after type switch').toBeUndefined()
    await expect.soft(page.getByRole('listitem').filter({ hasText: 'Renew soon' }), 'list still shows the member for a lead follow-up').toContainText('Converted Lead', { timeout: 1500 })

    // reschedule: +1 / +3 / +7 relative to today, then custom
    await leadItem.getByRole('button', { name: 'Reschedule' }).click()
    d = page.getByRole('dialog')
    await expect(d.getByRole('heading', { name: 'Reschedule follow-up' })).toBeVisible()
    await expect(d.getByLabel(/^New due date/)).toHaveValue(addDays(today(), 1)) // overdue → tomorrow
    await d.getByRole('button', { name: '+3 days' }).click()
    await expect(d.getByLabel(/^New due date/)).toHaveValue(addDays(today(), 3))
    await d.getByRole('button', { name: '+7 days' }).click()
    await expect(d.getByLabel(/^New due date/)).toHaveValue(addDays(today(), 7))
    await d.getByRole('button', { name: '+1 day' }).click()
    await expect(d.getByLabel(/^New due date/)).toHaveValue(addDays(today(), 1))
    // empty date must be refused
    await d.getByLabel(/^New due date/).fill('')
    await d.getByRole('button', { name: 'Reschedule' }).click()
    fus = await readStore<FU>(page, 'followups')
    const leadNow = fus.find((f) => f.leadName === 'Lead Person')!
    expect.soft(leadNow.dueDate, 'reschedule accepted an empty date').toBe(addDays(today(), -1))
    if (await d.isVisible()) {
      await d.getByLabel(/^New due date/).fill(addDays(today(), 10))
      await d.getByRole('button', { name: 'Reschedule' }).click()
      await expect(d).toBeHidden()
    } else {
      await leadItem.getByRole('button', { name: 'Reschedule' }).click()
      d = page.getByRole('dialog')
      await d.getByLabel(/^New due date/).fill(addDays(today(), 10))
      await d.getByRole('button', { name: 'Reschedule' }).click()
      await expect(d).toBeHidden()
    }
    await expect(page.getByRole('status').filter({ hasText: `Rescheduled to ${formatDate(addDays(today(), 10))}` })).toBeVisible()
    fus = await readStore<FU>(page, 'followups')
    expect(fus.find((f) => f.leadName === 'Lead Person')?.dueDate).toBe(addDays(today(), 10))
    await expect(leadItem.getByText('Overdue')).toHaveCount(0)
    // reschedule of a non-overdue item defaults to the day after its due date
    await leadItem.getByRole('button', { name: 'Reschedule' }).click()
    d = page.getByRole('dialog')
    await expect(d.getByLabel(/^New due date/)).toHaveValue(addDays(today(), 11))
    await d.getByRole('button', { name: 'Cancel' }).click()
    await expect(d).toBeHidden()

    // done → Done tab → reopen → delete
    await otherItem.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Marked done' })).toBeVisible()
    await expect(otherItem).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /Open/ })).toContainText('2')
    await expect(page.getByRole('tab', { name: /Done/ })).toContainText('1')
    fus = await readStore<FU>(page, 'followups')
    const done = fus.find((f) => f.note === 'Order towels')!
    expect(done.status).toBe('done')
    expect(done.completedAt).toBeTruthy()
    await page.getByRole('tab', { name: /Done/ }).click()
    const doneItem = page.getByRole('listitem').filter({ hasText: 'Order towels' })
    await expect(doneItem).toContainText(`Completed ${formatDate(dateOf(done.completedAt!))}`)
    await expect(doneItem.getByRole('button', { name: 'Done' })).toHaveCount(0)
    await doneItem.getByRole('button', { name: 'Reopen' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Reopened' })).toBeVisible()
    fus = await readStore<FU>(page, 'followups')
    expect(fus.find((f) => f.note === 'Order towels')).toMatchObject({ status: 'open' })
    expect(fus.find((f) => f.note === 'Order towels')?.completedAt).toBeUndefined()
    await expect(page.getByText('No completed follow-ups')).toBeVisible()
    await page.getByRole('tab', { name: /Open/ }).click()
    await otherItem.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('tab', { name: /Done/ }).click()
    await doneItem.getByRole('button', { name: 'Delete' }).click()
    d = page.getByRole('dialog')
    await expect(d.getByRole('heading', { name: 'Delete this follow-up?' })).toBeVisible()
    await d.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Deleted' })).toBeVisible()
    fus = await readStore<FU>(page, 'followups')
    expect(fus).toHaveLength(2)
    expect(fus.some((f) => f.note === 'Order towels')).toBe(false)
  })

  test('upcoming expiries: windows, renewed and lapsed members, contact links, add follow-up', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/follow-ups')
    const card = page.getByRole('heading', { name: 'Upcoming expiries' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    await expect(card.getByRole('heading', { name: 'No memberships end in the next 7 days' })).toBeVisible()

    const t = today()
    let n = 0
    const member = (name: string, extra: object = {}) => stamp('mem', { name, phone: `98200 001${String(++n).padStart(2, '0')}`, joiningDate: addDays(t, -90), status: 'active', ...extra }, n)
    const cover = (memberId: string, start: number, end: number, extra: object = {}) =>
      stamp('ms', { memberId, planId: 'plan_x', planName: 'Monthly', durationValue: 1, durationUnit: 'months', startDate: addDays(t, start), endDate: addDays(t, end), listPricePaise: 150000, discountPaise: 0, pricePaise: 150000, invoiceId: 'inv_x', ...extra }, ++n)
    const asha = member('Asha Today')
    const bala = member('Bala Tomorrow')
    const chitra = member('Chitra Week')
    const dev = member('Dev Eight')
    const esha = member('Esha Month')
    const farid = member('Farid Far')
    const gita = member('Gita Renewed')
    const hari = member('Hari Lapsed')
    const indu = member('Indu Archived', { status: 'archived' })
    const jai = member('Jai Cancelled')
    const extras = [member('Kavya Twenty'), member('Lata Twentyone'), member('Mohan Twentytwo')]
    const gitaFirst = cover(gita.id, -27, 2)
    await putStore(page, 'members', [asha, bala, chitra, dev, esha, farid, gita, hari, indu, jai, ...extras])
    await putStore(page, 'memberships', [
      cover(asha.id, -29, 0),
      cover(bala.id, -28, 1),
      cover(chitra.id, -22, 7),
      cover(dev.id, -21, 8),
      cover(esha.id, 1, 30),
      cover(farid.id, 2, 31),
      gitaFirst,
      cover(gita.id, 3, 33, { renewalOfId: gitaFirst.id }),
      cover(hari.id, -30, -1),
      cover(indu.id, -26, 3),
      cover(jai.id, -25, 4, { cancelledAt: new Date().toISOString(), cancelReason: 'Invoice voided' }),
      ...extras.map((m, i) => cover(m.id, -9 + i, 20 + i)),
    ])
    await page.reload()

    const rows = card.getByRole('listitem')
    const names = async () => (await rows.locator('a[href^="/members/"]').allTextContents()).map((x) => x.trim())
    // 7 days: today, tomorrow and day 7, soonest first. Renewed, lapsed, archived, cancelled and later ones are out.
    await expect(rows).toHaveCount(3)
    expect(await names()).toEqual(['Asha Today', 'Bala Tomorrow', 'Chitra Week'])
    await expect(rows.nth(0)).toContainText('Ends today')
    await expect(rows.nth(1)).toContainText('Ends tomorrow')
    await expect(rows.nth(2)).toContainText('7 days left')
    await expect(rows.nth(2)).toContainText(`Monthly · ends ${formatDate(addDays(t, 7))}`)
    await expect(card.getByRole('button', { name: /Show all/ })).toHaveCount(0)

    // 15 days adds day 8 only
    await card.getByRole('tab', { name: '15 days' }).click()
    await expect(rows).toHaveCount(4)
    expect(await names()).toEqual(['Asha Today', 'Bala Tomorrow', 'Chitra Week', 'Dev Eight'])
    await expect(rows.nth(3)).toContainText('8 days left')

    // 30 days: 8 members, six shown until "Show all"; day 31 and the renewed member stay out
    await card.getByRole('tab', { name: '30 days' }).click()
    await expect(card).toContainText('Memberships ending in the next 30 days')
    await expect(rows).toHaveCount(6)
    await card.getByRole('button', { name: 'Show all 8' }).click()
    await expect(rows).toHaveCount(8)
    expect(await names()).toEqual(['Asha Today', 'Bala Tomorrow', 'Chitra Week', 'Dev Eight', 'Kavya Twenty', 'Lata Twentyone', 'Mohan Twentytwo', 'Esha Month'])
    for (const out of ['Farid Far', 'Gita Renewed', 'Hari Lapsed', 'Indu Archived', 'Jai Cancelled']) await expect(card.getByText(out)).toHaveCount(0)
    await card.getByRole('button', { name: 'Show fewer' }).click()
    await expect(rows).toHaveCount(6)
    await card.getByRole('tab', { name: '7 days' }).click()
    await expect(rows).toHaveCount(3)

    // contact links
    const ashaRow = rows.filter({ hasText: 'Asha Today' })
    const digits = asha.phone.replace(/\D/g, '')
    await expect(ashaRow.getByRole('link', { name: 'Call' })).toHaveAttribute('href', `tel:${digits}`)
    const wa = new URL((await ashaRow.getByRole('link', { name: 'WhatsApp' }).getAttribute('href'))!)
    expect(wa.origin + wa.pathname).toBe('https://api.whatsapp.com/send')
    expect(wa.searchParams.get('phone')).toBe(`91${digits}`)
    expect(wa.searchParams.get('text')).toBe(expiryMessage({ gymName: 'Test Gym', gymPhone: (await readStore<{ phone?: string }>(page, 'settings'))[0].phone, memberName: 'Asha Today', planName: 'Monthly', endDate: t, today: t }))
    expect(wa.searchParams.get('text')).toContain('Hi Asha Today 👋\n⏳ Your *Monthly* membership ends *today*.')
    await expect(ashaRow.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('rel', /noopener/)
    const waWeek = new URL((await rows.filter({ hasText: 'Chitra Week' }).getByRole('link', { name: 'WhatsApp' }).getAttribute('href'))!)
    expect(waWeek.searchParams.get('text')).toContain(`⏳ Your *Monthly* membership ends on *${formatDate(addDays(t, 7))}* (7 days left).`)

    // the same reminder in Marathi, one tap away
    const mrLink = ashaRow.getByRole('link', { name: 'मराठी' })
    const mr = new URL((await mrLink.getAttribute('href'))!)
    expect(mr.origin + mr.pathname).toBe('https://api.whatsapp.com/send')
    expect(mr.searchParams.get('phone')).toBe(`91${digits}`)
    expect(mr.searchParams.get('text')).toBe(expiryMessage({ gymName: 'Test Gym', gymPhone: (await readStore<{ phone?: string }>(page, 'settings'))[0].phone, memberName: 'Asha Today', planName: 'Monthly', endDate: t, today: t, lang: 'mr' }))
    expect(mr.searchParams.get('text')).toContain('नमस्कार Asha Today 👋\n⏳ आपले *Monthly* सदस्यत्व *आज* संपत आहे.')
    await expect(mrLink).toHaveAttribute('target', '_blank')
    await expect(mrLink).toHaveAttribute('rel', /noopener/)
    await expect(rows.getByRole('link', { name: 'मराठी' })).toHaveCount(3)
    // the extra button does not push a phone-width row off screen
    const size = page.viewportSize()!
    await page.setViewportSize({ width: 375, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await expect(mrLink).toBeVisible()
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/expiry-phone.png` })
    await page.setViewportSize(size)

    // the lapsed member is offered under Suggested instead; members still covered are not
    const suggested = page.getByRole('heading', { name: 'Suggested' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    await expect(suggested.getByRole('listitem')).toHaveCount(1)
    await expect(suggested.getByRole('listitem')).toContainText(`Hari Lapsed · Monthly ended ${formatDate(addDays(t, -1))}`)

    // add a follow-up from a row: prefilled, then the row shows it is already covered
    const balaRow = rows.filter({ hasText: 'Bala Tomorrow' })
    await balaRow.getByRole('button', { name: 'Add follow-up' }).click()
    const d = page.getByRole('dialog')
    await expect(d.getByLabel(/^Type/)).toHaveValue('expiry')
    await expect(d.getByText('Bala Tomorrow', { exact: true })).toBeVisible()
    await expect(d.getByLabel(/^Due date/)).toHaveValue(t)
    await expect(d.getByLabel(/^Note/)).toHaveValue(`Monthly ends ${formatDate(addDays(t, 1))}; offer renewal`)
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d).toBeHidden()
    const fus = await readStore<FU>(page, 'followups')
    expect(fus).toHaveLength(1)
    expect(fus[0]).toMatchObject({ type: 'expiry', memberId: bala.id, status: 'open', dueDate: t })
    await expect(balaRow).toContainText('Follow-up open')
    await expect(balaRow.getByRole('button', { name: 'Add follow-up' })).toHaveCount(0)
    await expect(ashaRow.getByRole('button', { name: 'Add follow-up' })).toBeVisible()

    // once it is done the row can get a new one; the section is only on the Open tab
    const todo = page.getByRole('heading', { name: 'To do' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    await todo.getByRole('listitem').filter({ hasText: 'Bala Tomorrow' }).getByRole('button', { name: 'Done' }).click()
    await expect(balaRow.getByRole('button', { name: 'Add follow-up' })).toBeVisible()
    await expect(balaRow).not.toContainText('Follow-up open')
    await page.getByRole('tab', { name: /^Done/ }).click()
    await expect(page.getByRole('heading', { name: 'Upcoming expiries' })).toHaveCount(0)

    // phone width: no horizontal overflow
    await page.getByRole('tab', { name: /^Open/ }).click()
    await page.setViewportSize({ width: 375, height: 800 })
    await card.getByRole('tab', { name: '30 days' }).click()
    await expect(rows).toHaveCount(6)
    const { scrollW, inner } = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, inner: window.innerWidth }))
    expect(scrollW).toBeLessThanOrEqual(inner)
  })

  test('suggested section (sample data) and contact link hrefs', async ({ page }) => {
    await onboard(page, 'sample')
    const t = today()
    type M = { id: string; name: string; phone: string; status: string }
    const members = await readStore<M>(page, 'members')
    const memberships = await readStore<{ memberId: string; startDate: string; endDate: string }>(page, 'memberships')

    await page.goto('/follow-ups')
    const suggested = page.getByRole('heading', { name: 'Suggested' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    await expect(suggested).toBeVisible()
    // Balances are not chased from here any more: no "Payment" suggestions, only lapsed plans.
    await expect(suggested.getByRole('listitem').filter({ hasText: 'Payment' })).toHaveCount(0)
    // an expiring member (Diya) already has an open expiry follow-up so must not be suggested; Vihaan's trial ended within 14 days → suggested
    const vihaan = members.find((m) => m.name.includes('Vihaan'))!
    const vMs = memberships.find((ms) => ms.memberId === vihaan.id)!
    await expect(suggested.getByRole('listitem').filter({ hasText: 'Vihaan' })).toContainText(`10-day trial ended ${formatDate(vMs.endDate)}`)
    await expect(suggested.getByRole('listitem').filter({ hasText: 'Diya' })).toHaveCount(0)

    // add a prefilled expiry follow-up from the suggestion
    const vLi = suggested.getByRole('listitem').filter({ hasText: 'Vihaan' })
    await vLi.getByRole('button', { name: 'Add' }).click()
    const d = page.getByRole('dialog')
    await expect(d.getByLabel(/^Type/)).toHaveValue('expiry')
    await expect(d.getByText(vihaan.name, { exact: true })).toBeVisible()
    await expect(d.getByLabel(/^Due date/)).toHaveValue(t)
    await expect(d.getByLabel(/^Note/)).toHaveValue(`10-day trial ended ${formatDate(vMs.endDate)}; offer renewal`)
    await d.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(d).toBeHidden()
    const created = (await readStore<FU>(page, 'followups')).find((f) => f.memberId === vihaan.id && f.type === 'expiry')!
    expect(created).toMatchObject({ status: 'open', dueDate: t })
    // suggestion disappears once a follow-up exists
    await expect(vLi).toHaveCount(0)

    // contact hrefs, on the sample payment follow-up for Kabir
    const target = members.find((m) => m.name.includes('Kabir'))!
    const todo = page.getByRole('heading', { name: 'To do' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    const row = todo.getByRole('listitem').filter({ hasText: target.name }).filter({ hasText: 'Collect remaining' })
    const kabirNote = (await readStore<FU>(page, 'followups')).find((f) => f.memberId === target.id && f.type === 'payment')!.note
    const digits = target.phone.replace(/\D/g, '')
    expect(digits).toHaveLength(10)
    await expect(row.getByRole('link', { name: 'Call' })).toHaveAttribute('href', `tel:${digits}`)
    const wa = await row.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')
    const waUrl = new URL(wa!)
    expect(waUrl.origin + waUrl.pathname).toBe('https://api.whatsapp.com/send')
    expect(waUrl.searchParams.get('phone')).toBe(`91${digits}`)
    expect(waUrl.searchParams.get('text')).toBe(`Hi ${target.name.replace(/^Sample\s+/, '')}, this is Test Gym. ${kabirNote}`)
    await expect(row.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('target', '_blank')
    await expect(row.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('rel', /noopener/)
    // Members no longer carry an email address, so a member row never offers an Email link.
    await expect(row.getByRole('link', { name: 'Email' })).toHaveCount(0)
    await expect(todo.getByRole('listitem').filter({ hasText: 'Kabir' }).getByRole('link', { name: 'Email' })).toHaveCount(0)
    for (const m of await readStore<Record<string, unknown>>(page, 'members')) for (const k of ['email', 'trainerId', 'emergencyName', 'emergencyPhone']) expect(k in m, `${String(m.name)} has ${k}`).toBe(false)

    // lead with +country phone: digits kept as-is, no 91 prefix; 10-digit lead phone gets 91
    const tara = todo.getByRole('listitem').filter({ hasText: 'Tara Menon' })
    await expect(tara.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', /^https:\/\/api\.whatsapp\.com\/send\?phone=919810000099&text=/)
    await expect(tara.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:9810000099')
    await expect(tara.getByRole('link', { name: 'Email' })).toHaveCount(0)
    await page.getByRole('button', { name: 'New follow-up' }).first().click()
    const nd = page.getByRole('dialog')
    await nd.getByLabel(/^Type/).selectOption('lead')
    await nd.getByLabel(/^Lead name/).fill('Intl Lead')
    await nd.getByLabel(/^Phone/).fill('+1 (555) 123-4567')
    await nd.getByLabel(/^Note/).fill('Note with & and ? chars')
    await nd.getByRole('button', { name: 'Add follow-up' }).click()
    await expect(nd).toBeHidden()
    const intl = todo.getByRole('listitem').filter({ hasText: 'Intl Lead' })
    await expect(intl.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+15551234567')
    const intlWa = new URL((await intl.getByRole('link', { name: 'WhatsApp' }).getAttribute('href'))!)
    expect(intlWa.searchParams.get('phone')).toBe('15551234567')
    expect(intlWa.searchParams.get('text')).toBe('Hi Intl Lead, this is Test Gym. Note with & and ? chars')
  })
})

// =====================================================================
// 5. REPORTS
// =====================================================================
test.describe('reports', () => {
  type Pay = { id: string; status: string; receivedAt: string; amountPaise: number; invoiceId?: string; memberId: string; method: string }
  type Inv = { id: string; number: string; status: string; issueDate: string; totalPaise: number; memberId: string; subtotalPaise: number; discountPaise: number }
  type Adj = { invoiceId: string; amountPaise: number; createdAt: string }
  type Ms = { memberId: string; createdAt: string; renewalOfId?: string }
  type Att = { memberId: string; checkInAt: string; checkOutAt: string | null }

  test('stat cards and attendance summary match IndexedDB for the default period', async ({ page }) => {
    await onboard(page, 'sample')
    const t = today()
    const start = t.slice(0, 7) + '-01'
    const [payments, invoices, adjustments, memberships, attendance] = await Promise.all([
      readStore<Pay>(page, 'payments'),
      readStore<Inv>(page, 'invoices'),
      readStore<Adj>(page, 'adjustments'),
      readStore<Ms>(page, 'memberships'),
      readStore<Att>(page, 'attendance'),
    ])
    const inP = (d: string) => d >= start && d <= t
    const recv = payments.filter((p) => p.status === 'recorded' && inP(dateOf(p.receivedAt)))
    const received = recv.reduce((s, p) => s + p.amountPaise, 0)
    const inv = invoices.filter((i) => i.status === 'issued' && inP(i.issueDate))
    const invoiced = inv.reduce((s, i) => s + i.totalPaise, 0)
    const visits = attendance.filter((a) => inP(dateOf(a.checkInAt)))
    const unique = new Set(visits.map((a) => a.memberId)).size
    const newMs = memberships.filter((m) => !m.renewalOfId && inP(dateOf(m.createdAt))).length
    const renewals = memberships.filter((m) => m.renewalOfId && inP(dateOf(m.createdAt))).length
    expect(received).toBeGreaterThan(0)

    await page.goto('/reports')
    await expect(page.getByText(`${formatDate(start)} – ${formatDate(t)} · Asia/Kolkata`)).toBeVisible()
    await expect(statCard(page, 'Revenue received')).toContainText(inr(received))
    await expect(statCard(page, 'Revenue received')).toContainText(`${recv.length} payment${recv.length === 1 ? '' : 's'}`)
    await expect(statCard(page, 'Invoiced')).toContainText(inr(invoiced))
    await expect(statCard(page, 'Invoiced')).toContainText(`${inv.length} invoice${inv.length === 1 ? '' : 's'} issued`)
    await expect(page.getByRole('main')).not.toContainText(/Expenses|Net cash/)
    await expect(page.getByText(`${visits.length} visits by ${unique} member${unique === 1 ? '' : 's'} · ${newMs} new · ${renewals} renewal${renewals === 1 ? '' : 's'}`)).toBeVisible()
    // received by method list
    const byMethod = new Map<string, number>()
    for (const p of recv) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountPaise)
    const methodCard = page.getByRole('heading', { name: 'Received by method' }).locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
    for (const [k, v] of byMethod) await expect(methodCard.getByRole('listitem').filter({ hasText: new RegExp(`^${k === 'upi' ? 'UPI' : k[0].toUpperCase() + k.slice(1)}`) })).toContainText(inr(v))

    // 7 days
    await page.getByRole('tab', { name: '7 days' }).click()
    const s7 = addDays(t, -6)
    const recv7 = payments.filter((p) => p.status === 'recorded' && dateOf(p.receivedAt) >= s7 && dateOf(p.receivedAt) <= t).reduce((s, p) => s + p.amountPaise, 0)
    await expect(statCard(page, 'Revenue received')).toContainText(inr(recv7))

    // custom period with start > end
    await page.getByRole('tab', { name: 'Custom' }).click()
    await page.getByLabel('From date').fill(addDays(t, 5))
    const fromVal = await page.getByLabel('From date').inputValue()
    const toVal = await page.getByLabel('To date').inputValue()
    expect.soft(fromVal <= toVal, `reports accepted from=${fromVal} > to=${toVal}`).toBe(true)
    await expect(statCard(page, 'Revenue received')).toBeVisible() // page did not crash
    // custom period in the past: 90 days ago to 60 days ago → recompute
    await page.getByLabel('To date').fill(addDays(t, -60))
    await page.getByLabel('From date').fill(addDays(t, -90))
    const a = addDays(t, -90)
    const b = addDays(t, -60)
    const recvC = payments.filter((p) => p.status === 'recorded' && dateOf(p.receivedAt) >= a && dateOf(p.receivedAt) <= b)
    await expect(page.getByText(`${formatDate(a)} – ${formatDate(b)} · Asia/Kolkata`)).toBeVisible()
    await expect(statCard(page, 'Revenue received')).toContainText(inr(recvC.reduce((s, p) => s + p.amountPaise, 0)))
    await expect(statCard(page, 'Revenue received')).toContainText(`${recvC.length} payment${recvC.length === 1 ? '' : 's'}`)
  })

  test('CSV exports: structure, formatting, escaping, period filtering', async ({ page }) => {
    await onboard(page, 'sample')
    const t = today()
    const start = t.slice(0, 7) + '-01'
    // add rows designed to stress escaping: formula-like name, + phone, comma/quote/newline in notes
    await page.goto('/members/new')
    await page.getByLabel('Full name').fill('=SUM(A1) "Quoted", Comma')
    await page.getByLabel(/^Phone/).fill('+91 98200 77777')
    await page.getByLabel('Notes', { exact: true }).fill('line1\nline2')
    await page.getByLabel('Height (cm)').fill('180')
    await page.getByLabel('Weight (kg)').fill('82.5')
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)
    const [payments, invoices, attendance, members] = await Promise.all([
      readStore<Pay>(page, 'payments'),
      readStore<Inv>(page, 'invoices'),
      readStore<Att>(page, 'attendance'),
      readStore<{ id: string; name: string; phone: string; status: string }>(page, 'members'),
    ])
    const inP = (d: string) => d >= start && d <= t

    await page.goto('/reports')
    const checkShape = (rows: string[][], what: string) => {
      const header = rows[0]
      for (let i = 1; i < rows.length; i++) expect(rows[i].length, `${what} row ${i} has ${rows[i].length} cols; header has ${header.length}: ${JSON.stringify(rows[i])}`).toBe(header.length)
    }
    const amountRe = /^'?-?\d+\.\d{2}$/
    // Timestamps are exported as wall-clock time in the gym timezone, not UTC instants.
    const isoInstant = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    const isoDate = /^\d{4}-\d{2}-\d{2}$/

    // payments
    const pay = await downloadCsv(page, 'Payments')
    expect(pay.name).toBe(`gymbook-payments-${start}_to_${t}.csv`)
    expect(pay.text.startsWith('﻿')).toBe(true)
    expect(pay.rows[0]).toEqual(['Received at (gym time)', 'Member', 'Phone', 'Amount (INR)', 'Method', 'Invoice', 'Status', 'Reference', 'Note'])
    checkShape(pay.rows, 'payments')
    const payExpected = payments.filter((p) => inP(dateOf(p.receivedAt)))
    expect(pay.rows.length - 1).toBe(payExpected.length)
    for (const r of pay.rows.slice(1)) {
      expect(r[0]).toMatch(isoInstant)
      expect(r[3]).toMatch(amountRe)
      expect(['Cash', 'UPI', 'Bank transfer', 'Card', 'Bank']).toContain(r[4])
    }
    expect(pay.rows.slice(1).map((r) => r[3]).sort()).toEqual(payExpected.map((p) => (p.amountPaise / 100).toFixed(2)).sort())
    await expect(page.getByRole('status').filter({ hasText: 'CSV exported' })).toBeVisible()

    // invoices
    const inv = await downloadCsv(page, 'Invoices')
    expect(inv.rows[0]).toEqual(['Invoice', 'Issued', 'Member', 'Phone', 'Subtotal (INR)', 'Discount (INR)', 'Adjustments (INR)', 'Total due (INR)', 'Paid (INR)', 'Balance (INR)', 'Status'])
    checkShape(inv.rows, 'invoices')
    const invExpected = invoices.filter((i) => inP(i.issueDate))
    expect(inv.rows.length - 1).toBe(invExpected.length)
    expect(inv.rows.slice(1).map((r) => r[0]).sort()).toEqual(invExpected.map((i) => i.number).sort())
    for (const r of inv.rows.slice(1)) {
      expect(r[1]).toMatch(isoDate)
      for (const c of [4, 5, 6, 7, 8, 9]) expect(r[c]).toMatch(amountRe)
      expect(['paid', 'partial', 'unpaid', 'void', 'credit']).toContain(r[10])
    }

    // the Expenses export went away with the section
    await expect(page.getByRole('button', { name: 'Expenses', exact: true })).toHaveCount(0)

    // attendance
    const at = await downloadCsv(page, 'Attendance')
    expect(at.rows[0]).toEqual(['Check-in (gym time)', 'Check-out (gym time)', 'Member', 'Phone', 'Override reason', 'Note'])
    checkShape(at.rows, 'attendance')
    const atExpected = attendance.filter((a) => inP(dateOf(a.checkInAt)))
    expect(at.rows.length - 1).toBe(atExpected.length)
    const openCount = atExpected.filter((a) => a.checkOutAt === null).length
    expect(at.rows.slice(1).filter((r) => r[1] === '').length).toBe(openCount)
    for (const r of at.rows.slice(1)) {
      expect(r[0]).toMatch(isoInstant)
      if (r[1]) expect(r[1]).toMatch(isoInstant)
      expect(r[2]).not.toBe('')
    }

    // members (full list, including archived)
    const me = await downloadCsv(page, 'Members')
    expect(me.name).toBe(`gymbook-members-${t}.csv`)
    expect(me.rows[0]).toEqual(['Name', 'Phone', 'Height (cm)', 'Weight (kg)', 'Joined', 'Status', 'Current plan', 'Plan start', 'Plan end', 'Membership state', 'Balance (INR)', 'Last visit (gym time)'])
    checkShape(me.rows, 'members')
    expect(me.rows.length - 1).toBe(members.length)
    expect(me.rows.slice(1).filter((r) => r[5] === 'archived').length).toBe(members.filter((m) => m.status === 'archived').length)
    const stressRow = me.rows.find((r) => r[0].includes('SUM(A1)'))!
    expect(stressRow[0]).toBe("'=SUM(A1) \"Quoted\", Comma")
    expect(me.text).toContain('"\'=SUM(A1) ""Quoted"", Comma"')
    expect(stressRow[1]).toBe("'+91 98200 77777")
    expect(stressRow[2]).toBe('180')
    expect(stressRow[3]).toBe('82.5')
    expect(stressRow[9]).toBe('none')
    expect(stressRow[10]).toBe('0.00')
    // sample members with and without measurements
    expect(me.rows.find((r) => r[0].includes('Aarav'))!.slice(2, 4)).toEqual(['176', '78.5'])
    expect(me.rows.find((r) => r[0].includes('Kabir'))!.slice(2, 4)).toEqual(['', ''])
    for (const r of me.rows.slice(1)) {
      expect(r[4]).toMatch(isoDate)
      expect(r[10]).toMatch(amountRe)
      if (r[11]) expect(r[11]).toMatch(isoInstant)
      expect(['active', 'expiring', 'expired', 'upcoming', 'none']).toContain(r[9])
    }

    // export for a period with no data gives header only
    await page.getByRole('tab', { name: 'Custom' }).click()
    await page.getByLabel('From date').fill('2000-01-01')
    await page.getByLabel('To date').fill('2000-01-31')
    const empty = await downloadCsv(page, 'Payments')
    expect(empty.name).toBe('gymbook-payments-2000-01-01_to_2000-01-31.csv')
    expect(empty.rows).toHaveLength(1)
    await expect(page.getByText('No data for this period').first()).toBeVisible()
  })
})
