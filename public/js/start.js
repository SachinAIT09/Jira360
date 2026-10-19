// Runs last: asks which passcodes are needed, wires the passcode box and opens the last used tab.

$('passcode').addEventListener('change', () => { store.set('jira.passcode', $('passcode').value); loadOptions(); pullFromJira(); loadInbox(); });

(async () => {
  try { auth = await (await fetch('ui/auth')).json(); } catch { /* an older server: keep asking for passcodes */ }
  // No passcode set on the server: no box to fill in
  for (const el of [$('passcode'), document.querySelector('label[for="passcode"]')]) el.hidden = !auth.passcode;
  if (!auth.admin) $('slock').hidden = true;
  showTab(store.get('jira.tab', 'single'));
  loadOptions();
  loadInbox();
})();
