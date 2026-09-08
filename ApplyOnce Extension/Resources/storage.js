/*
Shared storage + label-matching utilities.
Loaded in three contexts: the background service worker (via importScripts),
the content script (declared before content.js in the manifest so they share one
global scope), and the popup/options pages (via a <script> tag). Plain function
declarations here become callable by bare name in all three.
*/

var jaaBrowser =
  typeof browser !== "undefined"
    ? browser
    : typeof chrome !== "undefined"
      ? chrome
      : null;

var JAA_STORAGE_KEY = "jaaState";
var JAA_FILE_STORAGE_PREFIX = "jaaFile:";
var JAA_MAX_STORED_FILE_BYTES = 20 * 1024 * 1024;

var JAA_ACTIVITY_LOG_MAX = 300;

function jaaDefaultState() {
  return {
    version: 1,
    enabled: true,
    fields: {},
    // fields[key] = { value, aliases: [...], type, createdAt, updatedAt, recordedPath?: [...] }
    // File bytes are stored separately under JAA_FILE_STORAGE_PREFIX + encoded field key.
    activityLog: []
    // activityLog[] = { ts, type, label, value, url }
    //   type: "filled" | "saved" | "file-saved" | "file-fail" | "recorded" |
    //         "replay-attempt" | "replay-success" | "replay-fail"
  };
}

async function getState() {
  var res = await jaaBrowser.storage.local.get(JAA_STORAGE_KEY);
  var state = res && res[JAA_STORAGE_KEY];
  if (state && typeof state === "object" && state.fields) {
    if (!state.activityLog) state.activityLog = []; // backfill for profiles saved before this existed
    return state;
  }
  return jaaDefaultState();
}

async function setState(state) {
  var wrapped = {};
  wrapped[JAA_STORAGE_KEY] = state;
  await jaaBrowser.storage.local.set(wrapped);
}

function storedFileKey(fieldKey) {
  return JAA_FILE_STORAGE_PREFIX + encodeURIComponent(fieldKey);
}

async function getStoredFile(fieldKey) {
  var storageKey = storedFileKey(fieldKey);
  var res = await jaaBrowser.storage.local.get(storageKey);
  return res?.[storageKey] || null;
}

async function setStoredFile(fieldKey, fileRecord) {
  var value = {};
  value[storedFileKey(fieldKey)] = fileRecord;
  await jaaBrowser.storage.local.set(value);
}

async function removeStoredFile(fieldKey) {
  await jaaBrowser.storage.local.remove(storedFileKey(fieldKey));
}

async function removeAllStoredFiles() {
  var res = await jaaBrowser.storage.local.get(null);
  var keys = Object.keys(res || {}).filter(function (key) {
    return key.indexOf(JAA_FILE_STORAGE_PREFIX) === 0;
  });
  if (keys.length) await jaaBrowser.storage.local.remove(keys);
}

async function renameStoredFile(oldKey, newKey) {
  if (oldKey === newKey) return;
  var fileRecord = await getStoredFile(oldKey);
  if (!fileRecord) return;
  await setStoredFile(newKey, fileRecord);
  await removeStoredFile(oldKey);
}

// Collapse whitespace, strip required/optional markers and punctuation noise,
// lowercase — so "Email Address *" and "email address" compare equal.
function normalizeLabel(label) {
  return (label || "")
    .toString()
    .toLowerCase()
    .replace(/\(optional\)/g, " ")
    .replace(/\(required\)/g, " ")
    .replace(/[*:]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(label) {
  var norm = normalizeLabel(label).replace(/\s+/g, "_");
  return (norm || "field").slice(0, 60);
}

function uniqueKey(state, base) {
  var key = base || "field";
  var i = 2;
  while (state.fields && state.fields[key]) {
    key = base + "_" + i;
    i++;
  }
  return key;
}

// How close a containment match must be before it counts. A loose substring
// test is actively dangerous here: the saved alias "country" appears inside
// "...enter in the currency of the country where this position is located..."
// (the salary question) and inside "...to work in the country you are applying
// to work in..." (the visa question), so a naive match typed the user's
// country into their expected-salary box. Wrong data on a real job
// application is far worse than an unmatched field, which merely gets saved
// as a new entry the user can merge later — so this errs strict.
var JAA_MIN_CONTAINMENT_RATIO = 0.6;

// Both strings are normalized (lowercase, space-separated words), so padding
// with spaces makes this a true whole-word check rather than a substring one.
function containsWholePhrase(longer, shorter) {
  return (" " + longer + " ").indexOf(" " + shorter + " ") !== -1;
}

// Exact alias match wins outright. Otherwise accept a containment match only
// when the two are near-equivalent phrases -- i.e. one is the other plus a
// little trailing helper text -- never when a short generic alias merely
// appears somewhere inside a long question.
function findMatchingKey(state, label) {
  var norm = normalizeLabel(label);
  if (!norm || !state || !state.fields) return null;

  var best = null;
  var bestRatio = 0;

  for (var key in state.fields) {
    if (!Object.prototype.hasOwnProperty.call(state.fields, key)) continue;
    // Imported profiles often use the response/API field name as the key,
    // while the page shows a friendlier question. Treat both as aliases.
    var aliases = [key].concat(state.fields[key].aliases || []);
    for (var i = 0; i < aliases.length; i++) {
      var na = normalizeLabel(aliases[i]);
      if (!na) continue;
      if (na === norm) return key;

      var shorter = na.length <= norm.length ? na : norm;
      var longer = na.length <= norm.length ? norm : na;

      // A single word is too generic to anchor a fuzzy match on ("country",
      // "name", "date"). Require exact equality for those, handled above.
      if (shorter.indexOf(" ") === -1) continue;
      if (!containsWholePhrase(longer, shorter)) continue;

      var ratio = shorter.length / longer.length;
      if (ratio < JAA_MIN_CONTAINMENT_RATIO) continue;

      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = key;
      }
    }
  }
  return best;
}

if (typeof window !== "undefined") {
  window.getState = getState;
  window.setState = setState;
  window.normalizeLabel = normalizeLabel;
  window.slugify = slugify;
  window.uniqueKey = uniqueKey;
  window.findMatchingKey = findMatchingKey;
  window.jaaDefaultState = jaaDefaultState;
  window.getStoredFile = getStoredFile;
  window.setStoredFile = setStoredFile;
  window.removeStoredFile = removeStoredFile;
  window.removeAllStoredFiles = removeAllStoredFiles;
  window.renameStoredFile = renameStoredFile;
}
