# ApplyOnce Autofill Engine

Fills job application forms from a saved JSON profile, and automatically
learns new fields as you type. The web-extension layer uses Manifest V3 and
dependency-free vanilla JavaScript.

## Source location

All runtime files live directly in `ApplyOnce Extension/Resources`, as
expected by the Safari Web Extension target. See the repository `README.md`
for Xcode build and Safari activation instructions.

## How it works

**`storage.js`** — shared module (loaded by the background worker, the
content script, and both UI pages) that owns the single JSON profile stored
in WebExtensions local storage:

```json
{
  "version": 1,
  "enabled": true,
  "fields": {
    "email": {
      "value": "you@example.com",
      "aliases": ["Email", "Email Address", "Work Email"],
      "type": "text",
      "createdAt": 1699999999999,
      "updatedAt": 1699999999999
    }
  }
}
```

Each key is one profile field: a `value`, a list of `aliases` (every label
wording seen "in the wild" that should map to it), a `type`, and timestamps.
The key itself also participates in matching, so an imported/API-facing name
such as `source` can match even when the page displays a friendlier question.

Stored file bytes use separate `jaaFile:*` records in local extension storage.
The profile only keeps the filename, MIME type, size, and field aliases, so
normal scans and JSON exports do not repeatedly load or serialize the file.

**`content.js`** — runs on every page (including iframes, since ATS widgets
like Greenhouse are often embedded). It:

1. Scans `input`/`textarea`/`select` elements (and radio-button groups) for
  both the human label and stable technical aliases such as `name`, `id`,
  `data-automation-id`, and Workday's `formField-*` identifier. Generated
  GUIDs and generic names such as `Search` are discarded.
2. Matches that label against every field's `aliases` (exact match first,
   then whole-phrase containment) via `findMatchingKey`.
3. Fills matches, using React/Vue-safe value setting (native property
   setter + `input`/`change`/`blur` events) so framework-driven forms pick
   the value up correctly.
4. Listens for edits on every field it touches. If you correct a filled
   value, that correction is saved back as the new value for that key. If
   you type into a field that didn't match anything, a **brand-new field is
   created automatically** — keyed by a slug of its label, with that label
   recorded as its first alias.
5. Re-scans on DOM mutations (debounced) so it keeps up with multi-step /
   single-page-app forms like Workday.
