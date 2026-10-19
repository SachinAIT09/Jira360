// Runs last: wires the passcode box and opens the last used tab.

$('passcode').addEventListener('change', () => { store.set('jira.passcode', $('passcode').value); loadOptions(); pullFromJira(); loadInbox(); });

showTab(store.get('jira.tab', 'single'));
loadOptions();
loadInbox();
