# GymBook test report

Date: 2026-10-28. Environment: macOS, Node 24, Chromium-based in-app browser at 320, 390, 768, 1024 and 1440 px.

## Redesign pass (same day, later)

The UI was redesigned on top of the same data layer: Inter typography, new neutral + emerald token set with light and dark themes, 36/44 px controls, collapsible sidebar, command palette (`⌘K`), keyboard shortcuts, skeleton loading states, page-enter transitions, header action slot, sectioned settings. All 20 unit tests and all 20 Playwright tests were re-run after the redesign and pass unchanged (the e2e selectors are role/label based, so they double as a regression check that no workflow broke). Screens were re-inspected in the in-app browser in light and dark themes at desktop width and at 390 px, including the mobile drawer, the bottom-sheet dialog and the command palette.

## Mobile pass

Added a bottom tab bar, floating page actions, touch-sized controls (verified under touch emulation: inputs 44 px tall at 16 px, primary buttons 44 px), safe-area padding, scroll restoration, manifest and icons. Re-swept every route at 320 px under the same no-overflow check (all pass, `scrollX` max 0) and re-inspected dashboard, members, plans, the More drawer and a bottom-sheet form at 375 px. Both suites re-run afterwards.

## Training and operations features (same day, later)

Added member profile fields and member codes (database version 2 with an upgrade that back-fills codes), PT sessions with conflict checks, equipment with an incident workflow, workout plans with a built-in library and printable sheets, an activity log page, dashboard trend and operations cards, grouped navigation, a printable report summary and an offline service worker (production builds only).

- Unit: 5 new service tests (member codes and code search, session double-booking and adjacency, incident lifecycle and equipment condition, template copy and assignment, backup round-trip of the new stores).
- E2E: `e2e/features.spec.ts` covers profile entry and check-in by code, booking with a refused overlap and completion visible on trainer and member pages, the full incident lifecycle with dashboard alerts, template use with assignment and the personalised print sheet, and the activity filter plus a 390 px overflow sweep of the new pages.
- The existing suites were re-run after the schema change; selectors that became ambiguous (a second "Notes" field, a "Workout plans" nav entry, the labelled member picker) and counts that grew (palette commands, backup stores, counters) were updated in the exploratory specs.
- Offline: verified in headless Chromium against the production build that the worker registers, precaches the shell and 53 assets, and that `/members` loads with the network disabled. The desktop app's embedded browser refuses to fetch worker scripts, so that check was not possible there.

| Suite | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright main + features | 25 passed |
| Playwright exploratory: members / money / ops / shell | 32 / 14 / 10 / 28 passed |
| Typecheck, lint, build (with service-worker precache step) | clean |

## Exploratory bug hunt (parallel agents, same day)

Five agents attacked the app in parallel: members data entry, money flows, operations screens, settings/shell/accessibility/responsive, and a unit-level audit of the domain and data layer. They left their work in place so it can be rerun:

- `e2e/explore/members.spec.ts`, `money.spec.ts`, `ops.spec.ts`, `shell.spec.ts` (Playwright, run one file at a time with `--output <own dir>`; they share the 4173 dev server)
- `src/domain/audit.test.ts`, `src/data/audit.test.ts` (vitest; 98 extra cases)

### Bugs found and fixed

High
- Browser Back on an edited form, then "Discard changes", re-opened the dialog forever (the guard reset a stale blocker after `proceed()`). `DiscardGuard.tsx`
- Loading sample data failed whenever a real invoice existed (hard-coded `INV-00001…`), and reloading it rewound the invoice counter so every later sale failed. Sample numbering now continues from the stored counter and prefix, and the counter never goes backwards. `data/sample.ts`

Medium
- Voiding an invoice left its membership active (check-in still allowed). The membership is now marked cancelled with the reason, excluded from current/renewal logic, and shown as "Cancelled". `services/payments.ts`, `domain/membership.ts`
- "Outstanding" had three definitions (dashboard per member, Payments and Reports per invoice). All now use one member-level definition that applies unlinked credits and excludes archived members. `domain/metrics.ts`
- Attendance history and the period pickers accepted inverted date ranges (empty results, misleading headers); ranges are normalised. `Attendance.tsx`, `PeriodPicker.tsx`
- Switching a follow-up from a member type to "lead" kept the stale member (list showed the member, not the lead). Irrelevant fields are stripped on save. `validation.ts`
- Reschedule accepted an empty date and stored `dueDate: ""`. Validated in the dialog and the service. `FollowUps.tsx`, `services/followups.ts`
- `/payments?action=record` focused the picker before it existed (timer race); it now focuses once data has loaded. `Payments.tsx`
- Member search dropped keystrokes when typing fast (input controlled by the URL); the box is local state and the URL follows. `Members.tsx`
- Phone numbers starting with "(" were refused; joining dates had no bounds (2999 and 1900 accepted). `validation.ts`
- Schedule times accepted `25:00` / `09:60`, and `formatMinutes(1440)` rendered 12:00 pm. `validation.ts`, `dates.ts`
- Toasts covered the bottom tab bar on phones; on small screens they now appear under the header. `Toast.tsx`
- Command palette did not return focus to its opener and Tab could leave it. `CommandPalette.tsx`
- Member picker had no accessible label; faint text failed WCAG AA contrast (2.8:1 light, 3.7:1 dark; now 4.7:1 and 5.5:1). `MemberPicker.tsx`, `index.css`
- `parseRupees` accepted totals beyond the safe-integer range; plan price now capped at ₹100 crore. `money.ts`, `validation.ts`
- Default invoice issue date in the service used the UTC date rather than the gym's date (the UI always passed the right date). `services/memberships.ts`

Low
- Raw zod messages for over-long text and durations; "1 recorded payments" pluralisation; form-level errors lingering after edits; footer Cancel bypassing the unsaved-changes guard in dialogs; Reset dialog keeping the typed "RESET" after Cancel; developer fail-point UI never re-arming; `theme-color` not synced at boot; `G`+letter chord broken when Shift was held; ⌘K opening the palette over another dialog; "Other" follow-ups labelled "Lead"; negative numbers in CSV exported as text; CSV timestamps exported in UTC rather than gym time; IndexedDB uniqueness errors surfacing as a raw browser message.

