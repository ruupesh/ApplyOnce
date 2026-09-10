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
    // Which sites the extension runs on:
    //   "all"       -> every site, except the ones in blockedSites
    //   "allowlist" -> only the sites in allowedSites
    siteMode: "all",
    allowedSites: [],
    blockedSites: [],
    fields: {},
    // fields[key] = { value, aliases: [...], type, createdAt, updatedAt, recordedPath?: [...] }
    // File bytes are stored separately under JAA_FILE_STORAGE_PREFIX + encoded field key.
    activityLog: [],
    // activityLog[] = { ts, type, label, value, url }
    //   type: "filled" | "saved" | "file-saved" | "file-fail" | "recorded" |
    //         "replay-attempt" | "replay-success" | "replay-fail"
    applications: []
    // applications[] = { id, url, baseUrl, host, company, title, reqId, notes,
    //                    status, appliedAt, timeZone, updatedAt }
    //   status is free text; JAA_APPLICATION_STATUSES are only suggestions.
  };
}

async function getState() {
  var res = await jaaBrowser.storage.local.get(JAA_STORAGE_KEY);
  var state = res && res[JAA_STORAGE_KEY];
  if (state && typeof state === "object" && state.fields) {
    if (!state.activityLog) state.activityLog = []; // backfill for profiles saved before this existed
    if (state.siteMode !== "allowlist") state.siteMode = "all";
    if (!Array.isArray(state.allowedSites)) state.allowedSites = [];
    if (!Array.isArray(state.blockedSites)) state.blockedSites = [];
    if (!Array.isArray(state.applications)) state.applications = [];
    state.applications.forEach(jaaNormalizeApplication);
    return state;
  }
  return jaaDefaultState();
}

// ---------- Per-site on/off ----------

// Turn any hostname or pasted URL into a bare, comparable host:
// "https://www.Boards.Greenhouse.io/acme" -> "boards.greenhouse.io".
function jaaNormalizeHost(value) {
  var text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return "";
  if (text.indexOf("//") !== -1) text = text.split("//")[1] || "";
  text = text.split("/")[0];
  text = text.split("@").pop();
  text = text.split("?")[0].split("#")[0];
  text = text.replace(/:\d+$/, "");
  text = text.replace(/^\.+/, "").replace(/\.+$/, "");
  if (text.indexOf("www.") === 0) text = text.slice(4);
  return text;
}

function jaaHostFromUrl(url) {
  return jaaNormalizeHost(url);
}

// True when `host` is a list entry or a subdomain of one, so adding
// "greenhouse.io" also covers "boards.greenhouse.io".
function jaaHostInList(host, list) {
  var h = jaaNormalizeHost(host);
  if (!h || !Array.isArray(list)) return false;
  return list.some(function (entry) {
    var e = jaaNormalizeHost(entry);
    return !!e && (h === e || h.slice(-(e.length + 1)) === "." + e);
  });
}

// The single question every context asks: should ApplyOnce act on this host?
function jaaShouldRunOnHost(state, host) {
  if (!state || state.enabled === false) return false;
  var h = jaaNormalizeHost(host);
  if (!h) return false;
  if (state.siteMode === "allowlist") return jaaHostInList(h, state.allowedSites);
  return !jaaHostInList(h, state.blockedSites);
}

// ---------- Application tracking ----------
//
// Job boards never put the employer in the hostname ("wd1.myworkdaysite.com"),
// but they almost always put it in the path: Workday carries the tenant site
// ("WellsFargoJobs"), Greenhouse/Lever/Ashby carry the company as the first
// path segment. These helpers turn that into a first-draft company and title
// that the user only has to correct when the guess is wrong.

// Suggested statuses, not a closed set — a status is whatever string the user
// settles on, so these are stored as display text rather than lookup keys.
var JAA_APPLICATION_STATUSES = ["Applied", "Saved", "Interviewing", "Offer", "Rejected"];

function jaaDecodeSegment(text) {
  var raw = String(text == null ? "" : text);
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return raw; // stray "%" in the path — use it as-is
  }
}

