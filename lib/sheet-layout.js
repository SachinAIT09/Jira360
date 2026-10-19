// The Jira360 sheet's columns: one definition for "Create a new sheet", "Set up the linked sheet"
// and the downloadable template. Dropdowns come from Jira's real lists (they warn, never reject:
// the sync's own checks report problems).

import { JIRA_PROJECT_KEY } from './config.js';
import { lists } from './jira.js';
import { extraFields, getFieldConfig } from './fields.js';

// kind: 'app' = filled in by Jira360 (greyed, warn before editing); 'date' = date column
const BASE = [
  { header: 'Task ID', width: 120, note: 'Filled in for new rows' },
  { header: 'Jira Key', width: 115, note: 'Type a key to link a row to an existing ticket' },
  { header: 'Title', width: 320 },
  { header: 'Description', width: 360 },
  { header: 'Assignee', width: 170, list: 'people' },
  { header: 'Parent ticket', width: 125, list: 'parents' },
  { header: 'Start date', width: 115, kind: 'date' },
  { header: 'End date', width: 115, kind: 'date' },
  { header: 'Original estimate', width: 130 },
  { header: 'Sprint', width: 160, list: 'sprints' },
  { header: 'Labels', width: 170 },
  { header: 'Fix version', width: 140, list: 'versions' },
  { header: 'Priority', width: 110, list: 'priorities' },
  { header: 'Status', width: 140, list: 'statuses' },
  { header: 'Comment', width: 260, note: 'Added to the ticket once' },
];
const APP = [
  { header: 'Sync status', width: 240, kind: 'app' },
  { header: 'Last synced', width: 150, kind: 'app' },
  { header: 'Edited at', width: 140, kind: 'app', hidden: true, note: 'Kept by the optional Apps Script' },
];

export async function sheetLayout() {
  const p = JIRA_PROJECT_KEY, safe = x => x.catch(() => []);
  const [statuses, priorities, sprints, users, versions, parents, extras, cfg] = await Promise.all([
    safe(lists.statuses(p)), safe(lists.priorities()), safe(lists.sprints(p)), safe(lists.users(p)), safe(lists.versions(p)),
    safe(lists.parents(p)), safe(extraFields()), getFieldConfig().catch(() => ({ hidden: [], order: [] })),
  ]);
  const values = {
    statuses, priorities, sprints: sprints.map(s => s.name), people: users.map(u => u.name), versions: versions.map(v => v.name),
    parents: parents.slice(0, 200).map(x => x.key),
  };
  // "More fields" switched on for everyone (same rule as the page's Customize fields)
  const shown = extras.filter(f => f.required || (cfg.order.includes(f.id) && !cfg.hidden.includes(f.id)))
    .sort((a, b) => cfg.order.indexOf(a.id) - cfg.order.indexOf(b.id));
  const extraCols = shown.map(f => ({ header: f.name, width: 160, ...(f.kind === 'date' && { kind: 'date' }),
    ...(['option', 'version'].includes(f.kind) && f.allowed.length && { values: f.allowed }),
    ...(f.kind === 'user' && { values: values.people }) }));
  const columns = [...BASE, ...extraCols, ...APP].map(c => ({ ...c, values: c.values || (c.list ? values[c.list].filter(Boolean) : undefined) }));
  return { tab: 'Tasks', columns, headers: columns.map(c => c.header) };
}

// The same layout as an .xlsx to import into Google Sheets (File -> Import). Dropdown values live on
// a hidden "Lists" sheet, so long lists aren't cut at Excel's 255-character limit.
export async function templateXlsx() {
  const { default: ExcelJS } = await import('exceljs');
  const def = await sheetLayout();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jira360';
  const ws = wb.addWorksheet(def.tab, { views: [{ state: 'frozen', ySplit: 1 }] });
  const listWs = wb.addWorksheet('Lists', { state: 'veryHidden' });
  ws.columns = def.columns.map(c => ({ header: c.header, width: Math.round(c.width / 7), hidden: !!c.hidden }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEAFF' } };
  let listCol = 0;
  def.columns.forEach((c, i) => {
    const letter = ws.getColumn(i + 1).letter, range = `${letter}2:${letter}1000`;
    if (c.note) head.getCell(i + 1).note = c.note;
    if (c.kind === 'date') { ws.getColumn(i + 1).numFmt = 'yyyy-mm-dd'; ws.dataValidations.add(range, { type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(2000, 0, 1)], showErrorMessage: false }); }
    if (c.values?.length) {
      const lc = listWs.getColumn(++listCol);
      c.values.forEach((v, k) => { listWs.getCell(k + 1, listCol).value = String(v); });
      ws.dataValidations.add(range, { type: 'list', allowBlank: true, formulae: [`Lists!$${lc.letter}$1:$${lc.letter}$${c.values.length}`], showErrorMessage: false });
    }
    if (c.kind === 'app') ws.getColumn(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F9' } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
