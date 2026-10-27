/**
 * AKPsi Brother Ledger — Google Apps Script web app.
 *
 * Reads the dues sheet and the social calendar sheet live, and only returns
 * data to a visitor who enters the chapter password. Nothing is published.
 * Setup steps are in README.md.
 */

// Sheet IDs and the password live in Script Properties (Project Settings), not in
// this public repo. Keys: CHAPTER_PASSWORD, DUES_SHEET_ID, CALENDAR_SHEET_ID.
const PROPS = PropertiesService.getScriptProperties();

const CONFIG = {
  DUES_SHEET_ID: PROPS.getProperty('DUES_SHEET_ID'),
  DUES_TAB: 'Status Sheet',
  DUES_INFO_TAB: 'Information',
  CALENDAR_SHEET_ID: PROPS.getProperty('CALENDAR_SHEET_ID'),
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

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
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
  const cache = CacheService.getScriptCache();
  const hit = cache.get('data');
  if (hit) return JSON.parse(hit);

  const data = {
    term: CONFIG.TERM,
    treasurer: CONFIG.TREASURER,
    finesContact: CONFIG.FINES_CONTACT,
    duesSheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.DUES_SHEET_ID + '/edit',
    calendarSheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.CALENDAR_SHEET_ID + '/edit',
    payments: CONFIG.PAYMENTS,
    updated: new Date().toISOString(),
  };
  const duesBook = SpreadsheetApp.openById(CONFIG.DUES_SHEET_ID);
  data.brothers = readDues_(duesBook);
  data.info = readDuesInfo_(duesBook);
  data.events = readCalendar_(SpreadsheetApp.openById(CONFIG.CALENDAR_SHEET_ID));

  cache.put('data', JSON.stringify(data), CONFIG.CACHE_SECONDS);
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
  CacheService.getScriptCache().remove('data');
  const book = SpreadsheetApp.openById(CONFIG.DUES_SHEET_ID);
  const brothers = readDues_(book);
  const events = readCalendar_(SpreadsheetApp.openById(CONFIG.CALENDAR_SHEET_ID));
  Logger.log('Brothers: %s, unpaid: %s', brothers.length, brothers.filter(b => !b.paidSocial || !b.paidNat).length);
  Logger.log('Dues info: %s', JSON.stringify(readDuesInfo_(book)));
  Logger.log('Events: %s', events.length);
  events.slice(0, 10).forEach(e => Logger.log(JSON.stringify(e)));
}
