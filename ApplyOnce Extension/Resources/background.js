importScripts("storage.js");

// Make sure a valid default state exists on first install so the popup and
// options page never see an undefined profile.
jaaBrowser.runtime.onInstalled.addListener(async function () {
  await setState(await getState());
});
