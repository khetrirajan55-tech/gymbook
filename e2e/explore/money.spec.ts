import { test as base, expect, type Page, type Locator } from '@playwright/test'
import { onboard, createPlan, addMember, sellMembership, readStore, inr } from '../helpers'
import { membershipEndDate, addDays, formatDate, todayInTz, instantToDateInTz } from '../../src/domain/dates'

const TZ = 'Asia/Kolkata'

/** Every test fails on any console.error or uncaught page error. */
const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await use(page)
    expect(errors, 'no console errors or page errors').toEqual([])
  },
})

type Plan = { id: string; name: string; pricePaise: number; durationValue: number; durationUnit: string; archived: boolean; rev: number }
type Membership = { id: string; memberId: string; planId: string; planName: string; listPricePaise: number; discountPaise: number; pricePaise: number; startDate: string; endDate: string; invoiceId: string; renewalOfId?: string }
type Invoice = { id: string; number: string; memberId: string; status: string; subtotalPaise: number; discountPaise: number; totalPaise: number; issueDate: string; rev: number; voidReason?: string }
type Payment = { id: string; memberId: string; invoiceId?: string; amountPaise: number; method: string; status: string; receivedAt: string; rev: number; voidReason?: string }
type Adjustment = { id: string; invoiceId: string; memberId: string; amountPaise: number; reason: string }
type Counter = { key: string; value: number }
type Member = { id: string; name: string; status: string }

/** Call a service function inside the app (same Vite module graph) to probe guards the UI hides. */
async function svc<T = unknown>(page: Page, mod: string, fn: string, ...args: unknown[]): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return page.evaluate(
    async ({ mod, fn, args }) => {
      const m = (await import(/* @vite-ignore */ mod)) as Record<string, (...a: unknown[]) => Promise<unknown>>
      try {
        return { ok: true as const, value: (await m[fn](...args)) as never }
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    },
    { mod: `/src/data/services/${mod}.ts`, fn, args },
  )
}

