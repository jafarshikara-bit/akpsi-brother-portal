/**
 * AKPsi Brother Ledger — Google Apps Script web app.
 *
 * Reads the dues sheet and the social calendar sheet live, and only returns
 * data to a visitor who enters the chapter password. Nothing is published.
 * Setup steps are in README.md.
 */

// Sheet IDs and the password live in Script Properties (Project Settings), not in
// this public repo. Keys: CHAPTER_PASSWORD, DUES_SHEET_ID, CALENDAR_SHEET_ID,
// and optionally BUDGET_SHEET_ID, OFFICER_PASSWORD, ATTENDANCE_SHEET_ID and
// POINTS_SHEET_ID. A sheet ID or its full link both work.
const PROPS = PropertiesService.getScriptProperties();
const CODE_VERSION = 'v6';

function sheetId_(key) {
  // Accepts a bare ID, a full link, or a partial one like "ID/edit?gid=0".
  const v = String(PROPS.getProperty(key) || '').trim();
  const m = v.match(/\/d\/([\w-]{20,})/) || v.match(/([\w-]{25,})/);
  return m ? m[1] : null;
}

const CONFIG = {
  DUES_SHEET_ID: sheetId_('DUES_SHEET_ID'),
  DUES_TAB: 'Status Sheet',
  DUES_INFO_TAB: 'Information',
  CALENDAR_SHEET_ID: sheetId_('CALENDAR_SHEET_ID'),
  BUDGET_SHEET_ID: sheetId_('BUDGET_SHEET_ID'),
  CALENDAR_LEGEND_TAB: 'Info Page',
  CALENDAR_MONTHS: ['August', 'September', 'October', 'November', 'December'],
  YEAR: 2026,
  TERM: 'Fall 2026',
  TREASURER: 'Daniel Roupas',
  FINES_CONTACT: 'Lexie',
  // Extra payments brothers may be asked for. amount/due null shows as TBD.
  PAYMENTS: [
    { name: 'Formal ticket', detail: 'Formal is Saturday, Dec 5.', amount: null, due: null, required: false },
  ],
  CACHE_SECONDS: 300,
};

