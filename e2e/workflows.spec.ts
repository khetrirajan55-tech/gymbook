import { test, expect } from '@playwright/test'
import { onboard, createPlan, addMember, sellMembership, readStore, inr } from './helpers'
import { membershipEndDate, addDays, formatDate, todayInTz } from '../src/domain/dates'

const TZ = 'Asia/Kolkata'

test.describe('sale, payments and invoice', () => {
  test('add member → sell plan with partial payment → pay balance → printable invoice', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Ravi Kumar', '98200 11223')

    await sellMembership(page, { receivedNow: '500', method: 'upi' })
    const article = page.getByRole('article')
    await expect(article).toContainText('RK-00001')
    await expect(article).toContainText('Partly paid')
    await expect(article).toContainText('₹1,000.00')

    await page.getByRole('button', { name: 'Record payment' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Amount received')).toHaveValue('1000')
    await dialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(dialog).toBeHidden()
    await expect(article).toContainText('Paid')
    await expect(article.getByText('Balance due')).toBeVisible()
    await expect(article).toContainText('₹0.00')
    await expect(article.locator('text=UPI')).toBeVisible()
    await expect(article.locator('text=Cash')).toBeVisible()

    // Print layout hides the toolbar and shows the invoice body only.
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('.no-print').first()).toBeHidden()
    await expect(article).toBeVisible()
    await page.emulateMedia({ media: null })

    const payments = await readStore<{ amountPaise: number; status: string }>(page, 'payments')
    expect(payments.map((p) => p.amountPaise).sort((a, b) => a - b)).toEqual([50000, 100000])
    expect(payments.every((p) => p.status === 'recorded')).toBe(true)
  })

  test('overpayment against an invoice is refused with the outstanding amount', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Asha Rao', '98200 00001')
    await sellMembership(page, { receivedNow: '500' })
    await page.getByRole('button', { name: 'Record payment' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Amount received').fill('5000')
    await dialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Only ₹1,000.00 is outstanding')
    await expect(dialog.getByLabel('Amount received')).toHaveValue('5000')
  })
})

test.describe('renewal', () => {
  test('renewal starts the day after the current plan and ends one month later (inclusive)', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const memberUrl = await addMember(page, 'Dev Nair', '98200 00002')
    await sellMembership(page, { receivedNow: '1500' })

    const today = todayInTz(TZ)
    const firstEnd = membershipEndDate(today, 1, 'months')
    const renewStart = addDays(firstEnd, 1)
    const renewEnd = membershipEndDate(renewStart, 1, 'months')

    await page.goto(memberUrl)
    await page.getByRole('button', { name: 'Renew' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: /After current plan/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog).toContainText(formatDate(renewStart))
    await expect(dialog).toContainText(`${formatDate(renewStart)} to ${formatDate(renewEnd)}`)
    await expect(dialog).toContainText('last day of access')
    await dialog.getByRole('button', { name: 'Renew and create invoice' }).click()
    await expect(page).toHaveURL(/\/invoices\//)
    const article = page.getByRole('article')
    await expect(article).toContainText('RK-00002')
    await expect(article).toContainText(`Issued ${formatDate(today, 'long')}`)

    const memberships = await readStore<{ startDate: string; endDate: string; renewalOfId?: string }>(page, 'memberships')
    expect(memberships).toHaveLength(2)
    const renewal = memberships.find((m) => m.renewalOfId)!
    expect(renewal.startDate).toBe(renewStart)
    expect(renewal.endDate).toBe(renewEnd)
  })
})

test.describe('attendance', () => {
  test('check in → duplicate refused → check out; no-membership override needs a reason', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Kiran Das', '98200 00003')
    await sellMembership(page, { receivedNow: '1500' })
    await addMember(page, 'Lata Menon', '98200 00004') // no membership

    await page.goto('/attendance')
    const pick = async (name: string) => {
      const clear = page.getByRole('button', { name: 'Clear selected member' })
      if (await clear.count()) await clear.click()
      const box = page.getByRole('combobox')
      await box.fill(name)
      await page.getByRole('option', { name: new RegExp(name) }).click()
    }
    await pick('Kiran')
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Kiran Das checked in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Currently inside' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Kiran Das' }).first()).toBeVisible()

    await pick('Kiran')
    await expect(page.getByText('Already checked in')).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'already checked in' })).toBeVisible()
    expect((await readStore(page, 'attendance')).length).toBe(1)

    await page.getByRole('button', { name: 'Out' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Kiran Das checked out' })).toBeVisible()
    const visits = await readStore<{ checkOutAt: string | null }>(page, 'attendance')
    expect(visits).toHaveLength(1)
    expect(visits[0].checkOutAt).not.toBeNull()

    await pick('Lata')
    await expect(page.getByText('No active membership today')).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'No active membership' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Allow entry anyway' })).toBeDisabled()
    await dialog.getByLabel('Reason for allowing entry').fill('Owner approved trial day')
    await dialog.getByRole('button', { name: 'Allow entry anyway' }).click()
    await expect(dialog).toBeHidden()
    const after = await readStore<{ overrideReason?: string }>(page, 'attendance')
    expect(after.some((a) => a.overrideReason === 'Owner approved trial day')).toBe(true)
  })
})

