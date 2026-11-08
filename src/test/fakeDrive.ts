import { createHash } from 'node:crypto'

/**
 * An in-memory stand-in for the parts of the Google Drive API that GymBook uses.
 * It is not Google: it proves the app's own logic (what it uploads, when it refuses, how it reacts
 * to failures), not that Google behaves this way. Used by the unit tests and, through request
 * interception, by the browser tests.
 */

export interface FakeAccount {
  id: string
  email: string
  name: string
  /** Bytes; uploads that would pass it are refused like a full Google account. */
  limit: number
  usedElsewhere: number
  /** Signed in but without the Drive permission. */
  noDrivePermission?: boolean
}

export interface FakeFile {
  id: string
  name: string
  content: Uint8Array
  modifiedTime: string
  appProperties: Record<string, string>
}

export interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: Uint8Array
}

export interface FakeResponse {
  status: number
  headers: Record<string, string>
  /** Text for JSON answers; the stored bytes, untouched, for a file download. */
  body: string | Uint8Array
}

type Failure = 'network' | { status: number; reason?: string; message?: string }

const enc = new TextEncoder()
const dec = new TextDecoder()

export class FakeDrive {
  private tokens = new Map<string, string>()
  accounts = new Map<string, FakeAccount>()
  /** accountId → that account's app folder. */
  folders = new Map<string, Map<string, FakeFile>>()
  private sessions = new Map<string, { accountId: string; fileId?: string; metadata: { name?: string; appProperties?: Record<string, string> } }>()
  private failures: { match: (r: FakeRequest) => boolean; fail: Failure; times: number }[] = []
  /** Report a wrong checksum for the next upload, as if the stored bytes were damaged. */
  corruptNextUpload = false
  log: { method: string; path: string; account?: string }[] = []
  private seq = 0
  /**
   * Drive's clock for modifiedTime. It starts a minute ago in real time, not on a fixed date, because the
   * app judges "backup more than a day old" against the real clock: a fixed date made every test fail
   * once a day had passed since it was written.
   */
  private clock = Date.now() - 60_000

  addAccount(token: string, account: Partial<FakeAccount> & { id: string; email: string }): FakeAccount {
    const full: FakeAccount = { name: account.email.split('@')[0], limit: 15 * 1024 ** 3, usedElsewhere: 0, ...account }
    this.accounts.set(full.id, full)
    this.tokens.set(token, full.id)
    if (!this.folders.has(full.id)) this.folders.set(full.id, new Map())
    return full
  }

  /** The token stops working, as after the hour runs out or access is removed in the Google account. */
  revoke(token: string): void {
    this.tokens.delete(token)
  }

  /** Make matching requests fail `times` times: 'network' drops the connection, otherwise an HTTP error. */
  failNext(match: (r: FakeRequest) => boolean, fail: Failure, times = 1): void {
    this.failures.push({ match, fail, times })
  }

  files(accountId: string): FakeFile[] {
    return [...(this.folders.get(accountId)?.values() ?? [])]
  }

  uploads(): number {
    return this.log.filter((l) => l.path.startsWith('/upload/') && (l.method === 'POST' || l.method === 'PATCH')).length
  }

  /** Put a file straight into an account's folder, as another device would have. */
  seed(accountId: string, name: string, content: string, appProperties: Record<string, string> = {}): FakeFile {
    const file: FakeFile = { id: `file_${++this.seq}`, name, content: enc.encode(content), modifiedTime: this.tick(), appProperties }
    this.folders.get(accountId)!.set(file.id, file)
    return file
  }

  private tick(): string {
    this.clock += 60_000
    return new Date(this.clock).toISOString()
  }

  private resource(file: FakeFile, corrupt = false) {
    return { id: file.id, name: file.name, modifiedTime: file.modifiedTime, size: String(file.content.length), md5Checksum: corrupt ? '0'.repeat(32) : createHash('md5').update(file.content).digest('hex'), appProperties: file.appProperties }
  }

