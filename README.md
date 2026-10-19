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

A page where the team creates or updates Jira tickets, one at a time or many at once from an Excel/CSV file. Every send shows a preview first; nothing reaches Jira until it's confirmed. Each person's recent posts are listed under the form in their own browser.

Files:

| File | What it is |
|---|---|
| `public/index.html` | The page (the only thing that is published) |
| `app.js` | The server: wires the routes together. Talks to Jira with the API token |
| `lib/jira.js` | Jira client, lookups, and the cached lists the form shows |
| `lib/sync.js` | Creates/updates tickets, moves status, adds comments and work logs (the only code that writes to Jira) |
| `lib/check.js` | Checks a task against Jira before sending (the preview) |
| `lib/bulk.js` | Reads Excel / CSV uploads |
| `lib/store.js` | Remembers things across restarts (see "Storage" below) |
| `routes/` | The web addresses: `ui.js` (the page), `portal.js` (the portal), `jira.js` (Jira webhook) |
| `server.js` | Runs `app.js` on your computer (`npm start`) |
| `netlify/functions/api.mjs`, `netlify.toml` | Runs `app.js` on Netlify |

### Storage

The server remembers which Jira ticket belongs to each task, and which portal events it has already handled, so a resend after a restart doesn't create a duplicate.
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
- HMAC-signed requests from the portal; duplicate events ignored via `X-Event-Id`
- Retries on Jira 429/5xx with backoff
- Returns `jiraKey` so the portal can store it
- Optional: Jira status changes pushed back to the portal (`/jira/webhook`), with a loop guard that ignores the integration user's own edits

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
2. Jira → Settings → System → WebHooks → Create: URL `https://<host>/jira/webhook?secret=<JIRA_WEBHOOK_SECRET>`, event *Issue updated*, JQL `project = PCAI`.
3. The portal receives `{ taskId, jiraKey, status }` signed with `X-Jira-Signature` (HMAC-SHA256, same shared secret).

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