async function openPlanDialog(page: Page): Promise<Locator> {
  await page.goto('/plans')
  await page.getByRole('button', { name: 'New plan' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

async function fillPlan(dialog: Locator, v: { name?: string; duration?: string; unit?: 'days' | 'months'; price?: string }) {
  if (v.name !== undefined) await dialog.getByLabel('Plan name').fill(v.name)
  if (v.duration !== undefined) await dialog.getByLabel('Duration').fill(v.duration)
  if (v.unit) await dialog.getByLabel('Unit').selectOption(v.unit)
  if (v.price !== undefined) await dialog.getByLabel('Price').fill(v.price)
}

/** Open the sell/renew dialog for the member on screen and fill it without submitting. */
async function openSell(page: Page, opts: { planLabel?: RegExp; discount?: string; receivedNow?: string; method?: string; startDate?: string } = {}): Promise<Locator> {
  await page.getByRole('button', { name: /Sell membership|Renew/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  if (opts.planLabel) {
    const labels = await dialog.getByLabel('Plan').locator('option').allTextContents()
    const hit = labels.find((l) => opts.planLabel!.test(l))
    if (!hit) throw new Error(`No plan option matching ${opts.planLabel}: ${labels.join(' | ')}`)
    await dialog.getByLabel('Plan').selectOption({ label: hit })
  }
  if (opts.startDate) {
    await dialog.getByRole('button', { name: /Pick a date/ }).click()
    await dialog.getByLabel('Start date').fill(opts.startDate)
  }
  if (opts.discount !== undefined) await dialog.getByLabel('Discount').fill(opts.discount)
  if (opts.receivedNow !== undefined) await dialog.getByLabel('Received now').fill(opts.receivedNow)
  if (opts.method) await dialog.getByLabel('Payment method').selectOption(opts.method)
  return dialog
}

async function submitSell(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: /Sell and create invoice|Renew and create invoice/ }).click()
  await expect(page).toHaveURL(/\/invoices\/inv_/)
  return page.url()
}

/** Read the Subtotal/Discount/Adjustments/Total/Paid/Balance rows from the invoice article. */
async function invoiceTotals(page: Page): Promise<Record<string, string>> {
  const rows = page.getByRole('article').locator('dl > div')
  const out: Record<string, string> = {}
  const n = await rows.count()
  for (let i = 0; i < n; i++) {
    out[(await rows.nth(i).locator('dt').innerText()).trim()] = (await rows.nth(i).locator('dd').innerText()).trim()
  }
  return out
}

async function recordPaymentOnInvoice(page: Page, amount: string, method?: string) {
  await page.getByRole('button', { name: 'Record payment' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Amount received').fill(amount)
  if (method) await dialog.getByLabel('Method').selectOption(method)
  await dialog.getByRole('button', { name: 'Record payment' }).click()
  return dialog
}

const statCard = (scope: Locator, label: string) => scope.getByText(label, { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')

const paginationText = (page: Page) => page.getByRole('navigation', { name: 'Pagination' })

test.describe('1. plans', () => {
  test('price edge cases: valid ones store exact paise, invalid ones are refused with a field error', async ({ page }) => {
    await onboard(page, 'empty')
    const valid: Array<[string, number]> = [
      ['0', 0],
      ['1,50,000', 15000000],
      ['₹ 999.99', 99999],
      ['1000000000', 100000000000], // ₹100 crore is the cap
    ]
    const invalid = ['0.005', '-5', 'abc', '1e3', '99999999999']

    for (const [price, paise] of valid) {
      const dialog = await openPlanDialog(page)
      await fillPlan(dialog, { name: `Price ${price}`, duration: '1', price })
      await dialog.getByRole('button', { name: 'Create plan' }).click()
      await expect(dialog, `price "${price}" should be accepted`).toBeHidden()
      const plans = await readStore<Plan>(page, 'plans')
      expect(plans.find((p) => p.name === `Price ${price}`)?.pricePaise, `stored paise for "${price}"`).toBe(paise)
    }

    const dialog = await openPlanDialog(page)
    await fillPlan(dialog, { name: 'Invalid prices', duration: '1' })
    for (const price of invalid) {
      await fillPlan(dialog, { price })
      await dialog.getByRole('button', { name: 'Create plan' }).click()
      await expect(dialog, `price "${price}" should be refused`).toBeVisible()
      const alert = dialog.getByRole('alert')
      await expect(alert, `error for "${price}"`).toBeVisible()
      const msg = await alert.innerText()
      test.info().annotations.push({ type: 'price-error', description: `"${price}" → ${msg}` })
      expect(msg).toMatch(price === '-5' ? /negative/ : price === '99999999999' ? /at most/ : /valid price/)
    }
    expect((await readStore<Plan>(page, 'plans')).map((p) => p.name)).not.toContain('Invalid prices')
    // Note for the report: there is no upper bound on price (₹99,99,99,99,999 accepted).
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
  })

  test('duration edge cases, unit switch and whitespace name', async ({ page }) => {
    await onboard(page, 'empty')
    const dialog = await openPlanDialog(page)
    await fillPlan(dialog, { name: 'Duration tests', price: '100' })
    const cases: Array<[string, RegExp]> = [
      ['0', /at least 1/],
      ['-1', /at least 1/],
      ['1.5', /whole number/],
      ['', /at least 1/],
    ]
    for (const [d, re] of cases) {
      await fillPlan(dialog, { duration: d })
      await dialog.getByRole('button', { name: 'Create plan' }).click()
      await expect(dialog, `duration "${d}" should be refused`).toBeVisible()
      const msg = await dialog.getByRole('alert').innerText()
      test.info().annotations.push({ type: 'duration-error', description: `"${d}" → ${msg}` })
      expect(msg, `duration "${d}"`).toMatch(re)
    }
    // 4000 is over the 3650 max: the message should be human, not zod's default.
    await fillPlan(dialog, { duration: '4000' })
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog).toBeVisible()
    const big = await dialog.getByRole('alert').innerText()
    test.info().annotations.push({ type: 'duration-error', description: `"4000" → ${big}` })
    expect.soft(big, 'BUG: raw zod message for duration > 3650').not.toMatch(/expected number/)

    // Whitespace-only name.
    await fillPlan(dialog, { name: '   ', duration: '1' })
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toContainText(/at least 2 characters/)
    expect((await readStore<Plan>(page, 'plans')).length).toBe(0)

    // Unit switch changes the example end date and the stored unit.
    await fillPlan(dialog, { name: 'Ten units', duration: '10', unit: 'months' })
    const today = todayInTz(TZ)
    await expect(dialog).toContainText(`would end on ${formatDate(membershipEndDate(today, 10, 'months'))}`)
    await fillPlan(dialog, { unit: 'days' })
    await expect(dialog).toContainText(`would end on ${formatDate(membershipEndDate(today, 10, 'days'))}`)
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog).toBeHidden()
    const plans = await readStore<Plan>(page, 'plans')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ name: 'Ten units', durationValue: 10, durationUnit: 'days', pricePaise: 10000, archived: false })
    await expect(page.getByText('10 days', { exact: false }).first()).toBeVisible()
  })

  test('editing a plan after a sale keeps the membership snapshot; archived plans are not offered', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await createPlan(page, 'Weekly', 7, 'days', '400')
    const memberUrl = await addMember(page, 'Snap Shot', '98200 11000')
    await sellMembership(page, { planLabel: /Monthly/, receivedNow: '1500' })

    await page.goto('/plans')
    await page.getByRole('button', { name: 'Edit' }).first().click() // plans sorted by name: Monthly first
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Plan name')).toHaveValue('Monthly')
    await fillPlan(dialog, { name: 'Monthly Plus', duration: '2', price: '2999.50' })
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Plan updated' })).toBeVisible()

    const plans = await readStore<Plan>(page, 'plans')
    const plus = plans.find((p) => p.name === 'Monthly Plus')!
    expect(plus).toMatchObject({ durationValue: 2, pricePaise: 299950, rev: 2 })
    const ms = await readStore<Membership>(page, 'memberships')
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ planId: plus.id, planName: 'Monthly', listPricePaise: 150000, pricePaise: 150000, discountPaise: 0 })
    expect(ms[0].endDate).toBe(membershipEndDate(ms[0].startDate, 1, 'months'))
    const invoices = await readStore<Invoice>(page, 'invoices')
    expect(invoices[0].totalPaise).toBe(150000)

    // Member page still shows the snapshot.
    await page.goto(memberUrl + '?tab=memberships')
    await expect(page.getByRole('main')).toContainText('Monthly')
    await expect(page.getByRole('main')).not.toContainText('Monthly Plus')
    await expect(page.getByRole('main')).toContainText('1 month · ₹1,500.00')

    // Archive Weekly, then it is gone from the sell dialog but the edited plan is present with new label.
    await page.goto('/plans')
    const weeklyCard = page.locator('xpath=//*[contains(@class,"rounded-2xl")][.//text()="Weekly"]').first()
    await weeklyCard.getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Plan archived' })).toBeVisible()
    expect((await readStore<Plan>(page, 'plans')).find((p) => p.name === 'Weekly')?.archived).toBe(true)
    await expect(page.getByText(/^Weekly/)).toHaveCount(0)
    await page.getByRole('button', { name: /Show archived/ }).click()
    await expect(page.getByText(/^Weekly/).first()).toBeVisible()
    await expect(page.getByText(/^Weekly/).first()).toContainText('Archived')

    await page.goto(memberUrl)
    const sell = await openSell(page)
    const options = await sell.getByLabel('Plan').locator('option').allTextContents()
    expect(options).toEqual(['Monthly Plus · 2 months · ₹2,999.50'])
    await page.keyboard.press('Escape')
    await expect(sell).toBeHidden()

    // Selling the archived plan through the service is refused.
    const weekly = (await readStore<Plan>(page, 'plans')).find((p) => p.name === 'Weekly')!
    const member = (await readStore<Member>(page, 'members'))[0]
    const res = await svc(page, 'memberships', 'assignMembership', { memberId: member.id, planId: weekly.id, startDate: todayInTz(TZ), discountPaise: 0, initialPaymentPaise: 0, paymentMethod: 'cash' })
    expect(res).toMatchObject({ ok: false, error: /archived/ })

    // Archive everything: the sell dialog explains and disables the submit.
    await page.goto('/plans')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Plan archived' })).toBeVisible()
    await page.goto(memberUrl)
    await page.getByRole('button', { name: 'Renew' }).click()
    const none = page.getByRole('dialog')
    await expect(none.getByRole('alert')).toContainText('No active plans')
    await expect(none.getByRole('button', { name: /create invoice/ })).toBeDisabled()
    expect((await readStore<Membership>(page, 'memberships')).length).toBe(1)
  })
})

