import { createBrowserRouter, RouterProvider, Outlet, ScrollRestoration } from 'react-router-dom'
import { lazy, Suspense, useEffect, useState, useMemo } from 'react'
import { loadSnapshot } from '@/data/snapshot'
// The front-desk pages ship in the main bundle: a lazily loaded page cost about half a second extra on
// a phone before it could show anything, which is most of what the desk opens all day. Rarely used
// pages (plans, reports, settings, printing) still load on demand.
import { MembersPage } from '@/pages/Members'
import { MemberDetailPage } from '@/pages/MemberDetail'
import { MemberFormPage } from '@/pages/MemberForm'
import { AttendancePage } from '@/pages/Attendance'
import { PaymentsPage } from '@/pages/Payments'
import { FollowUpsPage } from '@/pages/FollowUps'
const PlansPage = lazy(() => import('@/pages/Plans').then((m) => ({ default: m.PlansPage })))
const InvoicePage = lazy(() => import('@/pages/Invoice').then((m) => ({ default: m.InvoicePage })))
const ReportsPage = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.ReportsPage })))
const SettingsPage = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })))
const WorkoutsPage = lazy(() => import('@/pages/Workouts').then((m) => ({ default: m.WorkoutsPage })))
const WorkoutPrintPage = lazy(() => import('@/pages/WorkoutPrint').then((m) => ({ default: m.WorkoutPrintPage })))
const ActivityPage = lazy(() => import('@/pages/Activity').then((m) => ({ default: m.ActivityPage })))
import { AppProvider, HeaderContext, useApp, type PageMeta } from './AppContext'
import { Shell } from './Shell'
import { Dashboard } from '@/pages/Dashboard'
import { NotFound } from '@/pages/NotFound'
import { Onboarding } from '@/pages/Onboarding'
import { StorageProblem } from '@/pages/StorageProblem'
import { ToastProvider } from '@/components/ui/Toast'
import { PageLoading } from '@/components/ui/Spinner'
import { ErrorPage } from '@/pages/ErrorPage'

function Root() {
  const [meta, setMeta] = useState<PageMeta>({ title: '' })
  const header = useMemo(() => ({ meta, setMeta }), [meta])
  return (
    <ToastProvider>
      <ScrollRestoration />
      <AppProvider fallback={<PageLoading label="Opening GymBook…" />} onStorageError={(err, retry) => <StorageProblem error={err} retry={retry} />}>
        <HeaderContext.Provider value={header}>
          <Gate />
        </HeaderContext.Provider>
      </AppProvider>
    </ToastProvider>
  )
}

function Gate() {
  const { settings } = useApp()
  const ready = settings.dataMode !== 'unset'
  // Start reading the records every page needs as soon as the gym is set up, in parallel with the first
  // page's own work, so the first tap on Members or Payments opens from memory.
  useEffect(() => {
    if (ready) void loadSnapshot().catch(() => {})
  }, [ready])
  if (!ready) return <Onboarding />
  return (
    <Suspense fallback={<PageLoading />}>
      <Outlet />
    </Suspense>
  )
}

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')
export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <ErrorPage />,
    children: [
      {
        element: <Shell />,
        children: [
          { path: '/', element: <Dashboard /> },
          { path: '/members', element: <MembersPage /> },
          { path: '/members/new', element: <MemberFormPage mode="new" /> },
          { path: '/members/:id', element: <MemberDetailPage /> },
          { path: '/members/:id/edit', element: <MemberFormPage mode="edit" /> },
          { path: '/plans', element: <PlansPage /> },
          { path: '/attendance', element: <AttendancePage /> },
          { path: '/payments', element: <PaymentsPage /> },
          { path: '/follow-ups', element: <FollowUpsPage /> },
          { path: '/reports', element: <ReportsPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/workouts', element: <WorkoutsPage /> },
          { path: '/activity', element: <ActivityPage /> },
        ],
      },
      { path: '/invoices/:id', element: <InvoicePage /> },
      { path: '/workouts/:id/print', element: <WorkoutPrintPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
], { basename })

export function App() {
  return <RouterProvider router={router} />
}