6. Separately, also scans every `data-automation-id="formField-*"` container
   for Workday-style custom widgets (chip-based multiselects like "How Did
   You Hear About Us?", button-based single-selects like Country) whose
   selected answer lives in sibling DOM rather than in any element's
   `.value` — a plain input/select scan can't see those at all. It reads the
   real selected text (chip labels, or a button's own text, filtering out
   placeholder text like "Select One") and saves it the same way. This is
   what makes fields that only *look* like radio buttons (Workday renders
   dropdown leaf options as styled `<li>`s, not real `<input type="radio">`)
   get captured too.
7. For nested-category widgets specifically, it first replays a saved path
  when one exists. With only a leaf value, it performs a bounded traversal
  of rows that Workday explicitly marks as parent categories; it never
  clicks a non-matching leaf. Once it finds an exact normalized leaf match,
  it selects it and saves the discovered path. Manual choices are still
  recorded too, so repeat fills take the shortest direct route.
8. Handles native file inputs, including hidden inputs inside Workday's
  button-based attachment wrappers. A stored resume is reconstructed as a
  browser `File`, assigned through `DataTransfer`, checked against the
  input's `accept` rule, and verified in `input.files` after `change` fires.
  Selecting a file manually on an application also learns and stores it.
9. Handles Oracle Candidate Experience (`*.fa.oraclecloud.com`) in a separate,
   host-gated adapter. It scans only the currently visible SPA section,
   resolves Oracle's stable field names to canonical profile keys, fills
   pill-button questions, and operates `role="combobox"` grids through each
   input's own `aria-controls` popup. Options are clicked only after an exact
   normalized match; large grids may be filtered first, and an unmatched
   search is restored and closed instead of leaving invalid text behind.

### Workday dropdown mechanics (verified by testing against a live form)

Getting replay to actually work required three non-obvious fixes. All were
found by instrumenting a real Wells Fargo Workday application, not guessed:

- **Scope to the open popup.** The open dropdown is one
  `[data-automation-id="activeListContainer"]`, portaled outside the field's
  own container. A document-wide search for menu rows also matches rows
  belonging to *other* widgets on the page (the phone-country list showed up
  as `India (+91)`), which is how an earlier build picked "Job Board" when
  asked for "LinkedIn".
- **The list is ReactVirtualized — scroll before you search.** Only the two
  or three rows currently in view exist in the DOM. "Social Media" simply
  *is not present* until the grid is scrolled down, so any
  find-then-click approach fails on anything below the fold. The fix steps
  `grid.scrollTop` and re-checks as rows render in.
- **Click the inner `promptLeafNode`, with real pointer events.** A bare
  `.click()` on a row does nothing. Even a full
  pointerdown/mousedown/mouseup/click sequence on the `menuItem` wrapper
  does nothing. The handler lives on the inner `promptLeafNode` and needs
  the full sequence. (`menuItem` is the row; `promptLeafNode` is its
  clickable child; `promptOption` is the text — matching on both `menuItem`
  and `promptLeafNode`, as an earlier build did, also double-counted every
  row.)

- **Two different popup flavours exist.** The big taxonomy pickers use the
  virtualized `activeListContainer` described above. The short Application
  Questions dropdowns instead use a plain `[role="listbox"]` of
  `<li role="option">` — not virtualized, no `activeListContainer` at all.
  Code that only knew about the first flavour silently found nothing on the
  second.
- **Not every field's question lives in a `<label>`.** My Information fields
  use `<label>`; Application Questions use `<fieldset><legend>`. Reading only
  `<label>` made those fields fall back to their `data-automation-id` — which
  for Application Questions is a **random per-posting GUID**
  (`formField-21e8358308c8100011df2cd1a0360000`). So "Are you a current or
  former Wells Fargo employee?" answered on one posting could never match the
  identical question on the next one; it just minted a new junk key each time.
  Labels now come from `legend` first, then `<label>`, and a bare hex blob is
  rejected as a label outright.

Also worth knowing: the widget's **"Search" box does not filter** this
list — typing into it, with or without Enter, leaves the categories
unchanged. That's why there's no text-search shortcut and the recorded-path
and branch-traversal approaches are necessary rather than merely convenient.

- **Nested discovery traverses categories, not guesses.** Parent rows expose
  a stable side-charm/chevron marker. The extension may open those rows to
  inspect their children, but it only clicks a leaf when that leaf exactly
  matches the saved value. It closes and reopens the widget at its root
  between branches, caps depth/menu count, serializes multiple custom-field
  fills, and suppresses duplicate mutation-driven attempts.

Replay waits for each step to actually render (polling up to 3s per step)
rather than sleeping a fixed amount, and **verifies a value actually landed**
before reporting success — so "Replay OK" in the Activity Log means the chip
is really there, not just that clicks were dispatched.

A small "ApplyOnce: filled N fields" badge appears bottom-right after any
pass that changes something, so you can see it working without it being
noisy — it stays silent on passive scans that find nothing new.

**`popup.html`/`popup.js`** — quick status (saved field count, this page's
matched/unmapped count), the actual **list of unmapped field labels on the
current page** (not just a count), an enable/disable toggle, a manual
"Rescan & Autofill This Page" button, and a link to the full editor.

**`options.html`/`options.js`** — opens in a full tab, two views:

- **Fields** — edit any key/value/type/alias-list inline, delete fields, add
  one manually, use **Add Resume** to store or replace a local PDF/DOC/DOCX,
  search, a **Path** column showing a badge (hover for the
  steps) on any field with a recorded click-path, and **Export JSON** /
  **Import JSON** to back up or hand-edit your whole profile outside the
  browser. Any field set to type `file` gets its own choose/replace/remove
  controls. Files are capped at 20 MB.
- **Activity Log** — a live dashboard of what the extension has actually
  done: every autofill, every save (including brand-new fields it created),
  every path recording, and every replay attempt/success/failure, newest
  first, with the field label, value/detail, and site. Updates live via
  `storage.onChanged` while the page is open — leave it open in a tab
  while you fill out an application to watch it work in real time. Capped
  at the most recent 300 events; "Clear Log" wipes it (saved field values
  are untouched).

## Field types handled

| Type | How it's filled | How it's saved |
|---|---|---|
| text / email / tel / number / url / search | native value set | plain string |
| textarea | native value set | plain string |
| date / datetime-local / month / time / week | native value set using the browser's required value format | plain string |
| color / range | native value set; implicit browser defaults may be replaced | plain string |
| file / resume upload | reconstructs the locally stored file, enforces `accept`, assigns `input.files`, and emits `input`/`change` | filename and metadata in the profile; bytes in a separate local record |
| `<select>` | matches visible text or submitted `value`; supports comma-separated native multi-select values | selected option text(s) |
| checkbox | checked if stored value looks truthy (`yes`/`true`/`1`/`on`) | `"Yes"` / `"No"` |
| radio group | matches stored value against the visible label or submitted `value`, then clicks it | the selected radio's visible label |
| Workday-style `formField-*` widgets **with a recorded path** | normal scans replay the exact path, polling for each menu level | reads the actual selected chip/button text and keeps the path |
| Workday-style `formField-*` widgets **with no recorded path yet**, button single-selects only (e.g. Country) | opens the list and clicks an exact matching option (polls up to 3s per stage) | same passive save as above |
| Workday-style nested chip/taxonomy widgets **with no recorded path** | normal scans safely traverse marked parent categories until an exact leaf matches, then save the path | selected text plus discovered path |
| Oracle Candidate Experience pill groups | exact saved answer clicks for Title and Yes/No-style questions; manual answers are learned | selected pill text |
| Oracle Candidate Experience grid comboboxes | serialized, popup-scoped exact matching for geography, dates, education, diversity, and similar pickers | explicit user choices are learned; automated display formatting does not overwrite richer shared values |
| Oracle Candidate Experience multi-selects | preserves existing pills, respects explicit limits such as “top 2,” and clicks only exact listbox options; programming-language questions can derive ordered exact matches from the saved skills list | selected pill text joined as a comma-separated value |
| generic `role="combobox"`/`role="listbox"` widgets (non-Workday) | best-effort: click to open, type into any inner `<input>`, click the matching `role="option"` | not auto-saved (too unreliable to trust a scraped value from arbitrary unknown markup) |

Every fill/save/record/replay event is visible in the **Activity Log** tab
of the full editor as it happens, including failures (e.g. "Replay failed —
stuck at step 2") so you can see exactly what it tried.

## Alias matching — why it errs strict

Exact (normalized) label match always wins. Candidates include the profile
key, saved aliases, the visible description, and stable technical DOM names.
When a field is saved, both its visible and technical aliases are learned.
A fuzzy *containment* match is only accepted when the two labels are
near-equivalent phrases: whole-word aligned, the shorter at least 60% the
length of the longer, and never on a single-word alias.

That strictness is deliberate, and was added after a real failure. The saved
alias `Country` (7 chars) was substring-matching two unrelated questions that
merely contain the word "country":

- *"…enter in the currency of the **country** where this position is
  located…"* — the expected-salary box, which got filled with `India`
- *"…require sponsorship … to work in the **country** you are applying to
  work in…"* — a Yes/No dropdown, where `India` matched no option, so it
  silently stayed empty

Wrong data on a real job application is far worse than an unmatched field
(which just gets saved as a new entry you can merge in the editor), so the
matcher biases hard toward "don't guess". The practical cost is that a
genuinely new wording variant creates a new field the first time it's seen
instead of being auto-merged.

## Safety / privacy

- Everything lives in Safari's local extension storage on your device. Nothing is
  sent anywhere.
- Resume/file bytes are stored locally as base64 and capped at 20 MB per
  field. They are deliberately excluded from profile JSON exports, so after
  importing a profile on another device you must select the file again.
- Fields whose label matches password, SSN, passport, driver's license,
  card/CVV, bank account/routing number, or PIN patterns are **never read,
  filled, or saved** — see `SENSITIVE_LABEL_RE` in `content.js`. This is a
  hard exclusion, not a setting.
- Passive scanning (auto-fill without you clicking anything) only engages
  on pages with at least 3 fillable fields, to avoid the extension doing
  anything on ordinary search boxes and login forms across the web. The
  toggle in the popup/options page turns it off globally at any time.

## Known limitations

- Automatic nested discovery depends on Workday exposing parent rows with
  its current side-charm/chevron metadata. If that markup changes, discovery
  stops and logs a failure instead of clicking an unrelated leaf. A manual
  choice will still be captured when Workday retains its `menuItem` markup.
- Oracle support is isolated by hostname and does not call or modify the
  Workday replay path. Oracle keeps inactive application sections mounted in
  the DOM, so only controls with a visible active wrapper are scanned.
- Oracle repeatable Education/Experience records still use one profile value
  per logical key. The extension fills an opened editor from those values but
  never clicks Add/Save/Submit; review each repeated record before saving it.
- File autofill requires a real `<input type="file">`, visible or hidden.
  Upload components implemented entirely as a proprietary drag/drop API may
  still need a manual drop. Sites that reject script-dispatched events will
  log `File failed` instead of reporting a false success.
  Standard HTML form controls (the vast majority of
  Greenhouse/Lever/iCIMS/company-career-page forms) are fully automatic
  from the very first fill.
- Recorded paths assume the site's own menu text stays the same between
  visits (e.g. "Social Media" → "LinkedIn" wording). If a company changes
  their form's option labels, a stale recorded path will fail to find a
  match at that step and log a "Replay failed" entry rather than clicking
  something wrong — check the Activity Log tab if a fill silently doesn't
  happen, and just re-pick it by hand to re-record.
- The custom-widget support is keyed to Workday's `data-automation-id`
  convention specifically. Other ATS platforms with their own heavily
  custom (non-native) dropdown components would need similar
  platform-specific handling added the same way.
- Label detection is heuristic. If a page's label placement is unusual, the
  saved alias might come out named after the field's `name`/`id` attribute
  instead of readable text — you can rename any key in the full editor.
- No account/multi-device sync — the profile is local to this Safari extension.
  Use Export/Import JSON to move it elsewhere.
