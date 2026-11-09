import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Member } from '@/domain/types'
import { normalizePhone } from '@/domain/validation'
import { Avatar } from '@/components/ui/misc'
import { cn } from '@/lib/cn'
import { controlClasses } from '@/components/ui/Field'
import { MembershipStateBadge } from './MembershipBadge'
import type { MembershipState } from '@/domain/membership'

export interface PickerMember {
  member: Member
  state?: MembershipState
}

export function filterMembers<T extends { member: Member }>(rows: T[], term: string): T[] {
  const t = term.trim().toLowerCase()
  if (!t) return rows
  const digits = normalizePhone(t)
  return rows.filter(({ member }) => {
    if (member.name.toLowerCase().includes(t)) return true
    if (member.memberCode && member.memberCode.toLowerCase().replace('-', '').includes(t.replace('-', ''))) return true
    if (digits.length >= 3 && normalizePhone(member.phone).includes(digits)) return true
    return false
  })
}

/** Accessible combobox for choosing a member by name, phone or member code. */
export function MemberPicker({ rows, value, onChange, placeholder = 'Search by name or phone', autoFocus, id: externalId, invalid, describedBy }: { rows: PickerMember[]; value: Member | null; onChange: (m: Member | null) => void; placeholder?: string; autoFocus?: boolean; id?: string; invalid?: boolean; describedBy?: string }) {
  const internalId = useId()
  const id = externalId ?? internalId
  const listId = `${id}-list`
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => filterMembers(rows, term).slice(0, 8), [rows, term])

  useEffect(() => {
    setActive(0)
  }, [term])

  if (value) {
    return (
      <div className={cn(controlClasses, 'flex h-auto min-h-11 items-center gap-3 py-1.5')}>
        <Avatar name={value.name} src={value.photoDataUrl} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{value.name}</span>
          <span className="block truncate text-xs text-muted">{value.phone}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null)
            setTimeout(() => inputRef.current?.focus(), 0)
          }}
          className="pressable -mr-1 rounded-md p-1.5 text-muted hover:bg-sunken"
          aria-label="Clear selected member"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    )
  }

  const choose = (m: Member) => {
    onChange(m)
    setTerm('')
    setOpen(false)
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${results[active].member.id}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-label={placeholder}
        className={cn(controlClasses, 'h-11 pl-9')}
        placeholder={placeholder}
        value={term}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={(e) => {
          setTerm(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((a) => Math.min(results.length - 1, a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter' && open && results[active]) {
            e.preventDefault()
            choose(results[active].member)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open ? (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto surface-pop rounded-2xl py-1.5">
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted">{term ? 'No members match.' : rows.length === 0 ? 'No members yet.' : 'Type to search members.'}</li>
          ) : (
            results.map((r, i) => (
              <li
                key={r.member.id}
                id={`${listId}-${r.member.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r.member)}
                onMouseEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-center gap-3 px-3 py-2', i === active && 'bg-ink/5')}
              >
                <Avatar name={r.member.name} src={r.member.photoDataUrl} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.member.name}</span>
                  <span className="block truncate text-xs text-muted">{r.member.phone}</span>
                </span>
                <MembershipStateBadge state={r.state} />
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
