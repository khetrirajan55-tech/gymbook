import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { onboard, createPlan, readStore } from '../helpers'
import { FakeDrive, mockGoogle, setGoogle } from '../google'
import { formatDateTime } from '../../src/domain/dates'
import { gunzipSync } from 'node:zlib'

/**
 * Google Drive backup, end to end in the browser, against a stand-in for Google (see e2e/google.ts).
 * These prove what GymBook does with Google's answers. They do not prove Google's side: sign-in
 * with a real account and a real Drive upload are listed as NOT TESTED in TEST-REPORT.md.
 */

const TZ = 'Asia/Kolkata'
const A = { id: 'acct-a', email: 'owner.a@example.com' }
const B = { id: 'acct-b', email: 'owner.b@example.com' }
// A 1×1 PNG; the app turns it into the small JPEG it stores with the member.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

type Rec = Record<string, unknown> & { id: string }
const STORES = ['members', 'plans', 'memberships', 'invoices', 'payments'] as const

const newDrive = () => {
  const drive = new FakeDrive()
  drive.addAccount('token-a', A)
  drive.addAccount('token-b', B)
  return drive
}
const section = (page: Page) => page.locator('#drive')
const isUpload = (r: { url: string }) => r.url.includes('/upload/')
/** The backup as Drive holds it. It is gzip-compressed; Node's own gzip opens it, independently of the app's code. */
const stored = (drive: FakeDrive, accountId: string) => {
  const raw = Buffer.from(drive.files(accountId)[0].content)
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  return JSON.parse(text) as { data: Record<string, Rec[]> }
}
const byId = (rows: Rec[]) => [...rows].sort((x, y) => (x.id < y.id ? -1 : 1))

async function snapshot(page: Page): Promise<Record<string, Rec[]>> {
  const out: Record<string, Rec[]> = {}
  for (const s of STORES) out[s] = byId(await readStore<Rec>(page, s))
  return out
}

/** A member with a photo, a plan, a membership, an invoice and a part payment. Returns the member's URL. */
async function addTestMember(page: Page, name = 'Drive Test Member', phone = '98200 77001'): Promise<string> {
  await createPlan(page, 'Monthly', 1, 'months', '1500')
  await page.goto('/members/new')
  await page.getByLabel('Full name').fill(name)
  await page.getByLabel(/^Phone/).fill(phone)
  await page.locator('input#member-photo').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible()
  await page.getByLabel('Plan', { exact: true }).selectOption({ index: 1 })
  await page.getByLabel('Received now').fill('500')
  await page.getByRole('button', { name: 'Add member and create invoice' }).click()
  await expect(page).toHaveURL(/\/members\/mem_/)
  return page.url()
}

/** Open Settings (a full page load, so any earlier Google session is gone) and sign in. */
/** The remembered Google sign-in lasts an hour; tests that need a signed-out start let that hour "run out". */
const expireSession = (page: Page) => page.evaluate(() => localStorage.removeItem('gymbook-drive-token'))

async function openAndSignIn(page: Page, token = 'token-a') {
  await expireSession(page)
  await page.goto('/settings')
  await setGoogle(page, { token })
  await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
}

async function backUp(page: Page) {
  await section(page).getByRole('button', { name: 'Back up now' }).click()
}

/** Everything up to a first verified backup in account A. */
async function gymWithBackup(page: Page, drive: FakeDrive) {
  await mockGoogle(page, drive)
  await onboard(page, 'empty')
  const memberUrl = await addTestMember(page)
  await openAndSignIn(page)
  await expect(section(page)).toContainText(A.email)
  await backUp(page)
  await expect(section(page).getByRole('status').filter({ hasText: 'Backup saved to Google Drive' })).toBeVisible()
  return memberUrl
}

