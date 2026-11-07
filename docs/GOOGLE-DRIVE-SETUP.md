# Google Drive backup: one-time setup

Google Drive backup stays switched off until the site is given a **Google OAuth client ID**. Creating one is free and takes about ten minutes. It has to be done by the gym owner (or whoever runs the site), signed in to their own Google account, because Google ties the client to that account.

Nothing secret is involved. The client ID is a public identifier; the app has no client secret, API key or stored token.

> The names of Google Cloud Console pages change from time to time. These steps were carried out in a real console on 6 November 2026 and again on 7 November 2026 for this site (project `GymBook`, id `gymbook-514006`, owned by the gym's Google account khetrirajan55@gmail.com). At that time the console called the pages *Google Auth Platform* → *Branding*, *Audience*, *Data Access* and *Clients*; a label may differ slightly from what you see later.

## What you will end up with

| Value | Example | Where it goes |
| --- | --- | --- |
| OAuth client ID | `1234567890-abc123.apps.googleusercontent.com` | GitHub repository variable `VITE_GOOGLE_CLIENT_ID` |

## Steps in Google Cloud Console

1. Open <https://console.cloud.google.com/> and sign in with the Google account that should own the setup.
2. **Create a project.** Project picker at the top → *New project* → name it `GymBook` → *Create*. Make sure it is selected.
3. **Enable the Drive API.** *APIs & Services* → *Library* → search for **Google Drive API** → *Enable*.
4. **Set up the consent screen.** *APIs & Services* → *OAuth consent screen* (newer consoles call this *Google Auth Platform* → *Branding* and *Audience*).
   - User type: **External**.
   - App name: `GymBook`. User support email and developer contact: your own email.
   - Audience: leave it in **Testing** and add, under *Test users*, every Gmail address that will sign in (the owner's, and any staff account that should back up). Only listed test users can sign in while the app is in Testing.
   - Later you can press *Publish app* so any Google account can sign in. The one permission GymBook asks for is on Google's list of non-sensitive scopes, which normally do not need Google's verification review; that was not confirmed in a console here.
5. **Add the permission (scope).** *Data access* (or *Scopes*) → *Add or remove scopes* → paste this one scope and save:

   ```
   https://www.googleapis.com/auth/drive.appdata
   ```

   It lets GymBook read and write only its own hidden folder in the signed-in person's Drive. Do not add any other Drive scope.
6. **Create the client.** *APIs & Services* → *Credentials* (or *Google Auth Platform* → *Clients*) → *Create credentials* → *OAuth client ID*.
   - Application type: **Web application**. Name: `GymBook web`.
   - **Authorized JavaScript origins**, add both, exactly, with no path and no trailing slash:

     ```
     https://khetrirajan55-tech.github.io
     http://localhost:5173
     ```

     The first is the live site; the second is only for trying it on the developer's own machine. If the site ever moves to another address, add that address here too.
   - **Authorized redirect URIs: leave empty.** GymBook signs in through Google's pop-up window, which does not use a redirect address.
   - *Create*, then copy the **Client ID**. Google also shows a *client secret*: GymBook does not use it. Do not copy it anywhere.

## Give the client ID to the site

Either:

- GitHub → the `gymbook` repository → *Settings* → *Secrets and variables* → *Actions* → **Variables** tab → *New repository variable* → name `VITE_GOOGLE_CLIENT_ID`, value the client ID → then *Actions* → *Deploy to GitHub Pages* → *Run workflow*; or
- from a terminal in the project:

  ```bash
  gh variable set VITE_GOOGLE_CLIENT_ID --body "PASTE-CLIENT-ID-HERE"
  ```

  ```bash
  gh workflow run pages.yml
  ```

It is a *variable*, not a *secret*, on purpose: the value ends up in the public website anyway, and Google only accepts it from the origins listed in step 6.

To try it locally, copy `.env.example` to `.env.local`, put the client ID after `VITE_GOOGLE_CLIENT_ID=`, and restart the dev server.

## Check that it works

1. Open the site → *Settings* → **Google Drive backup**. It should now show a *Sign in with Google* button instead of "Not set up".
2. Sign in, tick the Drive permission if Google shows a checkbox, then *Back up now*. The page should say "Backup saved to Google Drive … checked against what Google Drive stored".
3. In Google Drive → ⚙ *Settings* → *Manage apps*, **GymBook** should be listed with "hidden app data". The file itself is not shown in My Drive; that is how the hidden app folder works.

## If something goes wrong

| What you see | Likely cause |
| --- | --- |
| Google says "Access blocked: this app's request is invalid" or `origin_mismatch` | The site's address is missing from *Authorized JavaScript origins*, or has a trailing slash or a path |
| Google says "Access blocked: GymBook has not completed the Google verification process" | The app is in Testing and this Gmail address is not in *Test users* |
| "The Google Drive permission was not ticked" | Google showed a checkbox for Drive access and it was left empty; sign in again and tick it |
| "The browser blocked the Google sign-in window" | Allow pop-ups for the site |
| Settings still says "Not set up" | The variable name is misspelt, or the site was not redeployed after adding it |

## What the backup is, and who can reach it

- **Contents:** one file, `gymbook-backup.json`, holding every member (with photo), plan, membership, invoice, payment, visit, follow-up, workout plan, the activity log and the settings. It is the same data as *Export backup* in Settings, gzip-compressed to save upload data and Drive space (records shrink to about a tenth; photos barely shrink). GymBook opens it itself on restore; backups made before compression was added are still read.
- **Where:** the hidden app folder of the Google account that signed in. Each Google account has its own; one account cannot list or read another's.
- **Who can read it:** only someone signed in to that Google account, through this GymBook site. GymBook cannot see any other file in the Drive.
- **One copy:** each backup replaces the one before. Older versions are not kept.
- **Deleting it:** GymBook never deletes it. To remove it, use Google Drive → *Settings* → *Manage apps* → GymBook → *Delete hidden app data*. To remove GymBook's access, use *Disconnect* in GymBook's Settings or <https://myaccount.google.com/permissions>.

## What it costs

Nothing for this setup: the Drive API has no charge at this volume, the Google Cloud project needs no billing account, and the backup uses the account's own Drive storage (a few hundred KB without photos; roughly 15 to 25 KB more per member photo).

## What it cannot do

The backup runs in the browser. It runs a couple of minutes after a change while GymBook is open and signed in; it **cannot run while GymBook is closed**. A server cannot do it instead, because the records exist only in the browser. If a real daily backup that does not depend on the app being open is needed, the records would have to live on a server (for example Firebase): a different design, with its own cost (likely free to about ₹100 a month at this size; not priced precisely here).