test.describe('2. membership sale', () => {
  test('discount and received-now validation, decimals, payment method', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const memberUrl = await addMember(page, 'Disco Unt', '98200 12000')

    // Discount > price: refused by the service, form keeps values.
    let dialog = await openSell(page, { discount: '1500.01' })
    await expect(dialog.locator('text=Net price').locator('..')).toContainText('₹0.00')
    await dialog.getByRole('button', { name: 'Sell and create invoice' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/Discount must be between ₹0 and ₹1,500.00/)
    await expect(dialog.getByLabel('Discount')).toHaveValue('1500.01')
    expect((await readStore(page, 'memberships')).length).toBe(0)
    expect((await readStore<Counter>(page, 'counters')).find((c) => c.key === 'invoice')?.value ?? 0).toBe(0)

    // Received > net: refused.
    await dialog.getByLabel('Discount').fill('500')
    await dialog.getByLabel('Received now').fill('1000.01')
    await expect(dialog.getByLabel('Payment method')).toBeEnabled()
    await dialog.getByRole('button', { name: 'Sell and create invoice' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/cannot exceed the net price of ₹1,000.00/)
    expect((await readStore(page, 'memberships')).length).toBe(0)
    expect((await readStore<Counter>(page, 'counters')).find((c) => c.key === 'invoice')?.value ?? 0).toBe(0)

    // Negative received: refused by the schema.
    await dialog.getByLabel('Received now').fill('-1')
    await dialog.getByRole('button', { name: 'Sell and create invoice' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/cannot be negative/)

    // Payment method is disabled until something is received.
    await dialog.getByLabel('Received now').fill('')
    await expect(dialog.getByLabel('Payment method')).toBeDisabled()

    // Decimals + UPI succeed.
    await dialog.getByLabel('Received now').fill('499.99')
    await dialog.getByLabel('Payment method').selectOption('upi')
    await expect(dialog).toContainText('₹500.01 will remain outstanding')
    await submitSell(page, dialog)
    const article = page.getByRole('article')
    await expect(article).toContainText('RK-00001')
    await expect(article).toContainText('Partly paid')
    let totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Subtotal: '₹1,500.00', Discount: '− ₹500.00', Total: '₹1,000.00', Paid: '₹499.99', 'Balance due': '₹500.01' })
    const pays = await readStore<Payment>(page, 'payments')
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ amountPaise: 49999, method: 'upi', status: 'recorded' })
    const ms = await readStore<Membership>(page, 'memberships')
    expect(ms[0]).toMatchObject({ listPricePaise: 150000, discountPaise: 50000, pricePaise: 100000 })

    // Discount equal to price: net 0, invoice total 0 and shows Paid with nothing received.
    await page.goto(memberUrl)
    dialog = await openSell(page, { discount: '1500' })
    await expect(dialog.locator('text=Net price').locator('..')).toContainText('₹0.00')
    await expect(dialog).toContainText('Nothing recorded as paid yet')
    await dialog.getByLabel('Received now').fill('1')
    await dialog.getByRole('button', { name: 'Renew and create invoice' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/cannot exceed the net price of ₹0.00/)
    await dialog.getByLabel('Received now').fill('')
    await submitSell(page, dialog)
    await expect(page.getByRole('article')).toContainText('RK-00002')
    totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Subtotal: '₹1,500.00', Discount: '− ₹1,500.00', Total: '₹0.00', Paid: '₹0.00', 'Balance due': '₹0.00' })
    await expect(page.getByRole('article').locator('span', { hasText: /^Paid$/ })).toBeVisible()
    const inv2 = (await readStore<Invoice>(page, 'invoices')).find((i) => i.number === 'RK-00002')!
    expect(inv2).toMatchObject({ totalPaise: 0, discountPaise: 150000, subtotalPaise: 150000 })
    const free = (await readStore<Membership>(page, 'memberships')).find((m) => m.invoiceId === inv2.id)!
    expect(free).toMatchObject({ pricePaise: 0, discountPaise: 150000, listPricePaise: 150000 })
    expect((await readStore<Payment>(page, 'payments')).length).toBe(1)
  })

  test('start-date choices: after current, today after expiry, overlap warning, past and far future', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const today = todayInTz(TZ)
    const memberUrl = await addMember(page, 'Dates Person', '98200 13000')

    // First sale: an expired membership from a custom past date. No warning is shown for a past start.
    let dialog = await openSell(page, { startDate: '2020-01-01' })
    await expect(dialog).toContainText(`${formatDate('2020-01-01')} to ${formatDate('2020-01-31')}`)
    await expect(dialog).not.toContainText(/Overlaps/)
    await submitSell(page, dialog)
    const inv1 = (await readStore<Invoice>(page, 'invoices'))[0]
    expect(inv1.issueDate, 'invoice is issued today, not on the start date').toBe(today)
    await page.goto(memberUrl)
    await expect(page.getByRole('main')).toContainText('Expired')

    // Renewing an expired membership defaults to Today and labels the other option as in the past.
    dialog = await openSell(page)
    await expect(dialog.getByRole('button', { name: /^Today/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByRole('button', { name: /Right after last plan/ })).toHaveAttribute('aria-pressed', 'false')
    await expect(dialog.getByRole('button', { name: /Right after last plan/ })).toContainText('(in the past)')
    await expect(dialog.getByRole('button', { name: /Right after last plan/ })).toContainText(formatDate('2020-02-01'))
    await expect(dialog).toContainText(`${formatDate(today)} to ${formatDate(membershipEndDate(today, 1, 'months'))}`)
    await submitSell(page, dialog)
    const current = (await readStore<Membership>(page, 'memberships')).find((m) => m.startDate === today)!
    expect(current.renewalOfId).toBeTruthy()

    // Renewing an active membership defaults to After current plan; choosing Today warns about the overlap.
    await page.goto(memberUrl)
    dialog = await openSell(page)
    await expect(dialog.getByRole('button', { name: /After current plan/ })).toHaveAttribute('aria-pressed', 'true')
    const after = addDays(current.endDate, 1)
    await expect(dialog).toContainText(`${formatDate(after)} to ${formatDate(membershipEndDate(after, 1, 'months'))}`)
    await expect(dialog).not.toContainText(/Overlaps/)
    await dialog.getByRole('button', { name: /^Today/ }).click()
    await expect(dialog).toContainText(`Overlaps the existing Monthly membership (${formatDate(current.startDate)} – ${formatDate(current.endDate)}). You can still proceed.`)
    // Far future custom date: accepted, no overlap, member shows an upcoming plan.
    await dialog.getByRole('button', { name: /Pick a date/ }).click()
    await dialog.getByLabel('Start date').fill('2099-12-31')
    await expect(dialog).toContainText(`${formatDate('2099-12-31')} to ${formatDate('2100-01-30')}`)
    await expect(dialog).not.toContainText(/Overlaps/)
    // Blank custom date is refused by the schema.
    await dialog.getByLabel('Start date').fill('')
    await dialog.getByRole('button', { name: 'Renew and create invoice' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/valid date/)
    await dialog.getByLabel('Start date').fill('2099-12-31')
    await submitSell(page, dialog)
    const all = await readStore<Membership>(page, 'memberships')
    expect(all).toHaveLength(3)
    expect(all.find((m) => m.startDate === '2099-12-31')?.endDate).toBe('2100-01-30')
    const counters = await readStore<Counter>(page, 'counters')
    expect(counters.find((c) => c.key === 'invoice')?.value).toBe(3)
    const numbers = (await readStore<Invoice>(page, 'invoices')).map((i) => i.number).sort()
    expect(numbers).toEqual(['RK-00001', 'RK-00002', 'RK-00003'])
  })

  test('end dates: 31 Jan month plan, Feb 29 2028, 12-month from a leap day, day plans', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await createPlan(page, 'Yearly', 12, 'months', '12000')
    await createPlan(page, 'Ten days', 10, 'days', '500')
    await addMember(page, 'Leap Year', '98200 14000')

    const cases: Array<{ plan: RegExp; start: string; end: string; note?: string }> = [
      { plan: /Monthly/, start: '2026-01-31', end: '2026-02-27', note: '31 Jan + 1 month clamps to 28 Feb exclusive → 27 Feb inclusive (same end as a 28 Jan start)' },
      { plan: /Monthly/, start: '2026-01-28', end: '2026-02-27' },
      { plan: /Monthly/, start: '2026-02-01', end: '2026-02-28' },
      { plan: /Monthly/, start: '2028-01-29', end: '2028-02-28' },
      { plan: /Monthly/, start: '2028-01-31', end: '2028-02-28' },
      { plan: /Monthly/, start: '2028-02-29', end: '2028-03-28' },
      { plan: /Yearly/, start: '2028-02-29', end: '2029-02-27', note: '12 months from a leap day ends 27 Feb 2029 (365 days)' },
      { plan: /Yearly/, start: '2028-03-01', end: '2029-02-28' },
      { plan: /Ten days/, start: '2028-02-25', end: '2028-03-05' },
      { plan: /Ten days/, start: '2026-12-31', end: '2027-01-09' },
    ]
    const dialog = await openSell(page, { planLabel: cases[0].plan, startDate: cases[0].start })
    for (const c of cases) {
      const labels = await dialog.getByLabel('Plan').locator('option').allTextContents()
      await dialog.getByLabel('Plan').selectOption({ label: labels.find((l) => c.plan.test(l))! })
      await dialog.getByLabel('Start date').fill(c.start)
      const [v, unit] = c.plan.test('Ten days') ? [10, 'days' as const] : c.plan.test('Yearly') ? [12, 'months' as const] : [1, 'months' as const]
      expect(membershipEndDate(c.start, v, unit), `library end date for ${c.start}`).toBe(c.end)
      await expect(dialog, `${c.start} (${c.plan})`).toContainText(`${formatDate(c.start)} to ${formatDate(c.end)}`)
      if (c.note) test.info().annotations.push({ type: 'end-date', description: `${c.start}: ${c.note}` })
    }
    // Sell the 31 Jan one so the stored record matches the preview.
    const labels = await dialog.getByLabel('Plan').locator('option').allTextContents()
    await dialog.getByLabel('Plan').selectOption({ label: labels.find((l) => /Monthly/.test(l))! })
    await dialog.getByLabel('Start date').fill('2026-01-31')
    await submitSell(page, dialog)
    const ms = await readStore<Membership>(page, 'memberships')
    expect(ms[0]).toMatchObject({ startDate: '2026-01-31', endDate: '2026-02-27' })
    await expect(page.getByRole('article')).toContainText(`${formatDate('2026-01-31')} to ${formatDate('2026-02-27')}`)
  })
})

