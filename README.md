# Portal → Jira Auto-Update

Two ways to get the same result: every time a task is posted in the portal, the matching Jira issue is created or updated (fields, status, comment, logged hours).

| | Option A: Shortcut | Option B: Full integration |
|---|---|---|
| Setup time | 30–60 min | Half a day incl. deploy |
| Code to host | None (portal makes one HTTP call) | Small Node service (`server.js`) |
| Create if missing | Yes (Lookup + condition) | Yes |
| Status transitions | One If-branch per status | Automatic, any workflow |
| Assignee by email | Limited | Yes |
| Retries, idempotency, logs | No | Yes |
| Jira → portal sync back | No | Yes (optional) |
| Limits | Counts against Jira Automation monthly run quota | Jira API rate limits only |

Use A today. Move to B when volume grows or rules become hard to maintain. Both use the same payload, so the portal side doesn't change (`portal-hook.js`, switch `JIRA_SYNC_MODE`).

---

## Phase 1: HTML form (start here)

A page where the team creates or updates Jira tickets, one at a time or many at once from an Excel/CSV file or a Google Sheet. Every send shows a preview first; nothing reaches Jira until it's confirmed. Everything sent is listed in the Activity tab.

Files:

| File | What it is |
|---|---|
| `public/` | The page: `index.html`, `styles.css`, and one script per tab in `js/` (the only folder that is published) |
| `app.js` | The server: wires the routes together. Talks to Jira with the API token |
| `lib/jira.js` | Jira client, lookups, and the cached lists the form shows |
| `lib/sync.js` | Creates/updates tickets, moves status, adds comments and work logs (the only code that writes to Jira) |
| `lib/check.js` | Checks a task against Jira before sending (the preview) |
| `lib/bulk.js` | Reads Excel / CSV uploads |
| `lib/store.js` | Remembers things across restarts (see "Storage" below) |
| `lib/activity.js`, `lib/inbox.js` | The Activity history, and changes waiting for approval |
| `lib/fields.js` | Jira's field list for the project, and which fields the form shows |
| `lib/ai.js` | AI suggestions (optional) |
| `lib/google.js`, `lib/sheet.js` | Google Sheet sync (optional) |
| `routes/` | The web addresses: `ui.js` (the page), `portal.js` (the portal), `jira.js` (Jira webhook) |
| `server.js` | Runs `app.js` on your computer (`npm start`) |
| `netlify/functions/api.mjs`, `netlify.toml` | Runs `app.js` on Netlify |

### Single ticket

