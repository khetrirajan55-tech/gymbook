/**
 * Google sign-in for the browser, through Google Identity Services.
 *
 * The app asks for one permission only: its own hidden folder in the person's Google Drive
 * (`drive.appdata`). It cannot see or change any other file in that Drive.
 *
 * There is no client secret: the client ID is a public identifier, and Google only honours it from
 * the web addresses registered for it. The access token Google returns stops working after about
 * an hour; the caller remembers it on the device for that hour only.
 */

/** Public OAuth client ID, set at build time. Empty means Google Drive backup is not set up for this site. */
export const GOOGLE_CLIENT_ID = ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_URL = 'https://accounts.google.com/gsi/client'

export type SignInErrorKind = 'not-configured' | 'load-failed' | 'popup-blocked' | 'cancelled' | 'denied' | 'no-drive-permission' | 'unknown'

export class SignInError extends Error {
  kind: SignInErrorKind
  constructor(kind: SignInErrorKind, message: string) {
    super(message)
    this.name = 'SignInError'
    this.kind = kind
  }
}

export interface GoogleToken {
  token: string
  /** Epoch milliseconds, with a minute taken off so a token is never used at the edge of its life. */
  expiresAt: number
}

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  error?: string
  error_description?: string
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; hint?: string }): void
}
interface GoogleOauth2 {
  initTokenClient(config: { client_id: string; scope: string; hint?: string; prompt?: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type?: string; message?: string }) => void }): TokenClient
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean
  revoke(token: string, done?: () => void): void
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOauth2 } }
  }
}

let loading: Promise<GoogleOauth2> | null = null

function loadGoogle(): Promise<GoogleOauth2> {
  const ready = window.google?.accounts?.oauth2
  if (ready) return Promise.resolve(ready)
  if (!loading) {
    loading = new Promise<GoogleOauth2>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = GIS_URL
      script.async = true
      script.onload = () => {
        const api = window.google?.accounts?.oauth2
        if (api) resolve(api)
        else reject(new SignInError('load-failed', 'Google sign-in could not start. Reload the page and try again.'))
      }
      script.onerror = () => reject(new SignInError('load-failed', 'Google sign-in could not be loaded. Check the internet connection, or an ad blocker may be stopping it.'))
      document.head.appendChild(script)
    }).catch((err) => {
      loading = null
      throw err
    })
  }
  return loading
}

/**
 * Ask Google for an access token.
 * - `interactive`: opened by a click; Google may show its account chooser and permission screen.
 * - otherwise: no screen is allowed. It only works if the person has already agreed and is still
 *   signed in to Google, and a browser may still refuse because no click opened the window.
 */
export async function requestGoogleToken(options: { interactive: boolean; hint?: string; chooseAccount?: boolean }): Promise<GoogleToken> {
  if (!GOOGLE_CLIENT_ID) throw new SignInError('not-configured', 'Google Drive backup is not set up for this site.')
  const oauth2 = await loadGoogle()
  return new Promise<GoogleToken>((resolve, reject) => {
    let settled = false
    const fail = (err: SignInError) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    }
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      hint: options.hint,
      callback: (r) => {
        if (settled) return
        if (r.error || !r.access_token) {
          fail(new SignInError(r.error === 'access_denied' ? 'denied' : 'unknown', r.error === 'access_denied' ? 'Google sign-in was not completed, so nothing was connected.' : `Google sign-in failed${r.error ? ` (${r.error})` : ''}.`))
          return
        }
        if (!oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE)) {
          fail(new SignInError('no-drive-permission', 'The Google Drive permission was not ticked, so GymBook cannot save a backup. Sign in again and allow it.'))
          return
        }
        settled = true
        resolve({ token: r.access_token, expiresAt: Date.now() + Math.max(0, Number(r.expires_in ?? 3600) - 60) * 1000 })
      },
      error_callback: (e) => {
        if (e.type === 'popup_failed_to_open') fail(new SignInError('popup-blocked', 'The browser blocked the Google sign-in window. Allow pop-ups for this site, then try again.'))
        else if (e.type === 'popup_closed') fail(new SignInError('cancelled', 'The Google sign-in window was closed before it finished.'))
        else fail(new SignInError('unknown', 'Google sign-in did not finish.'))
      },
    })
    client.requestAccessToken({ prompt: options.interactive ? (options.chooseAccount ? 'select_account' : '') : 'none', hint: options.hint })
  })
}

/** Remove GymBook's access to the Google account entirely. The backup file itself is not deleted. */
export async function revokeGoogleAccess(token: string): Promise<void> {
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) return
  await new Promise<void>((resolve) => oauth2.revoke(token, () => resolve()))
}