### Final state after fixes

| Suite | Result |
| --- | --- |
| Vitest (domain + data, incl. 98 audit cases) | 119 passed |
| Playwright main workflows | 20 passed |
| Playwright exploratory: members / money / ops / shell | 32 / 14 / 10 / 28 passed |
| Typecheck, lint, production build | clean |

The exploratory specs were updated where they had encoded the old behaviour (inverted ranges, per-invoice outstanding, UTC CSV timestamps, the uncapped price) and their "expected to fail" probes were promoted to ordinary tests.

### Judged as design choices, left as is
- Month plans starting on the 29th–31st end on the day before the same date next month after clamping (31 Jan → 27 Feb), which is documented in the sell dialog. A product decision could prefer "end of next month".
- Phone numbers starting with "+" are still apostrophe-escaped in CSV (a real formula risk in spreadsheets).
- `?page=99` is clamped but the URL keeps the typed value.

## Automated

`npm test` — 20 tests in 2 files, all passing.

- `domain/domain.test.ts`: inclusive end-date arithmetic for month and day plans, month clamping (31 Jan + 1 month), timezone "today" and start-of-day instants, rupee parsing/formatting round-trips, CSV formula escaping, membership state from dates, invoice balance (partial, void payment, adjustment) and that paid is never inferred from active.
- `data/services.test.ts` (fake-indexeddb): sale → partial payment → overpayment refused → balance paid; sequential invoice numbers across renewals; plan snapshot survives plan edit; idempotency key collapses a double submit into one invoice; void payment + adjustment keep history; attendance (no membership → `MembershipRequiredError`, override with reason, duplicate open check-in refused, check-out, stale revision refused); archive keeps invoices and payments and blocks new sales; stale-revision update refused (two-tab simulation); simulated storage failure writes nothing; backup round-trip, invalid backup rejected with data untouched, invoice counter advanced after import; sample data seeds labelled records and removal leaves real records; trainer schedule overlap rejected.

`npm run test:e2e` — 20 Playwright tests in `e2e/workflows.spec.ts`, all passing in headless Chromium against a fresh dev server (each test starts from an empty browser context, so IndexedDB is clean, and completes onboarding through the UI). They cover: sale with partial payment → balance paid → print-media layout; overpayment refused with the outstanding amount; renewal start/end dates computed independently with the domain date helpers and invoice issued on the sale date; check-in, duplicate refused, check-out, no-membership override with a required reason; archive keeps invoices/payments and hides sale actions; invalid and non-JSON backups rejected with data counts unchanged; two tabs editing one member (second save refused, edits kept, "load latest" works); simulated save failure keeps the form and retry succeeds; double-click creates one record; dashboard money and counts match an independent recomputation from IndexedDB; empty-period reports show zeros and the members CSV escapes a formula-like name; no horizontal scroll on every screen at 320, 390, 768, 1024 and 1440 px; phone drawer, bottom sheet with close button, focus trap over 20 Tab presses, Escape, focus returned to the opener; `prefers-reduced-motion` zeroes the press scale and dialogs still open/close; unsaved-edit guard, branded 404, Back/Forward; duplicate phone warns without blocking.

Bugs found by the end-to-end suite and fixed: a failed request stayed in the idempotency map for five seconds so an immediate retry re-threw the old error; the check-in idempotency key was time-bucketed so a duplicate attempt within three seconds reported success; the chart's screen-reader-only data table was 300 px wide and caused a 10 px horizontal scroll on Reports at 320 px.

`npm run typecheck` clean. `npm run build` succeeds; pages are code-split (main chunk ≈ 396 kB minified, pages 3–9 kB each).

## Browser workflows executed interactively (before the Playwright suite existed)

| Workflow | Result |
| --- | --- |
| Add member (duplicate phone warning shown, non-blocking) → sell Monthly plan with ₹500 partial payment → invoice INV-00015 "Partly paid", balance ₹1,000 → record ₹1,000 from invoice page → "Paid", balance ₹0, both payments listed | Pass |
| Renew: default start "After current plan" = day after current end (28 Nov) → end 27 Dec 2026 (inclusive), explanation text shown, invoice INV-00016 | Pass (found and fixed: invoice issue date used the future start date; now the sale date) |
| Attendance: keyboard-select member in combobox → check in → second check-in refused ("already checked in") → check out, duration recorded | Pass |
| Archive member: invoices, payments, memberships and visits still listed; "Archived" badge; sell/check-in actions hidden | Pass |
| Import invalid backup (missing member / invoice references): preview lists errors, nothing replaced | Pass |
| Two tabs editing the same member: tab A saves; tab B keeps its typed edits, shows "Changed in another tab", its save is refused with a conflict message; tab A's value is what is stored | Pass (found and fixed: form previously remounted on remote change and lost edits) |
| Simulated save failure (Settings → Developer tools) on Add expense: error shown inside the dialog, amount preserved, retry succeeds | Pass |
| Dashboard totals vs. raw IndexedDB: cash received, invoiced, expenses, net cash, outstanding, active members, attendance today recomputed independently in the page and matched | Pass |
| Every screen at 320 / 390 / 768 / 1024 / 1440: no element wider than the viewport, no horizontal page scroll (`scrollX` max 0) | Pass (found and fixed: unwrapped toolbars at 320, card-header tab strips and a grid column not shrinking at 390) |
| Dialog on phone width renders as bottom sheet with visible close button; focus starts on first control; Tab stays inside; Escape closes; focus returns to opener | Pass (found and fixed: focus restore after close) |
| Direct links, Back/Forward (history-driven navigation used in the sweep), unique titles per page, 404 page with home link | Pass |

## Verified by code inspection only (not exercised in a browser)

- `prefers-reduced-transparency` and `prefers-contrast: more` token overrides.
- The actual `window.print()` dialog; the print-media layout itself is asserted by the e2e suite via `emulateMedia`.
- Drag-to-dismiss on the mobile sheet (pointer capture, rubber-banding at the top, velocity threshold) — implemented with motion's drag controls from the sheet handle; a real touch device was not available.
- Photo/logo downscaling (`createImageBitmap` + canvas), WhatsApp/mailto links.

