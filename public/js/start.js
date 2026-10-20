// Runs last: signs in (or creates the first admin), then opens the last used tab.

function gate(form, text = '', kind = 'info') {
  for (const id of ['loginForm', 'setupForm', 'pwForm']) $(id).hidden = id !== form;
  $('gate').hidden = !form;
  $('shell').hidden = !!form;
  const m = $('gatemsg');
  m.className = text ? 'msg ' + kind : 'msg';
  m.textContent = text;
  if (form) $(form).querySelector('input:not([hidden])')?.focus();
}
const gateErr = text => { $('gatemsg').className = 'msg err'; $('gatemsg').textContent = text; };

let started = false;
function enter(person) {
  me = person;
  if (me.mustChange) return askNewPassword(true);
  document.body.dataset.role = me.role;
  $('meName').textContent = me.name;
  $('meRole').textContent = `${ROLE_NAMES[me.role] || me.role} · ${me.email}`;
  $('meInitial').textContent = (me.name || me.email).trim().charAt(0).toUpperCase();
  gate('');
  showTab(tabFromHash() || store.get('jira.tab', 'single'), 'replace'); // a link to a section wins over the last one used (also loads the Inbox and numbers)
  loadOptions();
  if (started) pullFromJira();
  started = true;
}

// Called by api() when the server says the session is gone
function sessionEnded() {
  if (!me) return;
  me = null;
  delete document.body.dataset.role;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  gate('loginForm', 'You were signed out. Sign in again.');
}

function askNewPassword(forced) {
  $('pwWhy').textContent = forced ? 'You signed in with a temporary password. Choose your own to continue.' : 'Other browsers where you are signed in will be signed out.';
  $('pwCancel').textContent = forced ? 'Sign out' : 'Cancel';
  $('pwUser').value = me?.email || '';
  for (const id of ['pwCur', 'pwNew', 'pwNew2']) $(id).value = '';
  gate('pwForm');
}

async function submitting(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  $('gatemsg').className = 'msg'; // the last error goes while this one is tried
  try { await fn(); } catch (err) { gateErr(err.message); } finally { btn.disabled = false; }
}

$('loginForm').addEventListener('submit', e => {
  e.preventDefault();
  submitting($('loginForm'), async () => {
    const r = await api('ui/login', postJson({ email: $('lEmail').value, password: $('lPass').value }));
    $('lPass').value = '';
    enter(r.me);
  });
});

$('setupForm').addEventListener('submit', e => {
  e.preventDefault();
  submitting($('setupForm'), async () => {
    const r = await api('ui/setup', postJson({ name: $('suName').value, email: $('suEmail').value, password: $('suPass').value, setupCode: $('suCode').value }));
    enter(r.me);
  });
});

$('pwForm').addEventListener('submit', e => {
  e.preventDefault();
  if ($('pwNew').value !== $('pwNew2').value) return gateErr('The two new passwords are not the same.');
  submitting($('pwForm'), async () => {
    const r = await api('ui/me/password', postJson({ current: $('pwCur').value, password: $('pwNew').value }));
    enter(r.me);
    $('optsState').textContent = 'Password changed';
  });
});
$('pwCancel').addEventListener('click', () => (me?.mustChange ? signOut() : gate('')));

$('mePw').addEventListener('click', () => askNewPassword(false));
// A fresh page after signing out: nothing of this person's work stays for the next one
async function signOut() {
  try { await api('ui/logout', postJson({})); } catch { /* signed out either way */ }
  location.replace(location.pathname);
}
$('meOut').addEventListener('click', signOut);

(async () => {
  let a;
  try { a = await api('ui/auth'); }
  catch (err) { gate('loginForm', err.message, 'err'); return; }
  const min = `(at least ${a.minPassword} characters)`;
  $('suMin').textContent = min; $('pwMin').textContent = min;
  $('suCodeBox').hidden = !a.setupCode;
  if (a.needsSetup) return gate('setupForm');
  if (a.me) return enter(a.me);
  gate('loginForm');
})();