function doGet(e) {
  const page = HtmlService.createTemplateFromFile('Index');
  // A scanned check-in QR opens the site with ?checkin=<code>.
  page.checkin = String((e && e.parameter && e.parameter.checkin) || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
  return page
    .evaluate()
    .setTitle('AKPsi Brother Ledger')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Called from the page. Returns all site data, or throws if the password is wrong. */
function getData(password) {
  const expected = PROPS.getProperty('CHAPTER_PASSWORD');
  if (!expected) throw new Error('The site has no chapter password set yet. Ask the VP of Finance.');
  if (String(password || '').trim() !== expected) {
    Utilities.sleep(1500); // slow down guessing
    throw new Error('That password is not right.');
  }
  // Key the cache on the sheet settings so changing a link takes effect right away.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'data:' + [CONFIG.DUES_SHEET_ID, CONFIG.CALENDAR_SHEET_ID, CONFIG.BUDGET_SHEET_ID, PROPS.getProperty('BUDGET_TAB'), PROPS.getProperty('POINTS_SHEET_ID')].join('|');
  const hit = cache.get(cacheKey);
  if (hit) return withAttendance_(JSON.parse(hit));

  const data = {
    term: CONFIG.TERM,
    treasurer: CONFIG.TREASURER,
    finesContact: CONFIG.FINES_CONTACT,
    duesSheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.DUES_SHEET_ID + '/edit',
    calendarSheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.CALENDAR_SHEET_ID + '/edit',
    payments: CONFIG.PAYMENTS,
    updated: new Date().toISOString(),
  };
  if (!CONFIG.DUES_SHEET_ID || !CONFIG.CALENDAR_SHEET_ID) throw new Error('The site is missing its sheet links. Ask the VP of Finance to finish setup.');
  const duesBook = SpreadsheetApp.openById(CONFIG.DUES_SHEET_ID);
  data.brothers = readDues_(duesBook);
  data.info = readDuesInfo_(duesBook);
  data.events = readCalendar_(SpreadsheetApp.openById(CONFIG.CALENDAR_SHEET_ID));
  data.budget = CONFIG.BUDGET_SHEET_ID ? readBudgetSafely_(CONFIG.BUDGET_SHEET_ID) : null;
  if (data.budget) data.budgetSheetUrl = 'https://docs.google.com/spreadsheets/d/' + CONFIG.BUDGET_SHEET_ID + '/edit';
  const pointsId = sheetId_('POINTS_SHEET_ID');
  data.points = pointsId ? readPointsSafely_(pointsId) : null;
  if (data.points) data.pointsSheetUrl = 'https://docs.google.com/spreadsheets/d/' + pointsId + '/edit';

  cache.put(cacheKey, JSON.stringify(data), CONFIG.CACHE_SECONDS);
  return withAttendance_(data);
}

/** Attendance changes during a meeting, so it is read fresh instead of cached. */
function withAttendance_(data) {
  try {
    const book = attendanceBook_(false);
    data.attendance = book ? readAttendance_(book) : null;
  } catch (e) {
    data.attendance = { events: [], checkins: [], error: 'The attendance sheet could not be opened. Check ATTENDANCE_SHEET_ID.' };
  }
  return data;
}

function readDues_(book) {
  const rows = book.getSheetByName(CONFIG.DUES_TAB).getDataRange().getValues();
  const head = rows.shift().map(h => String(h).trim().toLowerCase());
  const col = name => head.indexOf(name);
  const c = {
    name: col('name'), paidSocial: col('paid social'), paidNat: col('paid nationals'),
    social: col('social dues'), nat: col('national dues'), pc: col('pc'), status: col('status'),
  };
  return rows
    .filter(r => String(r[c.name]).trim())
    .map(r => ({
      name: String(r[c.name]).trim(),
      paidSocial: r[c.paidSocial] === true,
      paidNat: r[c.paidNat] === true,
      social: toNumber_(r[c.social]),
      nat: toNumber_(r[c.nat]),
      pc: String(r[c.pc]).trim(),
      sheetComplete: String(r[c.status]).trim().toLowerCase() === 'complete',
    }));
}

/** Pulls due dates, Venmo handle and per-pledge-class rates from the Information tab. */
function readDuesInfo_(book) {
  const info = { socialDue: null, nationalDue: null, venmo: null, rates: {} };
  const sheet = book.getSheetByName(CONFIG.DUES_INFO_TAB);
  if (!sheet) return info;
  sheet.getDataRange().getDisplayValues().forEach(row => {
    const line = row.join(' ').replace(/\s+/g, ' ').trim();
    let m;
    if ((m = line.match(/National Due (\d{1,2})\/(\d{1,2})/i))) info.nationalDue = isoDate_(m[1], m[2]);
    if ((m = line.match(/Social Due (\d{1,2})\/(\d{1,2})/i))) info.socialDue = isoDate_(m[1], m[2]);
    if ((m = line.match(/Venmo:?\s*(@\S+)/i))) info.venmo = m[1];
    if ((m = line.match(/\((Z[A-Z])\)\s*\$(\d+(?:\.\d+)?)/))) info.rates[m[1]] = Number(m[2]);
  });
  return info;
}

/**
 * Month tabs are a grid: B..H are Sun..Sat, a row of day numbers is followed by
 * a row of event names. Event cell colors match the legend on the Info Page tab.
 */
function readCalendar_(book) {
  const legend = readLegend_(book);
  const events = [];
  CONFIG.CALENDAR_MONTHS.forEach(monthName => {
    const sheet = book.getSheetByName(monthName);
    if (!sheet) return;
    const month = new Date(monthName + ' 1, ' + CONFIG.YEAR).getMonth();
    const range = sheet.getRange(1, 2, sheet.getMaxRows(), 7); // B..H
    const values = range.getDisplayValues();
    const colors = range.getBackgrounds();
    const merges = range.getMergedRanges();

    for (let r = 0; r < values.length - 1; r++) {
      // A day-number row: every filled cell starts with a number ("14", "26🎂").
      const filled = values[r].map(v => String(v).trim()).filter(Boolean);
      if (!filled.length || !filled.every(v => /^\d{1,2}(\D|$)/.test(v))) continue;
      const days = values[r].map(v => (String(v).match(/^\s*(\d{1,2})/) || [])[1]);
      for (let c = 0; c < 7; c++) {
        const text = String(values[r + 1][c] || '').trim();
        if (!days[c] || !text || /^\d{1,2}\D?$/.test(text)) continue;
        // A merged event cell spans several days; record its last day too.
        let endDay = null;
        const merge = merges.find(m => m.getRow() === r + 2 && m.getColumn() === c + 2);
        if (merge && merge.getNumColumns() > 1) endDay = days[c + merge.getNumColumns() - 1] || null;
        const bg = (colors[r + 1][c] || '').toLowerCase();
        splitEvents_(text).forEach(name => {
          events.push({
            date: isoDate_(month + 1, days[c]),
            end: endDay ? isoDate_(month + 1, endDay) : null,
            name: name,
            category: legend[bg] || null,
          });
        });
      }
      r++; // skip the event row we just read
    }
  });
  return events;
}

/**
 * A cell can hold several events on separate lines ("Chapter 3" / "Mental Health Walk"),
 * but long names also wrap onto a new line ("Buffalo" / "Tailgate"). One-word lines
 * are treated as part of the name around them.
 */
function splitEvents_(text) {
  const parts = text.split(/\n+|\s{3,}/).map(s => s.trim()).filter(Boolean);
  const out = [];
  parts.forEach(p => {
    if (out.length && (p.split(/\s+/).length === 1 || out[out.length - 1].split(/\s+/).length === 1)) out[out.length - 1] += ' ' + p;
    else out.push(p);
  });
  return out.map(s => s.replace(/\s+/g, ' '));
}

function readLegend_(book) {
  const legend = {};
  const sheet = book.getSheetByName(CONFIG.CALENDAR_LEGEND_TAB);
  if (!sheet) return legend;
  const range = sheet.getRange(1, 1, Math.min(sheet.getMaxRows(), 20), 1);
  const values = range.getDisplayValues();
  const colors = range.getBackgrounds();
  values.forEach((row, i) => {
    const label = String(row[0]).trim();
    const bg = (colors[i][0] || '').toLowerCase();
    if (label && bg && bg !== '#ffffff' && !/colors/i.test(label)) legend[bg] = label;
  });
  return legend;
}

/** A broken budget link shouldn't take down the rest of the site. */
function readBudgetSafely_(id) {
  try {
    return readBudget_(SpreadsheetApp.openById(id));
  } catch (e) {
    // An uploaded .xlsx has a Drive ID but can't be opened as a spreadsheet.
    return { lines: [], error: 'The budget sheet could not be opened. If it is an Excel file, open it in Google Drive, choose File, Save as Google Sheets, and use the new link for BUDGET_SHEET_ID.' };
  }
}

/**
 * Budget sheet: on the first tab, finds a header row with an item column
 * (Event / Item / Category / Line item) and money columns (Budget / Planned /
 * Allocated and Spent / Actual). Rows below it become budget lines. Set
 * BUDGET_TAB in Script Properties to read a different tab.
 */
function readBudget_(book) {
  const tabName = PROPS.getProperty('BUDGET_TAB');
  const sheet = (tabName && book.getSheetByName(tabName)) || book.getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  const clean = h => String(h).replace(/\s+/g, ' ').trim();
  const find = (head, re) => head.findIndex(h => re.test(clean(h)));
  const itemRe = /^(chair|event|item|category|expense|description|name|line)\b|line item/i;
  // First look for a header row with a recognizable item column, then accept any header row.
  const candidates = [];
  for (let r = 0; r < Math.min(rows.length, 40); r++) candidates.push(r);
  const ordered = candidates.filter(r => find(rows[r], itemRe) >= 0).concat(candidates);
  for (const r of ordered) {
    const head = rows[r];
    const planned = find(head, /^(?!total).*(budget|planned|allot|allocated|projected|estimate)/i);
    const spent = find(head, /spent|actual|cost to date/i);
    if (planned < 0 && spent < 0) continue;
    // Needs to look like a header row: at least 3 text labels and no money in it.
    const labels = head.filter(h => typeof h === 'string' && clean(h));
    if (labels.length < 3 || head.some(h => typeof h === 'number')) continue;
    let item = find(head, itemRe);
    if (item < 0) item = head.findIndex(h => typeof h === 'string' && clean(h)); // first labelled column
    const cat = find(head, /^(category|type)\b|holder|owner/i);
    const lines = [];
    for (let i = r + 1; i < rows.length; i++) {
      const name = clean(rows[i][item]);
      if (!name) continue;
      if (/^total/i.test(name)) break;
      const p = planned >= 0 ? toNumber_(rows[i][planned]) : null;
      const a = spent >= 0 ? toNumber_(rows[i][spent]) : null;
      if (!p && !a) continue;
      lines.push({ name: name, category: cat >= 0 && cat !== item ? clean(rows[i][cat]) : '', planned: p, spent: a });
    }
    return { tab: sheet.getName(), lines: lines, hasPlanned: planned >= 0, hasSpent: spent >= 0 };
  }
  return { tab: sheet.getName(), lines: [], error: 'Could not find the budget table on the "' + sheet.getName() + '" tab. Expected a header row with a Budget or Spent column. (' + CODE_VERSION + ')' };
}

// ---- Attendance (QR check-in) ----
// Officers open a check-in for a meeting or event and show its QR code. Brothers
// scan it, pick their name, and a row lands on the attendance sheet's Check-ins tab.
// The site adds two log tabs to the attendance sheet. A check-in also puts a 1 in
// the matching attendance grid ("Chapter Attendance" for type Chapter meeting,
// "Pledge Meeting Attendance" for Pledge meeting) under that date's column,
// adding the column or the brother's row if missing. Other tabs are left alone.
// With no ATTENDANCE_SHEET_ID set, the first check-in creates a new sheet.
const ATT = {
  EVENTS_TAB: 'Check-in Events',
  CHECKINS_TAB: 'Check-ins',
  EVENT_HEAD: ['ID', 'Code', 'Event', 'Date', 'Type', 'Points', 'Closes', 'Created'],
  CHECKIN_HEAD: ['Timestamp', 'Event ID', 'Event', 'Name', 'Method', 'Device'],
  DEFAULT_HOURS: 3,
};

function attendanceBook_(create) {
  const id = sheetId_('ATTENDANCE_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  if (!create) return null;
  const book = SpreadsheetApp.create('AKPsi Attendance · ' + CONFIG.TERM);
  PROPS.setProperty('ATTENDANCE_SHEET_ID', book.getId());
  return book;
}

function attTab_(book, name, head) {
  let sheet = book.getSheetByName(name);
  if (sheet) return sheet;
  sheet = book.insertSheet(name);
  sheet.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  // A brand-new spreadsheet comes with an empty Sheet1.
  const blank = book.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && book.getSheets().length > 1) book.deleteSheet(blank);
  return sheet;
}

function isoIn_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : String(v);
}

function readAttEvents_(book) {
  const sheet = book.getSheetByName(ATT.EVENTS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const tz = book.getSpreadsheetTimeZone();
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ATT.EVENT_HEAD.length).getValues()
    .map((r, i) => ({
      row: i + 2, id: String(r[0]), code: String(r[1]), name: String(r[2]), date: isoIn_(r[3], tz),
      type: String(r[4]), points: toNumber_(r[5]), closes: r[6] instanceof Date ? r[6] : null,
    }))
    .filter(e => e.id && e.code);
}

function readAttCheckins_(book) {
  const sheet = book.getSheetByName(ATT.CHECKINS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ATT.CHECKIN_HEAD.length).getValues()
    .filter(r => r[1] && r[3])
    .map(r => ({ time: r[0], eventId: String(r[1]), name: String(r[3]).trim(), method: String(r[4]), device: String(r[5]) }));
}

/** What every brother sees: events (without their codes), who checked in, and the attendance grids. */
function readAttendance_(book) {
  return {
    events: readAttEvents_(book).map(e => ({ id: e.id, name: e.name, date: e.date, type: e.type, points: e.points })),
    checkins: readAttCheckins_(book).map(c => ({ e: c.eventId, n: c.name })),
    grids: book.getSheets().filter(sh => /attendance/i.test(sh.getName())).map(readGrid_).filter(Boolean),
    sheetUrl: book.getUrl(),
  };
}

// ---- Attendance grids (one row per brother, one column per date, 1 = present) ----
const NAME_HEAD = /^(name|brother|brother name|full name)$/i;
const cellText_ = v => String(v).replace(/\s+/g, ' ').trim();
/** "Last, First" and "First Last" give the same key. */
const personKey_ = n => {
  n = String(n);
  if (n.includes(',')) n = n.split(',').map(x => x.trim()).reverse().join(' ');
  return n.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
};
const dateHead_ = h => { const m = cellText_(h).match(/^(\d{1,2})\/(\d{1,2})\b/); return m ? [Number(m[1]), Number(m[2])] : null; };

function nameHeaderRow_(values) {
  for (let r = 0; r < Math.min(values.length, 10); r++) if (values[r].some(v => NAME_HEAD.test(cellText_(v)))) return r;
  return -1;
}

function readGrid_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  const h = nameHeaderRow_(values);
  if (h < 0) return null;
  const head = values[h].map(cellText_);
  const nameCol = head.findIndex(x => NAME_HEAD.test(x));
  const dateCols = head.map((x, c) => dateHead_(x) ? c : -1).filter(c => c >= 0);
  const marked = v => { v = cellText_(v).toLowerCase(); return v !== '' && v !== '0' && v !== 'false' && v !== 'no'; };
  return {
    tab: sheet.getName(),
    dates: dateCols.map(c => { const [m, d] = dateHead_(head[c]); return isoDate_(m, d); }),
    rows: values.slice(h + 1).filter(r => cellText_(r[nameCol]))
      .map(r => ({ name: cellText_(r[nameCol]), marks: dateCols.map(c => marked(r[c])) })),
  };
}

