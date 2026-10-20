// Settings → People (admins): who can sign in, and their role. A new person, or a reset, gets a
// temporary password shown once here; they choose their own at first sign-in.

const ROLE_NAMES = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
let people = [];
function ushow(kind, html) { const m = $('umsg'); m.className = 'msg ' + kind; m.innerHTML = html; }

async function loadUsers() {
  if (!can('admin')) return;
  try { people = (await api('ui/users')).users; renderUsers(); }
  catch (err) { ushow('err', 'People not loaded: ' + esc(err.message)); }
}

function renderUsers() {
  $('utable').innerHTML = '<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
    people.map(u => {
      const self = u.email === me?.email;
      return `<tr data-email="${esc(u.email)}"${u.disabled ? ' class="muted"' : ''}>` +
        `<td>${esc(u.name)}${self ? ' <span class="srctag">you</span>' : ''}${u.disabled ? ' <span class="tag tag-grey">off</span>' : u.mustChange ? ' <span class="tag tag-amber">temporary password</span>' : ''}</td>` +
        `<td>${esc(u.email)}</td>` +
        `<td><select data-role aria-label="Role of ${esc(u.name)}" class="w-auto py-1"${self ? ' disabled title="Another admin can change your role"' : ''}>${Object.entries(ROLE_NAMES).map(([v, t]) => `<option value="${v}"${v === u.role ? ' selected' : ''}>${t}</option>`).join('')}</select></td>` +
        `<td>${u.lastLogin ? esc(when(u.lastLogin)) : '<span class="muted">never</span>'}</td>` +
        `<td class="whitespace-nowrap">` + (self ? '<span class="muted">Use "Change password" in the menu</span>'
          : `<button class="linkbtn" type="button" data-reset>Reset password</button> · ` +
            `<button class="linkbtn" type="button" data-toggle>${u.disabled ? 'Switch on' : 'Switch off'}</button> · ` +
            `<button class="linkbtn errt" type="button" data-delete>Delete</button>`) + '</td></tr>';
    }).join('') + '</tbody>';
}

// The temporary password, with a copy button (shown once: the server keeps only its hash)
function showTemp(email, password, what) {
  ushow('ok', `${what} Temporary password for <b>${esc(email)}</b>: <code id="uTemp">${esc(password)}</code> ` +
    '<button class="linkbtn" type="button" id="uCopy">Copy</button><br>Give it to them privately; they choose their own at first sign-in. It isn\'t shown again.');
  $('uCopy').addEventListener('click', () => navigator.clipboard?.writeText(password).then(() => { $('uCopy').textContent = 'Copied'; }));
}

async function changeUser(email, body, done) {
  ushow('info', 'Saving…');
  try {
    const r = await api('ui/users/' + encodeURIComponent(email), postJson(body));
    if (r.tempPassword) showTemp(email, r.tempPassword, done);
    else ushow('ok', esc(done));
    await loadUsers();
  } catch (err) {
    ushow('err', esc(err.message));
    renderUsers(); // put a refused role change back
  }
}

$('utable').addEventListener('change', e => {
  const sel = e.target.closest('select[data-role]');
  if (!sel) return;
  const email = sel.closest('tr').dataset.email;
  changeUser(email, { role: sel.value }, `${email} is now ${ROLE_NAMES[sel.value]}.`);
});
$('utable').addEventListener('click', e => {
  const btn = e.target.closest('button');
  const email = btn?.closest('tr')?.dataset.email;
  if (!email) return;
  const u = people.find(p => p.email === email);
  if (btn.hasAttribute('data-reset') && confirm(`Give ${email} a new temporary password? Their current password stops working and they are signed out.`))
    changeUser(email, { resetPassword: true }, 'Password reset.');
  if (btn.hasAttribute('data-toggle'))
    changeUser(email, { disabled: !u.disabled }, u.disabled ? `${email} can sign in again.` : `${email} is switched off and signed out.`);
  if (btn.hasAttribute('data-delete') && confirm(`Delete the account of ${email}? Their past Activity stays.`))
    changeUser(email, { delete: true }, `${email} deleted.`);
});

$('uAdd').addEventListener('click', async () => {
  const email = $('uEmail').value.trim();
  if (!email) return ushow('err', 'Type their email.');
  $('uAdd').disabled = true;
  ushow('info', 'Adding…');
  try {
    const r = await api('ui/users', postJson({ email, name: $('uName').value.trim(), role: $('uRole').value }));
    showTemp(r.user.email, r.tempPassword, `Added ${r.user.name} as ${ROLE_NAMES[r.user.role]}.`);
    $('uEmail').value = ''; $('uName').value = '';
    await loadUsers();
  } catch (err) {
    ushow('err', esc(err.message));
  } finally {
    $('uAdd').disabled = false;
  }
});