  handle(req: FakeRequest): FakeResponse | 'network-error' {
    const url = new URL(req.url)
    const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
    const accountId = this.tokens.get(auth.replace(/^Bearer\s+/i, ''))
    this.log.push({ method: req.method, path: url.pathname, account: accountId })

    const failure = this.failures.find((f) => f.times > 0 && f.match(req))
    if (failure) {
      failure.times -= 1
      if (failure.fail === 'network') return 'network-error'
      return this.error(failure.fail.status, failure.fail.reason ?? 'backendError', failure.fail.message ?? 'Injected failure')
    }

    if (!accountId) return this.error(401, 'authError', 'Invalid Credentials')
    const account = this.accounts.get(accountId)!
    if (account.noDrivePermission) return this.error(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.')
    const folder = this.folders.get(accountId)!
    const ok = (body: unknown, headers: Record<string, string> = {}): FakeResponse => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    const used = () => account.usedElsewhere + [...folder.values()].reduce((s, f) => s + f.content.length, 0)

    if (url.pathname === '/drive/v3/about') {
      return ok({ user: { permissionId: account.id, emailAddress: account.email, displayName: account.name }, storageQuota: { limit: String(account.limit), usage: String(used()) } })
    }

    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      if (url.searchParams.get('spaces') !== 'appDataFolder') return this.error(403, 'insufficientPermissions', 'This app can only list its own app folder.')
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(url.searchParams.get('q') ?? '')?.[1]?.replace(/\\(.)/g, '$1')
      const files = [...folder.values()].filter((f) => name === undefined || f.name === name).sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1))
      return ok({ files: files.map((f) => this.resource(f)) })
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
    if (fileMatch && req.method === 'GET') {
      const file = folder.get(decodeURIComponent(fileMatch[1]))
      // A file in another account's folder does not exist as far as this account can tell.
      if (!file) return this.error(404, 'notFound', 'File not found.')
      if (url.searchParams.get('alt') === 'media') return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: file.content }
      return ok({ ...this.resource(file), trashed: false })
    }

    const uploadMatch = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname)
    if (uploadMatch) {
      const fileId = uploadMatch[1] ? decodeURIComponent(uploadMatch[1]) : undefined
      const uploadId = url.searchParams.get('upload_id')
      const store = (target: string | undefined, metadata: { name?: string; appProperties?: Record<string, string> }, content: Uint8Array): FakeResponse => {
        const existing = target ? folder.get(target) : undefined
        if (target && !existing) return this.error(404, 'notFound', 'File not found.')
        if (used() - (existing?.content.length ?? 0) + content.length > account.limit) return this.error(403, 'storageQuotaExceeded', 'The user’s Drive storage quota has been exceeded.')
        const file: FakeFile = existing ? { ...existing, content, modifiedTime: this.tick(), appProperties: { ...existing.appProperties, ...metadata.appProperties } } : { id: `file_${++this.seq}`, name: metadata.name ?? 'Untitled', content, modifiedTime: this.tick(), appProperties: metadata.appProperties ?? {} }
        folder.set(file.id, file)
        const corrupt = this.corruptNextUpload
        this.corruptNextUpload = false
        return ok(this.resource(file, corrupt))
      }

      if (req.method === 'PUT' && uploadId) {
        const session = this.sessions.get(uploadId)
        if (!session || session.accountId !== accountId) return this.error(404, 'notFound', 'Upload session not found.')
        this.sessions.delete(uploadId)
        return store(session.fileId, session.metadata, req.body ?? new Uint8Array())
      }
      const type = url.searchParams.get('uploadType')
      if (type === 'resumable') {
        const id = `session_${++this.seq}`
        this.sessions.set(id, { accountId, fileId, metadata: JSON.parse(dec.decode(req.body ?? enc.encode('{}'))) })
        return ok('', { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` })
      }
      if (type === 'multipart') {
        const parts = splitMultipart(req.body ?? new Uint8Array(), req.headers['content-type'] ?? req.headers['Content-Type'] ?? '')
        if (!parts) return this.error(400, 'badRequest', 'Malformed multipart body.')
        return store(fileId, JSON.parse(dec.decode(parts.metadata)), parts.content)
      }
    }
    return this.error(404, 'notFound', `No fake handler for ${req.method} ${url.pathname}`)
  }

  private error(status: number, reason: string, message: string): FakeResponse {
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: status, message, errors: [{ reason, message }] } }) }
  }

  /** A `fetch` that talks to this fake, for code that takes one. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const body = init.body
    const bytes = body === undefined || body === null ? undefined : typeof body === 'string' ? enc.encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
    const res = this.handle({ method: init.method ?? 'GET', url: String(input), headers, body: bytes })
    if (res === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(res.body as BodyInit, { status: res.status, headers: res.headers })
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function splitMultipart(body: Uint8Array, contentType: string): { metadata: Uint8Array; content: Uint8Array } | null {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
  if (!boundary) return null
  const delim = enc.encode(`--${boundary}`)
  const blank = enc.encode('\r\n\r\n')
  const first = indexOf(body, delim)
  const second = indexOf(body, delim, first + delim.length)
  const end = body.length - enc.encode(`\r\n--${boundary}--`).length
  if (first < 0 || second < 0 || end < second) return null
  const metaStart = indexOf(body, blank, first) + blank.length
  const contentStart = indexOf(body, blank, second) + blank.length
  return { metadata: body.slice(metaStart, second - 2), content: body.slice(contentStart, end) }
}