test.describe('archive', () => {
  test('archiving a member keeps invoices, payments and visits', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const memberUrl = await addMember(page, 'Meera Joshi', '98200 00005')
    await sellMembership(page, { receivedNow: '700' })
    await page.goto(memberUrl + '?tab=payments')
    await page.getByRole('button', { name: 'Archive' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByText('Archived', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Sell membership|Renew/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'RK-00001' })).toBeVisible()
    await expect(page.getByText('₹700.00').first()).toBeVisible()
    expect((await readStore(page, 'invoices')).length).toBe(1)
    expect((await readStore(page, 'payments')).length).toBe(1)
    await page.goto('/members?filter=archived')
    await expect(page.getByRole('link', { name: /Meera Joshi/ })).toBeVisible()
  })
})

test.describe('backup', () => {
  test('an invalid backup is rejected and existing data is untouched', async ({ page }) => {
    await onboard(page, 'sample')
    const before = (await readStore(page, 'members')).length
    expect(before).toBeGreaterThan(5)
    await page.goto('/settings')
    const bad = {
      format: 'gymbook-backup',
      version: 1,
      exportedAt: '2026-10-28T00:00:00Z',
      data: {
        members: [], plans: [], invoices: [], adjustments: [], payments: [], attendance: [], trainers: [], schedules: [], expenses: [], followups: [], activity: [], counters: [], settings: null,
        memberships: [{ id: 'ms1', createdAt: '', updatedAt: '', rev: 1, memberId: 'ghost', planId: 'p', planName: 'x', durationValue: 1, durationUnit: 'months', startDate: '2026-01-01', endDate: '2026-01-31', listPricePaise: 1, discountPaise: 0, pricePaise: 1, invoiceId: 'nope' }],
      },
    }
    await page.locator('input[type=file][accept*=json]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) })
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: /can’t be imported/ })).toBeVisible()
    await expect(dialog).toContainText('missing member ghost')
    await expect(dialog.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    expect((await readStore(page, 'members')).length).toBe(before)

    await page.locator('input[type=file][accept*=json]').setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('not json') })
    await expect(page.getByRole('dialog')).toContainText('not valid JSON')
    await page.keyboard.press('Escape')
    expect((await readStore(page, 'members')).length).toBe(before)
  })
})