test.describe('3. invoice numbering', () => {
  test('sequential across sales and renewals, unique, no gaps after a void, counter equals invoices created', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const a = await addMember(page, 'Alpha One', '98200 15001')
    await sellMembership(page, { receivedNow: '0' })
    await page.goto(a)
    await sellMembership(page) // renewal
    const b = await addMember(page, 'Beta Two', '98200 15002')
    await sellMembership(page)

    let invoices = await readStore<Invoice>(page, 'invoices')
    expect(invoices.map((i) => i.number).sort()).toEqual(['RK-00001', 'RK-00002', 'RK-00003'])

    // Void RK-00002 (no payments) from the member page.
    await page.goto(a + '?tab=payments')
    const row = page.locator('li', { hasText: 'RK-00002' }).first()
    await row.getByRole('button', { name: 'Void' }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm.getByRole('button', { name: 'Void' })).toBeDisabled()
    await confirm.getByLabel('Reason').fill('Sold by mistake')
    await confirm.getByRole('button', { name: 'Void' }).click()
    await expect(confirm).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Invoice voided' })).toBeVisible()

    // A failed sale (discount too high) must not consume a number.
    await page.goto(b)
    const bad = await openSell(page, { discount: '9999' })
    await bad.getByRole('button', { name: 'Renew and create invoice' }).click()
    await expect(bad.getByRole('alert')).toContainText(/Discount/)
    await bad.getByLabel('Discount').fill('0')
    await submitSell(page, bad)

    invoices = await readStore<Invoice>(page, 'invoices')
    const numbers = invoices.map((i) => i.number).sort()
    expect(numbers).toEqual(['RK-00001', 'RK-00002', 'RK-00003', 'RK-00004'])
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(invoices.find((i) => i.number === 'RK-00002')).toMatchObject({ status: 'void', voidReason: 'Sold by mistake' })
    const counters = await readStore<Counter>(page, 'counters')
    expect(counters.find((c) => c.key === 'invoice')).toEqual({ key: 'invoice', value: 4 })

    // BUG probe: voiding the invoice leaves its membership in place and the member still looks active.
    const ms = await readStore<Membership>(page, 'memberships')
    const voidedMs = ms.find((m) => m.invoiceId === invoices.find((i) => i.number === 'RK-00002')!.id)
    // Voiding the invoice cancels the membership it sold; the record stays for history.
    expect(voidedMs?.cancelledAt).toBeTruthy()
    expect(voidedMs?.cancelReason).toContain('RK-00002')
    await page.goto(a + '?tab=memberships')
    const voidedRow = page.locator('li', { hasText: 'RK-00002' }).first()
    await expect(voidedRow).toBeVisible()
    await expect(voidedRow).toContainText('Void')
    await expect(voidedRow).toContainText('Cancelled')
  })
})