## Known gaps

- The e2e suite runs in Chromium only; WebKit and Firefox projects are not configured.
- The React Compiler lint reports two memoization advisories in `MembershipDialog.tsx`; they do not affect behaviour.
- Dark mode is not implemented (light theme only, by design for this version).

## Glass UI pass (2026-10-28)

Visual refresh only: ambient colour wash plus three translucent surface layers (`.glass`, `.glass-card`, `.glass-pop`), larger radii, lighter borders, softer shadows. No data or behaviour changes.

| Suite | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright main + features + shell exploratory | 53 passed (2 reran after fixes below) |
| Typecheck, lint, build | clean (lint warnings unchanged) |

Findings fixed during the pass:

- Light-mode `--c-faint` fell to 4.45:1 on the new canvas; darkened to 102 103 110 (5.16:1 on canvas, 4.98:1 on sunken).
- Theme exploratory test asserted the old canvas colours and `theme-color` meta; updated to the new tokens.
- Tab strip showed a horizontal scrollbar on phones; hidden with `.scrollbar-none`.

## Branding and GitHub Pages deploy (2026-10-29)

Branded for R.K. Gym Fitness Centre (name, address, phone, RK invoice prefix, RK monogram logo, crimson palette) and deployed to GitHub Pages at https://adityakushwaha8421-crypto.github.io/gymbook/ via `.github/workflows/pages.yml` (moved on 2026-11-07 to https://khetrirajan55-tech.github.io/gymbook/ under the `khetrirajan55-tech` account; the old repository was kept at the owner's request and still serves the old copy).

| Check | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright main + features + shell + members | 85 passed (79 first run, 6 fixed and rerun) |
| Pages simulation (dist served under `/gymbook/`, 404 fallback) | deep links, back/forward, sample data, SW scope OK |
| Live site in headless Chromium | deep link `/gymbook/settings` renders, SW scope `/gymbook/`, offline reload of `/members` shows 12 sample members, no page errors |

Test fixes in this pass were all branding follow-through: default gym name, prefilled onboarding name, "Change logo" as the initial state, invoice numbers `RK-…`, and a photo-upload locator scoped to `main` so it ignores the new sidebar logo.

## Polish pass with Impeccable (2026-11-05)

Refinement only, following Impeccable's `polish` playbook: the glass look, crimson brand and all behaviour are unchanged.

Findings and fixes:

- **Status colours inverted after the rebrand.** The accent (now crimson) was still used for positive states, so Active, Paid, Completed, Inside and In service rendered red. Added a `success` token (emerald) and moved every status use to it; accent is now brand and primary actions only.
- **Warn and danger were nearly the same hue.** Warn is now gold (hue 40°), danger red-orange (hue 8°), with yellow and pink soft backgrounds.
- **Charts.** Cash received and new memberships use success instead of the brand red, so they no longer read like expenses.
- **Orphaned minus sign.** In the five-up Reports row "−₹42,500.00" broke after the minus; long amounts now step down a type size.
- **Field focus looked like an error.** Focused inputs get a neutral ink border; invalid stays red.
- **Coloured button glow** (flagged by the detector on dark backgrounds) replaced with neutral elevation.
- **Browser surfaces.** Caret, native control accent, scrollbars and link underline offset now follow the palette.

| Check | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright main + features + shell exploratory | 53 passed |
| Contrast table (light and dark, now including success) | every pair ≥ 5.1:1 |
| Impeccable detector | source clean; one rendered finding (button glow) fixed |
| Typecheck, lint | clean |

Follow-up the same day: on phones the page actions no longer float. They sit under the page title as equal-width buttons, in the flow, so they cannot cover card content (the floating Check in and Record payment pills used to hide values on the dashboard). The tablet top bar's search text and Sample data pill no longer wrap. The unused `eyebrow` prop was removed from `PageHeader`.

| Check | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright main + features + shell exploratory | 53 passed (one attendance test stalled for 7 minutes with no assertion error on the first run and passed in 9 s on rerun) |
| Phone 375 px, tablet 768 px, desktop | checked in the browser |

## Unslop pass (2026-11-06)