test.describe('concurrency and failures', () => {
  test('two tabs editing the same member: second save is refused, edits kept', async ({ page, context }) => {
    await onboard(page, 'empty')
    const memberUrl = await addMember(page, 'Sana Khan', '98200 00006')
    const pageB = await context.newPage()
    await page.goto(memberUrl + '/edit')
    await pageB.goto(memberUrl + '/edit')
    await page.getByLabel('Notes', { exact: true }).fill('Edited in tab A')
    await pageB.getByLabel('Notes', { exact: true }).fill('Edited in tab B')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(memberUrl)
    await expect(pageB.getByText('Changed in another tab')).toBeVisible()
    await expect(pageB.getByLabel('Notes', { exact: true })).toHaveValue('Edited in tab B')
    await pageB.getByRole('button', { name: 'Save changes' }).click()
    await expect(pageB.getByRole('alert').filter({ hasText: 'changed in another tab' })).toBeVisible()
    await expect(pageB.getByLabel('Notes', { exact: true })).toHaveValue('Edited in tab B')
    const members = await readStore<{ notes?: string }>(page, 'members')
    expect(members[0].notes).toBe('Edited in tab A')
    await pageB.getByRole('button', { name: /Load latest/ }).click()
    await expect(pageB.getByLabel('Notes', { exact: true })).toHaveValue('Edited in tab A')
  })

  test('a failed save shows an error and keeps the form; retry succeeds', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/settings')
    await expect(page.getByText('Developer tools')).toHaveCount(0) // no test switch in the UI
    await page.evaluate(() => sessionStorage.setItem('gymbook-fail-next-save', '1'))
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plans', exact: true }).click()
    await page.getByRole('button', { name: 'New plan' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Plan name').fill('Monthly')
    await dialog.getByLabel('Price').fill('1500')
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Simulated storage failure')
    await expect(dialog.getByLabel('Plan name')).toHaveValue('Monthly')
    await expect(dialog.getByLabel('Price')).toHaveValue('1500')
    expect((await readStore(page, 'plans')).length).toBe(0)
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Plan created' })).toBeVisible()
    expect((await readStore(page, 'plans')).length).toBe(1)
  })

  test('double-clicking a submit creates one record', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/plans')
    await page.getByRole('button', { name: 'New plan' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Plan name').fill('Quarterly')
    await dialog.getByLabel('Price').fill('4000')
    await dialog.getByRole('button', { name: 'Create plan' }).dblclick()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Plan created' })).toBeVisible()
    expect((await readStore(page, 'plans')).length).toBe(1)
  })
})

test.describe('dashboard and reports derive from records', () => {
  test('dashboard money and counts match an independent computation from IndexedDB', async ({ page }) => {
    await onboard(page, 'sample')
    type Pay = { status: string; receivedAt: string; amountPaise: number; invoiceId?: string; memberId: string }
    type Inv = { id: string; status: string; issueDate: string; totalPaise: number; memberId: string }
    type Adj = { invoiceId: string; amountPaise: number }
    const [payments, invoices, adjustments, members, memberships, attendance] = await Promise.all([
      readStore<Pay>(page, 'payments'),
      readStore<Inv>(page, 'invoices'),
      readStore<Adj>(page, 'adjustments'),
      readStore<{ id: string; status: string }>(page, 'members'),
      readStore<{ memberId: string; startDate: string; endDate: string }>(page, 'memberships'),
      readStore<{ checkInAt: string }>(page, 'attendance'),
    ])
    const today = todayInTz(TZ)
    const start = addDays(today, -29)
    const dateOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
    const received = payments.filter((p) => p.status === 'recorded' && dateOf(p.receivedAt) >= start && dateOf(p.receivedAt) <= today).reduce((s, p) => s + p.amountPaise, 0)
    const invoiced = invoices.filter((i) => i.status === 'issued' && i.issueDate >= start && i.issueDate <= today).reduce((s, i) => s + i.totalPaise, 0)
    const active = members.filter((m) => m.status !== 'archived' && memberships.some((ms) => ms.memberId === m.id && ms.startDate <= today && today <= ms.endDate)).length
    const visitsToday = attendance.filter((a) => dateOf(a.checkInAt) === today).length

    const main = page.getByRole('main')
    await expect(main).toContainText(inr(received))
    await expect(main).toContainText(inr(invoiced))
    await expect(main).not.toContainText(/Expenses|Net cash/)
    await expect(main.getByText('Active members', { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')).toContainText(String(active))
    await expect(main.getByText('Attendance today', { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')).toContainText(String(visitsToday))
  })

  test('reports show zeros for an empty period and export CSV with escaped formulas', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/reports')
    const main = page.getByRole('main')
    await expect(main.getByText('Revenue received', { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')).toContainText('₹0.00')
    await expect(main.getByText('No data for this period').first()).toBeVisible()
    await addMember(page, '=HYPERLINK("x")', '98200 00007')
    await page.goto('/reports')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Members', exact: true }).click()])
    const text = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))
    expect(text).toContain(`"'=HYPERLINK(""x"")"`)
  })
})

test.describe('navigation, layout and accessibility', () => {
  const routes = ['/', '/members', '/members/new', '/plans', '/attendance', '/payments', '/payments?tab=invoices', '/follow-ups', '/workouts', '/activity', '/reports', '/settings']

  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await onboard(page, 'sample')
      const kabir = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name.includes('Kabir'))!
      const memberUrl = `/members/${kabir.id}`
      for (const route of [...routes, memberUrl, `${memberUrl}?tab=payments`, `${memberUrl}/edit`]) {
        await page.goto(route)
        await page.waitForLoadState('networkidle')
        const { scrollW, inner, maxScrollX } = await page.evaluate(() => {
          window.scrollTo(5000, 0)
          const x = window.scrollX
          window.scrollTo(0, 0)
          return { scrollW: document.documentElement.scrollWidth, inner: window.innerWidth, maxScrollX: x }
        })
        expect(maxScrollX, `${route} scrolls horizontally`).toBe(0)
        expect(scrollW, `${route} content wider than viewport`).toBeLessThanOrEqual(inner)
        await expect(page).toHaveTitle(/· GymBook$/)
      }
    })
  }

  test('phone width: drawer, bottom sheet with close button, focus trap, Escape, focus restore', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await onboard(page, 'sample')
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const nav = page.getByRole('dialog', { name: 'Navigation' })
    await expect(nav).toBeVisible()
    await nav.getByRole('link', { name: 'Members' }).click()
    await expect(page).toHaveURL(/\/members$/)
    await expect(nav).toBeHidden()
    const kabir = (await readStore<{ id: string; name: string }>(page, 'members')).find((m) => m.name.includes('Kabir'))!
    await page.goto(`/members/${kabir.id}`)
    const opener = page.getByRole('button', { name: 'Renew' })
    await opener.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible()
    await expect(dialog.getByLabel('Plan')).toBeFocused()
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('reduced motion disables press scale and dialogs still open and close', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await onboard(page, 'sample')
    const scale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--press-scale').trim())
    expect(scale).toBe('1')
    await page.goto('/plans')
    await page.getByRole('button', { name: 'New plan' }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('unsaved edits are protected, 404 is branded, back/forward works', async ({ page }) => {
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await page.getByLabel('Full name').fill('Half typed')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plans', exact: true }).click()
    const guard = page.getByRole('dialog')
    await expect(guard.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible()
    await guard.getByRole('button', { name: 'Keep editing' }).click()
    await expect(page).toHaveURL(/\/members\/new$/)
    await expect(page.getByLabel('Full name')).toHaveValue('Half typed')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plans', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
    await expect(page).toHaveURL(/\/plans$/)

    await page.goto('/this/does/not/exist')
    await expect(page).toHaveTitle(/Page not found/)
    await page.getByRole('link', { name: 'Go to the dashboard' }).click()
    await expect(page).toHaveTitle(/Dashboard/)
    await page.goto('/members')
    await page.goto('/plans')
    await page.goBack()
    await expect(page).toHaveURL(/\/members$/)
    await page.goForward()
    await expect(page).toHaveURL(/\/plans$/)
  })

  test('duplicate phone warns but does not block saving', async ({ page }) => {
    await onboard(page, 'empty')
    await addMember(page, 'First Person', '98200 00008')
    await page.goto('/members/new')
    await page.getByLabel('Full name').fill('Second Person')
    await page.getByLabel(/^Phone/).fill('98200 00008')
    await expect(page.getByText('Possible duplicate')).toBeVisible()
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page).toHaveTitle(/Second Person/)
  })
})
