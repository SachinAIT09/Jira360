// One JSON line per event, always with where it came from (ui, bulk, portal, inbox, jira-webhook),
// and one error shape for every route: { error, code, errors? }.

export const log = (source, data) => console.log(JSON.stringify({ at: new Date().toISOString(), source, ...data }));
export const logError = (source, e, data = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), source, level: 'error', error: e.message || String(e), ...data }));

// codes: invalid, unauthorized, bad_signature, not_found, conflict, not_configured, jira_error
export const fail = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });

// A thrown error -> the matching reply: our own 400s stay 400, Jira's 404 stays 404, the rest is Jira's fault (502)
export function sendError(res, e, source, data) {
  logError(source, e, data);
  if (e.status === 400) return fail(res, 400, 'invalid', e.message);
  if (e.status === 404) return fail(res, 404, 'not_found', e.message);
  return fail(res, 502, 'jira_error', e.message);
}
