import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Search, X, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Input } from './Field'
import { PAGE_ACTIONS_ID } from './PageActions'

export function PageHeader({ title, description, actions, back, slot }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; slot?: boolean }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back ? (
          <Link to={back.to} className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink">
            <ChevronRight className="h-3 w-3 rotate-180" aria-hidden />
            {back.label}
          </Link>
        ) : null}
        <h1 className="text-3xl font-medium leading-tight sm:text-4xl">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions || slot ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-2 sm:shrink-0',
            // Phones: actions sit under the title as equal-width buttons, in the flow, so they never cover content.
            slot && 'empty:hidden max-sm:[&>*]:min-w-0 max-sm:[&>*]:flex-1',
          )}
          id={slot ? PAGE_ACTIONS_ID : undefined}
        >
          {actions}
        </div>
      ) : null}
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search', className, autoFocus, inputRef }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
      <Input ref={inputRef} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="pl-9 pr-9" autoFocus={autoFocus} />
      {value ? (
        <button type="button" onClick={() => onChange('')} className="pressable absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint hover:bg-sunken hover:text-ink" aria-label="Clear search">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

const avatarHues = ['bg-accent-soft text-accent-ink', 'bg-info-soft text-info', 'bg-warn-soft text-warn', 'bg-sunken text-muted']
function hueFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return avatarHues[h % avatarHues.length]
}

export function Avatar({ name, src, size = 'md' }: { name: string; src?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const initials = name
    .replace(/^Sample\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
  const dim = size === 'sm' ? 'h-7 w-7 text-2xs' : size === 'lg' ? 'h-14 w-14 text-lg' : size === 'xl' ? 'h-16 w-16 text-xl' : 'h-9 w-9 text-xs'
  if (src) return <img src={src} alt="" className={cn('shrink-0 rounded-full object-cover ring-1 ring-line', dim)} />
  return (
    <span aria-hidden className={cn('flex shrink-0 select-none items-center justify-center rounded-full font-medium ring-1 ring-inset ring-black/5 dark:ring-white/10', hueFor(name), dim)}>
      {initials || '?'}
    </span>
  )
}

/** The signature detail: someone is in the gym right now. Used for live presence only. */
export function LiveDot() {
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
}

/** A stat is a label, a figure and a line of context. Nothing decorative. */
export function Stat({ label, value, hint, tone, to }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warn' | 'success'; to?: string }) {
  // Long amounts step down a size so a five-up row never breaks "−" away from its number.
  // On a phone these sit two-up in ~150px, so anything beyond a short figure steps down there too.
  const len = typeof value === 'string' ? value.length : 0
  const size = len >= 12 ? 'text-lg' : len >= 10 ? 'text-xl' : len >= 8 ? 'text-xl sm:text-3xl' : 'text-3xl'
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('tabular mt-2 font-medium !leading-none [overflow-wrap:anywhere]', size, tone === 'danger' && 'text-danger', tone === 'warn' && 'text-warn', tone === 'success' && 'text-success')}>{value}</p>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </>
  )
  const cls = 'surface-card block min-w-0 rounded-2xl px-5 py-4'
  if (to) return <Link to={to} className={cn(cls, 'pressable hover:border-line-strong')}>{body}</Link>
  return <div className={cls}>{body}</div>
}

export function KeyValue({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{it.label}</dt>
          <dd className="mt-0.5 break-words text-base">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Banner({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'danger'; children: ReactNode; action?: ReactNode }) {
  const cls = tone === 'warn' ? 'border-warn/25 bg-warn-soft text-warn' : tone === 'danger' ? 'border-danger/25 bg-danger-soft text-danger' : 'border-info/25 bg-info-soft text-info'
  return (
    <div className={cn('flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between', cls)} role={tone === 'danger' ? 'alert' : 'status'}>
      <div>{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items, className, 'aria-label': ariaLabel }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; className?: string; 'aria-label'?: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('bg-sunken scrollbar-none flex max-w-full gap-0.5 overflow-x-auto rounded-xl p-1', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            'pressable flex h-8 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium',
            value === it.value ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
          )}
        >
          {it.label}
          {it.count !== undefined ? <span className={cn('tabular font-mono text-xs', value === it.value ? 'text-muted' : 'text-faint')}>{it.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function ContactLinks({ phone, className }: { phone?: string; className?: string }) {
  const tel = phone?.replace(/[^\d+]/g, '')
  return (
    <span className={cn('flex flex-wrap items-center gap-x-3 gap-y-0.5', className)}>
      {phone ? (
        <a href={`tel:${tel}`} className="tabular text-ink hover:text-accent-ink hover:underline">
          {phone}
        </a>
      ) : null}
    </span>
  )
}

/** Section wrapper for settings-style pages: a left label column and right content. */
export function Section({ title, description, children, id }: { title: ReactNode; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="grid gap-4 border-b border-line py-6 first:pt-0 last:border-b-0 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
      <div>
        <h2 className="text-md font-medium">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
