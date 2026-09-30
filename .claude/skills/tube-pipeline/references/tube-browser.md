# TuBe admin page: steps and snippets

Every TuBe step runs in the owner's Chrome through **Claude in Chrome** (`mcp__claude-in-chrome__*`), on https://tube-seo.vercel.app/admin → **Prospecting**. The in-app browser is not signed in to TuBe. Never type a TuBe password: if the page shows the sign-in form, stop and ask the owner to sign in.

All snippets below were run against the live page on 2026-09-29.

## Contents
- §0 Page limits (read first)
- §1 Open the page
- §2 Which firms has TuBe scanned? (also: scan progress)
- §3 Upload + scan
- §4 Unfinished rows, Stop, worker health
- §5 Export for outreach
- §6 The in-app "Send to TuBe" path (not live yet)

## §0 Page limits

- **`javascript_tool` returns about 1,000 characters**; anything longer is cut off. Return counts and short strings, never lists. `tube-check.js` returns bitmasks for this reason. Bulk data leaves TuBe only through the export zip.
- **The Prospecting tab lists only the 5 newest batches and the newest 500 scans.** Export each batch soon after it finishes, or its buttons disappear.
- **Never trigger a browser dialog.** TuBe's **Stop** button opens `window.confirm`, which freezes the extension. Ask the owner to press Stop, or wait out the worker's 30-minute auto-clear.
- **Chrome may disconnect** mid-task. Retry once; if it still fails, tell the owner and wait. Don't switch browsers.
- Every snippet that clicks a button matches the batch **label** exactly as the page shows it (e.g. `9/25/2026, 12:49:59 PM`), and aborts unless exactly one button matches.
- **The page's own Supabase client** gives read-only queries under the owner's session. The `prospect_scans` rows are admin-readable:

  ```js
  let sb = null;
  for (const u of performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/assets\/supabase-[^/]+\.js/.test(n))) {
    try { const m = await import(u); sb = Object.values(m).find((v) => v && typeof v.from === 'function' && typeof v.rpc === 'function' && v.auth); } catch {}
    if (sb) break;
  }
  ```

## §1 Open the page

1. Call `tabs_context_mcp` with `{createIfEmpty: true}`. Use the new tab, and close it at the end.
2. In one `browser_batch`:
   - `navigate` to https://tube-seo.vercel.app/admin;
   - `computer` `wait` 3 s;
   - run the snippet below;
   - `wait` 5 s.

The tabs are Base UI and need pointer events; a plain `.click()` doesn't switch them.

```js
const t = [...document.querySelectorAll('[role="tab"]')].find((b) => /Prospecting/.test(b.textContent));
if (t) for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }));
t ? 'switched' : `no Prospecting tab (signed out?) at ${location.href}`
```

## §2 Which firms has TuBe scanned? (also: scan progress)

1. `build-upload.mts` writes `<run>/tube-check.js`, with the run's domain list inside it. Read that file and pass its **entire** text as `javascript_tool`'s `text`.
2. It answers with one line, e.g. `{"n":191,"done":191,"open":0,"errors":0,"batches":[{"id":"57791c84-…","label":"9/25/2026, 12:49:59 PM","mask":"fff…e"}]}`.
   - `done`: domains with a finished scan.
   - `open`: domains still queued or running. Watch this fall to 0 during a scan.
   - `errors`: domains whose newest scan failed.
   - `nopdf`: finished scans without a PDF. Their report page works, but TuBe's download button offers only a re-scan.
   - `batches`: which batch holds each finished domain. The mask is a hex bitmask over the domain list.
3. Save the line **verbatim** as `<run>/tube-scanned.json` (the Write tool; no edits). Then re-run `build-upload.mts --run <name>`, which decodes and records it.

An `ERROR: …` answer means nothing was checked. Don't save it.

## §3 Upload + scan (only after the owner's go)

**A. Tag the scan's hidden file input.** The "Upload CSV" button opens one of three hidden file inputs. This snippet intercepts its click to learn which one, and labels it:

```js
const orig = HTMLInputElement.prototype.click, origPicker = HTMLInputElement.prototype.showPicker;
let target = null;
HTMLInputElement.prototype.click = function () { if (this.type === 'file') { target = this; return; } return orig.call(this); };
HTMLInputElement.prototype.showPicker = function () { if (this.type === 'file') { target = this; return; } return origPicker?.call(this); };
try { [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Upload CSV')?.click(); }
finally { HTMLInputElement.prototype.click = orig; HTMLInputElement.prototype.showPicker = origPicker; }
if (target) target.setAttribute('aria-label', 'Scan CSV upload input');
target ? 'tagged the scan file input' : 'no file input was triggered'
```

**B. Attach the file.**
1. `find` "Scan CSV upload input" to get its `ref`.
2. Call `file_upload` with that `ref` and `paths: ["C:/Users/dtucc/Downloads/tube-pipeline/<run>/tube-upload-<run>.csv"]`.

**C. Check before running:**

```js
({
  run: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter((t) => /^Run \d+ from CSV$/.test(t)),
  toasts: [...document.querySelectorAll('[data-sonner-toast], li[data-type]')].map((t) => t.innerText.replace(/\s+/g, ' ').slice(0, 160)),
  depth: [...document.querySelectorAll('button')].filter((b) => /^(Cold touch|Lean|Wow)/.test(b.innerText.trim()) && b.className.includes('border-brand')).map((b) => b.innerText.trim().split('\n')[0]),
  boxes: [...document.querySelectorAll('input[type=checkbox]')].map((c) => c.checked),
})
```