test.describe('Google Drive backup', () => {
  test.beforeEach(({}, testInfo) => testInfo.setTimeout(90_000))

  test('1–3. member with photo is in IndexedDB; back up, verify the file, change, back up again; unchanged data is not uploaded', async ({ page }) => {
    const drive = newDrive()
    await mockGoogle(page, drive)
    await onboard(page, 'empty')
    const memberUrl = await addTestMember(page)

    // 1. the test member, its membership and its photo are in IndexedDB
    const local = await snapshot(page)
    expect(local.members).toHaveLength(1)
    expect(local.members[0]).toMatchObject({ name: 'Drive Test Member', phone: '98200 77001' })
    expect(String(local.members[0].photoDataUrl)).toMatch(/^data:image\/jpeg;base64,/)
    expect(local.memberships).toHaveLength(1)
    expect(local.invoices).toHaveLength(1)
    expect(local.payments).toMatchObject([{ amountPaise: 50000 }])

    // 2. sign in, back up, and check what actually landed in Drive
    await page.goto('/settings')
    await expect(section(page).getByRole('heading', { name: 'Google Drive backup' })).toBeVisible()
    await expect(section(page)).toContainText('Not signed in')
    await expect(section(page)).toContainText('Never')
    await expect(section(page)).toContainText('Not backed up to Google Drive yet')
    await setGoogle(page, { token: 'token-a' })
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await expect(section(page)).toContainText(A.email)
    // signing in is not a backup and not a restore
    expect(drive.uploads()).toBe(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const calls = await page.evaluate(() => (window as unknown as { __googleCalls: { scope: string; client_id: string }[] }).__googleCalls)
    expect(calls[0]).toMatchObject({ scope: 'https://www.googleapis.com/auth/drive.appdata', client_id: 'gymbook-tests.apps.googleusercontent.com' })

    await backUp(page)
    const saved = section(page).getByRole('status').filter({ hasText: 'Backup saved to Google Drive' })
    await expect(saved).toContainText('checked against what Google Drive stored')
    expect(drive.files(A.id)).toHaveLength(1)
    const first = { ...drive.files(A.id)[0] }
    expect(first.name).toBe('gymbook-backup.json')
    expect(byId(stored(drive, A.id).data.members)).toEqual(local.members)
    expect(byId(stored(drive, A.id).data.memberships)).toEqual(local.memberships)
    await expect(section(page)).toContainText(formatDateTime(first.modifiedTime, TZ))
    await expect(section(page)).toContainText('1 member')
    await expect(section(page)).toContainText('Up to date')
    // the token is remembered in one place only, for no longer than Google's hour, and signing out removes it
    const kept = await page.evaluate(() => Object.entries(localStorage).filter(([, v]) => v.includes('token-a')).map(([k, v]) => ({ k, left: (JSON.parse(v) as { expiresAt: number }).expiresAt - Date.now() })))
    expect(kept.map((x) => x.k)).toEqual(['gymbook-drive-token'])
    expect(kept[0].left).toBeGreaterThan(0)
    expect(kept[0].left).toBeLessThanOrEqual(3600_000)

    if (process.env.SHOT_DIR) {
      await section(page).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${process.env.SHOT_DIR}/drive-desktop.png`, fullPage: true })
      const size = page.viewportSize()!
      await page.setViewportSize({ width: 375, height: 812 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      await page.screenshot({ path: `${process.env.SHOT_DIR}/drive-phone.png`, fullPage: true })
      await page.setViewportSize(size)
    }

    // 3a. nothing changed: no second upload
    await backUp(page)
    await expect(section(page).getByRole('status').filter({ hasText: 'Already up to date' })).toContainText('nothing was uploaded')
    expect(drive.uploads()).toBe(1)

    // 3b. change the member: the same file is replaced, not a second one added
    await page.goto(memberUrl + '/edit')
    await page.getByLabel('Full name').fill('Drive Test Member Renamed')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(memberUrl)
    await page.goto('/settings')
    await section(page).getByRole('button', { name: 'Sign out' }).click()
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('token-a')
    await page.reload()
    await expect(section(page)).toContainText('Changes on this device are not backed up yet')
    await expect(section(page)).toContainText(`${A.email} (signed out)`)
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await backUp(page)
    await expect(saved).toBeVisible()
    expect(drive.uploads()).toBe(2)
    expect(drive.files(A.id)).toHaveLength(1)
    const second = drive.files(A.id)[0]
    expect(second.id).toBe(first.id)
    expect(second.modifiedTime > first.modifiedTime).toBe(true)
    expect(stored(drive, A.id).data.members[0].name).toBe('Drive Test Member Renamed')
    await expect(section(page)).toContainText(formatDateTime(second.modifiedTime, TZ))
  })

  test('4. after local data is cleared, signing in offers a restore and brings back the member, membership and photo', async ({ page }) => {
    const drive = newDrive()
    await gymWithBackup(page, drive)
    const before = await snapshot(page)

    await page.getByRole('button', { name: 'Reset everything…' }).click()
    await page.getByRole('dialog').getByLabel('Type RESET to confirm').fill('RESET')
    await page.getByRole('dialog').getByRole('button', { name: 'Delete all data' }).click()
    await expect(page).toHaveURL(/\/$/)
    expect(await page.evaluate(() => localStorage.getItem('gymbook-drive-link'))).toBeNull()
    await onboard(page, 'empty')
    expect(await readStore(page, 'members')).toEqual([])

    const uploads = drive.uploads()
    await openAndSignIn(page)
    const offer = page.getByRole('dialog', { name: 'This Google account already has a backup' })
    await expect(offer).toContainText('Test Gym · 1 member')
    await expect(offer).toContainText('no gym records yet')
    await expect(offer.getByRole('button', { name: 'Keep this device’s data' })).toHaveCount(0)
    // signing in alone restored nothing and uploaded nothing
    expect(await readStore(page, 'members')).toEqual([])
    expect(drive.uploads()).toBe(uploads)

    await offer.getByRole('button', { name: 'Review and restore' }).click()
    const review = page.getByRole('dialog', { name: 'Replace all data on this device with this backup?' })
    await expect(review).toContainText(A.email)
    await expect(review.getByText('members1', { exact: true })).toBeVisible()
    await review.getByRole('button', { name: 'Replace my data' }).click()
    await expect(section(page).getByRole('status').filter({ hasText: 'Restored from Google Drive' })).toContainText('Every record was read back and matches the backup')

    expect(await snapshot(page)).toEqual(before)
    expect(String((await snapshot(page)).members[0].photoDataUrl)).toBe(String(before.members[0].photoDataUrl))
    await page.goto(`/members/${before.members[0].id}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Drive Test Member')
    await expect(page.getByRole('main').locator('img').first()).toHaveAttribute('src', String(before.members[0].photoDataUrl))
    await expect(page.getByRole('main')).toContainText('Monthly')
  })

  test('5. a different Google account cannot see the backup, and this device’s data is not uploaded to it', async ({ page }) => {
    const drive = newDrive()
    await gymWithBackup(page, drive)
    const fileA = { ...drive.files(A.id)[0] }
    const uploads = drive.uploads()

    await setGoogle(page, { token: 'token-b' })
    await section(page).getByRole('button', { name: 'Use another account' }).click()
    const warning = section(page).getByRole('status').filter({ hasText: 'Different Google account' })
    await expect(warning).toContainText(`backed up to ${A.email}, and you are signed in as ${B.email}`)
    await expect(warning).toContainText('Nothing was uploaded')
    await expect(warning).toContainText(`${B.email} has no GymBook backup`)
    expect(drive.uploads()).toBe(uploads)

    // restoring finds nothing: account B cannot see account A's file
    await section(page).getByRole('button', { name: 'Restore…' }).click()
    await expect(section(page).getByRole('status').filter({ hasText: 'No backup found' })).toContainText(B.email)

    // backing up is stopped until someone says yes
    await backUp(page)
    const confirm = page.getByRole('dialog', { name: 'Replace the backup in Google Drive?' })
    await expect(confirm).toContainText(`was backed up to ${A.email}. It was not uploaded to ${B.email}`)
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    expect(drive.files(B.id)).toEqual([])
    expect(drive.uploads()).toBe(uploads)
    expect(drive.files(A.id)[0]).toEqual(fileA)
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('gymbook-drive-link')))!)).toMatchObject({ accountId: A.id })

    // an explicit yes moves this device to account B; account A's backup is left as it was
    await backUp(page)
    await confirm.getByRole('button', { name: 'Replace with this device’s data' }).click()
    await expect(section(page).getByRole('status').filter({ hasText: 'Backup saved to Google Drive' })).toBeVisible()
    expect(drive.files(B.id)).toHaveLength(1)
    expect(drive.files(A.id)[0]).toEqual(fileA)
  })

  test('6. failures are reported as failures and nothing is lost', async ({ page }) => {
    const drive = newDrive()
    const memberUrl = await gymWithBackup(page, drive)
    const good = { ...drive.files(A.id)[0] }
    const lastBackupLine = formatDateTime(good.modifiedTime, TZ)
    const alert = section(page).getByRole('alert')

    // make a change so there is something to upload
    await page.goto(memberUrl + '/edit')
    await page.getByLabel('Notes', { exact: true }).fill('Prefers mornings')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(memberUrl)
    const local = await snapshot(page)
    await openAndSignIn(page)
    await expect(section(page)).toContainText('Changes on this device are not backed up yet')

    // offline
    drive.failNext(isUpload, 'network', 99)
    await backUp(page)
    await expect(alert).toContainText('Backup failed; nothing was changed in Google Drive')
    await expect(alert).toContainText('Could not reach Google Drive')
    expect(drive.files(A.id)[0]).toEqual(good)
    await expect(section(page)).toContainText(lastBackupLine)
    await expect(section(page).getByRole('status').filter({ hasText: 'Backup saved' })).toHaveCount(0)

    // an upload that fails on Google's side, three times
    drive.failNext(isUpload, 'network', 0)
    const d2 = drive as unknown as { failures: { times: number }[] }
    d2.failures.forEach((f) => (f.times = 0))
    drive.failNext(isUpload, { status: 500 }, 99)
    await backUp(page)
    await expect(alert).toContainText('Google Drive is having trouble right now')
    d2.failures.forEach((f) => (f.times = 0))

    // the Google account is full
    drive.failNext(isUpload, { status: 403, reason: 'storageQuotaExceeded', message: 'The user’s Drive storage quota has been exceeded.' }, 1)
    await backUp(page)
    await expect(alert).toContainText('storage is full')
    expect(drive.files(A.id)[0]).toEqual(good)

    // Drive stores something other than what was sent
    drive.corruptNextUpload = true
    await backUp(page)
    await expect(alert).toContainText('stored something different from what was sent')
    await expect(section(page)).toContainText(lastBackupLine)
    // put the good backup back for the next checks
    drive.folders.get(A.id)!.set(good.id, good)

    // the backup file in Drive is damaged: restore refuses it and local data stays
    drive.folders.get(A.id)!.set(good.id, { ...good, content: new TextEncoder().encode('{ damaged') })
    await section(page).getByRole('button', { name: 'Restore…' }).click()
    const refused = page.getByRole('dialog', { name: 'This backup can’t be restored' })
    await expect(refused).toContainText('Nothing was changed on this device')
    await expect(refused).toContainText('not valid JSON')
    await expect(refused.getByRole('button', { name: 'Replace my data' })).toHaveCount(0)
    await refused.getByRole('button', { name: 'Close' }).last().click()
    expect(await snapshot(page)).toEqual(local)
    drive.folders.get(A.id)!.set(good.id, good)

    // Drive permission removed in the Google account
    drive.revoke('token-a')
    await backUp(page)
    await expect(alert).toContainText('sign-in has expired or access was removed')
    await expect(section(page).getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
    await expect(section(page)).toContainText(`${A.email} (signed out)`)
    expect(await snapshot(page)).toEqual(local)

    // sign-in itself failing: refused, permission box not ticked, pop-up blocked, window closed
    drive.addAccount('token-a', A)
    await setGoogle(page, { token: 'token-a', mode: 'denied' })
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await expect(alert).toContainText('sign-in was not completed')
    await setGoogle(page, { token: 'token-a', mode: 'no-scope' })
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await expect(alert).toContainText('Google Drive permission was not ticked')
    await setGoogle(page, { token: 'token-a', mode: 'popup-blocked' })
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await expect(alert).toContainText('Allow pop-ups for this site')
    await setGoogle(page, { token: 'token-a', mode: 'closed' })
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await expect(section(page).getByRole('button', { name: 'Sign in with Google' })).toBeEnabled()
    await expect(section(page)).toContainText(`${A.email} (signed out)`)

    // after all of that, a normal backup still works and replaces the one file
    await setGoogle(page, { token: 'token-a' })
    await section(page).getByRole('button', { name: 'Sign in with Google' }).click()
    await backUp(page)
    await expect(section(page).getByRole('status').filter({ hasText: 'Backup saved to Google Drive' })).toBeVisible()
    expect(drive.files(A.id)).toHaveLength(1)
    expect(stored(drive, A.id).data.members[0].notes).toBe('Prefers mornings')
  })

  test('7. automatic backup runs while the app is open, not while it is closed; an old backup shows a reminder', async ({ page, context }) => {
    const drive = newDrive()
    await page.clock.install()
    await gymWithBackup(page, drive)
    expect(drive.uploads()).toBe(1)

    // a change made while signed in (no page reload) is backed up by itself two minutes later
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plans', exact: true }).click()
    await page.getByRole('button', { name: 'New plan' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Plan name').fill('Quarterly')
    await dialog.getByLabel('Duration').fill('3')
    await dialog.getByLabel('Price').fill('4000')
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog).toBeHidden()
    await page.clock.fastForward('01:30')
    expect(drive.uploads()).toBe(1)
    await page.clock.fastForward('00:40')
    await expect.poll(() => drive.uploads()).toBe(2)
    expect(stored(drive, A.id).data.plans.map((p) => p.name).sort()).toEqual(['Monthly', 'Quarterly'])
    expect(drive.files(A.id)).toHaveLength(1)

    // another change, then the app is closed before the two minutes are up: nothing can run
    await page.getByRole('button', { name: 'New plan' }).first().click()
    await dialog.getByLabel('Plan name').fill('Yearly')
    await dialog.getByLabel('Duration').fill('12')
    await dialog.getByLabel('Price').fill('12000')
    await dialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(dialog).toBeHidden()
    // pretend the last backup was three days ago
    await page.evaluate(() => {
      const link = JSON.parse(localStorage.getItem('gymbook-drive-link')!)
      link.lastBackupAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
      localStorage.setItem('gymbook-drive-link', JSON.stringify(link))
    })
    await expireSession(page)
    await page.close()
    await new Promise((r) => setTimeout(r, 3000))
    expect(drive.uploads()).toBe(2)
    expect(stored(drive, A.id).data.plans.map((p) => p.name)).not.toContain('Yearly')

    // reopened: Google does not allow a silent sign-in here, so nothing is uploaded and a reminder shows
    const reopened = await openPage(context, drive, { token: 'token-a', silent: false })
    await reopened.goto('/')
    const reminder = reopened.getByRole('status').filter({ hasText: 'Google Drive backup is out of date' })
    await expect(reminder).toBeVisible()
    await reopened.waitForTimeout(6500)
    expect(drive.uploads()).toBe(2)
    // any tap in the app renews the sign-in (a tap is what lets Google's window open) and the backup follows
    await reopened.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members', exact: true }).click()
    await expect.poll(() => drive.uploads()).toBe(3)
    await expect(reminder).toHaveCount(0)
    expect(stored(drive, A.id).data.plans.map((p) => p.name)).toContain('Yearly')
    // and the sign-in is remembered across a reload for its hour: no "signed out" on reopening
    await reopened.goto('/settings')
    await expect(section(reopened)).toContainText(A.email)
    await expect(section(reopened)).not.toContainText('(signed out)')
    await expect(section(reopened).getByRole('button', { name: 'Back up now' })).toBeVisible()
    await expireSession(reopened)
    await reopened.close()

    // reopened where Google does allow it silently: the change is backed up without any click
    const third = await openPage(context, drive, { token: 'token-a', silent: true })
    await third.goto('/plans')
    await third.getByRole('button', { name: 'New plan' }).first().click()
    const d3 = third.getByRole('dialog')
    await d3.getByLabel('Plan name').fill('Trial')
    await d3.getByLabel('Duration').fill('1')
    await d3.getByLabel('Price').fill('0')
    await d3.getByRole('button', { name: 'Create plan' }).click()
    await expect(d3).toBeHidden()
    await third.clock.fastForward('02:05')
    await expect.poll(() => drive.uploads()).toBe(4)
    expect(drive.files(A.id)).toHaveLength(1)

    // switched off: changes are no longer uploaded by themselves
    await third.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click()
    await section(third).getByLabel(/Back up automatically while GymBook is open/).uncheck()
    await third.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plans', exact: true }).click()
    await third.getByRole('button', { name: 'New plan' }).first().click()
    await d3.getByLabel('Plan name').fill('Off Peak')
    await d3.getByLabel('Duration').fill('1')
    await d3.getByLabel('Price').fill('900')
    await d3.getByRole('button', { name: 'Create plan' }).click()
    await expect(d3).toBeHidden()
    await third.clock.fastForward('05:00')
    await third.waitForTimeout(500)
    expect(drive.uploads()).toBe(4)
  })

  test('8–9. another browser restores the same records and photo; data already there is saved to a file first', async ({ page, browser }) => {
    const drive = newDrive()
    await gymWithBackup(page, drive)
    const original = await snapshot(page)

    // a second browser profile: nothing shared with the first except the Google account
    const other = await browser.newContext()
    const page2 = await openPage(other, drive, { token: 'token-a' })
    await onboard(page2, 'empty', 'Second Device')
    await page2.goto('/members/new')
    await page2.getByLabel('Full name').fill('Local Person')
    await page2.getByLabel(/^Phone/).fill('98200 77002')
    await page2.getByRole('button', { name: 'Add member', exact: true }).click()
    await expect(page2).toHaveURL(/\/members\/mem_/)

    const uploads = drive.uploads()
    await page2.goto('/settings')
    await section(page2).getByRole('button', { name: 'Sign in with Google' }).click()
    const offer = page2.getByRole('dialog', { name: 'This Google account already has a backup' })
    await expect(offer).toContainText('This device has its own records')
    await expect(offer.getByRole('button', { name: 'Keep this device’s data' })).toBeVisible()
    // neither side has been touched yet
    expect((await readStore<Rec>(page2, 'members')).map((m) => m.name)).toEqual(['Local Person'])
    expect(drive.uploads()).toBe(uploads)

    // "keep this device's data" needs a second, explicit yes; cancelling changes nothing
    await offer.getByRole('button', { name: 'Keep this device’s data' }).click()
    const replace = page2.getByRole('dialog', { name: 'Replace the backup in Google Drive?' })
    await expect(replace).toContainText('Only one backup is kept')
    await replace.getByRole('button', { name: 'Cancel' }).click()
    expect(drive.uploads()).toBe(uploads)
    expect(byId(stored(drive, A.id).data.members)).toEqual(original.members)

    // back at the offer; restore instead: the local data is downloaded as a file before it is replaced
    await offer.getByRole('button', { name: 'Review and restore' }).click()
    const review = page2.getByRole('dialog', { name: 'Replace all data on this device with this backup?' })
    await expect(review).toContainText('A copy of the current data is downloaded to this device first')
    const download = page2.waitForEvent('download')
    await review.getByRole('button', { name: 'Replace my data' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^gymbook-before-restore-.*\.json$/)
    const copy = JSON.parse(await (await import('node:fs/promises')).readFile(await file.path(), 'utf8')) as { format: string; data: { members: Rec[] } }
    expect(copy.format).toBe('gymbook-backup')
    expect(copy.data.members.map((m) => m.name)).toEqual(['Local Person'])
    await expect(section(page2).getByRole('status').filter({ hasText: 'Restored from Google Drive' })).toContainText('A copy of the data that was on this device was downloaded first')

    // the second browser now holds exactly what the first one backed up, photo included
    expect(await snapshot(page2)).toEqual(original)
    expect(String((await snapshot(page2)).members[0].photoDataUrl)).toMatch(/^data:image\/jpeg;base64,/)
    await other.close()
  })
})

/** A new tab (or a tab in another browser profile) with Google stood in for. */
async function openPage(context: BrowserContext, drive: FakeDrive, google: { token: string; silent?: boolean }): Promise<Page> {
  const page = await context.newPage()
  await page.clock.install()
  await mockGoogle(page, drive)
  await page.addInitScript((c) => sessionStorage.setItem('fake-google', JSON.stringify(c)), google)
  return page
}
