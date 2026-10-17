# Parts Tracker

Tracks company-owned printer parts at customer sites and in engineers' vans. Each site has a QR code; scanning it opens the app for that site, where parts are booked in, recorded as used or customer-fitted, and counted. Signed-in engineers also get **My van** and can switch site without a QR code; admins get a dashboard at `?admin`.

- `backend/`: Google Apps Script, bound to the tracker Google Sheet. The Sheet is the database.
- `web/`: the phone app, a static site hosted on GitHub Pages. Talks to the backend over HTTPS, works offline (records wait on the phone and send when there is signal; on Android, even with the app closed).
- `test/`: end-to-end test that runs the real backend on in-memory sheets, driven through the real app. `sample-data.js` holds the test data; it is never part of the backend.

## Set up the backend (once)

1. Create a new Google Sheet called **Parts Tracker**.
2. In the Sheet: **Extensions → Apps Script**.
   - Rename `Code.gs` and paste in `backend/Code.gs`.
   - **+ → Script**, name it `Setup`, paste in `backend/Setup.gs`.
   - **Project Settings ⚙ → tick "Show appsscript.json"**, then paste `backend/appsscript.json` into that file.
3. Reload the Sheet. A **Parts Tracker** menu appears. Run **Set up sheets** and approve the permissions.
4. In Apps Script: **Deploy → New deployment → Web app**. Execute as **Me**, access **Anyone**. Copy the URL ending in `/exec`.

### If Extensions → Apps Script says "Sorry, unable to open the file at present"

The browser is signed into more than one Google account. Open the Sheet in a private/incognito window signed into only the tracker account, or use a separate project:

1. Go to **script.google.com** (signed in as the account that owns the Sheet) → **New project**.
2. Add `Code.gs`, `Setup.gs` and `appsscript.json` as in step 2 above.
3. In `Code.gs`, paste the Sheet's ID into `SHEET_ID` (the part of the Sheet's address between `/d/` and `/edit`).
4. Choose **runSetup** in the function list next to **Run**, click **Run** and approve the permissions. The menu items are also available as **runSiteTokens** and **runHashPins**; results show in the Execution log.
5. Deploy as in step 4 above.

## Set up the phone app

1. Paste the `/exec` URL into `web/config.js`.
2. Push to the `live` branch. GitHub Actions publishes the `web` folder to GitHub Pages: https://parts-tracker.github.io/
3. Open `https://parts-tracker.github.io/?admin`, sign in with an admin PIN, and print the QR codes.

## The Sheet

Columns are found by their heading, so they can be moved, and unused ones deleted.

- **Sites**: Name, Address (town), Postcode. No customer contact details are kept. Run **Parts Tracker → Give sites IDs and QR tokens** after adding sites (admins can also add sites in the app). To replace a lost or copied QR code, clear that site's Token and run it again.
- **Printers**: one row per machine: SiteID, Model, Serial. Type `TRUE` under **No kit** for a machine with no Up Time Kit (e.g. a training machine).
- **Users**: UserID, Name, Role (`engineer` or `admin`), PIN (4–8 digits, unique), Active (`TRUE`), and Email, Postcode and ByBox for the order forms. Then run **Parts Tracker → Secure new PINs**: PINs are replaced by a hash.
- **Parts**: fills itself as new parts are scanned. Check new parts' names (or approve them in the app's admin page).
- **Kits** (Model, Part Number, Qty) and **VanKit** (Part Number, Min, Max). Their Name column is a lookup from Parts.
- **Settings**: the daily kit email and order form values, and the archive settings. Each row has a note.
- **Movements**: every record. **Stock is worked out from these rows: never edit or delete them.** A stock count corrects stock; `archiveMovements` (below) keeps the tab small. The tab has a warning protection, and setup refuses to recreate it if it goes missing. Restore it from **File → Version history** instead.

## Tasks run from the Apps Script editor

Pick the function next to **Run**, click **Run**, and read the Execution log.

| Function | What it does |
|---|---|
| `runSetup` | Creates missing tabs, columns and settings; protects Movements. Safe to run again. |
| `installDailyReport` | Turns on the daily Up Time Kit email at the Settings tab's ReportHour (run again after changing the hour). `removeDailyReport` turns it off; `testDailyKitReport` sends a test now. |
| `previewKitStock` / `fillKitStock` | Shows / adds an assumed full Up Time Kit for every kit machine at open sites (one kit per machine, topped up, never doubled). |
| `previewArchive` / `archiveMovements` | Shows / moves movements older than ArchiveKeepDays to an archive spreadsheet, replaced by carried-forward totals. Checks every stock level is unchanged. |
| `runSiteTokens`, `runHashPins` | The same as the Sheet menu items. |

## Updating

- Backend: paste the new code, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
- App: bump `CACHE` in `web/sw.js` so phones pick up the change, commit, and push to `live`. Publishing takes about a minute.

## Testing

```
python3 -m http.server 8000
```
Open `http://localhost:8000/test/e2e.html`. It runs the whole flow and prints PASS/FAIL lines (also in `window.__result`).