Proceed only if all four hold:
- `run` is `["Run N from CSV"]`, with N equal to the upload file's row count.
- `depth` is `["Cold touch"]`.
- `boxes` is `[false, false]`: the ChatGPT and branded questions are off (owner rule: Google only, the cheapest).
- The toast says `N domains loaded from CSV`.

If anything else, stop and report.

**D. Run.**
1. `find` "Run N from CSV button", then `left_click` its `ref` (a real click).
2. `wait` 5 s, then read the toasts again. Expect `Scanning N domains (cold)… Est. ~$X`.
3. Record it with `status.mts --run <name> --mark scan --note "N firms, TuBe est. $X"`.

**E. Watch.** Re-run `tube-check.js` every few minutes: `open` falls to 0. On 2026-09-25, 184 of 191 finished in about 45 minutes, and a 7-firm re-run took 90 seconds.

## §4 Unfinished rows, Stop, worker health

**Re-run unfinished** re-scans the batch's failed or never-reached firms. It costs about 3.4¢ each, so get the owner's go:

```js
const LABEL = '9/25/2026, 12:49:59 PM'; // the batch label, exactly as shown
const hits = [...document.querySelectorAll('button')].filter((b) => /^Re-run \d+ unfinished$/.test(b.textContent.trim()) && (b.closest('div.flex')?.innerText ?? '').replace(/\s+/g, ' ').trim().startsWith(LABEL));
hits.length === 1 ? (hits[0].click(), `clicked "${hits[0].textContent.trim()}" at ${new Date().toISOString()}`) : `ABORT: ${hits.length} matching buttons`
```

"Unfinished" means rows not done, plus sheet websites the worker never reached. Re-run rows rejoin the same batch, and finished ones are skipped.

**Stop:** don't click it from Chrome (§0). The worker marks a row Error by itself once it has shown "Running" for 30 minutes.

**Worker health** (read-only). Every job the worker takes is stamped `<render pod>@<git commit>`, so this shows exactly which TuBe code is live and whether anything is stuck. Paste the §0 client lines first:

```js
const { data, error } = await sb.from('jobs').select('job_type,status,worker_id,created_at,heartbeat_at').order('created_at', { ascending: false }).limit(60);
error ? error.message : JSON.stringify({
  now: new Date().toISOString().slice(0, 16),
  worker: (data.find((j) => j.worker_id)?.worker_id ?? '').replace(/^srv-[a-z0-9]+-/, ''),
  lastJob: data.find((j) => j.worker_id)?.created_at?.slice(0, 16),
  open: data.filter((j) => ['queued', 'running'].includes(j.status)).map((j) => `${j.job_type} ${j.status} hb ${String(j.heartbeat_at).slice(11, 16)}`),
})
```

- Compare the `@commit` with `git -C "<TuBe repo>" log -1 --format=%h origin/master`.
- Render auto-deploys the worker on every push to TuBe `master`.
- Add `.eq('job_type', 'prospect_scan')` to see only scan jobs. They are visible to the owner's session.
- A scan job marked `dead` after 2 attempts means the worker gave up on it. The two stuck 2026-09-25 jobs ended that way, while their rows sat on "Running" until the worker's clean-up shipped.
- Only Michael has Render access.

## §5 Export for outreach (only after the owner's go to download)

```js
const LABEL = '9/25/2026, 12:49:59 PM';
const hits = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Export for outreach' && (b.closest('div.flex')?.innerText ?? '').replace(/\s+/g, ' ').trim().startsWith(LABEL));
hits.length !== 1 ? `ABORT: ${hits.length} matching buttons` : hits[0].disabled ? 'DISABLED: no scan in this batch has finished yet' : (hits[0].click(), `clicked at ${new Date().toISOString()}`)
```

1. `wait` 5 s, then read the toasts. Expect `Outreach export: N to send, M to review`.
2. The zip lands in `C:\Users\dtucc\Downloads\` as `<uploaded file name>-outreach.zip`. For batches this skill uploaded, that is `tube-upload-<run>-outreach.zip`; the 9/25 WA batch was uploaded as `tube-upload-wa10-2026-09-25.csv`.
3. Take the newest one created after the click:

   ```bash
   ls -t /c/Users/dtucc/Downloads/*-outreach.zip | head -3
   ```

4. Then run `validate-export.mjs --run <name> --zip "<that file>"`.

Rows not finished at export time go to TuBe's review list as UNSCANNED. Export again after they finish, and validate reads every export in the run folder, keeping the newest scan per firm.

## §6 The in-app "Send to TuBe" path (not live yet)

LeadStart has a built but unshipped **Send to TuBe** button. It lives in the Prospecting → Local businesses TuBe upload dialog and posts the sheet straight into TuBe's scan queue, HMAC-signed. It goes live when three things are done:
- secrets are set on both Vercel projects;
- both repos are pushed;
- Michael applies TuBe migration 074.

Until then, step 5 is the Chrome upload in §3. When it is live, step 5 becomes that button, and §2's check still guards against re-scans.
