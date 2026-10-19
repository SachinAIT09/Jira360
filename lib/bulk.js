// Reading many tasks at once: an .xlsx / CSV upload (and later the Google Sheet) -> tasks.

import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { badRequest } from './jira.js';
import { isoDay, normTitle } from './check.js';
import { extraHeaderMap } from './fields.js';

export const MAX_BULK_ROWS = 200;
export const CHECK_CHUNK = 5;

// Spreadsheet column headers accepted for each field (compared lower-case, letters and digits only)
export const HEADER_ALIASES = {
  taskId: ['taskid', 'task', 'id'],
  jiraKey: ['jirakey', 'key', 'jira', 'ticketkey'],
  title: ['title', 'tickettitle', 'summary'],
  description: ['description', 'ticketdescription', 'details'],
  assigneeEmail: ['assignee', 'assigneeemail', 'assignto', 'assign', 'email'],
  parentKey: ['parent', 'parentticket', 'parentkey', 'epic'],
  startDate: ['startdate', 'start'],
  dueDate: ['enddate', 'duedate', 'end', 'due'],
  originalEstimate: ['originalestimate', 'estimate', 'estimatehours'],
  sprint: ['sprint'],
  labels: ['labels', 'label'],
  fixVersions: ['fixversion', 'fixversions', 'version'],
  priority: ['priority'],
  status: ['status'],
};
export const HEADER_TO_FIELD = Object.fromEntries(Object.entries(HEADER_ALIASES).flatMap(([f, names]) => names.map(n => [n, f])));
export const normHeader = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, ''); // the byte-order mark Excel adds
  const nl = text.search(/\r?\n/);
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  // Excel saves CSV with ";" in some regions, so pick whichever separator the header uses most
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cellText(cell) {
  const v = cell.value;
  if (v instanceof Date) return isoDay(v);
  if (v && typeof v === 'object' && 'result' in v) return v.result instanceof Date ? isoDay(v.result) : String(v.result ?? ''); // formula
  return cell.text ?? '';
}

export async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets.find(w => w.actualRowCount > 0);
  if (!ws) return [];
  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r), cells = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c)));
    rows.push(cells);
  }
  return rows;
}

// Rows of cells -> [{ row, task }], using the first non-empty row as headers
// extra: { <normalized header>: <Jira field id> } for columns named after other Jira fields
export function rowsToTasks(rows, extra = {}) {
  const h = rows.findIndex(r => r.some(c => String(c).trim()));
  if (h < 0) throw badRequest('The file is empty');
  const headers = rows[h].map(x => String(x).trim());
  const fields = headers.map(x => HEADER_TO_FIELD[normHeader(x)] || (extra[normHeader(x)] ? 'f:' + extra[normHeader(x)] : null));
  if (!fields.includes('title')) throw badRequest('No "Title" column found. Download the template to see the expected columns.');
  const tasks = [];
  for (let i = h + 1; i < rows.length; i++) {
    const task = {};
    fields.forEach((f, c) => {
      const v = String(rows[i][c] ?? '').trim();
      if (!f || !v) return;
      if (f.startsWith('f:')) (task.fields ||= {})[f.slice(2)] = v; else task[f] = v;
    });
    if (Object.keys(task).length) tasks.push({ row: i + 1, task });
  }
  return { tasks, ignoredColumns: headers.filter((x, i) => x && !fields[i]) };
}

// Task ID for a row that has none: made from the title (and parent), so uploading the same row
// again finds the ticket it created the first time instead of creating a duplicate
export const autoTaskId = t => 'XL-' + crypto.createHash('sha1')
  .update(normTitle(t.title) + '|' + String(t.parentKey || '').trim().toUpperCase()).digest('hex').slice(0, 10).toUpperCase();

// Runs fn over items with at most n in flight, keeping order
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// An uploaded file -> its rows as tasks, with duplicates inside the file marked. No Jira calls.
export async function readBulkFile(buf) {
  let rows;
  if (buf[0] === 0x50 && buf[1] === 0x4b) rows = await parseXlsx(buf);           // .xlsx is a zip ("PK")
  else if (buf[0] === 0xd0 && buf[1] === 0xcf) throw badRequest('Old .xls files are not supported. In Excel use File > Save As > Excel Workbook (.xlsx) or CSV.');
  else rows = parseCsv(buf.toString('utf8'));

  const { tasks, ignoredColumns } = rowsToTasks(rows, await extraHeaderMap(normHeader));
  if (!tasks.length) throw badRequest('No ticket rows found under the header row');
  if (tasks.length > MAX_BULK_ROWS) throw badRequest(`The file has ${tasks.length} rows; the limit is ${MAX_BULK_ROWS} per upload`);

  // Duplicates inside the file. Same Task ID / Jira key (including Task IDs made from the same
  // title) would make the second row overwrite the first, so that's an error; the same title
  // under different Task IDs is allowed but suspicious, so those rows start unticked.
  const generated = new Set();
  for (const { row, task } of tasks) {
    if (task.taskId) continue;
    if (task.jiraKey) task.taskId = task.jiraKey.toUpperCase(); // only used to send; the key finds the ticket
    else { task.taskId = autoTaskId(task); generated.add(row); }
  }
  const firstSeen = new Map(), dupes = new Map(), titleDupes = new Map();
  for (const { row, task } of tasks) {
    for (const id of [task.taskId && `Task ID ${task.taskId}`, task.jiraKey && `Jira key ${task.jiraKey.toUpperCase()}`]) {
      if (!id) continue;
      const first = firstSeen.get(id);
      if (!first) { firstSeen.set(id, row); continue; }
      dupes.set(row, generated.has(row) && generated.has(first)
        ? `Same title as row ${first}. Give each row its own Task ID if both are really needed`
        : `${id} is also on row ${first}`);
    }
    const tKey = task.title && `title ${normTitle(task.title)}`;
    if (tKey && !dupes.has(row)) {
      if (firstSeen.has(tKey)) titleDupes.set(row, firstSeen.get(tKey)); else firstSeen.set(tKey, row);
    }
  }

  return {
    ignoredColumns,
    rows: tasks.map(({ row, task }) => ({
      row, task,
      errors: dupes.has(row) ? [dupes.get(row)] : [],
      info: {
        ...(titleDupes.has(row) && { sameTitleRow: titleDupes.get(row), suggestUntick: true }),
        ...(generated.has(row) && { autoTaskId: true }),
      },
    })),
  };
}