- Type a **Task ID** or **Jira key** to load a ticket; the form keeps it in sync with Jira every 10 seconds. A new ticket doesn't need a Task ID: one is made (`UI-…`) and shown after sending.
- **Latest in Jira** (under the key) lists the ticket's last comments and logged work.
- **Review and send** opens a dialog grouped into Details / Planning / Status and work / More fields. For an existing ticket each line shows what the ticket has now → what it will have; removed values are red.
- Shortcuts: **Ctrl+Enter** reviews (and in the dialog, confirms), **Esc** goes back, **/** jumps to the Task ID.

### Fields on the form

**Customize fields** (above the title) lists every field Jira has for the project's issue type.
- **More Jira fields**: custom fields such as story points, lists, checkboxes or people. Switch one on and it appears on the form under "More fields", in the bulk-upload template, and is read from Excel and Google Sheet columns with the same name. Use ↑ ↓ to order them.
- **Already on the form**: the built-in fields can be switched off too (Title can't: a ticket needs one).
- **Everyone** is saved on the server for all users. **Just for me** overrides it in your browser only.
- Fields Jira requires for a new ticket are always shown. Fields that can't be edited from a form (attachments, links, ranking) are listed as such.

### Bulk upload review

After a file is read, a full-screen review opens (Close keeps it; **Open review** brings it back).
- Tabs: **All / Problems / Warnings / New tickets / Updates**, and after sending **Sent / Failed**.
- For a row that updates a ticket, each value shows the ticket's current value struck through → the file's value; labels show what is added.
- **Edit** fixes a row in place; it is checked against Jira again on save.
- **Tick all ready rows shown** / **Untick all shown** work on the current tab.
- While sending, a progress bar and **Stop after this row**. Afterwards **Retry failed rows** and **Download results** (one line per row: created / updated / failed, with the Jira key).

### AI suggestions (optional)

With AI switched on, the page offers:
- **Draft from text with AI**: paste an email, chat or notes; you get a title, a description with acceptance criteria, and suggested assignee, epic, priority, labels, estimate and sprint, each with a reason. Untick what you don't want, then **Fill the form**.
- **Improve wording with AI**: a clearer title and description, shown before → after.
- **Similar open tickets (AI)** in the review of a new ticket: finds tickets about the same work even when worded differently.
- **Suggest fixes with AI** in the bulk review: corrections for rows with problems (e.g. "Hi" → High, a first name → the person, "finished" → Done). Click **Use** per fix or **Use all AI fixes**; the rows are checked again.
- **Summarize with AI** in the Inbox: what is waiting, and which changes deserve a second look.

The AI only suggests: it chooses only from Jira's real people, epics, sprints, priorities and statuses, and everything still goes through the normal review before anything is sent.

Setup: `npm install @anthropic-ai/sdk`, then in `.env` set `AI_ENABLED=true` and `ANTHROPIC_API_KEY` (from console.anthropic.com). Optional: `AI_MODEL` (default `claude-opus-5-5`), `AI_DAILY_LIMIT` (requests per day for the whole site, default 200). Without these the AI buttons don't show.
Ticket text you send to the AI is processed by Anthropic.

### Google Sheet (optional)

Keep a task list in a Google Sheet and have its changes reach Jira, each one approved first.
- **Columns**: the same as the bulk template (download it from the Bulk tab), plus **Comment**. The app adds **Task ID**, **Jira Key**, **Sync status** and **Last synced** if they are missing and fills them in; rows without a Task ID get one.
- The sheet is checked every `SHEET_POLL_MINUTES` (default 5), or with **Check sheet now** in the Inbox. A new or edited row becomes a change in the **Inbox**, already checked against Jira. Nothing is sent until someone approves it; the row's Sync status says "Waiting for approval".
- **Approve** sends it and writes the Jira key, "Synced" and the time into the row. **Reject** writes "Rejected" (with the reason); that version is not offered again unless the row changes again. Changing a row back before approval withdraws the change.
- Only what changed in a row is sent. Emptying a cell empties that field in Jira. A **Comment** is added to the ticket once.
- **Conflicts**: if a field was changed in Jira after the last sync and also in the sheet, the change shows both values; pick **Sheet** or **Jira**. Keeping Jira's value writes it into the sheet.
- **Jira → sheet**: status, end date and assignee changes made in Jira are written into the row (needs the Jira webhook, see "Optional: Jira → portal"; `PORTAL_CALLBACK_URL` isn't needed for this).

Setup:
1. In Google Cloud, create a service account, enable the **Google Sheets API**, and create a JSON key for the account.
2. Share the sheet with the service account's email (Editor).
3. In `.env`: `GOOGLE_SA_JSON` = the key file's contents on one line (or `GOOGLE_SA_FILE` = its path), `SHEET_ID` = the id in the sheet's address (`docs.google.com/spreadsheets/d/<SHEET_ID>/edit`), and `SHEET_TAB` if the tab isn't called Sheet1.

### Settings (admin)

The **Settings** tab sets the keys and switches without editing `.env` or restarting:
- **Portal**: whether portal changes wait in the Inbox for approval.
- **AI**: on/off, the Anthropic API key, the model, and the daily request limit. **Test the key** checks it with Anthropic without using a request.
- **Google Sheet**: the service account key (paste the downloaded .json), the sheet's address, the tab, and how often to check it. The page shows which email to share the sheet with. **Test the sheet** reads it once.

It needs the admin passcode: set `ADMIN_PASSCODE` in `.env` once (use a different, longer one than `UI_PASSCODE`). Without it the tab stays locked. After 10 wrong tries an address is locked out for 10 minutes.

How values are used: a value saved in Settings wins over `.env`; **Remove saved key** goes back to the `.env` value. Each value is marked "set here", "from .env" or "default".
Keys are kept on the server (in `data/` on your computer, in Netlify Blobs on Netlify, like `.env` they are stored as plain text, so keep that folder private) and are never sent back to the page, which shows only the last 4 characters. The admin passcode is remembered only until the browser tab is closed.

### Activity (history)

The **Activity** tab lists everything sent to Jira from the form, bulk uploads, the portal and Inbox approvals. Everyone using the page sees the same history.
- Each line shows when, where it came from, **who** (the "Your name" box next to the passcode), the task and ticket, and what happened. Failed sends are kept with their error.
- **Search** by Task ID, Jira key, title or name. **Filter** by source, sent/failed and dates.
- **Click a line** to see that task's full history, with each changed field's value **before → after**.
- **Retry** on a failed line opens the normal review dialog, so the task is checked against Jira again before it is sent.
- **Export CSV** saves what the filters show (newest 500).

Portal tasks refused by the checks are listed too, as "Refused". They have no Retry: the portal has to send them again, fixed.

### Storage

The server remembers which Jira ticket belongs to each task, which portal events it has already handled (so a resend after a restart doesn't create a duplicate), the Inbox, and the Activity history.
- On your computer it keeps these in the `data/` folder (not uploaded to git).
- On Netlify it uses Netlify Blobs. Run `npm install @netlify/blobs` once before deploying. Without it the server falls back to temporary storage that is lost whenever Netlify restarts the function.

Why it isn't a standalone .html file: Jira blocks API calls made directly from a web page, and the API token would be visible to anyone who opens the page. The page talks to `app.js`, which holds the token.

### Run it on your computer

```bash
copy env.example .env     # Windows (cp on Mac/Linux); fill JIRA_* values and set UI_PASSCODE
npm install
npm start
```
Open `http://localhost:8080/`. To let others on the network use it, set `HOST=0.0.0.0` in `.env` and share `http://<your computer's IP>:8080/`.

### Put it on Netlify

Dragging the folder onto Netlify does **not** work: it publishes the files but can't run `app.js`, and it can publish files you don't want public. Deploy with the Netlify CLI instead, which publishes only `public/` and runs `app.js` as a function:

```bash
npx netlify-cli login                  # opens the browser once
npx netlify-cli link                   # pick the existing site
npx netlify-cli env:import .env        # copies the settings to Netlify (the token is stored there, not in the site files)
npx netlify-cli env:set UI_PASSCODE "<a long random passcode>"   # the site is public: don't reuse a short passcode
npx netlify-cli deploy --prod
```
After changing settings in Netlify, deploy again for them to take effect.

The Netlify site is on the public internet: anyone who has the link and the passcode can create and change tickets as `JIRA_EMAIL`. Use a long random passcode and change it when people leave the team.

### How duplicates are avoided

- A row or form with a **Task ID** that was sent before updates that ticket. The link is the hidden label `portal-<Task ID>` on the ticket: **if someone removes that label in Jira, the next send creates a new ticket.**
- A bulk row **without** a Task ID gets one made from its title (and parent), so uploading the same file again updates instead of duplicating. Changing the title makes it a new ticket.
- A new ticket whose title exactly matches an existing one is flagged as a possible duplicate (with a link) and starts unticked.
- Two sends of the same task at the same moment create one ticket.

Phases 2 and 3 below (Jira Automation webhook, full portal integration) reuse the same server and Jira logic.

---

## Payload the portal sends (both options)

```json
{
  "taskId": "T-1001",
  "jiraKey": "PCAI-123",
  "title": "Configure outage SMS template",
  "description": "Details of the task...",
  "status": "in_progress",
  "comment": "Template drafted, waiting on client review.",
  "hoursSpent": 2,
  "assigneeEmail": "dev@company.com",
  "dueDate": "2026-10-20",
  "priority": "High"
}
```

Only `taskId` is required. `jiraKey` is optional: if the portal stores the key, updates go straight to it; otherwise the issue is found by the label `portal-<taskId>`.

---

## Option A: Shortcut (Jira Automation, no server)

1. **Jira → Project settings → Automation → Create rule.**
2. **Trigger: Incoming webhook.** Select "No issues from the webhook". Save it, then copy the **webhook URL** and **secret token** shown in the trigger panel. (Field names in that panel vary slightly by Jira version; check what yours shows.)
3. **Action: Lookup issues** with JQL:
   ```
   project = PCAI AND labels = "portal-{{webhookData.taskId}}"
   ```
4. **If/else block → Smart value condition:** `{{lookupIssues.size}}` equals `0`
   - **Then: Create issue** in PCAI, type Task
     - Summary: `{{webhookData.title}}`
     - Description: `{{webhookData.description}}`
     - Labels: `portal-{{webhookData.taskId}}`
   - **Else:** leave empty (handled below)
5. **Branch rule → JQL:** `project = PCAI AND labels = "portal-{{webhookData.taskId}}"`. Inside the branch:
   - **Edit issue:** Summary `{{webhookData.title}}`, Description `{{webhookData.description}}`
   - **If** `{{webhookData.comment}}` is not empty → **Comment on issue:** `{{webhookData.comment}}`
   - **If** `{{webhookData.hoursSpent}}` is not empty → **Log work:** time spent `{{webhookData.hoursSpent}}h`
   - **If** `{{webhookData.status}}` equals `in_progress` → **Transition issue** to *In Progress*
   - **If** `{{webhookData.status}}` equals `done` → **Transition issue** to *Done*
   - (one If per status you use)
6. Turn the rule on and set "Rule actor" to an integration user so the audit trail is clear.
7. In the portal backend, set:
   ```
   JIRA_SYNC_MODE=automation
   JIRA_AUTOMATION_WEBHOOK_URL=<url from step 2>
   JIRA_AUTOMATION_WEBHOOK_TOKEN=<secret from step 2>
   ```
   and call `pushTaskToJira(task)` from `portal-hook.js` after a task is saved.

**Quick test without the portal:**
```bash
curl -X POST "<webhook URL>" \
  -H "Content-Type: application/json" \
  -H "X-Automation-Webhook-Token: <secret>" \
  -d '{"taskId":"T-1001","title":"Test from curl","status":"in_progress","comment":"hello","hoursSpent":1}'
```
Check the rule's **Audit log** in Jira if nothing happens.

**Caveats:** a brand-new issue created in step 4 won't be picked up by the step 5 branch in the same run on every Jira version, so the first post may create without transitioning; the next post updates it. Automation runs count toward your plan's monthly limit.

---

## Option B: Full integration service

### What it does
- Finds the issue by `jiraKey`, or by label `portal-<taskId>`; creates it if missing
- Updates summary, description, due date, priority, assignee (looked up by email)
- Transitions to the mapped status by reading the issue's available transitions (works with any workflow)
- Adds a comment and a worklog when provided
- HMAC-signed requests from the portal; duplicate events ignored via `X-Event-Id` (remembered across restarts)
- **Checks every task first**, like the form's preview: dates, assignee, sprint, priority, status, parent, hours. A task with problems is refused and nothing reaches Jira
- **Optional approval:** with `PORTAL_REQUIRE_APPROVAL=true`, good tasks wait in the page's **Inbox** tab until someone approves them
- Retries on Jira 429/5xx with backoff
- Returns `jiraKey` so the portal can store it
- Optional: Jira changes pushed back to the portal (`/jira/webhook`): status, assignee, due date and new comments, with a loop guard that ignores the integration user's own edits

### Replies to the portal
| Reply | Meaning |
|---|---|
| `200 { taskId, jiraKey, actions, warning?, warnings? }` | Sent to Jira. `warnings` lists things like a possible duplicate title |
| `202 { taskId, queued: true, inboxId, action }` | Approval is on: waiting in the Inbox. Nothing sent yet |
| `200 { ..., duplicate: true }` | This `X-Event-Id` was handled before; the earlier answer is repeated (after approval: the Jira result; after rejection: `rejected: true`) |
| `400 { error, code: "invalid", errors: [...] }` | The task has problems (listed). Nothing was sent. Fix it and send again; the same event id may be reused |
| `401 { code: "bad_signature" }` | Signature doesn't match |
| `502 { code: "jira_error" }` | Jira refused or failed; safe to retry |

Every error reply has the same shape: `{ error, code, errors? }`.

### Approving portal changes (Inbox)
1. Set `PORTAL_REQUIRE_APPROVAL=true` and restart (or redeploy on Netlify).
2. Open the page and the **Inbox** tab. A badge shows how many changes are waiting.
3. Each change shows what will happen (create, or update with a link to the ticket), the values, and any problems or possible duplicates.
4. **Approve and send** checks it against Jira again (Jira may have changed while it waited) and then sends it. **Reject** drops it; a reason is optional.
5. Type your name in the Inbox so each decision records who made it. The "Recently decided" list shows the last 30.

On Netlify, waiting changes are kept in Netlify Blobs; on your computer, in `data/`.

### Run it
```bash
cp env.example .env       # fill in values
npm install
npm start                 # http://localhost:8080
```
The portal side (`portal-hook.js`, `pushTaskToJira`) is not in this folder yet; it signs each request body with `PORTAL_SHARED_SECRET` and posts it to `/portal/task`.
Requires Node 22.12+ (`--env-file`, global `fetch`, and `@netlify/blobs`).

### Jira setup
1. Create an integration user (or use a service account) with access to the project.
2. Create an API token: Atlassian account → Security → API tokens.
3. Make sure the project's create/edit screens include any fields you send (priority, due date), otherwise Jira rejects them.
4. Set `STATUS_MAP_JSON` if your portal's status values differ from the defaults in `server.js`.

### Portal setup
```
JIRA_SYNC_MODE=service
JIRA_SYNC_URL=https://<host>/portal/task
PORTAL_SHARED_SECRET=<same as service>
```
Call `pushTaskToJira(task)` after save and store the returned `jiraKey` on the task.

### Optional: Jira → portal
1. Set `PORTAL_CALLBACK_URL` and `JIRA_WEBHOOK_SECRET`.
2. Jira → Settings → System → WebHooks → Create: URL `https://<host>/jira/webhook?secret=<JIRA_WEBHOOK_SECRET>`, events *Issue updated* and *Comment created*, JQL `project = PCAI`.
3. The portal receives, signed with `X-Jira-Signature` (HMAC-SHA256, same shared secret):
   ```json
   { "taskId": "T-1001", "jiraKey": "PCAI-123", "event": "updated", "status": "Done",
     "changes": { "status": "Done", "assignee": { "id": "<accountId>", "name": "Asha" }, "dueDate": "2026-12-01" } }

   { "taskId": "T-1001", "jiraKey": "PCAI-123", "event": "commented",
     "comment": { "id": "10077", "author": "Asha", "body": "Looks good", "created": "2026-10-19T10:00:00.000+0000" } }
   ```
   `changes` holds only what changed (`assignee: null` = unassigned). `status` is also at the top level, as in the first version. Changes and comments made by the integration user itself are not sent back.

### Deploy
Any place that runs Node: a small VM, container (Cloud Run / ECS / AKS), or an existing internal server. One instance is fine; if you run more than one, note that `data/` is per machine: point `lib/store.js` at a shared store (Redis, Netlify Blobs) instead.

### Troubleshooting
| Symptom | Likely cause |
|---|---|
| 401 from service | Portal secret mismatch, or body re-serialized after signing |
| Jira 400 "Field cannot be set" | Field not on the create/edit screen |
| `warning: No transition to "X"` | Workflow doesn't allow that move from current status; response lists allowed targets |
| Jira 401/403 | Token wrong or user lacks project permission |
| Assignee not set | Email not visible to the integration user (Atlassian privacy settings) |