test.describe('4. payments, voids and adjustments', () => {
  test('partial → overpay refused with outstanding amount → exact; unlinked credit; void payment; void invoice rules', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const memberUrl = await addMember(page, 'Pay Person', '98200 16000')
    const invoiceUrl = await sellMembership(page, { receivedNow: '500', method: 'cash' })

    // Partial.
    let dialog = await recordPaymentOnInvoice(page, '300', 'upi')
    await expect(dialog).toBeHidden()
    let totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Total: '₹1,500.00', Paid: '₹800.00', 'Balance due': '₹700.00' })

    // Overpay refused with the outstanding amount; values kept.
    dialog = await recordPaymentOnInvoice(page, '700.01', 'card')
    await expect(dialog.getByRole('alert')).toContainText('Only ₹700.00 is outstanding on RK-00001')
    await expect(dialog.getByLabel('Amount received')).toHaveValue('700.01')
    // Zero refused by the schema.
    await dialog.getByLabel('Amount received').fill('0')
    await dialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/greater than zero/)
    // Exact.
    await dialog.getByLabel('Amount received').fill('700')
    await dialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(dialog).toBeHidden()
    totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Paid: '₹1,500.00', 'Balance due': '₹0.00' })
    await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0)
    let payments = await readStore<Payment>(page, 'payments')
    expect(payments.map((p) => p.amountPaise).sort((x, y) => x - y)).toEqual([30000, 50000, 70000])

    // Unlinked credit from the member page changes the member balance (credit) but not the invoice.
    await page.goto(memberUrl + '?tab=payments')
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹0.00')
    await page.getByRole('button', { name: 'Record payment' }).first().click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('No invoices with a balance')
    await expect(dialog.getByLabel('Apply to invoice')).toHaveValue('')
    await dialog.getByLabel('Amount received').fill('200')
    await dialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'unlinked credit' })).toBeVisible()
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹200.00 credit')
    payments = await readStore<Payment>(page, 'payments')
    const credit = payments.find((p) => !p.invoiceId)!
    expect(credit).toMatchObject({ amountPaise: 20000, status: 'recorded' })
    await expect(page.getByRole('main')).toContainText('unlinked credit')

    // Void the credit: reason required, balance returns to 0, record kept as void.
    const creditRow = page.locator('li', { hasText: 'unlinked credit' }).first()
    await creditRow.getByRole('button', { name: 'Void' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Void payment of ₹200.00?' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Void' })).toBeDisabled()
    await dialog.getByLabel('Reason').fill('   ')
    await expect(dialog.getByRole('button', { name: 'Void' })).toBeDisabled()
    await dialog.getByLabel('Reason').fill('Entered twice')
    await dialog.getByRole('button', { name: 'Void' }).click()
    await expect(dialog).toBeHidden()
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹0.00')
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹1,500.00 paid of ₹1,500.00')
    payments = await readStore<Payment>(page, 'payments')
    expect(payments.find((p) => p.id === credit.id)).toMatchObject({ status: 'void', voidReason: 'Entered twice', rev: 2 })
    expect(payments).toHaveLength(4)
    // Service refuses an empty reason and a second void.
    expect(await svc(page, 'payments', 'voidPayment', credit.id, 2, '  ')).toMatchObject({ ok: false, error: /reason/i })
    expect(await svc(page, 'payments', 'voidPayment', credit.id, 2, 'again')).toMatchObject({ ok: false, error: /already void/ })

    // Void invoice is blocked while it has recorded payments (button hidden, service refuses).
    const invoice = (await readStore<Invoice>(page, 'invoices'))[0]
    const invRow = page.locator('li', { hasText: 'RK-00001' }).first()
    await expect(invRow.getByRole('button', { name: 'Void' })).toHaveCount(0)
    expect(await svc(page, 'payments', 'voidInvoice', invoice.id, invoice.rev, 'test')).toMatchObject({ ok: false, error: /recorded payments/ })
    expect((await readStore<Invoice>(page, 'invoices'))[0].status).toBe('issued')

    // Void the three payments, then the invoice can be voided.
    for (const amount of ['₹700.00', '₹300.00', '₹500.00']) {
      await page.locator('li', { hasText: amount }).filter({ has: page.getByRole('button', { name: 'Void' }) }).first().getByRole('button', { name: 'Void' }).click()
      const d = page.getByRole('dialog')
      await d.getByLabel('Reason').fill(`refund ${amount}`)
      await d.getByRole('button', { name: 'Void' }).click()
      await expect(d).toBeHidden()
    }
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹1,500.00')
    await expect(invRow.getByRole('button', { name: 'Void' })).toBeVisible()
    await invRow.getByRole('button', { name: 'Void' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason').fill('Cancelled')
    await dialog.getByRole('button', { name: 'Void' }).click()
    await expect(dialog).toBeHidden()
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹0.00')
    const voided = (await readStore<Invoice>(page, 'invoices'))[0]
    expect(voided).toMatchObject({ status: 'void', voidReason: 'Cancelled' })
    expect((await readStore<Payment>(page, 'payments')).every((p) => p.status === 'void')).toBe(true)

    // Void invoice page: no Adjust / Record payment, shows the void banner; payment against it refused by the service.
    await page.goto(invoiceUrl)
    await expect(page.getByRole('article')).toContainText('Void invoice')
    await expect(page.getByRole('article')).toContainText('This invoice was voided on')
    await expect(page.getByRole('button', { name: 'Adjust' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0)
    totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Total: '₹0.00', Paid: '₹0.00', 'Balance due': '₹0.00' })
    const member = (await readStore<Member>(page, 'members'))[0]
    expect(await svc(page, 'payments', 'recordPayment', { memberId: member.id, invoiceId: voided.id, amountPaise: 100, method: 'cash', receivedAt: new Date().toISOString() })).toMatchObject({ ok: false, error: /void/ })
    expect(await svc(page, 'payments', 'addAdjustment', { invoiceId: voided.id, amountPaise: 100, reason: 'x' })).toMatchObject({ ok: false, error: /Void invoices cannot be adjusted/ })
  })

  test('adjustments: reduce below zero rejected, reduce, increase, reason required; invoice totals match the store', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Adj Person', '98200 17000')
    await sellMembership(page, { receivedNow: '400' })

    await page.getByRole('button', { name: 'Adjust' }).click()
    let dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Current total ₹1,500.00')
    const add = dialog.getByRole('button', { name: 'Add adjustment' })
    await expect(add).toBeDisabled()
    await dialog.getByLabel('Amount').fill('2000')
    await expect(add, 'reason required').toBeDisabled()
    await dialog.getByLabel('Reason').fill('   ')
    await expect(add, 'whitespace reason is not a reason').toBeDisabled()
    await dialog.getByLabel('Reason').fill('Too much')
    await expect(add).toBeEnabled()
    await add.click()
    await expect(dialog.getByRole('alert')).toContainText(/would make the invoice total negative \(currently ₹1,500.00\)/)
    expect((await readStore(page, 'adjustments')).length).toBe(0)

    // Zero and bad amounts keep the button disabled.
    await dialog.getByLabel('Amount').fill('0')
    await expect(add).toBeDisabled()
    await dialog.getByLabel('Amount').fill('abc')
    await expect(add).toBeDisabled()

    // Reduce by 500.
    await dialog.getByLabel('Amount').fill('500')
    await add.click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'RK-00001 is now ₹1,000.00' })).toBeVisible()
    let totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Subtotal: '₹1,500.00', Adjustments: '− ₹500.00', Total: '₹1,000.00', Paid: '₹400.00', 'Balance due': '₹600.00' })
    expect(totals.Discount).toBeUndefined()
    await expect(page.getByRole('article')).toContainText('Adjustment: Too much')

    // Increase by 250.75.
    await page.getByRole('button', { name: 'Adjust' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Current total ₹1,000.00')
    await dialog.getByLabel('Direction').selectOption('increase')
    await dialog.getByLabel('Amount').fill('250.75')
    await dialog.getByLabel('Reason').fill('Locker')
    await dialog.getByRole('button', { name: 'Add adjustment' }).click()
    await expect(dialog).toBeHidden()
    totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Adjustments: '− ₹249.25', Total: '₹1,250.75', Paid: '₹400.00', 'Balance due': '₹850.75' })

    // Reduce to exactly zero is allowed and shows the paid amount as credit.
    await page.getByRole('button', { name: 'Adjust' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Amount').fill('1250.75')
    await dialog.getByLabel('Reason').fill('Waived')
    await dialog.getByRole('button', { name: 'Add adjustment' }).click()
    await expect(dialog).toBeHidden()
    totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Total: '₹0.00', Paid: '₹400.00', Credit: '₹400.00' })
    await expect(page.getByRole('article').getByText('Overpaid')).toBeVisible()

    // Store-derived numbers must equal what the page shows.
    const [inv] = await readStore<Invoice>(page, 'invoices')
    const adjs = await readStore<Adjustment>(page, 'adjustments')
    const pays = await readStore<Payment>(page, 'payments')
    expect(adjs.map((a) => a.amountPaise).sort((x, y) => x - y)).toEqual([-125075, -50000, 25075])
    const adjSum = adjs.reduce((s, a) => s + a.amountPaise, 0)
    const paid = pays.filter((p) => p.status === 'recorded' && p.invoiceId === inv.id).reduce((s, p) => s + p.amountPaise, 0)
    expect(totals.Subtotal).toBe(inr(inv.subtotalPaise))
    expect(totals.Adjustments).toBe(`${adjSum < 0 ? '− ' : '+ '}${inr(Math.abs(adjSum))}`)
    expect(totals.Total).toBe(inr(inv.totalPaise + adjSum))
    expect(totals.Paid).toBe(inr(paid))
    expect(totals.Credit).toBe(inr(Math.abs(inv.totalPaise + adjSum - paid)))
    // Member page agrees.
    await page.getByRole('link', { name: 'Adj Person' }).click()
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹400.00 credit')
    // Payments page invoice list reports the invoice as paid (balance ≤ 0) and the outstanding total excludes it.
    await page.goto('/payments?tab=invoices')
    await page.getByRole('tab', { name: 'Paid' }).click()
    await expect(page.getByRole('main')).toContainText('RK-00001')
    await expect(page.getByRole('main')).toContainText('Overpaid')
    await expect(statCard(page.getByRole('main'), 'Outstanding (all time)')).toContainText('₹0.00')
  })
})