The UI was reworked with the [unslop](https://github.com/heydamir/unslop) method by Damir Sokolovsky (@heydamir, CC BY 4.0): audit the signs, write a direction from the product, then fix spacing, colour, icons, copy, type, layout, details and motion in that order. Features, content and section order are unchanged.

Audit, with where each sign lived:

- Radial colour washes behind content (`body::before`) and glass cards with a white inner highlight (cards, stat tiles, sidebar, bars, dialogs, palette, toasts)
- Logo as a gradient tile
- Uppercase tracked labels (sidebar groups, table headers, palette and shortcut groups, activity dates, invoice labels, print headers)
- Weight 600 on 45 headings and figures; negative tracking on 15 to 30 px text
- Pills everywhere (badges, tab-bar indicator, sample-data link); radii of 14 to 24 px on controls and cards
- Stat cards padded with icons; two charts of equal size in Reports; several hues per chart with no lead
- Sidebar rows 1 px apart, group labels closer to the group above than to their own items
- Greeting headline on onboarding, a sparkle icon tile, trailing periods on one-line subheads, a wordy search placeholder
- A bouncy sheet spring, three different easing curves, an animated sidebar width

What changed: graphite ramp and solid surfaces, crimson kept as the one accent, IBM Plex Sans and Mono, weights 400 and 500, sentence case, flat logo, radii 6/8/10/14/18, numbers-only stats, one lead series per chart with charts drawn at real pixel width (labels were shrinking to about 6 px on phones), a 2/3 main chart in Reports, sidebar spacing and 240 px width, one easing curve and no bounce, and a live dot reserved for "in the gym now".

| Check | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright, every suite | 109 passed (102 on the first run; 7 money tests still expected `INV-` invoice numbers from before the branding change and passed once updated) |
| Contrast table, light and dark | every pair at least 4.6:1 |
| Desktop 1280, dark, phone 375 | checked in the browser |
| Typecheck, lint, production build | clean |

## Cleanup and sub-path fixes (2026-11-06)

- Removed dead code: 13 functions and one hook file nothing called, the unused accent badge tone, an unused CSS class and two unused Tailwind tokens.
- Removed the Developer tools section from Settings. The simulated save failure used by the failure-handling tests is now armed through a session flag that is read in development builds only; a production build ignores it.
- Fixed two links that left the app when it is served from a sub-path (GitHub Pages `/gymbook/`): "Reset everything" navigated to the domain root, and the workout sheet "Print" buttons opened `/workouts/…` without the base path. Both now go through `appUrl()` in `src/lib/appUrl.ts`.

| Check | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright main + features + shell exploratory | 53 passed |
| Production build served under `/gymbook/` | no Developer section; the failure flag is ignored and the save succeeds; Print opens `/gymbook/workouts/…/print`; Reset lands on `/gymbook/` |
| Typecheck, lint | clean |

## Member measurements and scope cut (2026-11-06)

Asked for: height and weight on the member form; Trainer, Email, Emergency contact and Emergency phone removed from it; and the PT sessions, Trainers, Equipment and Expenses sections removed from the app.

- **Member form:** Height (cm, 50 to 250) and Weight (kg, 20 to 300) are optional, accept at most one decimal and are stored as numbers. Text, units, feet-and-inches and out-of-range values are refused with a message. Both show on the member page and in the Members CSV export. The four removed fields are gone from the form, the member page, search, duplicate detection and the CSV.
- **Removed sections:** pages, routes, sidebar entries, command-palette entries, `G` shortcuts, the dashboard cards for today's PT sessions and equipment, the expense figures on the dashboard and in Reports (Expenses, Net cash, the expense series and category list, the Expenses CSV), the PT sessions tab on the member page, their services and form schemas, and their sample data. Their old addresses show the not-found page.
- **Kept on purpose:** the IndexedDB stores, record types and backup schema for those sections, and the old member fields on stored records. Nothing already saved is deleted, older backups still restore, and editing a member made by an earlier version keeps its old email, trainer and emergency contact untouched. Old activity-log rows keep their labels; the activity filter no longer offers the retired kinds. A backup preview lists a retired section only when the file still carries its records.
- **Tests:** the trainer, schedule, session, equipment and expense tests were removed with the features. The failed-save and double-submit tests that used the expense form now use the plan form. New tests cover height and weight validation, storage, editing and export, the absence of the removed fields and sections, and that records of removed sections survive a backup round trip.

| Check | Result |
| --- | --- |
| Vitest | 124 passed |
| Playwright, every suite | 104 passed (the first full run had 99; five failed: two still expected the old palette size and email search, one looked for the wrong not-found heading, and three hit a dev server that had stopped. All pass after the test updates and a rerun) |
| Desktop 1280 and phone 375 | member form, member page, dashboard and reports checked in the browser; no horizontal overflow |
| Typecheck, lint | clean |

## Upcoming expiries on Follow-ups (2026-11-06)

Asked for: a section of upcoming expiries on the Follow-ups page.

- **What it shows:** on the Open tab, members whose cover ends within 7, 15 or 30 days (switchable, 7 by default), soonest first, with days left, plan, end date and phone. Six rows show at first; "Show all" expands the rest.
- **Actions per row:** Call, WhatsApp with a renewal reminder already written, and "Add follow-up" prefilled as an expiry follow-up. A member who already has an open expiry follow-up is marked "Follow-up open" instead.
- **Who is left out:** archived members, cancelled memberships, plans that already ended, and members who have already renewed (cover is judged by the latest end date, in `upcomingExpiries` in `src/domain/metrics.ts`).
- **Suggested card:** it used to list expiring members too. It now lists only plans that lapsed in the last 14 days and outstanding balances, so nobody appears twice.

| Check | Result |
| --- | --- |
| Vitest | 128 passed (4 new for the expiry rules) |
| Playwright: workflows, features, shell, operations | 59 passed, including a new test for the section |
| Desktop 1280 and phone 375 | section checked in the browser; no horizontal overflow |
| Typecheck, lint | clean |

## Test run, fixes, camera photo and plan on Add member (2026-11-06)

Asked for: run the tests and fix things; a camera option for the member photo; a plan choice on the Add member page.

**Test run before any change:** typecheck clean, 128 unit tests and 105 browser tests passed, production build succeeded. Nothing was failing, so the fixes below come from reading the code while the suite ran.

- **Renewed members read as expiring (fixed).** The dashboard count and card, the Members "Expiring" filter and the member page judged a member by the plan that covers today, so someone who had already renewed still showed as "Expiring soon" while Follow-ups left them out. One rule now decides it everywhere (`memberMembershipState` in `src/domain/membership.ts`): with a renewal on file the member reads as active, and "Days left" on the member page counts to the end of the renewal ("Renewed to …").
- **Dates shown in UTC instead of gym time (fixed).** Between midnight and 05:30 in India these showed the previous day: the "generated on" date and adjustment dates on an invoice, and the "Completed" date of a follow-up. The backup preview's export time used the device's locale and timezone; it now uses the gym's.
- **Dialogs:** opening a dialog no longer tries to focus a disabled control.
- **Not changed:** the 22 lint warnings are older React-compiler style notes (state set in effects, fast-refresh exports). None is a test failure and none was touched.

**Camera photo.** The member form has "Take photo" beside "Upload photo". The dialog opens the device camera (back camera on a phone, the webcam on a laptop, "Switch camera" when there are two), shows a square preview, and offers Retake before "Use photo". The picture is cropped square, shrunk to 256 px and stored with the member like an uploaded one; nothing is sent anywhere. The camera is released when the dialog closes. A blocked camera, a missing camera, a busy camera and a browser without camera support each get their own message, with "Try again" and "Upload a photo instead".

**Plan on Add member.** A "Membership plan" section lists the active plans ("No plan for now" by default, so adding a member without a plan works as before). With a plan chosen it asks for the start date (follows the joining date until changed), discount, amount received now and payment method, and shows the last day of access and what stays outstanding. Saving writes the member, membership, invoice and first payment in one transaction (`createMemberWithMembership`): if the sale is refused, the member is not created either, and no member code or invoice number is used up.

| Check | Result |
| --- | --- |
| Vitest | 139 passed (11 new: renewal rule, add-with-plan service, form validation) |
| Playwright, every suite | 113 passed (8 new: 4 camera with Chromium's fake camera and stubbed failures, 4 add-member-with-plan). On the first run of the new tests 4 failed on wrong expectations in the tests themselves: the dev build opens the camera twice (React StrictMode), and the outstanding-amount line was misquoted |
| Camera dialog | live preview, taken photo and saved avatar checked on screenshots at 1100 and 375 px with the fake camera; the blocked-camera state checked in the in-app browser |
| Add member with plan | checked in the browser at 1100 and 375 px; no horizontal overflow |
| Not checked | a real phone or webcam: the camera was exercised only with Chromium's fake device |
| Typecheck, build | clean |

## WhatsApp messages for members (2026-11-06)

Asked for: after adding a member, an option to send them the invoice or a WhatsApp message about the amount paid and the expiry, with their name and proper emoji.

- **After adding a member:** the member's page opens with a notice, "New member saved", and a "Send on WhatsApp" button ("Not now" hides it; it does not come back on refresh). It is a notice and not a pop-up, so the desk is never blocked.
- **The dialog:** shows the message ready to send and lets the desk edit it. "Open WhatsApp" opens a chat with the member's number and the text filled in; "Copy" copies it. GymBook never sends anything itself.
- **Three messages** (`src/domain/whatsapp.ts`): *Welcome / Membership* (name, member ID, plan, start, valid-till date with days left, invoice number, amount, paid, balance due), *Invoice* (what was billed, discount, adjustment, paid, due) and *Expiry reminder*. A member added without a plan gets a short welcome with the member ID.
- **Also on:** a WhatsApp button on every member's page and on each invoice. The Upcoming expiries list on Follow-ups now sends the same emoji reminder.
- **Emoji** are single code points, with no variation selectors or joined sequences, the plainest form for older phones; a unit test enforces it.
- **Limit:** a WhatsApp link can carry text only, so the invoice goes as text, not as a PDF. To send the PDF, use "Print / save PDF" on the invoice and attach the file in WhatsApp.

| Check | Result |
| --- | --- |
| Vitest | 149 passed (10 new for the messages and links) |
| Playwright, every suite | 115 of 116 passed on the full run. The one failure was an older payments test that left the page before its payment was saved (a race in the test, not in the app); it now waits for the save and passed 4 times in a row. The full suite was not run again after that one-line test change |
| New browser tests | 3: member with a plan (all three messages, editing, banner dismissal), member without a plan, invoice page |
| Desktop 1100 and phone 375 | banner and dialog checked on screenshots; no horizontal overflow, no console errors |
| Not checked | an actual WhatsApp chat: the link and its text were verified, but no message was opened in WhatsApp or sent |
| Typecheck, build | clean |

**Changed the same day, at the owner's request:** the Welcome / Membership message no longer shows the member ID or the "Balance due" line. It still shows the invoice number, amount and what was paid. The Invoice message keeps its balance line, since an invoice that hides what is owed would mislead. 149 unit tests and the 3 WhatsApp browser tests pass with the new text.

**Emoji arrived as "�" in a real chat (fixed the same day).** The owner sent a message and every emoji showed as a replacement box. Cause: the short `wa.me` link answers with a redirect to `api.whatsapp.com`, and that redirect replaces each emoji in the text with U+FFFD (visible in its `Location` header: `%F0%9F%92%AA` goes in, `%EF%BF%BD` comes out). `whatsappUrl` now links to `https://api.whatsapp.com/send?phone=…&text=…` directly, which passes the text through untouched; every emoji the messages use was sent through that page with a dummy number and came back intact (0 replacement characters). This was missed earlier because only the link's own text was checked, not what WhatsApp does with it. 149 unit tests and the 6 WhatsApp and follow-up browser tests pass; not yet re-confirmed in a real chat.

## WhatsApp messages in Marathi (2026-11-06)

Asked for: a Marathi button in "Send on WhatsApp", for Marathi-speaking members.

- **Switch:** the dialog has "English | मराठी" beside the message tabs. All three messages (welcome / membership, invoice, expiry reminder) exist in both languages, on the member page and on invoices.
- **Remembered:** the language used last is kept on this device (`localStorage`), so a desk that sends in Marathi does not switch every time. Edits are kept per message and per language.
- **What is translated:** the gym's own words and the month names ("6 नोव्हेंबर 2026"). Member names, plan names, invoice numbers and invoice line descriptions go as they are stored. Digits stay Latin so dates match the rupee amounts.
- **Upcoming expiries on Follow-ups (added the same day, on request):** each row has a second link, "मराठी", beside "WhatsApp"; it opens the same reminder in Marathi. Checked at 375 px: the row wraps, nothing overflows. The follow-ups browser tests (3) pass with the new assertions.
- **Not changed:** the app's own screens stay in English.

| Check | Result |
| --- | --- |
| Vitest | 154 passed (5 new: exact Marathi text of each message, all twelve months, Devanagari through the link) |
| Playwright: workflows, features, operations, members | 67 passed, including 1 new Marathi test (language switch on all three messages, per-language edits, choice remembered after reload and on an invoice). Two tests first failed because the new tab group and the text box were both named "Message"; the tab group was renamed. The money and shell suites were not run for this change |
| Desktop 1100 and phone 375 | Marathi dialog checked on screenshots; Devanagari renders, no horizontal overflow, no console errors |
| Not checked | the Marathi wording by a native speaker, and a real WhatsApp chat |
| Typecheck, build | clean |

## Google sign-in and Google Drive backup (2026-11-06)

Asked for: Google sign-in, backup and restore to the owner's Google Drive, a clear status, account isolation, change detection, a daily automatic backup, and a tested restore.

**Read this first.** Everything below marked PASS was tested against a **stand-in for Google** written for these tests (`src/test/fakeDrive.ts`, `e2e/google.ts`). No real Google account, sign-in window or Drive was used, because that needs an OAuth client ID that only the site owner can create (`docs/GOOGLE-DRIVE-SETUP.md`). So the app's own logic is tested; Google's side of every step is **NOT TESTED**. Reliable recovery from Google Drive must not be assumed until the "real Google" rows at the end have been run and passed.

**Update, 7 November 2026.** The client ID now exists and the "real Google" rows R1 to R3 were run once on the live site with the gym's own Google account: sign-in, one small upload and a restore in the same browser passed. Later the same day the gzip-compressed backup was also uploaded to and read back from real Google (see the volume section). Still **not** run against real Google: a restore onto an empty browser or another device, a backup over 5 MB, and a second Google account. Until the empty-device restore passes, recovery after a lost device should not be called proven.

### Design

- **Sign-in:** Google Identity Services, pop-up token flow, in the browser. No client secret exists. The access token is held in memory only and expires after about an hour; nothing about the session is written to storage.
- **Permission:** `https://www.googleapis.com/auth/drive.appdata` and nothing else. The account's email and id come from the Drive `about` call, so no profile or email scope is requested.
- **Isolation:** the hidden app folder is per Google account. In addition the browser remembers which account its data belongs to (`gymbook-drive-link` in localStorage, cleared with "Reset everything") and refuses to upload it anywhere else without an explicit yes.
- **File:** one `gymbook-backup.json` per account in the existing versioned backup format (`gymbook-backup`, version 1), updated in place. Photos travel inside the member records.
- **Change detection:** a SHA-256 of the records is stored on the file; equal fingerprints mean no upload.
- **Verification:** an upload counts only when Drive's reported size and MD5 equal what was sent. A restore is read back and compared store by store.
- **Guards before overwriting a backup:** other account, a backup this device's data did not come from, a backup replaced by another device, and a device with fewer than half the members of the backup. Each stops and asks.
- **Restore:** download → the existing validator (schema plus cross-record checks) → preview → confirmation → current data downloaded as a file → one transaction → read back.
- **Not built:** keeping older versions. Each backup replaces the one before; the screen says so.

### Scheduling: what is and is not possible

A scheduled backup while the app is closed is **not possible** in this design, for two separate reasons: the records exist only in the browser, so no server can read them, and a closed browser runs no code (and has no long-lived Google token without a server). Nothing in the app claims a schedule exists.

What was built instead: while GymBook is open, a backup runs two minutes after a change and on a 15-minute check, when the device is tied to the signed-in account and nothing needs a decision. After a reload the token is gone; the app tries once to get one without a click, and if Google or the browser refuses it shows a reminder ("Google Drive backup is out of date", with a one-tap "Back up now") once the last backup is a day old.

A backup that does not depend on the app being open needs the records on a server (for example Firebase with a scheduled function). Estimated cost at this size: free to about ₹100 a month; this was not priced against current rates and was not built.

### Files

New: `src/lib/google.ts`, `src/data/drive/{driveApi,driveBackup,driveController,driveState,md5}.ts`, `src/components/domain/DriveBackupSection.tsx`, `src/hooks/useDriveState.ts`, `src/test/fakeDrive.ts`, `src/data/drive/drive.test.ts`, `e2e/google.ts`, `e2e/explore/drive.spec.ts`, `docs/GOOGLE-DRIVE-SETUP.md`, `.env.example`.
Changed: `src/pages/Settings.tsx` (new section; file backup renamed "Backup file"; reset also forgets the Drive link), `src/app/Shell.tsx` (starts automatic backup; reminder), `.github/workflows/pages.yml` (passes `VITE_GOOGLE_CLIENT_ID`), `playwright.config.ts` (a made-up client ID for tests), `README.md`.

### Test phase

| # | Test | Result | Notes |
| --- | --- | --- | --- |
| 1 | Member with membership and photo created; present in IndexedDB | PASS | Browser test reads IndexedDB directly |
| 2 | Sign in, grant Drive permission, Back Up Now, upload confirmed, file and timestamp checked | PASS against the stand-in; **NOT TESTED with Google** | File content compared record for record with IndexedDB; the screen shows the time Drive reported |
| 3 | Change the member and back up again: the one file is replaced, no duplicates; unchanged data is not uploaded | PASS against the stand-in | Same file id, later time, one file; second press says "Already up to date" and makes no upload request |
| 4 | Clear local data, sign in to the same account, restore; member details and photo return | PASS against the stand-in; **NOT TESTED with Google** | Signing in offered the restore and did nothing by itself; restored records equal the originals including the photo |
| 5 | Different Google account cannot see or restore the first account's backup; the first account's data is not silently uploaded | PASS against the stand-in; **NOT TESTED with Google** | Isolation itself is Google's app-folder rule, which the stand-in only imitates; the app's refusal to upload was tested directly |
| 6a | Offline | PASS | "Could not reach Google Drive", previous backup and status unchanged |
| 6b | Drive permission revoked / sign-in expired | PASS against the stand-in | Reported, signed out, link to the account kept |
| 6c | Interrupted upload | PASS against the stand-in | One dropped connection is retried and completes; a connection that stays down is reported and the old file is intact |
| 6d | Invalid or damaged backup file | PASS | Not JSON, wrong format, wrong version, broken links between records: each refused, local data untouched |
| 6e | Quota error | PASS against the stand-in | "storage is full"; previous backup intact |
| 6f | Restore conflict (device has its own data) | PASS | Offer shows both choices; replacing the Drive backup needs a second confirmation; restoring downloads the current data first |
| 6g | Drive stores something different from what was sent | PASS against the stand-in | Reported as failed; last-backup time not advanced |
| 6h | Sign-in refused, permission box not ticked, pop-up blocked, window closed | PASS against the stand-in | Each has its own message |
| 7 | Daily schedule with the app closed | **FAIL by design / not possible** | With the page closed nothing was uploaded, as expected. While open: backup two minutes after a change (PASS); reminder and one-tap backup after reopening (PASS); silent backup after reopening when the sign-in is allowed without a click (PASS against the stand-in; whether real Google allows it is NOT TESTED) |
| 7b | Backend or scheduled-service alternative | NOT TESTED | Not built; see "Scheduling" |
| 8 | Another browser: sign in to the same account, restore, compare records and photo | PASS against the stand-in; **NOT TESTED with Google or on a second physical device** | A separate browser profile with no shared storage |
| 9 | Restore protects existing local data | PASS | The downloaded safety file was opened and holds the device's previous member; explicit confirmation required |
| R1 | Real Google sign-in window opens and returns a token for this site | **PASS** (7 Nov 2026, live site, Chrome on macOS) | The owner chose the gym's Google account in Google's own window; the page then showed that account's address. One earlier attempt ended with the window closed and the page correctly stayed "Not signed in" |
| R2 | Real Drive accepts the upload | **PASS for a small backup** (2 members, 39 KB, single request); **NOT TESTED over 5 MB** | The page reported "checked against what Google Drive stored" (size and MD5 from Drive against the local bytes). A second "Back up now" uploaded nothing and said "Already up to date". The upload-session path for large backups is still untried against Google |
| R3 | Real Drive download and end-to-end restore | **PASS in the same browser** (7 Nov 2026); **NOT TESTED on an empty browser or a second device** | "Restore…" fetched the file from Drive, validated it and showed 2 members, 1 plan, 2 memberships, 2 invoices, 2 payments, 2 visits. After "Replace my data" the page reported "Every record was read back and matches the backup". Independently, a SHA-256 fingerprint of every IndexedDB store was taken before and after: 17 of 18 stores were identical, and the activity log had exactly one new entry, "Restored backup exported …". The safety copy `gymbook-before-restore-2026-11-06-19-07-44.json` (42,899 bytes) was found in Downloads. Limits: the browser already held the same records, so this shows the restore path runs and writes correctly against Google, not that an empty device gets its data back; and finding an existing backup by listing the app folder after a fresh sign-in was not exercised (the file did not exist yet at sign-in) |
| R4 | Real second Google account sees nothing | **NOT TESTED** | |
| R5 | The Cloud Console steps as written | **PASS for the console part** (6 Nov 2026) | Project, Drive API and app name set by the owner; the `drive.appdata` scope, the web client with both origins and one test user were then added and read back from the console after a reload. The client ID is set as the repository variable and is in the deployed build; Google accepted a sign-in with it (row R1) |

| Check | Result |
| --- | --- |
| Vitest | 177 passed (23 new: checksums against Node's, backup, change detection, isolation, guards, restore, every failure) |
| Playwright, every suite | 123 passed (6 new Drive tests). On their first run 3 of the 6 failed on ambiguous locators in the tests; the app was not changed for them |
| After the last small change (no repeated sign-in attempts without a click) | unit tests and the 6 Drive browser tests re-run and passed; the other suites were not re-run |
| Desktop 1280 and phone 375 | Drive section checked on screenshots; no horizontal overflow |
| Site without a client ID | Settings shows "Not set up for this site yet"; nothing else changes |
| Typecheck, build | clean |

### Who can access the backup, and what it contains

Contents: every member (with photo and health notes), plan, membership, invoice, payment, visit, follow-up, workout plan, the activity log and the settings. Access: only someone signed in to the Google account that made it, through this site; GymBook itself has no server and no copy. It is not encrypted beyond what Google Drive does for every file.

## Full test run and volume test (2026-11-07)

Everything was run, then the app was loaded with made-up gyms of growing size to see what slows down and where it stops. The volume test is new: `npm run test:volume` (`e2e-volume/`), kept out of the normal run because one pass takes minutes and writes files of tens to hundreds of MB.

### How the volume test works

- `e2e-volume/generate.ts` writes a GymBook backup file for a made-up gym: members (named "Vol …"), 1 to 6 years of memberships, invoices, payments, visits and the activity log, with forty different real 256 px JPEG photos of about 14 KB each (the size the app itself stores).
- The file is imported through Settings → Import backup, the way a person would. From then on the test only does what a person does: opens each page, searches, adds a member with a plan, checks them in, records a payment, runs a year's report, exports CSVs and the backup, backs up to Google Drive and restores.
- It runs against the **production build** in a real Chrome profile folder. Times are measured inside the page, on every frame, from the start of the page load until the real content is on screen. "Slow phone" is the same computer with the processor slowed four times (Chrome's CPU throttle); it is an imitation, not a real phone.
- Google Drive is the same stand-in used by the other tests, reached over a local HTTP server so a backup of any size goes through a real network request. **No volume test touched real Google.**
- Correctness is checked, not only speed: the dashboard's active members, total members, visits today, people in the gym now and members who owe money must equal the numbers the generator knows to be true, and record counts are read from the database after every step.

### Sizes tested

| Size | Members | Visits | Activity lines | Backup file | Result |
| --- | --- | --- | --- | --- | --- |
| gym (ordinary gym, 2 years) | 300 | 14,695 | 16,567 | 12 MB | PASS |
| busy (about 100 visits a day, 3 years) | 1,500 | 84,312 | 94,012 | 64 MB | PASS |
| large (5 years) | 5,000 | 319,083 | 353,142 | 182 MB | PASS |
| xlarge (5 years) | 10,000 | 637,892 | 706,754 | 327 MB | PASS, but slow (below) |
| huge (6 years) | 20,000 | 1,323,388 | 1,463,071 | 635 MB | **Cannot be imported**: a browser cannot read a file over about 500 MB in one piece. The app now says so and changes nothing; before it said "not valid JSON" |

Dashboard numbers matched the generator exactly at every size that loaded (for example at 5,000 members: 674 active, 4,786 in total, 207 visits today, 112 in the gym, 1,525 owing money). No uncaught error appeared in the page at any size.

### What was slow, and what was changed

1. **Dates.** Every visit and payment was turned into a calendar date through the browser's date formatter, several times per page. `instantToDateInTz` now looks the timezone's offset up once per day and reuses it; days with a clock change still take the exact path. A new unit test compares it with the formatter every 37 minutes over three years in 13 timezones.
2. **Pages that never show visits read every visit.** Payments, Invoice, Plans, Follow-ups and Workouts now leave the visit store out; a member's page reads only that member's visits.
3. **Payments looked through every payment for every invoice.** Grouped once now (the same in the invoice CSV export).
4. **Opening the app with Drive backup on read and fingerprinted the whole database** to learn whether anything had changed. A counter that goes up on every saved change answers that now. As a side effect, a change saved while a backup is uploading is no longer forgotten.
5. **The Drive backup is gzip-compressed** before upload, after the compressed copy has been opened again and found identical. Plain backups made earlier are still read. Browsers without `CompressionStream` upload plain JSON as before.
6. **A backup file too large to read** gets an honest message (above).

### Page load, old build against new (seconds; same data, same computer)

| Page | 300 members | 1,500 | 5,000 | 5,000 on "slow phone" | 10,000 (new only) |
| --- | --- | --- | --- | --- | --- |
| Dashboard | 0.28 → 0.18 | 1.07 → 0.83 | 3.77 → 1.78 | 12.1 → 3.9 | 4.1 |
| Members | 0.49 → 0.49 | 0.84 → 0.82 | 1.89 → 1.89 | 3.4 → 3.1 | 3.7 |
| Member's page | 0.55 → 0.50 | 1.11 → 0.78 | 3.06 → 1.82 | 5.1 → 3.0 | 3.6 |
| Attendance | 0.57 → 0.52 | 1.15 → 0.86 | 3.09 → 2.04 | 7.8 → 4.1 | 3.7 |
| Payments | 0.48 → 0.45 | 1.01 → 0.55 | 4.37 → 0.76 | 12.8 → 1.4 | 1.1 |
| Invoice | 0.48 → 0.43 | 0.76 → 0.51 | 1.91 → 0.70 | 2.8 → 1.2 | 0.9 |
| Follow-ups | 0.48 → 0.43 | 0.84 → 0.54 | 1.87 → 0.73 | 3.3 → 1.4 | 1.0 |
| Reports | 0.54 → 0.51 | 1.11 → 0.85 | 3.05 → 1.95 | 7.9 → 4.0 | 3.8 |
| Activity | 0.46 → 0.46 | 0.71 → 0.71 | 1.80 → 1.70 | 3.1 → 3.4 | 3.3 |

Everyday actions on the new build (seconds): search by name or phone 0.01 at every size; check-in 0.02 / 0.04 / 0.07 / 0.09; record a payment 0.01 to 0.03; add a member with a plan and land on their page 0.14 / 0.67 / 1.58 / 3.16; a year's report 0.04 / 0.07 / 0.16 / 0.30 (was 1.14 at 5,000).

### Backup, export, restore (new build unless marked)

| | 300 | 1,500 | 5,000 | 10,000 |
| --- | --- | --- | --- | --- |
| Import the file | 3 s | 17 s | 67 s | 156 s |
| Export backup file | 0.5 s, 15 MB | 1.8 s, 80 MB | 5.5 s, 240 MB | 11.8 s, 444 MB |
| Drive backup: size uploaded, old → new | 12 → 4.5 MB | 64 → 23 MB | 182 → 44 MB | 62 MB |
| Drive backup: time, old → new | 1.4 → 1.3 s | 6.7 → 4.9 s | 51 → 12 s | 23 s |
| "Back up now" with nothing changed | 0.4 s | 1.8 s | 5.1 s | 15 s |
| Restore from Drive, read back and matched | 5 s | 24 s | 110 s | 283 s |
| App frozen in its first seconds with Drive on, old → new | 0.2 → 0 s | 1.4 → 0.2 s | 5.3 → 0.7 s | 1.6 s |
| Browser storage used | 31 MB | 141 MB | 417 MB | 572 MB |

### Still slow or limited (not changed)

- **Photos dominate the Drive backup.** Records shrink about ten times, photos do not: at 1,500 members with a photo each, 21 MB of the 23 MB is photos. The whole file is sent again on every automatic backup, which runs up to every 15 minutes while data is changing. On mobile data that is a lot. Two possible changes, not made because they alter how the backup behaves: back up automatically less often, or keep photos in a second Drive file that is sent only when a photo changes.
- Dashboard, Members, Attendance, Reports and Activity still read every visit or activity line; they take 2 to 4 s at 5,000 members and more on a slow device.
- The attendance CSV for a year takes 2.5 s at 1,500 members and 5.5 s at 5,000.
- A restore replaces everything in one transaction and reads it back, so it takes minutes at the largest sizes; the app is busy during it.
- The backup file must stay under about 500 MB to be imported, which was reached between 10,000 and 20,000 members with years of visits.
- During the first measurement, in a throw-away test window, a restore at 5,000 members stopped with "Browser storage is full" and correctly left the data unchanged. A throw-away window gets a small storage allowance; in a real profile folder the same restore passed. A device that is nearly out of space would see the same message.

### Results

| Check | Result |
| --- | --- |
| Vitest | 191 passed (14 new: compression against Node's gzip, compressed and plain backups restored, damaged compressed file refused, browser without compression, the change counter, date conversion against the formatter) |
| Playwright, every suite, after the last source change | 123 passed (15.6 min) |
| An earlier full run | 120 passed, 3 failed. The 3 were caused by this session: volume runs started in the middle cleared the shared trace folder. The volume test now has its own folder; the 3 passed when re-run, and the full run above is clean |
| Volume: gym, busy, large, xlarge on the new build | PASS |
| Volume: huge | Import refused with the size message; nothing changed (expected) |
| Typecheck, build | clean. Lint: no new warnings |
| Compressed backup against **real Google Drive** | **PASS, small backup** (7 Nov 2026, after deploying commit 707db06, live build `index-D_Nq1-94.js`, Chrome, premtc404@gmail.com). "Back up now" over the old plain 39 KB backup uploaded a compressed one of 25,820 bytes and the page reported "checked against what Google Drive stored" (size and MD5 from Drive). "Restore…" then downloaded that compressed file from Google, decoded and validated it, and previewed 2 members, 1 plan, 2 memberships, 2 invoices, 2 payments, 2 visits: the same counts as the data on the device. The preview was cancelled; "Replace my data" was not run again (the write-back path was already verified on 7 November with the plain file). The 25 KB versus 39 KB shrink is small because this backup is mostly two photos. **Still NOT TESTED with real Google:** a compressed backup over 5 MB (upload-session path), and a restore onto an empty browser or second device |
| Real phone | **NOT TESTED**. "Slow phone" numbers come from a slowed desktop processor |
| Safari and Firefox | **NOT TESTED** |
