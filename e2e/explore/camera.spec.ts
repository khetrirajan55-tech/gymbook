import { test, expect, type Page } from '@playwright/test'
import { onboard, readStore } from '../helpers'

// Chromium's built-in fake camera: a moving test pattern, with the permission prompt auto-accepted.
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

type MemberRec = { id: string; name: string; photoDataUrl?: string }

/** Record every stream the page opens so a test can check the camera was released. */
async function trackStreams(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] }
    w.__streams = []
    const md = navigator.mediaDevices
    if (!md?.getUserMedia) return
    const original = md.getUserMedia.bind(md)
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await original(c)
      w.__streams.push(s)
      return s
    }
  })
}
// The dev build mounts effects twice (React StrictMode), so more than one stream may have been opened; every one must be stopped.
const liveTracks = (page: Page) =>
  page.evaluate(() => {
    const states = (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((t) => t.readyState))
    return { opened: states.length > 0, live: states.filter((x) => x !== 'ended').length }
  })

const imageSize = (page: Page, dataUrl: string) =>
  page.evaluate(
    (src) =>
      new Promise<[number, number]>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve([img.naturalWidth, img.naturalHeight])
        img.onerror = () => reject(new Error('photo did not decode'))
        img.src = src
      }),
    dataUrl,
  )

test.describe('member photo from the camera', () => {
  test('take, retake and use a photo; it is saved square with the member and the camera is released', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(e.message))
    await trackStreams(page)
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await page.getByLabel('Full name').fill('Camera Person')
    await page.getByLabel(/^Phone/).fill('98200 00011')
    await expect(page.getByRole('button', { name: 'Upload photo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Take photo' }).click()
    const dialog = page.getByRole('dialog', { name: 'Take photo' })
    await expect(dialog).toBeVisible()
    const shutter = dialog.getByRole('button', { name: 'Take photo' })
    await expect(shutter).toBeEnabled()
    await expect(shutter).toBeFocused()
    await expect(dialog.getByLabel('Camera preview')).toBeVisible()

    await shutter.click()
    await expect(dialog.getByRole('img', { name: 'Photo just taken' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Retake' }).click()
    await expect(dialog.getByRole('img', { name: 'Photo just taken' })).toHaveCount(0)
    await expect(dialog.getByLabel('Camera preview')).toBeVisible()

    await dialog.getByRole('button', { name: 'Take photo' }).click()
    await dialog.getByRole('button', { name: 'Use photo' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible()
    // nothing keeps recording once the dialog is gone
    await expect.poll(() => liveTracks(page)).toEqual({ opened: true, live: 0 })

    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)
    const [m] = await readStore<MemberRec>(page, 'members')
    expect(m.photoDataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(m.photoDataUrl!.length).toBeLessThan(400_000)
    expect(await imageSize(page, m.photoDataUrl!)).toEqual([256, 256])
    await expect(page.getByRole('main').locator('img').first()).toHaveAttribute('src', m.photoDataUrl!)
    expect(errors).toEqual([])
  })

  test('tapping the photo on a member page: view it, change it by upload or camera, remove it', async ({ page }) => {
    await trackStreams(page)
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await page.getByLabel('Full name').fill('Photo Tap')
    await page.getByLabel(/^Phone/).fill('98200 00044')
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page).toHaveURL(/\/members\/mem_/)
    const stored = async () => (await readStore<MemberRec>(page, 'members'))[0].photoDataUrl

    // No photo yet: the avatar offers to add one.
    await page.getByRole('button', { name: 'Add a photo of Photo Tap' }).click()
    let dialog = page.getByRole('dialog', { name: 'Photo Tap' })
    await expect(dialog).toContainText('No photo yet')
    await expect(dialog.getByRole('button', { name: 'Remove photo' })).toHaveCount(0)
    // 1×1 PNG; the app turns it into the small JPEG it stores.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    await dialog.getByLabel('Upload a photo').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: png })
    await expect(page.getByRole('status').filter({ hasText: 'Photo updated' })).toBeVisible()
    await expect(dialog).toBeHidden()
    const uploaded = await stored()
    expect(uploaded).toMatch(/^data:image\/jpeg;base64,/)

    // Now it opens as a viewer with the photo at full size, and the camera replaces it.
    await page.getByRole('button', { name: 'View or change photo of Photo Tap' }).click()
    dialog = page.getByRole('dialog', { name: 'Photo Tap' })
    await expect(dialog.getByRole('img', { name: 'Photo of Photo Tap' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Take photo' }).click()
    const camera = page.getByRole('dialog', { name: 'Take photo' })
    await expect(camera.locator('video')).toBeVisible()
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement | null)?.videoWidth)
    await camera.getByRole('button', { name: 'Take photo' }).click()
    await camera.getByRole('button', { name: 'Use photo' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Photo updated' }).last()).toBeVisible()
    await expect.poll(stored).not.toBe(uploaded)
    expect(await stored()).toMatch(/^data:image\/jpeg;base64,/)
    await expect.poll(() => liveTracks(page)).toEqual({ opened: true, live: 0 })

    // Remove it again.
    await page.getByRole('button', { name: 'View or change photo of Photo Tap' }).click()
    await page.getByRole('dialog', { name: 'Photo Tap' }).getByRole('button', { name: 'Remove photo' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Photo removed' })).toBeVisible()
    await expect.poll(stored).toBeUndefined()
    await expect(page.getByRole('button', { name: 'Add a photo of Photo Tap' })).toBeVisible()
  })

  test('cancelling leaves the form untouched and releases the camera', async ({ page }) => {
    await trackStreams(page)
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await page.getByRole('button', { name: 'Take photo' }).click()
    const dialog = page.getByRole('dialog', { name: 'Take photo' })
    await expect(dialog.getByRole('button', { name: 'Take photo' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
    await expect.poll(() => liveTracks(page)).toEqual({ opened: true, live: 0 })
  })

  test('a blocked camera explains the fix, can be retried, and offers upload instead', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __calls: number }
      w.__calls = 0
      navigator.mediaDevices.getUserMedia = async () => {
        w.__calls += 1
        throw new DOMException('Permission denied', 'NotAllowedError')
      }
    })
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await page.getByRole('button', { name: 'Take photo' }).click()
    const dialog = page.getByRole('dialog', { name: 'Take photo' })
    await expect(dialog.getByRole('alert')).toHaveText(/Camera access is blocked/)
    await expect(dialog.getByRole('button', { name: 'Take photo' })).toHaveCount(0)
    const calls = () => page.evaluate(() => (window as unknown as { __calls: number }).__calls)
    const before = await calls()
    await dialog.getByRole('button', { name: 'Try again' }).click()
    await expect.poll(calls).toBe(before + 1)
    await expect(dialog.getByRole('alert')).toHaveText(/Camera access is blocked/)

    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: 'Upload a photo instead' }).click()
    await chooser
    await expect(dialog).toBeHidden()
  })

  test('no camera on the device, and a browser without camera support', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('noCameraApi')) {
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
        return
      }
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Requested device not found', 'NotFoundError')
      }
    })
    await onboard(page, 'empty')
    await page.goto('/members/new')
    await page.getByRole('button', { name: 'Take photo' }).click()
    const dialog = page.getByRole('dialog', { name: 'Take photo' })
    await expect(dialog.getByRole('alert')).toHaveText('No camera was found on this device.')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await page.evaluate(() => sessionStorage.setItem('noCameraApi', '1'))
    await page.reload()
    await page.getByRole('button', { name: 'Take photo' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('This browser cannot open the camera on this page.')
    await expect(dialog.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Upload a photo instead' })).toBeVisible()
  })
})