/** The grid tab for an event type: "Chapter meeting" -> a tab named like "Chapter Attendance". */
function gridFor_(book, type) {
  const word = String(type || '').trim().split(/\s+/)[0].toLowerCase();
  if (!word) return null;
  return book.getSheets().find(sh => /attendance/i.test(sh.getName()) && sh.getName().toLowerCase().includes(word)) || null;
}

/** Put a 1 in the grid for this event's date and this brother. Adds the date column or name row if missing. */
function markGrid_(book, ev, display) {
  const sheet = gridFor_(book, ev.type);
  if (!sheet) return;
  let values = sheet.getDataRange().getDisplayValues();
  const h = nameHeaderRow_(values);
  if (h < 0) return;
  let head = values[h].map(cellText_);
  const nameCol = head.findIndex(x => NAME_HEAD.test(x));
  const [, m, d] = ev.date.split('-').map(Number);
  const findCol = () => head.findIndex(x => { const md = dateHead_(x); return md && md[0] === m && md[1] === d; });
  if (findCol() < 0) {
    addDateColumn_(sheet, h, head, m + '/' + d);
    values = sheet.getDataRange().getDisplayValues();
    head = values[h].map(cellText_);
  }
  const col = findCol();
  let row = values.findIndex((r, i) => i > h && personKey_(r[nameCol]) === personKey_(display));
  if (row < 0) row = addNameRow_(sheet, values, h, nameCol, head, display);
  sheet.getRange(row + 1, col + 1).setValue(1);
}

