import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useDriveState } from '@/hooks/useDriveState'
import { backupFromReminder, startAutoBackup } from '@/data/drive/driveController'
import { formatDateTime } from '@/domain/dates'
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  LayoutDashboard, Users, CreditCard, ClipboardCheck, Receipt, BellRing, BarChart3, Settings as SettingsIcon,
  X, UserPlus, Search, Sun, Moon, PanelLeftClose, PanelLeftOpen, Keyboard, FlaskConical, MoreHorizontal, Activity as ActivityIcon, NotebookPen,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { HeaderContext, useApp } from './AppContext'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useTheme } from '@/hooks/useTheme'
import { springSheet, fadeReduced, pageEnter } from '@/lib/motion'
import { LinkButton, Button, Kbd } from '@/components/ui/Button'
import { Banner, PageHeader } from '@/components/ui/misc'
import { CommandPalette } from './CommandPalette'
import { ShortcutsDialog } from './ShortcutsDialog'
import { BRAND } from '@/brand'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, key: 'd', group: 'Front desk' },
  { to: '/members', label: 'Members', icon: Users, key: 'm', group: 'Front desk' },
  { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, key: 'a', group: 'Front desk' },
  { to: '/payments', label: 'Payments', icon: Receipt, key: 'y', group: 'Front desk' },
  { to: '/follow-ups', label: 'Follow-ups', icon: BellRing, key: 'f', group: 'Front desk' },
  { to: '/plans', label: 'Plans', icon: CreditCard, key: 'p', group: 'Manage' },
  { to: '/workouts', label: 'Workout plans', icon: NotebookPen, key: 'w', group: 'Manage' },
  { to: '/reports', label: 'Reports', icon: BarChart3, key: 'r', group: 'Insights' },
  { to: '/activity', label: 'Activity', icon: ActivityIcon, key: 'l', group: 'Insights' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, key: 's', group: 'Insights' },
]
const GROUPS = ['Front desk', 'Manage', 'Insights']

const SIDEBAR_KEY = 'gymbook-sidebar'

function Logo({ name, logo, collapsed }: { name: string; logo?: string; collapsed?: boolean }) {
  return (
    <Link to="/" className={cn('pressable flex min-w-0 items-center gap-2.5 rounded-lg', collapsed ? 'justify-center p-1' : 'px-1.5 py-1')} aria-label="GymBook home" title={collapsed ? name : undefined}>
      {logo ? (
        <img src={logo} alt="" className="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-line" />
      ) : (
        <img src={BRAND.logoDataUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
      )}
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-4">{name}</span>
          <span className="block text-2xs leading-3 text-faint">GymBook</span>
        </span>
      ) : null}
    </Link>
  )
}

