// Settings read from the environment (.env locally, site settings on Netlify).

export const {
  JIRA_BASE_URL,                 // https://yourcompany.atlassian.net
  JIRA_EMAIL,                    // integration account email
  JIRA_API_TOKEN,                // API token for that account
  JIRA_PROJECT_KEY,              // default project, e.g. PCAI
  JIRA_ISSUE_TYPE = 'Task',
  PORTAL_SHARED_SECRET,          // HMAC secret shared with the portal
  PORTAL_CALLBACK_URL = '',      // optional: where to POST Jira-side status changes
  JIRA_WEBHOOK_SECRET = '',      // optional: secret query param on the Jira webhook URL
  STATUS_MAP_JSON = '',          // optional override, e.g. {"todo":"To Do","done":"Done"}
  JIRA_SPRINT_FIELD = '',        // optional: e.g. customfield_10020 (auto-detected if empty)
  JIRA_START_DATE_FIELD = '',    // optional: e.g. customfield_10015 (auto-detected if empty)
  UI_PASSCODE = '',              // HTML form - people enter this to use the form
} = process.env;

// true: portal changes wait in the page's Inbox until someone approves them (default: sent straight away)
export const PORTAL_REQUIRE_APPROVAL = /^(1|true|yes|on)$/i.test(process.env.PORTAL_REQUIRE_APPROVAL || '');

export const missingEnv = Object.entries({ JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, PORTAL_SHARED_SECRET })
  .filter(([, v]) => !v).map(([k]) => k);

// Portal status -> Jira status name. Keys are lower-cased portal values.
export const STATUS_MAP = {
  'todo': 'To Do', 'to do': 'To Do', 'open': 'To Do',
  'in_progress': 'In Progress', 'in progress': 'In Progress', 'wip': 'In Progress',
  'review': 'In Review', 'in review': 'In Review',
  'blocked': 'Blocked',
  'done': 'Done', 'completed': 'Done', 'closed': 'Done',
  ...(STATUS_MAP_JSON ? JSON.parse(STATUS_MAP_JSON) : {}),
};

export const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
export const BASE = (JIRA_BASE_URL || '').replace(/\/+$/, '');