test.describe('5. payments page', () => {
  test('period presets, custom range and method filter match the store; invoice filters; pagination at 25; ?action=record focuses the picker', async ({ page }) => {
    await onboard(page, 'sample')
    const today = todayInTz(TZ)
    const members = await readStore<Member>(page, 'members')
    const kabir = members.find((m) => m.name.includes('Kabir'))!

    // Seed 30 unlinked credits for Kabir through the service so the list exceeds one page.
    for (let i = 0; i < 30; i++) {
      const r = await svc(page, 'payments', 'recordPayment', { memberId: kabir.id, amountPaise: 100 + i, method: i % 2 ? 'cash' : 'bank', receivedAt: new Date().toISOString(), note: `seed ${i}` })
      expect(r.ok, `seed ${i}`).toBe(true)
    }
    const payments = await readStore<Payment>(page, 'payments')
    const invoices = await readStore<Invoice>(page, 'invoices')
    const adjustments = await readStore<Adjustment>(page, 'adjustments')
    const dateOf = (p: Payment) => instantToDateInTz(p.receivedAt, TZ)
    const countIn = (start: string, end: string, method = 'all') => payments.filter((p) => dateOf(p) >= start && dateOf(p) <= end && (method === 'all' || p.method === method)).length
    const sumIn = (start: string, end: string, method = 'all') => payments.filter((p) => p.status === 'recorded' && dateOf(p) >= start && dateOf(p) <= end && (method === 'all' || p.method === method)).reduce((s, p) => s + p.amountPaise, 0)

    await page.goto('/payments')
    const main = page.getByRole('main')
    const expectCount = async (label: string, n: number) => {
      if (n === 0) {
        await expect(main.getByText('No payments in this period'), label).toBeVisible()
        await expect(paginationText(page)).toHaveCount(0)
      } else {
        await expect(paginationText(page), label).toContainText(`of ${n}`)
        await expect(main.locator('tbody tr'), label).toHaveCount(Math.min(25, n))
      }
    }
    const presets: Array<[string, string, string]> = [
      ['30 days', addDays(today, -29), 'Received · last 30 days'],
      ['7 days', addDays(today, -6), 'Received · last 7 days'],
      ['This month', today.slice(0, 7) + '-01', 'Received · this month'],
      ['90 days', addDays(today, -89), 'Received · last 90 days'],
      ['This year', today.slice(0, 4) + '-01-01', 'Received · this year'],
    ]
    for (const [name, start, statLabel] of presets) {
      await page.getByRole('tab', { name, exact: true }).click()
      await expectCount(name, countIn(start, today))
      await expect(statCard(main, statLabel), `${name} total`).toContainText(inr(sumIn(start, today)))
    }
    // Pagination at 25 inside the current (year) preset.
    const yearStart = today.slice(0, 4) + '-01-01'
    const yearCount = countIn(yearStart, today)
    expect(yearCount).toBeGreaterThan(25)
    await expect(paginationText(page)).toContainText(`1–25 of ${yearCount}`)
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(page).toHaveURL(/page=2/)
    await expect(paginationText(page)).toContainText(`26–${Math.min(50, yearCount)} of ${yearCount}`)
    await expect(main.locator('tbody tr')).toHaveCount(Math.min(25, yearCount - 25))
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
    // Changing the method filter resets to page 1.
    await page.getByLabel('Method').selectOption('bank')
    await expect(page).toHaveURL(/page=1/)
    await expectCount('bank', countIn(yearStart, today, 'bank'))
    await page.getByLabel('Method').selectOption('upi')
    await expectCount('upi', countIn(yearStart, today, 'upi'))
    await page.getByLabel('Method').selectOption('all')

    // Custom range: today only, then a range with nothing in it.
    await page.getByRole('tab', { name: 'Custom' }).click()
    await page.getByLabel('From date').fill(today)
    await page.getByLabel('To date').fill(today)
    await expectCount('custom today', countIn(today, today))
    await page.getByLabel('From date').fill('2001-01-01')
    await page.getByLabel('To date').fill('2001-01-31')
    await expectCount('custom empty', 0)

    // Invoices tab filters.
    const balances = invoices.map((inv) => {
      const adj = adjustments.filter((a) => a.invoiceId === inv.id).reduce((s, a) => s + a.amountPaise, 0)
      const paid = payments.filter((p) => p.invoiceId === inv.id && p.status === 'recorded').reduce((s, p) => s + p.amountPaise, 0)
      const due = inv.status === 'void' ? 0 : inv.totalPaise + adj
      return { inv, balance: due - paid }
    })
    const open = balances.filter((b) => b.inv.status === 'issued' && b.balance > 0).length
    const paid = balances.filter((b) => b.inv.status === 'issued' && b.balance <= 0).length
    const voidN = balances.filter((b) => b.inv.status === 'void').length
    await page.getByRole('tab', { name: 'Invoices' }).click()
    await expect(page).toHaveURL(/tab=invoices/)
    const expectInvoices = async (label: string, n: number) => {
      if (n === 0) {
        await expect(main.getByText(/No outstanding invoices|No invoices here/), label).toBeVisible()
      } else {
        await expect(paginationText(page), label).toContainText(`of ${n}`)
        await expect(main.locator('tbody tr'), label).toHaveCount(Math.min(25, n))
      }
    }
    await expectInvoices('outstanding', open)
    await expect(main.locator('tbody')).not.toContainText(/\bPaid\b/)
    await page.getByRole('tab', { name: 'Paid' }).click()
    await expectInvoices('paid', paid)
    await page.getByRole('tab', { name: 'Void' }).click()
    await expectInvoices('void', voidN)
    await page.getByRole('tab', { name: 'All' }).click()
    await expectInvoices('all', invoices.length)
    expect(open + paid + voidN).toBe(invoices.length)

    // ?action=record focuses the member picker and strips the param.
    await page.goto('/payments?action=record')
    await expect(page.locator('#payment-member-picker')).toBeVisible()
    await expect(page).not.toHaveURL(/action=record/)
    await page.waitForTimeout(300)
    const focused = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName)
    expect.soft(focused, 'BUG: ?action=record does not focus the picker (focus fires 50ms after mount, before the snapshot has loaded)').toBe('payment-member-picker')
  })

  test('"recorded payments" hint pluralises by the recorded count', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    const memberUrl = await addMember(page, 'Plural Person', '98200 18000')
    await sellMembership(page, { receivedNow: '500' })
    // wait for the save before leaving the page, or the payment may never be written
    await expect(await recordPaymentOnInvoice(page, '200')).toBeHidden()
    await page.goto(memberUrl + '?tab=payments')
    await page.locator('li', { hasText: '₹200.00' }).first().getByRole('button', { name: 'Void' }).click()
    const d = page.getByRole('dialog')
    await d.getByLabel('Reason').fill('oops')
    await d.getByRole('button', { name: 'Void' }).click()
    await expect(d).toBeHidden()
    await page.goto('/payments')
    const main = page.getByRole('main')
    await expect(main).toContainText('₹500.00')
    await expect(paginationText(page)).toContainText('of 2')
    await expect(main.getByText(/\brecorded payment/)).toBeVisible()
    const hint = await main.getByText(/\brecorded payment/).innerText()
    expect.soft(hint, 'BUG: pluralisation uses the list length, not the recorded count').toBe('1 recorded payment')
  })
})

