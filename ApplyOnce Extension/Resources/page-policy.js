/* Shared by the options page, content scripts and background worker.
 * Read storage at the execution boundary; a model argument or saved task is
 * never authority to change this setting. Missing/invalid storage fails closed.
 */
async function jaaRequirePageActions() {
  var stored = await jaaBrowser.storage.local.get("jaaPageActionsAllowed");
  if (!stored || stored.jaaPageActionsAllowed !== true) {
    var error = new Error('Page actions are disabled. Enable "Allow agent actions on pages" in Assistant settings.');
    error.code = 'PAGE_ACTIONS_DISABLED';
    if (typeof jaaDiagnostics !== 'undefined') jaaDiagnostics.log('permission_denied', { code: error.code });
    throw error;
  }
}

async function jaaSetPageActionsAllowed(allowed) {
  // A separate key prevents a transcript/model-settings save from restoring
  // permission after it was revoked in another options window.
  await jaaBrowser.storage.local.set({ jaaPageActionsAllowed: allowed === true });
}
