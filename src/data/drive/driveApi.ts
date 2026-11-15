/**
 * A small Google Drive REST client for one job: keeping a single backup file in the app's own
 * hidden folder (`appDataFolder`). That folder belongs to one Google account and one app, so a
 * signed-in account can never list or read another account's backup.
 *
 * Nothing here knows about GymBook's data; see driveBackup.ts for the rules.
 */

export type DriveErrorKind =
  | 'offline' // the request never reached Google
  | 'auth' // token expired or access was revoked: sign in again
  | 'permission' // signed in, but Drive access was not granted
  | 'quota' // the Google account's storage is full
  | 'not-found'
  | 'rate' // asked too often; retried and still refused
  | 'server' // Google answered 5xx after retries
  | 'verify' // Drive stored something different from what was sent
  | 'unknown'

export class DriveError extends Error {
  kind: DriveErrorKind
  status?: number
  constructor(kind: DriveErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'DriveError'
    this.kind = kind
    this.status = status
  }
}

export interface DriveAccount {
  /** Stable id of the Google account (its Drive permission id). Emails can change; this does not. */
  id: string
  email: string
  name?: string
  /** Bytes. `limit` is absent for accounts with unlimited storage. */
  quota?: { limit?: number; usage: number }
}

export interface DriveFile {
  id: string
  name: string
  modifiedTime: string
  size: number
  md5Checksum?: string
  appProperties: Record<string, string>
}

export interface DriveClient {
  account(): Promise<DriveAccount>
  /** Every file with this name in the app folder, newest first. More than one means two devices raced; nothing is deleted. */
  list(name: string): Promise<DriveFile[]>
  get(id: string): Promise<DriveFile | null>
  /** The stored bytes exactly as they are; the caller decides how to read them. */
  download(id: string): Promise<Uint8Array>
  /** Create the file, or replace the content of `existingId`. The previous content stays until the upload completes. */
  upload(input: { name: string; bytes: Uint8Array; appProperties: Record<string, string>; existingId?: string; contentType?: string }): Promise<DriveFile>
  /** Delete a file from the app folder. A file that is already gone counts as removed. */
  remove(id: string): Promise<void>
}

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FILE_FIELDS = 'id,name,modifiedTime,size,md5Checksum,appProperties'
/** Google accepts single-request uploads up to 5 MB; larger files go through a resumable session. */
export const SINGLE_REQUEST_LIMIT = 5 * 1024 * 1024
const RETRIES = 3