test.describe('6. outstanding agreement', () => {
  test('dashboard, member detail and payments page agree with invoice balances minus unlinked credits', async ({ page }) => {
    await onboard(page, 'sample')
    const members = await readStore<Member>(page, 'members')
    const kabir = members.find((m) => m.name.includes('Kabir'))!
    // Kabir owes ₹500 on a ₹1,500 invoice; add a ₹200 unlinked credit.
    await page.goto(`/members/${kabir.id}`)
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹500.00')
    await page.getByRole('button', { name: 'Record payment' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Apply to invoice').selectOption('')
    await dialog.getByLabel('Amount received').fill('200')
    await dialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(dialog).toBeHidden()
    await expect(statCard(page.getByRole('main'), 'Outstanding')).toContainText('₹300.00')

    const [invoices, payments, adjustments] = await Promise.all([readStore<Invoice>(page, 'invoices'), readStore<Payment>(page, 'payments'), readStore<Adjustment>(page, 'adjustments')])
    const perMember = (m: Member) => {
      const due = invoices.filter((i) => i.memberId === m.id && i.status === 'issued').reduce((s, i) => s + i.totalPaise + adjustments.filter((a) => a.invoiceId === i.id).reduce((x, a) => x + a.amountPaise, 0), 0)
      const paid = payments.filter((p) => p.memberId === m.id && p.status === 'recorded').reduce((s, p) => s + p.amountPaise, 0)
      return due - paid
    }
    const live = members.filter((m) => m.status !== 'archived')
    const expectedDashboard = live.reduce((s, m) => s + Math.max(0, perMember(m)), 0)
    const owing = live.filter((m) => perMember(m) > 0).length
    expect(perMember(kabir)).toBe(30000)

    await page.goto('/')
    const card = statCard(page.getByRole('main'), 'Outstanding')
    const compact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(expectedDashboard / 100)
    await expect(card).toContainText(expectedDashboard % 100 === 0 ? compact : inr(expectedDashboard))
    await expect(card).toContainText(`${owing} member${owing === 1 ? '' : 's'} owe money`)

    // Members list "Owing" filter counts the same people.
    await page.goto('/members?filter=balance')
    await expect(page.getByRole('tab', { name: /Owing/ })).toContainText(String(owing))

    // Payments and Reports pages use the same member-level definition as the dashboard (unlinked credits applied, archived excluded).
    await page.goto('/payments')
    const paymentsPage = await statCard(page.getByRole('main'), 'Outstanding (all time)').innerText()
    expect(paymentsPage).toContain(inr(expectedDashboard))
    await page.goto('/reports')
    const reportsPage = await statCard(page.getByRole('main'), 'Outstanding (all time)').innerText()
    expect(reportsPage).toContain(inr(expectedDashboard))
  })
})

test.describe('7. double submit', () => {
  test('double-clicking Sell creates exactly one membership, invoice and payment', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Double Click', '98200 19000')
    const dialog = await openSell(page, { receivedNow: '100' })
    await dialog.getByRole('button', { name: 'Sell and create invoice' }).dblclick()
    await expect(page).toHaveURL(/\/invoices\/inv_/)
    await expect(page.getByRole('article')).toContainText('RK-00001')
    await page.waitForTimeout(500)
    expect((await readStore(page, 'memberships')).length).toBe(1)
    expect((await readStore(page, 'invoices')).length).toBe(1)
    expect((await readStore(page, 'payments')).length).toBe(1)
    expect((await readStore<Counter>(page, 'counters')).find((c) => c.key === 'invoice')).toEqual({ key: 'invoice', value: 1 })
  })

  test('double-clicking Record payment creates exactly one payment', async ({ page }) => {
    await onboard(page, 'empty')
    await createPlan(page, 'Monthly', 1, 'months', '1500')
    await addMember(page, 'Double Pay', '98200 19001')
    await sellMembership(page, { receivedNow: '100' })
    await page.getByRole('button', { name: 'Record payment' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Amount received').fill('300')
    await dialog.getByRole('button', { name: 'Record payment' }).dblclick()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Recorded ₹300.00' })).toBeVisible()
    await page.waitForTimeout(500)
    const payments = await readStore<Payment>(page, 'payments')
    expect(payments.map((p) => p.amountPaise).sort((a, b) => a - b)).toEqual([10000, 30000])
    const totals = await invoiceTotals(page)
    expect(totals).toMatchObject({ Paid: '₹400.00', 'Balance due': '₹1,100.00' })
  })
})
