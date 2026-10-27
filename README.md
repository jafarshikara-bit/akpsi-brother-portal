# AKPsi Brother Ledger

A brothers-only site for Alpha Kappa Psi: look up your dues, see upcoming payments, browse the social calendar, and track how much dues money has come in.

It runs as a Google Apps Script web app. It reads the dues sheet and the social calendar sheet live, and returns data only after a visitor enters the chapter password. The sheets stay private, and this repo holds code only, with no balances, sheet IDs or passwords.

## What reads from where

| Site section | Source |
| --- | --- |
| My dues | Dues sheet, `Status Sheet` tab (Name, Paid Social, Paid Nationals, Social Dues, National Dues, PC, Status) |
| Due dates, Venmo, pledge class rates | Dues sheet, `Information` tab |
| Social calendar | Calendar sheet, `August` through `December` tabs. Event categories come from the cell colors on the `Info Page` legend. |
| Social budget | Computed from the paid boxes on the dues sheet |
| Formal ticket and other extra payments | `CONFIG.PAYMENTS` in `Code.gs` |

Paid status comes from the checkboxes. If a brother's `Status` column disagrees with the boxes, their statement says so and asks them to contact the treasurer.

## Deploy (about 5 minutes)

Use a Google account that can open both sheets.

1. Go to [script.google.com](https://script.google.com) and click **New project**. Name it "AKPsi Brother Ledger".
2. Replace the contents of `Code.gs` with this repo's `Code.gs`.
3. Click **+** next to Files, choose **HTML**, name it `Index`, and paste in this repo's `Index.html`.
4. Open **Project Settings** (gear icon). Under **Script Properties**, add:
   - `CHAPTER_PASSWORD`: the chapter password
   - `DUES_SHEET_ID`: the long ID in the dues sheet's URL, between `/d/` and `/edit`
   - `CALENDAR_SHEET_ID`: the same for the calendar sheet
5. Back in the editor, pick `testRead` in the function menu and click **Run**. Approve the permissions prompt. The log should show the number of brothers and events.
6. Click **Deploy → New deployment**, choose type **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy** and copy the web app URL. That's the link to share with brothers.

To ship changes later, paste the new code in and use **Deploy → Manage deployments → Edit → New version**. The URL stays the same.

## Notes

- Data is cached for 5 minutes, so sheet edits show up within that window.
- A wrong password waits 1.5 seconds before answering, to slow down guessing. Change the password in Script Properties at any time. No redeploy needed.
- Pledge class rates and any fines are shown separately: anything above the class rate counts as fines.