// "WellsFargoJobs" -> "Wells Fargo Jobs"; "senior-software-engineer" -> "senior software engineer"
function jaaDeCamel(text) {
  return String(text == null ? "" : text)
    .replace(/[_+\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

// Capitalize only words that are already lowercase, so "IBM" and "eBay" survive.
function jaaTitleCase(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map(function (word) {
      return /^[a-z]/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

var JAA_COMPANY_NOISE = /^(jobs?|careers?|recruiting|hiring|talent|external|internal|portal|site)$/i;

// "WellsFargoJobs" -> "Wells Fargo"; "acme-external-careers" -> "Acme"
function jaaCleanCompany(text) {
  var words = jaaDeCamel(jaaDecodeSegment(text)).split(" ").filter(Boolean);
  while (words.length > 1 && JAA_COMPANY_NOISE.test(words[words.length - 1])) words.pop();
  if (!words.length || JAA_COMPANY_NOISE.test(words[0])) return "";
  return jaaTitleCase(words.join(" "));
}

// "Senior-Software-Engineer_R-572872" -> { title: "Senior Software Engineer", reqId: "R-572872" }
function jaaCleanTitle(text) {
  var raw = jaaDecodeSegment(text);
  var reqId = "";
  var cut = raw.lastIndexOf("_");
  if (cut > 0) {
    var tail = raw.slice(cut + 1);
    if (/^[A-Za-z]{0,4}-?\d[\w-]*$/.test(tail)) {
      reqId = tail;
      raw = raw.slice(0, cut);
    }
  }
  return { title: jaaTitleCase(jaaDeCamel(raw)), reqId: reqId };
}

function jaaParseUrl(url) {
  try {
    return new URL(String(url));
  } catch (error) {
    return null;
  }
}

// "careers.stripe.com" -> "Stripe"; last resort when no ATS pattern matches.
function jaaCompanyFromHost(host) {
  var labels = jaaNormalizeHost(host).split(".").filter(Boolean);
  while (
    labels.length > 2 &&
    /^(careers?|jobs?|apply|boards?|work|talent|hire|hiring|recruiting|my)$/i.test(labels[0])
  ) {
    labels.shift();
  }
  return jaaCleanCompany(labels[0] || "");
}

// Subdomain tenants: "careers-acme.icims.com" -> "Acme".
function jaaTenantFromHost(host) {
  var label = jaaNormalizeHost(host).split(".")[0] || "";
  return jaaCleanCompany(label.replace(/^(careers?|jobs?|apply|recruiting)[-.]/i, ""));
}

var JAA_PATH_ATS_RE =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|jobvite\.com|breezy\.hr|teamtailor\.com|pinpointhq\.com)$/;
var JAA_TENANT_ATS_RE =
  /(^|\.)(icims\.com|bamboohr\.com|recruitee\.com|taleo\.net|successfactors\.com|successfactors\.eu|applytojob\.com|oraclecloud\.com|paylocity\.com|dayforcehcm\.com)$/;

// Best-effort employer/title straight out of the URL. Empty strings mean
// "no idea" — the caller falls back to page metadata or the user.
function jaaGuessFromUrl(url) {
  var guess = { company: "", title: "", reqId: "" };
  var parsed = jaaParseUrl(url);
  if (!parsed) return guess;

  var host = jaaNormalizeHost(parsed.hostname);
  var segs = parsed.pathname.split("/").filter(Boolean);

  if (/(^|\.)(myworkdaysite\.com|myworkdayjobs\.com)$/.test(host)) {
    // .../recruiting/{tenant}/{TenantSite}/job/{Location}/{Title}_{ReqId}/...
    var jobIdx = segs.indexOf("job");
    if (jobIdx === -1) jobIdx = segs.indexOf("jobs");
    if (jobIdx > 0) {
      guess.company = jaaCleanCompany(segs[jobIdx - 1]);
      var afterJob = segs[jobIdx + 1] || "";
      var afterLocation = segs[jobIdx + 2] || "";
      var hasReqId = /_[A-Za-z]{0,4}-?\d/;
      var titleSeg = hasReqId.test(afterLocation) ? afterLocation : afterJob;
      var parsedTitle = jaaCleanTitle(titleSeg);
      guess.title = parsedTitle.title;
      guess.reqId = parsedTitle.reqId;
    }
    if (!guess.company) guess.company = jaaTenantFromHost(host);
  } else if (JAA_PATH_ATS_RE.test(host)) {
    var first = segs[0] || "";
    if (first.toLowerCase() !== "embed") guess.company = jaaCleanCompany(first);
  } else if (JAA_TENANT_ATS_RE.test(host)) {
    guess.company = jaaTenantFromHost(host);
  } else {
    guess.company = jaaCompanyFromHost(host);
  }

  return guess;
}

var JAA_LEGAL_SUFFIX_RE =
  /[\s,]+(private|pvt|pte|public)?[\s.]*(ltd|limited|llc|inc|incorporated|corp|corporation|holdings|plc|gmbh|ag|sa|nv|bv|oy|ab|as|srl|spa|pty|co)\.?$/i;

// Schema.org markup usually carries the legal entity, not the brand:
// "I01 Wells Fargo International Solutions Private LTD" -> "Wells Fargo International Solutions".
function jaaCleanLegalName(name) {
  var text = String(name || "").trim();
  text = text.replace(/^[A-Z]{1,3}\d{1,4}\s+/, ""); // internal entity code
  for (var i = 0; i < 4 && JAA_LEGAL_SUFFIX_RE.test(text); i++) {
    text = text.replace(JAA_LEGAL_SUFFIX_RE, "").trim();
  }
  return text.replace(/[\s,.]+$/, "").trim();
}

function jaaNewApplicationId() {
  return "app_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// A status is free text, but the suggested ones keep a canonical casing so
// "applied", "Applied" and "APPLIED" don't become three separate statuses.
function jaaCanonicalStatus(status) {
  var text = String(status || "").trim();
  if (!text) return JAA_APPLICATION_STATUSES[0];
  var known = JAA_APPLICATION_STATUSES.filter(function (candidate) {
    return candidate.toLowerCase() === text.toLowerCase();
  })[0];
  return known || text;
}

// Suggested statuses first, then any custom ones already in use.
function jaaApplicationStatusOptions(state) {
  var options = JAA_APPLICATION_STATUSES.slice();
  var seen = {};
  options.forEach(function (status) {
    seen[status.toLowerCase()] = true;
  });
  ((state && state.applications) || []).forEach(function (entry) {
    var status = jaaCanonicalStatus(entry.status);
    var key = status.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    options.push(status);
  });
  return options;
}

// Custom statuses have no colour of their own — they share a neutral one.
function jaaStatusClass(status) {
  var text = jaaCanonicalStatus(status).toLowerCase();
  var known = JAA_APPLICATION_STATUSES.some(function (candidate) {
    return candidate.toLowerCase() === text;
  });
  return known ? text : "custom";
}

// Bring rows written by earlier versions up to the current shape.
function jaaNormalizeApplication(entry) {
  if (!entry || typeof entry !== "object") return entry;
  if (!entry.title && entry.role) entry.title = entry.role; // "role" was renamed to "title"
  delete entry.role;
  entry.status = jaaCanonicalStatus(entry.status); // statuses were lowercase keys
  return entry;
}

function jaaLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (error) {
    return "";
  }
}

// Same posting logged twice should update, not duplicate.
function jaaFindApplicationByUrl(state, url) {
  var list = (state && state.applications) || [];
  var target = String(url || "").trim();
  if (!target) return null;
  return (
    list.filter(function (entry) {
      return String(entry.url || "").trim() === target;
    })[0] || null
  );
}

// Newest-first unique values, for the popup's type-ahead lists.
function jaaApplicationSuggestions(state, key) {
  var seen = {};
  var out = [];
  ((state && state.applications) || [])
    .slice()
    .sort(function (a, b) {
      return (b.updatedAt || b.appliedAt || 0) - (a.updatedAt || a.appliedAt || 0);
    })
    .forEach(function (entry) {
      var value = String(entry[key] || "").trim();
      var dedupe = value.toLowerCase();
      if (!value || seen[dedupe]) return;
      seen[dedupe] = true;
      out.push(value);
    });
  return out;
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
  window.jaaNormalizeHost = jaaNormalizeHost;
  window.jaaHostFromUrl = jaaHostFromUrl;
  window.jaaHostInList = jaaHostInList;
  window.jaaShouldRunOnHost = jaaShouldRunOnHost;
  window.jaaGuessFromUrl = jaaGuessFromUrl;
  window.jaaParseUrl = jaaParseUrl;
  window.jaaCleanCompany = jaaCleanCompany;
  window.jaaCleanLegalName = jaaCleanLegalName;
  window.jaaCleanTitle = jaaCleanTitle;
  window.jaaCanonicalStatus = jaaCanonicalStatus;
  window.jaaApplicationStatusOptions = jaaApplicationStatusOptions;
  window.jaaStatusClass = jaaStatusClass;
  window.jaaCompanyFromHost = jaaCompanyFromHost;
  window.jaaNewApplicationId = jaaNewApplicationId;
  window.jaaLocalTimeZone = jaaLocalTimeZone;
  window.jaaFindApplicationByUrl = jaaFindApplicationByUrl;
  window.jaaApplicationSuggestions = jaaApplicationSuggestions;
  window.JAA_APPLICATION_STATUSES = JAA_APPLICATION_STATUSES;
  window.getStoredFile = getStoredFile;
  window.setStoredFile = setStoredFile;
  window.removeStoredFile = removeStoredFile;
  window.removeAllStoredFiles = removeAllStoredFiles;
  window.renameStoredFile = renameStoredFile;
}