export interface DriveClientOptions {
  fetch?: typeof fetch
  /** Wait between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>
}

export function createDriveClient(token: string, options: DriveClientOptions = {}): DriveClient {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  /** One request with the token attached, retried on "try again later" answers. Throws DriveError for everything else that is not ok. */
  const request = async (url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> => {
    let last: DriveError | null = null
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (attempt > 0) await sleep(500 * 3 ** (attempt - 1))
      let res: Response
      try {
        res = await doFetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } })
      } catch {
        // A network failure is not retried here: the caller decides, because an upload may have been half sent.
        throw new DriveError('offline', 'Could not reach Google Drive. Check the internet connection and try again.')
      }
      if (res.ok || okStatuses.includes(res.status)) return res
      const err = await toDriveError(res)
      if (err.kind !== 'rate' && err.kind !== 'server') throw err
      last = err
    }
    throw last ?? new DriveError('unknown', 'Google Drive did not answer.')
  }

  const json = async <T>(res: Response): Promise<T> => {
    try {
      return (await res.json()) as T
    } catch {
      throw new DriveError('unknown', 'Google Drive sent an answer that could not be read.')
    }
  }

  const account = async (): Promise<DriveAccount> => {
    const res = await request(`${API}/about?fields=${encodeURIComponent('user(permissionId,emailAddress,displayName),storageQuota(limit,usage)')}`)
    const body = await json<{ user?: { permissionId?: string; emailAddress?: string; displayName?: string }; storageQuota?: { limit?: string; usage?: string } }>(res)
    if (!body.user?.permissionId || !body.user.emailAddress) throw new DriveError('unknown', 'Google did not say which account is signed in.')
    return {
      id: body.user.permissionId,
      email: body.user.emailAddress,
      name: body.user.displayName,
      quota: body.storageQuota?.usage !== undefined ? { usage: Number(body.storageQuota.usage), limit: body.storageQuota.limit !== undefined ? Number(body.storageQuota.limit) : undefined } : undefined,
    }
  }

  const list = async (name: string): Promise<DriveFile[]> => {
    const q = `name = '${name.replace(/['\\]/g, '\\$&')}' and trashed = false`
    const params = new URLSearchParams({ spaces: 'appDataFolder', q, fields: `files(${FILE_FIELDS})`, orderBy: 'modifiedTime desc', pageSize: '200' })
    const body = await json<{ files?: RawFile[] }>(await request(`${API}/files?${params}`))
    return (body.files ?? []).map(toFile)
  }

  const get = async (id: string): Promise<DriveFile | null> => {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS + ',trashed')}`, {}, [404])
    if (res.status === 404) return null
    const raw = await json<RawFile & { trashed?: boolean }>(res)
    return raw.trashed ? null : toFile(raw)
  }

  const download = async (id: string): Promise<Uint8Array> => {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?alt=media`)
    return new Uint8Array(await res.arrayBuffer())
  }

  const upload: DriveClient['upload'] = async ({ name, bytes, appProperties, existingId, contentType = 'application/json' }) => {
    const metadata = existingId ? { appProperties, mimeType: contentType } : { name, parents: ['appDataFolder'], mimeType: contentType, appProperties }
    const target = `${UPLOAD}/files${existingId ? `/${encodeURIComponent(existingId)}` : ''}`
    const method = existingId ? 'PATCH' : 'POST'
    const fields = `fields=${encodeURIComponent(FILE_FIELDS)}`

    const once = async (): Promise<DriveFile> => {
      if (bytes.length <= SINGLE_REQUEST_LIMIT) {
        // Metadata and content in one request: it either lands whole or not at all.
        const boundary = `gymbook${bytes.length.toString(36)}${Date.now().toString(36)}`
        const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`)
        const tail = new TextEncoder().encode(`\r\n--${boundary}--`)
        const body = new Uint8Array(head.length + bytes.length + tail.length)
        body.set(head)
        body.set(bytes, head.length)
        body.set(tail, head.length + bytes.length)
        const res = await request(`${target}?uploadType=multipart&${fields}`, { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
        return toFile(await json<RawFile>(res))
      }
      // Larger than the single-request limit: open a session, then send the content to it.
      const start = await request(`${target}?uploadType=resumable&${fields}`, {
        method,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': contentType, 'X-Upload-Content-Length': String(bytes.length) },
        body: JSON.stringify(metadata),
      })
      const session = start.headers.get('Location')
      if (!session) throw new DriveError('unknown', 'Google Drive did not open an upload session for this large backup.')
      const res = await request(session, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes as unknown as BodyInit })
      return toFile(await json<RawFile>(res))
    }

    // A dropped connection may have cut the upload short. Drive only replaces the file once an upload
    // completes, so the safe recovery is to start the whole upload again rather than guess what arrived.
    let failure: unknown
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (attempt > 0) await sleep(1000 * attempt)
      try {
        return await once()
      } catch (err) {
        failure = err
        if (!(err instanceof DriveError) || err.kind !== 'offline') throw err
      }
    }
    throw failure
  }

  const remove = async (id: string): Promise<void> => {
    await request(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, [404])
  }

  return { account, list, get, download, upload, remove }
}

interface RawFile {
  id: string
  name: string
  modifiedTime: string
  size?: string
  md5Checksum?: string
  appProperties?: Record<string, string>
}

const toFile = (raw: RawFile): DriveFile => ({ id: raw.id, name: raw.name, modifiedTime: raw.modifiedTime, size: Number(raw.size ?? 0), md5Checksum: raw.md5Checksum, appProperties: raw.appProperties ?? {} })

/** Turn a refused request into a DriveError the interface can explain. */
async function toDriveError(res: Response): Promise<DriveError> {
  let reason = ''
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } }
    reason = [body.error?.errors?.[0]?.reason, body.error?.details?.[0]?.reason, body.error?.status].filter(Boolean).join(' ')
    detail = body.error?.message ?? ''
  } catch {
    // No JSON body: the status code alone decides.
  }
  const status = res.status
  if (/storageQuotaExceeded|teamDriveFileLimitExceeded/i.test(reason) || (status === 403 && /storage quota/i.test(detail))) {
    return new DriveError('quota', 'The Google account’s storage is full, so the backup could not be saved. Free up space in Google Drive, Gmail or Photos, then try again.', status)
  }
  if (status === 401 || /authError|UNAUTHENTICATED/i.test(reason)) return new DriveError('auth', 'Google sign-in has expired or access was removed. Sign in again.', status)
  if (/rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reason) || status === 429) return new DriveError('rate', 'Google Drive is asking to slow down. Try again in a few minutes.', status)
  if (status === 403) return new DriveError('permission', 'GymBook does not have permission to use Google Drive for this account. Sign in again and allow the Drive permission.', status)
  if (status === 404) return new DriveError('not-found', 'The backup file was not found in Google Drive.', status)
  if (status >= 500) return new DriveError('server', 'Google Drive is having trouble right now. Try again in a few minutes.', status)
  return new DriveError('unknown', detail ? `Google Drive refused the request: ${detail}` : `Google Drive refused the request (${status}).`, status)
}
