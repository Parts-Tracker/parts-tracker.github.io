# Parts Tracker

Tracks company-owned printer parts at customer sites. Each site has a QR code; scanning it opens the app for that site, where parts are booked in, recorded as used or customer-fitted, and counted.

- `backend/`: Google Apps Script, bound to the tracker Google Sheet. The Sheet is the database.
- `web/`: the phone app, a static site (hosted on GitHub Pages). Talks to the backend over HTTPS.
- `test/`: end-to-end test that runs the real backend on in-memory sheets, driven through the real app.

## Set up the backend (once)

1. Create a new Google Sheet called **Parts Tracker**.
2. In the Sheet: **Extensions → Apps Script**.
   - Rename `Code.gs` and paste in `backend/Code.gs`.
   - **+ → Script**, name it `Setup`, paste in `backend/Setup.gs`.
   - **Project Settings ⚙ → tick "Show appsscript.json"**, then paste `backend/appsscript.json` into that file.
3. Reload the Sheet. A **Parts Tracker** menu appears. Run **Set up sheets** and approve the permissions.
4. For a trial run: **Parts Tracker → Load sample data**. It adds 2 sites, 9 parts, an engineer (PIN 1111) and an admin (PIN 9999).
5. In Apps Script: **Deploy → New deployment → Web app**. Execute as **Me**, access **Anyone**. Copy the URL ending in `/exec`.

### If Extensions → Apps Script says "Sorry, unable to open the file at present"

This usually means the browser is signed into more than one Google account. Either open the Sheet in a private/incognito window signed into only the tracker account, or use a separate project:

1. Go to **script.google.com** (signed in as the account that owns the Sheet) → **New project**.
2. Add `Code.gs`, `Setup.gs` and `appsscript.json` as in step 2 above.
3. In `Code.gs`, paste the Sheet's ID into `SHEET_ID` (the part of the Sheet's address between `/d/` and `/edit`).
4. Choose **runSetup** in the function list next to **Run**, click **Run** and approve the permissions. Then run **runSampleData** for a trial. The menu items are also available as **runSiteTokens** and **runHashPins**; results show in the Execution log.
5. Deploy as in step 5 above.

## Set up the phone app

1. Paste the `/exec` URL into `web/config.js`.
2. Push to the `live` branch. GitHub Actions publishes the `web` folder to GitHub Pages: https://parts-tracker.github.io/
3. Open `https://parts-tracker.github.io/?admin`, sign in with the admin PIN, and print the QR codes.
4. Scan a site QR code with a phone.

## Real data

- **Sites tab**: paste Name, Address, Postcode, Contact, Phone. Then run **Parts Tracker → Give sites IDs and QR tokens**.
- **Printers tab**: one row per printer: SiteID (from the Sites tab), Model, Serial.
- **Users tab**: UserID (any short code), Name, Role (`engineer` or `admin`), PIN (4–8 digits), Active (`TRUE`). Then run **Parts Tracker → Secure new PINs**: PINs are replaced by a hash. Each PIN must be unique.
- **Parts tab**: fills itself as new parts are scanned. Check new parts' names and set **Reviewed** to `TRUE`.
- **Movements tab**: every scan. Never edit stock directly; a stock count corrects it.

To replace a lost or copied QR code, clear that site's Token and run **Give sites IDs and QR tokens**.

## Updating

- Backend: paste the new code, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
- App: bump `CACHE` in `web/sw.js` so phones pick up the change, commit, and push to `live`. Publishing takes about a minute.

## Testing

```
python3 -m http.server 8000
```
Open `http://localhost:8000/test/e2e.html`. It runs the whole flow and prints PASS/FAIL lines (also in `window.__result`).
