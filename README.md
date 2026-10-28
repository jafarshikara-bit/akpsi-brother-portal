# AKPsi Brother Ledger

A brothers-only site for Alpha Kappa Psi: look up your dues, see upcoming payments, browse the social calendar, check attendance and points. An e-board section, behind its own password, shows the social budget and dues collections.

It runs as a Google Apps Script web app. It reads the dues sheet and the social calendar sheet live, and returns data only after a visitor enters the chapter password. The sheets stay private, and this repo holds code only, with no balances, sheet IDs or passwords.

## What reads from where

| Site section | Source |
| --- | --- |
| My dues | Dues sheet, `Status Sheet` tab (Name, Paid Social, Paid Nationals, Social Dues, National Dues, PC, Status) |
| Due dates, Venmo, pledge class rates | Dues sheet, `Information` tab |
| Social calendar | Calendar sheet, `August` through `December` tabs. Event categories come from the cell colors on the `Info Page` legend. |
| E-board: dues collected, who still owes | Computed from the paid boxes on the dues sheet |
| E-board: spending | Budget sheet (optional), first tab. Needs a header row with an item column (Chair, Line Item, Event, Item, Category or Expense) and a Budget/Planned column, a Spent/Actual column, or both. |
| Formal ticket and other extra payments | `CONFIG.PAYMENTS` in `Code.gs` |
| Attendance | Attendance sheet (optional). Grid tabs with "Attendance" in the name (`Chapter Attendance`, `Pledge Meeting Attendance`): a `Name` column, one `M/D` column per meeting, a 1 for present. A check-in puts a 1 in the grid whose name contains the event type's first word, adding the date column (before `Attendance Total`) or the brother's row if missing. The site also adds two log tabs, `Check-in Events` and `Check-ins`. With no sheet set, the first check-in creates one in the deploying account's Drive. |
| Points | Point tracker (optional). The tab with `Earned …` and `Total` columns (the `Mastersheet`) becomes the leaderboard. Category tabs (`Professional Points`, `Philanthropic Points`, `Other Points`), one column per activity like `Alumni Networking (1)`, give each brother's breakdown and the "Ways to earn points" list. Points set on QR check-ins are added on top. |

Paid status comes from the checkboxes. If a brother's `Status` column disagrees with the boxes, their statement says so and asks them to contact the treasurer.

## Deploy (about 5 minutes)

Use a Google account that can open all the sheets.

1. Go to [script.google.com](https://script.google.com) and click **New project**. Name it "AKPsi Brother Ledger".
2. Replace the contents of `Code.gs` with this repo's `Code.gs`.
3. Click **+** next to Files, choose **HTML**, name it `Index`, and paste in this repo's `Index.html`.
4. Open **Project Settings** (gear icon). Under **Script Properties**, add:
   - `CHAPTER_PASSWORD`: the chapter password
   - `DUES_SHEET_ID`: the long ID in the dues sheet's URL, between `/d/` and `/edit`
   - `CALENDAR_SHEET_ID`: the same for the calendar sheet
   - `EBOARD_PASSWORD`: a separate password for the E-board tab (budget and collections). Don't reuse the chapter password.
   - `BUDGET_SHEET_ID` (optional): the same for the budget sheet. To use an Excel file, upload it to Google Drive, open it, and choose **File → Save as Google Sheets** first. Add `BUDGET_TAB` too if the budget isn't on the first tab.

   - `OFFICER_PASSWORD` (for QR check-in): a separate password officers use to start a check-in. Don't reuse the chapter password.
   - `ATTENDANCE_SHEET_ID` (optional): the attendance sheet. Leave it out and the first check-in creates a new sheet and saves its ID here.
   - `POINTS_SHEET_ID` (optional): the roles and points sheet.

   You can paste either the ID or the whole sheet link.
5. Back in the editor, pick `testRead` in the function menu and click **Run**. Approve the permissions prompt. The log should show the number of brothers and events.
6. Click **Deploy → New deployment**, choose type **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy** and copy the web app URL. That's the link to share with brothers.

To ship changes later, paste the new code in and use **Deploy → Manage deployments → Edit → New version**. The URL stays the same.

## QR check-in

1. On the **Attendance** tab, open **Officers: run a check-in** and enter the officer password.
2. Fill in the event name, date, type, points for attending (0 if the points sheet already counts it), and how many hours check-in stays open. Click **Start check-in and show QR**.
3. Put the QR code on the projector. Brothers scan it with their phone camera, pick their name, and tap **Check in**. No chapter password needed; the code itself is the key, and it stops working when check-in closes.
4. The count and names update every 10 seconds. Add anyone without a phone by hand, and close check-in when the meeting starts.

Each phone can check in only one name per event. Type `Chapter meeting` marks the `Chapter Attendance` grid and `Pledge meeting` marks `Pledge Meeting Attendance`. Other types are logged on the `Check-ins` tab only.

## E-board section

The **E-board** tab shows the social budget, dues collected by pledge class, and the list of brothers who still owe. It asks for `EBOARD_PASSWORD`, and the server only sends budget data after checking it, so the chapter password can't load the budget even from the browser console. Change the password in Script Properties at any time.

Brothers using the chapter password still see their own dues and the full dues roster used for the name lookup, as before.

## Notes

- Data is cached for 5 minutes, so sheet edits show up within that window.
- A wrong password waits 1.5 seconds before answering, to slow down guessing. Change the password in Script Properties at any time. No redeploy needed.
- Pledge class rates and any fines are shown separately: anything above the class rate counts as fines.