function addDateColumn_(sheet, h, head, label) {
  const total = head.findIndex(x => /total/i.test(x));
  const dateCols = head.map((x, c) => dateHead_(x) ? c : -1).filter(c => c >= 0);
  const at = total >= 0 ? total : (dateCols.length ? dateCols[dateCols.length - 1] + 1 : head.length); // 0-based
  if (at < sheet.getMaxColumns()) sheet.insertColumnBefore(at + 1); else sheet.insertColumnAfter(at);
  const rows = sheet.getMaxRows() - h;
  if (at > 0) {
    // Same look and dropdowns as the column to its left.
    const left = sheet.getRange(h + 1, at, rows, 1), mine = sheet.getRange(h + 1, at + 1, rows, 1);
    left.copyTo(mine, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    left.copyTo(mine, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  sheet.getRange(h + 1, at + 1).setValue(label);
  // Inserting just before the total column leaves it out of each row's SUM, so widen the SUMs.
  if (total >= 0 && dateCols.length) {
    const totalCol = sheet.getRange(h + 2, total + 2, sheet.getMaxRows() - h - 1, 1);
    const span = (total + 1) - dateCols[0];
    totalCol.setFormulasR1C1(totalCol.getFormulasR1C1().map(([f]) => [/^=SUM\(/i.test(f) ? '=SUM(RC[-' + span + ']:RC[-1])' : f]));
  }
}

function addNameRow_(sheet, values, h, nameCol, head, display) {
  let last = h;
  values.forEach((r, i) => { if (i > h && cellText_(r[nameCol])) last = i; });
  sheet.insertRowAfter(last + 1);
  const width = sheet.getMaxColumns();
  sheet.getRange(last + 1, 1, 1, width).copyTo(sheet.getRange(last + 2, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sheet.getRange(last + 1, 1, 1, width).copyTo(sheet.getRange(last + 2, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  const total = head.findIndex(x => /total/i.test(x));
  if (total >= 0 && last > h) sheet.getRange(last + 1, total + 1).copyTo(sheet.getRange(last + 2, total + 1));
  sheet.getRange(last + 2, nameCol + 1).setValue(duesNameFor_(display));
  return last + 1;
}

/** The dues sheet's "Last, First" spelling for a "First Last" display name. */
function duesNameFor_(display) {
  const hit = readDues_(SpreadsheetApp.openById(CONFIG.DUES_SHEET_ID)).find(b => personKey_(b.name) === personKey_(display));
  return hit ? hit.name : display;
}

/** The log row is what counts; a grid that can't be written shouldn't fail the check-in. */
function markGridSafely_(book, ev, display) {
  try { markGrid_(book, ev, display); } catch (e) { console.error('Could not mark attendance grid: ' + e); }
}

function isOpen_(ev) { return !!ev.closes && ev.closes.getTime() > Date.now(); }

/** "Last, First" on the dues sheet becomes "First Last". Cached, since a whole room scans at once. */
function brotherNames_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('names:' + CONFIG.DUES_SHEET_ID);
  if (hit) return JSON.parse(hit);
  const names = readDues_(SpreadsheetApp.openById(CONFIG.DUES_SHEET_ID)).map(b => {
    const parts = b.name.split(',').map(x => x.trim());
    return (parts[1] ? parts[1] + ' ' + parts[0] : parts[0]).replace(/\s+/g, ' ');
  }).sort((a, b) => a.localeCompare(b));
  cache.put('names:' + CONFIG.DUES_SHEET_ID, JSON.stringify(names), CONFIG.CACHE_SECONDS);
  return names;
}

function officerOk_(password) {
  const expected = PROPS.getProperty('OFFICER_PASSWORD');
  if (!expected) throw new Error('No officer password is set yet. Add OFFICER_PASSWORD in Script Properties.');
  if (String(password || '').trim() !== expected) {
    Utilities.sleep(1500);
    throw new Error('That officer password is not right.');
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Officer view of one event: its QR link and the live list of names. */
function eventStatus_(book, ev) {
  const names = readAttCheckins_(book).filter(c => c.eventId === ev.id)
    .map(c => ({ name: c.name, method: c.method, time: c.time instanceof Date ? c.time.toISOString() : '' }));
  return {
    id: ev.id, name: ev.name, date: ev.date, type: ev.type, points: ev.points,
    open: isOpen_(ev), closes: ev.closes ? ev.closes.toISOString() : null,
    url: ScriptApp.getService().getUrl() + '?checkin=' + ev.code,
    checkedIn: names,
  };
}

/** Officer: start a check-in. ev = { name, date: 'yyyy-mm-dd', type, points, hours }. */
function createCheckin(officerPassword, ev) {
  officerOk_(officerPassword);
  const name = String((ev && ev.name) || '').trim().slice(0, 120);
  if (!name) throw new Error('Give the event a name.');
  const hours = Math.min(Math.max(Number(ev.hours) || ATT.DEFAULT_HOURS, 0.25), 24);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ev.date) ? ev.date : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return withLock_(() => {
    const book = attendanceBook_(true);
    const sheet = attTab_(book, ATT.EVENTS_TAB, ATT.EVENT_HEAD);
    attTab_(book, ATT.CHECKINS_TAB, ATT.CHECKIN_HEAD);
    const row = [
      Utilities.getUuid().slice(0, 8), Utilities.getUuid().replace(/-/g, ''), name, date,
      String(ev.type || 'Chapter meeting').slice(0, 60), Math.max(0, Number(ev.points) || 0),
      new Date(Date.now() + hours * 3600e3), new Date(),
    ];
    sheet.appendRow(row);
    return eventStatus_(book, readAttEvents_(book).find(e => e.id === row[0]));
  });
}

/** Officer: recent check-ins, newest first, to bring a QR code back up. */
function officerEvents(officerPassword) {
  officerOk_(officerPassword);
  const book = attendanceBook_(false);
  if (!book) return [];
  const counts = {};
  readAttCheckins_(book).forEach(c => { counts[c.eventId] = (counts[c.eventId] || 0) + 1; });
  return readAttEvents_(book).reverse().slice(0, 30)
    .map(e => ({ id: e.id, name: e.name, date: e.date, type: e.type, open: isOpen_(e), count: counts[e.id] || 0 }));
}

function officerEvent_(book, id) {
  const ev = readAttEvents_(book).find(e => e.id === id);
  if (!ev) throw new Error('That check-in no longer exists on the attendance sheet.');
  return ev;
}

/** Officer: live status of one check-in. */
function checkinStatus(officerPassword, id) {
  officerOk_(officerPassword);
  const book = attendanceBook_(false);
  return eventStatus_(book, officerEvent_(book, id));
}

/** Officer: close a check-in now, or reopen it for more hours. */
function setCheckinOpen(officerPassword, id, hours) {
  officerOk_(officerPassword);
  return withLock_(() => {
    const book = attendanceBook_(false);
    const ev = officerEvent_(book, id);
    const closes = new Date(Date.now() + Math.min(Math.max(Number(hours) || 0, 0), 24) * 3600e3);
    book.getSheetByName(ATT.EVENTS_TAB).getRange(ev.row, 7).setValue(closes);
    ev.closes = closes;
    return eventStatus_(book, ev);
  });
}

/** Officer: mark a brother present by hand (no phone, dead battery). */
function addCheckin(officerPassword, id, name) {
  officerOk_(officerPassword);
  const match = brotherNames_().find(n => n.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!match) throw new Error('No brother named "' + name + '" is on the dues sheet.');
  return withLock_(() => {
    const book = attendanceBook_(false);
    const ev = officerEvent_(book, id);
    if (!readAttCheckins_(book).some(c => c.eventId === id && c.name === match)) {
      book.getSheetByName(ATT.CHECKINS_TAB).appendRow([new Date(), ev.id, ev.name, match, 'Added by officer', '']);
      markGridSafely_(book, ev, match);
    }
    return eventStatus_(book, ev);
  });
}

function eventByCode_(book, code) {
  const ev = book && code ? readAttEvents_(book).find(e => e.code === code) : null;
  if (!ev) throw new Error('This check-in code is not valid. Ask an officer to show the QR code again.');
  return ev;
}

/** Scanned QR: the event and the list of names to pick from. No password; the code is the key. */
function getCheckinPage(code) {
  const ev = eventByCode_(attendanceBook_(false), String(code || ''));
  return { name: ev.name, date: ev.date, type: ev.type, open: isOpen_(ev), names: isOpen_(ev) ? brotherNames_() : [] };
}

/** Scanned QR: record one brother. A phone can check in only one name per event. */
function checkIn(code, name, device) {
  const match = brotherNames_().find(n => n.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!match) throw new Error('Pick your name from the list. If you are missing, ask an officer to add you.');
  device = String(device || '').replace(/[^\w-]/g, '').slice(0, 40);
  return withLock_(() => {
    const book = attendanceBook_(false);
    const ev = eventByCode_(book, String(code || ''));
    if (!isOpen_(ev)) throw new Error('Check-in for ' + ev.name + ' is closed. Ask an officer to add you.');
    const here = readAttCheckins_(book).filter(c => c.eventId === ev.id);
    if (here.some(c => c.name === match)) return { name: match, event: ev.name, already: true };
    const other = device && here.find(c => c.device === device);
    if (other) throw new Error('This phone already checked in ' + other.name + '. Each brother checks in on their own phone.');
    book.getSheetByName(ATT.CHECKINS_TAB).appendRow([new Date(), ev.id, ev.name, match, 'QR scan', device]);
    markGridSafely_(book, ev, match);
    return { name: match, event: ev.name, already: false };
  });
}

// ---- Points ----
// Built for the chapter point tracker: a Mastersheet tab (Name, Earned Professional,
// Earned Philanthropic, Earned Other, Total) and one tab per category with a row per
// brother and a column per activity, like "Alumni Networking (1)". Any tab with a
// Name column is read. The tab with the most Earned/Total columns becomes the
// leaderboard; the category tabs give each brother's breakdown and the point system.
function readPointsSafely_(id) {
  try {
    return readPoints_(SpreadsheetApp.openById(id));
  } catch (e) {
    return { tabs: [], leaderboard: null, error: 'The points sheet could not be opened. If it is an Excel file, save it as Google Sheets and use the new link for POINTS_SHEET_ID.' };
  }
}

function readPoints_(book) {
  const tabs = [];
  book.getSheets().forEach(sheet => {
    if (sheet.isSheetHidden()) return;
    const values = sheet.getDataRange().getDisplayValues();
    const h = nameHeaderRow_(values);
    if (h < 0) return;
    const head = values[h].map(cellText_);
    const nameCol = head.findIndex(x => NAME_HEAD.test(x));
    // Columns without a header are notes or spacing.
    const cols = head.map((x, c) => x && c !== nameCol ? c : -1).filter(c => c >= 0);
    tabs.push({
      name: sheet.getName(),
      head: cols.map(c => head[c]),
      rows: values.slice(h + 1).filter(r => cellText_(r[nameCol]) && !/^total/i.test(cellText_(r[nameCol])))
        .slice(0, 300).map(r => ({ name: cellText_(r[nameCol]), values: cols.map(c => cellText_(r[c])) })),
    });
  });
  const score = t => t.head.filter(x => /earned|total/i.test(x)).length;
  const board = tabs.filter(t => !/attendance/i.test(t.name) && score(t) && t.head.some(x => /total/i.test(x)))
    .sort((a, b) => score(b) - score(a))[0];
  let leaderboard = null;
  if (board) {
    const keep = board.head.map((x, i) => /earned|total|points/i.test(x) ? i : -1).filter(i => i >= 0);
    leaderboard = {
      tab: board.name,
      cols: keep.map(i => board.head[i].replace(/^earned\s+/i, '')),
      total: keep.findIndex(i => /total/i.test(board.head[i])),
      rows: board.rows.map(r => ({ name: r.name, values: keep.map(i => Number(String(r.values[i]).replace(/[^0-9.-]/g, '')) || 0) })),
    };
  }
  return { tabs: tabs.filter(t => t !== board), leaderboard: leaderboard };
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/[^0-9.]/g, '')) || 0;
}

function isoDate_(m, d) {
  const pad = n => ('0' + n).slice(-2);
  return CONFIG.YEAR + '-' + pad(m) + '-' + pad(d);
}

/** Run once from the editor to check the sheets parse. Logs counts, not balances. */
function testRead() {
  const book = SpreadsheetApp.openById(CONFIG.DUES_SHEET_ID);
  const brothers = readDues_(book);
  const events = readCalendar_(SpreadsheetApp.openById(CONFIG.CALENDAR_SHEET_ID));
  Logger.log('Brothers: %s, unpaid: %s', brothers.length, brothers.filter(b => !b.paidSocial || !b.paidNat).length);
  Logger.log('Dues info: %s', JSON.stringify(readDuesInfo_(book)));
  Logger.log('Events: %s', events.length);
  const att = attendanceBook_(false);
  if (att) Logger.log('Attendance: %s check-ins across %s events', readAttCheckins_(att).length, readAttEvents_(att).length);
  if (sheetId_('POINTS_SHEET_ID')) Logger.log('Points: %s', JSON.stringify(readPointsSafely_(sheetId_('POINTS_SHEET_ID'))).slice(0, 500));
  if (CONFIG.BUDGET_SHEET_ID) Logger.log('Budget: %s', JSON.stringify(readBudget_(SpreadsheetApp.openById(CONFIG.BUDGET_SHEET_ID))).slice(0, 500));
  events.slice(0, 10).forEach(e => Logger.log(JSON.stringify(e)));
}