function NavList({ onNavigate, collapsed }: { onNavigate?: () => void; collapsed?: boolean }) {
  return (
    <nav aria-label="Main" className="flex flex-col">
      {GROUPS.map((group) => (
        <div key={group} className={cn('flex flex-col gap-0.5', group !== GROUPS[0] && (collapsed ? 'mt-2 border-t border-line pt-2' : 'mt-6'))}>
          {!collapsed ? <p className="px-2.5 pb-2 text-xs text-faint">{group}</p> : null}
          {NAV.filter((n) => n.group === group).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          title={collapsed ? item.label : undefined}
          className={({ isActive }) =>
            cn(
              'pressable group relative flex h-9 items-center gap-2.5 rounded-xl text-sm font-medium',
              collapsed ? 'justify-center px-0' : 'px-2.5',
              isActive ? 'bg-sunken text-ink shadow-[inset_0_0_0_1px_rgb(var(--c-line))]' : 'text-muted hover:bg-sunken/70 hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-ink' : 'text-faint group-hover:text-muted')} aria-hidden />
              {!collapsed ? <span className="truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
            </>
          )}
        </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function Shell() {
  const { settings } = useApp()
  const { meta } = useContext(HeaderContext)
  const drive = useDriveState()
  useEffect(() => {
    startAutoBackup()
  }, [])
  const isDesktop = useIsDesktop()
  const [drawer, setDrawer] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
    } catch {
      return false
    }
  })
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const theme = useTheme()
  const pendingG = useRef<number | null>(null)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'open')
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  useEffect(() => {
    setDrawer(false)
  }, [location.pathname])

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const otherDialogOpen = !!document.querySelector('[role="dialog"]:not([data-state="closed"]):not([aria-label="Command palette"])')
        if (!otherDialogOpen) setPalette((p) => !p)
        return
      }
      if (e.key === 'Escape' && drawer) {
        setDrawer(false)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (document.querySelector('[role="dialog"]:not([data-state="closed"])')) return
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return
      const k = e.key
      if (pendingG.current !== null && Date.now() - pendingG.current < 1500) {
        pendingG.current = null
        const hit = NAV.find((n) => n.key === k.toLowerCase())
        if (hit) {
          e.preventDefault()
          navigate(hit.to)
          return
        }
      }
      if (k === 'g' || k === 'G') {
        pendingG.current = Date.now()
        return
      }
      if (k === '/') {
        e.preventDefault()
        setPalette(true)
      } else if (k === 'n' || k === 'N') {
        e.preventDefault()
        navigate('/members/new')
      } else if (k === '?') {
        e.preventDefault()
        setHelp(true)
      } else if (k === '[') {
        e.preventDefault()
        toggleCollapsed()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, navigate, toggleCollapsed])

  const sidebarWidth = collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)'
  const showHeader = meta.header !== false && meta.title

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar (desktop) */}
      <aside
        className="no-print bg-deep sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line lg:flex"
        style={{ width: sidebarWidth }}
        aria-label="Sidebar"
      >
        <div className={cn('flex h-16 items-center', collapsed ? 'justify-center px-2' : 'px-3')}>
          <Logo name={settings.gymName} logo={settings.logoDataUrl} collapsed={collapsed} />
        </div>
        <div className={cn('flex-1 overflow-y-auto py-3 scrollbar-thin', collapsed ? 'px-2' : 'px-2.5')}>
          <NavList collapsed={collapsed} />
        </div>
        <div className={cn('flex flex-col gap-1 border-t border-line py-2', collapsed ? 'items-center px-2' : 'px-2.5')}>
          <button type="button" onClick={() => setHelp(true)} title="Keyboard shortcuts" className={cn('pressable flex h-9 items-center gap-2.5 rounded-lg text-sm text-muted hover:bg-sunken hover:text-ink', collapsed ? 'w-9 justify-center' : 'px-2.5')}>
            <Keyboard className="h-4 w-4 shrink-0" aria-hidden />
            {!collapsed ? <span className="flex-1 text-left">Shortcuts</span> : <span className="sr-only">Keyboard shortcuts</span>}
            {!collapsed ? <Kbd>?</Kbd> : null}
          </button>
          <button type="button" onClick={theme.toggle} title={`Switch to ${theme.resolved === 'dark' ? 'light' : 'dark'} theme`} className={cn('pressable flex h-9 items-center gap-2.5 rounded-lg text-sm text-muted hover:bg-sunken hover:text-ink', collapsed ? 'w-9 justify-center' : 'px-2.5')}>
            {theme.resolved === 'dark' ? <Sun className="h-4 w-4 shrink-0" aria-hidden /> : <Moon className="h-4 w-4 shrink-0" aria-hidden />}
            {!collapsed ? <span className="flex-1 text-left">{theme.resolved === 'dark' ? 'Light theme' : 'Dark theme'}</span> : <span className="sr-only">Toggle theme</span>}
          </button>
          <button type="button" onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} className={cn('pressable flex h-9 items-center gap-2.5 rounded-lg text-sm text-muted hover:bg-sunken hover:text-ink', collapsed ? 'w-9 justify-center' : 'px-2.5')}>
            {collapsed ? <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden /> : <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden />}
            {!collapsed ? <span className="flex-1 text-left">Collapse</span> : <span className="sr-only">Expand sidebar</span>}
            {!collapsed ? <Kbd>[</Kbd> : null}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print bg-canvas sticky top-0 z-30 border-b border-line pt-[env(safe-area-inset-top)]">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-5 lg:h-16">
            <div className="min-w-0 lg:hidden">
              <Logo name={settings.gymName} logo={settings.logoDataUrl} />
            </div>
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="pressable hidden h-9 w-72 min-w-0 shrink items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm text-faint shadow-card hover:border-line-strong md:flex"
              aria-label="Search members and commands"
            >
              <Search className="h-4 w-4" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">Search</span>
              <Kbd>⌘K</Kbd>
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              {settings.dataMode === 'sample' ? (
                <Link to="/settings#data" className="pressable hidden h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs text-muted hover:bg-sunken hover:text-ink sm:inline-flex" title="Labelled sample data is loaded. Records marked “Sample” are not real. Click to manage.">
                  <FlaskConical className="h-3.5 w-3.5" aria-hidden />
                  Sample data
                </Link>
              ) : null}
              <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setPalette(true)} aria-label="Search" icon={<Search className="h-4 w-4" aria-hidden />} />
              <LinkButton to="/members/new" size="md" icon={<UserPlus className="h-4 w-4" aria-hidden />} className="ml-1">
                <span className="hidden sm:inline">Add member</span>
                <span className="sm:hidden">Add</span>
              </LinkButton>
            </div>
          </div>
        </header>

        <main className="main-mobile-pad min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
          <motion.div
            key={location.pathname}
            className="mx-auto w-full max-w-[1200px]"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? fadeReduced : pageEnter}
          >
            {drive.overdue && drive.link ? (
              <div className="no-print mb-5">
                <Banner
                  tone="warn"
                  action={
                    <span className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary" loading={drive.busy === 'backup' || drive.busy === 'signing-in' || drive.busy === 'checking'} onClick={() => void backupFromReminder()}>Back up now</Button>
                      <Link to="/settings#drive" className="text-sm font-medium underline-offset-2 hover:underline">Backup settings</Link>
                    </span>
                  }
                >
                  <strong className="font-medium">Google Drive backup is out of date.</strong> There are changes on this device since the last backup{drive.link.lastBackupAt ? ` on ${formatDateTime(drive.link.lastBackupAt, settings.timezone)}` : ''}.
                </Banner>
              </div>
            ) : null}
            {showHeader ? <PageHeader title={meta.title} description={meta.description} slot /> : null}
            {settings.dataMode === 'sample' && showHeader ? (
              <p className="-mt-3 mb-5 text-xs text-muted sm:hidden">
                Showing <Link to="/settings#data" className="font-medium text-info underline-offset-2 hover:underline">labelled sample data</Link>.
              </p>
            ) : null}
            <Outlet />
          </motion.div>
        </main>
        <footer className="no-print hidden px-5 py-4 text-center text-2xs text-faint lg:block">Data is stored in this browser only · © {new Date().getFullYear()} GymBook</footer>
      </div>

      {/* Bottom tab bar (phones and tablets) */}
      <nav aria-label="Quick navigation" className="no-print bg-canvas fixed inset-x-0 bottom-0 z-30 border-t border-line pb-safe lg:hidden">
        <ul className="grid h-14 grid-cols-5">
          {[
            { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
            { to: '/members', label: 'Members', icon: Users },
            { to: '/attendance', label: 'Check in', icon: ClipboardCheck },
            { to: '/payments', label: 'Payments', icon: Receipt },
          ].map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) => cn('pressable flex h-full flex-col items-center justify-center gap-0.5 text-2xs font-medium', isActive ? 'text-ink' : 'text-muted')}
              >
                {({ isActive }) => (
                  <>
                    <span className={cn('flex h-7 w-11 items-center justify-center rounded-lg', isActive && 'bg-sunken shadow-[inset_0_0_0_1px_rgb(var(--c-line))]')}>
                      <item.icon className="h-[18px] w-[18px]" aria-hidden />
                    </span>
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setDrawer(true)} className={cn('pressable flex h-full w-full flex-col items-center justify-center gap-0.5 text-2xs font-medium', drawer ? 'text-ink' : 'text-muted')} aria-label="Open navigation" aria-expanded={drawer} aria-controls="mobile-nav">
              <span className={cn('flex h-7 w-11 items-center justify-center rounded-lg', drawer && 'bg-sunken shadow-[inset_0_0_0_1px_rgb(var(--c-line))]')}>
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
              </span>
              More
            </button>
          </li>
        </ul>
      </nav>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawer && !isDesktop ? (
          <>
            <motion.button
              type="button"
              aria-label="Close navigation"
              className="fixed inset-0 z-40 bg-black/40 lg:hidden dark:bg-black/60"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fadeReduced}
              onClick={() => setDrawer(false)}
            />
            <motion.div
              id="mobile-nav"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="surface-pop fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto rounded-r-2xl px-3 py-3 pt-[calc(12px+env(safe-area-inset-top))] pb-safe lg:hidden"
              initial={reduced ? { opacity: 0 } : { x: '-100%' }}
              animate={reduced ? { opacity: 1 } : { x: 0 }}
              exit={reduced ? { opacity: 0 } : { x: '-100%' }}
              transition={reduced ? fadeReduced : springSheet}
              drag={reduced ? false : 'x'}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: 1, right: 0.05 }}
              dragSnapToOrigin
              onDragEnd={(_, info) => {
                if (info.offset.x < -80 || info.velocity.x < -500) setDrawer(false)
              }}
            >
              <div className="mb-3 flex items-center justify-between px-1">
                <Logo name={settings.gymName} logo={settings.logoDataUrl} />
                <button type="button" onClick={() => setDrawer(false)} className="pressable flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-sunken" aria-label="Close navigation" autoFocus>
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
              <NavList onNavigate={() => setDrawer(false)} />
              <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
                <span>Theme</span>
                <Button variant="secondary" size="sm" onClick={theme.toggle} icon={theme.resolved === 'dark' ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}>
                  {theme.resolved === 'dark' ? 'Light' : 'Dark'}
                </Button>
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      <CommandPalette open={palette} onClose={() => setPalette(false)} onToggleTheme={theme.toggle} />
      <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
    </div>
  )
}
