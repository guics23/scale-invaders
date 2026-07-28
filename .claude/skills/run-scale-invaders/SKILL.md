---
name: run-scale-invaders
description: Build, run, drive, and screenshot Scale Invaders (the interval-training game in index.html). Use when asked to run, start, launch, test, verify, or screenshot the game, or to confirm a change works in the real app — key changes, the countdown overlay, scoring, game over, or mobile layout.
---

Scale Invaders is a **single self-contained `index.html`** — no package.json, no
build, no dependencies, no test suite. It runs off `file://`, so there is no dev
server either.

It is driven headlessly by `.claude/skills/run-scale-invaders/driver.mjs`, which
launches Chrome and speaks raw CDP over node's built-in WebSocket — there is no
`chromium-cli`, playwright, or puppeteer installed here, and the driver needs no
dependencies. The driver reads commands on stdin, one per line.
**Paths below are relative to the repo root.**

## Prerequisites

Already present on this machine; nothing to install:

```bash
google-chrome --version   # Chrome/150.0.7871.186
node --version            # v22.14.0 — needs >= 22 for the built-in WebSocket
```

No `apt-get` needed, no X server needed. The driver passes `--no-sandbox` and a
throwaway `--user-data-dir`, which is the configuration verified here.

## Build

None. Edit `index.html` and reload. The nearest thing to a compile step is a
syntax check of the inline script — worth running after an edit, since a syntax
error yields a blank page with no obvious clue:

```bash
node -e '
const html = require("fs").readFileSync("index.html","utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if(!blocks.length) throw new Error("no inline script found");
blocks.forEach(js => new Function(js));
console.log(blocks.length + " inline script block(s) parse OK");
'
```

Note the non-greedy `*?` and the loop: there are **two** inline blocks now (the PWA
service-worker registration in `<head>`, then the game). A greedy `<script>([\s\S]*)`
spans from the first `<script>` to the last `</script>`, swallows the tags between
them, and reports a bogus `SyntaxError: Unexpected token '<'`.

## Run (agent path)

**Everything at once** — both modes, both tonalities, the key-change countdown,
real keyboard input, a scored hit, game over, and two mobile viewports:

```bash
bash .claude/skills/run-scale-invaders/smoke.sh
```

Screenshots land in `/tmp/scale-invaders-shots/` (override with `SI_SHOTS`).
It exits non-zero on the first failed step. **Open the screenshots** — this app
is almost entirely canvas, so a passing script proves nothing about what
rendered.

**For one specific thing**, pipe your own commands. The countdown overlay:

```bash
node .claude/skills/run-scale-invaders/driver.mjs <<'EOF'
nav
click #startArcadeBtn
until document.getElementById('keyIntroOverlay').classList.contains('show') @3000
text #keyIntroOverlay
si key
shot my-check
errors
quit
EOF
```

Verified output:

```
# google-chrome Chrome/150.0.7871.186  shots -> /tmp/scale-invaders-shots
nav -> file:///home/debelop/www/scale_invaders/index.html?sitest
click #startArcadeBtn -> clicked
until ... -> true after 0ms
text #keyIntroOverlay -> Get ready! | Key of G Major is coming in | 3 | 1 SHARP
si key -> "G"
shot my-check -> /tmp/scale-invaders-shots/my-check.png
errors -> none
```

### Driver commands

| Command | What it does |
|---|---|
| `nav [query]` | Load `index.html`; defaults to `?sitest`. `nav plain` loads it with no query, as a player gets it. An absolute `http(s)://` URL is used verbatim (needed for PWA work). Waits for the app to be *ready*, not just parsed. |
| `viewport <w> <h> [true]` | Resize; third arg `true` = mobile emulation at DPR 2 **plus touch**. Set it BEFORE `nav`. |
| `click <selector>` | `querySelector(...).click()`; errors if no match. Bypasses hit-testing — anything covering the element is ignored. |
| `tap <selector>` | A **real** click at the element's centre, hit-tested. Reports what the pointer actually hit. Use this to answer "can a user reach this?" |
| `tapxy <x> <y>` | Same, at CSS coordinates — for canvas taps, where there is no element to select. |
| `drag <x1> <y1> <x2> <y2> [steps] [ms]` | Real press-move-release (touch or mouse to match the mode). Required for steering: the game tells a tap from a drag by distance travelled. |
| `press <Code>` / `hold <Code> <ms>` | Real key events. `Space` (fire), `ArrowLeft`/`ArrowRight`, `KeyA`/`KeyD` (also move), `Escape` (pause). |
| `until <expr> [@ms]` | Poll every 50ms until truthy (default 10s). **The way to wait.** |
| `wait <ms>` | Dumb sleep — only for "let a frame paint". |
| `eval <js>` | Evaluate in the page, print the result. |
| `si <method>` | Call the `?sitest` seam, e.g. `si key`, `si score`, `si win`. |
| `text <selector>` | `innerText` with newlines flattened to ` \| `. |
| `shipx` | Ship's x in canvas backing-store px, read back off the canvas pixels. |
| `shot <name>` | PNG to `$SI_SHOTS/<name>.png`. |
| `offline on\|off` | Cut the network via CDP, to prove the service worker is serving. |
| `reload` | Reload the current page. |
| `pwa` | Installability report: manifest URL + parse errors, icons, worker state, whether `beforeinstallprompt` fired. |
| `errors` | Console errors + uncaught exceptions since load, or `none`. |
| `quit` | Kill Chrome, clean the temp profile, exit 0. |

### The `?sitest` seam — how to reach game internals

`index.html` attaches `window.__si` **only** when the URL contains `sitest`
(the driver's `nav` adds it by default). This is the whole story for
direct-invocation-style testing: the script is one big IIFE, so nothing else is
reachable from outside, and there is no way to import a function in node.

Read state: `si key`, `si tonality`, `si rounds`, `si lockTarget`, `si locked`,
`si noteYs`, `si interval`, `si correctNote`, `si score`, `si streak`,
`si lives`, `si running`, `si bullets`, `si shipX`, `si targetX`.

`si bullets` is how you assert a shot happened; `si targetX` is the pending drag
destination (`null` when idle), which is what proves a drag was speed-capped rather
than a teleport.

Drive outcomes through the **real** code paths — these call the game's own
`correctHit` / `wrongHit` / `missedCorrect`:

```
si win      # shoot the correct note
si wrong    # shoot a wrong note
si miss     # let the correct note fall past (costs a life)
```

Use these instead of trying to aim. Note x positions are not exposed, so a
genuine aimed shot is not scriptable — `press Space` proves firing works, `si
win` proves scoring works. To advance many questions (reach level 2+, force key
changes), loop `si win`; a run of 8–12 questions per key is randomized, so don't
assume a fixed count.

If you need state the seam doesn't expose, add an accessor to the `__si` object
near the bottom of `index.html` rather than reaching into the closure.

### Checking a key pool

Level pools are random per game, so one run tells you nothing about coverage.
Restart repeatedly and tally — this is how to confirm which keys a level can
draw (here: minor mode, level 1):

```bash
{ echo "nav"; echo 'click [data-ton="minor"]'
  for i in $(seq 1 16); do
    echo "click #startArcadeBtn"; echo "si key"
    echo "click #pauseBtn"; echo "click #quitBtn"
  done
  echo quit; } | node .claude/skills/run-scale-invaders/driver.mjs | grep "^si key" | sort | uniq -c
```

```
      5 si key -> "A"
      4 si key -> "B"
      3 si key -> "D"
      4 si key -> "E"
```

`#pauseBtn` then `#quitBtn` is the way back to the menu mid-game; `#menuBtn` only
exists on the game-over screen.

### PWA (installable / offline)

`file://` cannot run a service worker, so anything about installability or offline
play needs a real origin. Serve the repo root and drive that URL:

```bash
python3 -m http.server 8099 --bind 127.0.0.1 &
node .claude/skills/run-scale-invaders/driver.mjs <<'EOF'
nav http://127.0.0.1:8099/index.html?sitest
until !!navigator.serviceWorker.controller @9000
pwa
errors
quit
EOF
```

Verified output — `beforeinstallprompt: true` is the only real proof Chrome would
offer to install it; the rest is necessary but not sufficient:

```
{"manifestUrl":"http://127.0.0.1:8099/manifest.webmanifest","manifestErrors":[],
 "name":"Scale Invaders — Learn Your Intervals",
 "icons":["192x192 any","512x512 any","512x512 maskable"],
 "serviceWorker":"active (controlling)","beforeinstallprompt":true}
```

To prove offline play, warm the cache and then **kill the server** — that is
unambiguous, whereas `offline on` (CDP emulation) left `navigator.onLine === true`:

```
nav http://127.0.0.1:8099/index.html?sitest
until !!navigator.serviceWorker.controller @9000
wait 1500              # let the shell + fonts land in the cache
# ...kill the http server here...
reload
until !!window.__si @9000
click #startArcadeBtn  # plays, custom fonts and all
```

Stop the server with a self-excluding pattern: `kill $(pgrep -f "http.serve[r] 8099")`.

Files involved: `manifest.webmanifest`, `sw.js`, `icons/` (generated — regenerate with
`node tools/make-icons.mjs`, which renders the favicon artwork through headless Chrome
because ImageMagick's SVG delegate mangles the note's flag path).

## Run (human path)

Open `index.html` in any browser — it's a static file, no server and no flags
needed (the driver loads the same `file://` URL). This machine does have a
display (`$DISPLAY=:0.0`, X socket present, no `xvfb-run` installed), so a real
window is possible — but everything documented here is verified through the
headless path above, and popping a window onto the user's desktop is rarely what
you want.

## Gotchas

- **`#startArcadeBtn` exists before its click listener does.** The button is in
  the static HTML; `addEventListener` runs at the end of a ~1000-line inline
  script. Clicking in between silently no-ops — the click "succeeds", the game
  never starts, and `errors` reports nothing. `nav` gates on `window.__si`
  (attached dead last) to avoid it. Hit this if you write your own driver: it
  failed about half the runs I made before the fix, with no error anywhere.
- **Always use a quoted heredoc: `<<'EOF'`, never `<<EOF`.** Commands are full JS
  expressions with quotes and `$`-free but backslash-sensitive content. An
  unquoted heredoc (or wrapping the whole thing in `bash -c "..."`) turns `'x'`
  into `\'x\'` and the page throws `SyntaxError: Invalid or unexpected token`.
- **`until` needs `@` before a timeout.** `until __si.score() > 0 @3000`. A bare
  trailing number is part of the expression, so `until __si.score() > 0` waits
  on `score() > 0` as intended.
- **Nothing is visible for ~3.5s after the game starts.** A key change freezes
  the notes behind the countdown overlay for 3s, then notes spawn *above* the
  viewport (`y: -40, -86, -132`) and the first note of a new key falls at 60%
  speed. `until __si.noteYs()[0] > 120 @9000` is the reliable "notes are on
  screen now" wait; it typically resolves ~3.5s after the overlay clears.
- **Firing is blocked during the countdown** (`si locked` → `true`). `press
  Space` there is intentionally a no-op — the overlay is opaque and hides the
  notes. Don't read it as broken input.
- **The intro overlay fades in over 180ms** (`kiFade`). A `shot` fired the instant
  it appears catches it half-transparent with the canvas watermark showing
  through, which looks like a rendering bug and isn't. Add `wait 250` before
  screenshotting it.
- **Waiting for the overlay to *hide* right after `click #startArcadeBtn` passes
  instantly** — it hasn't appeared yet. Wait for `contains('show')` first, then
  for its absence.
- **`viewport w h true` enables touch emulation, which selects the input path.**
  `tap`/`tapxy`/`drag` dispatch touch events when it is on and mouse events when it is
  off, and the two are not interchangeable (see the hang below). The layout no longer
  depends on it — the old `◀ FIRE ▶` footer, which was gated on
  `navigator.maxTouchPoints`, is gone — but keep setting it before `nav` when
  emulating a phone so you exercise the same event path a phone does.
- **Under touch emulation `Input.dispatchMouseEvent` never acks and the call hangs
  forever** (killed my run at the 2-minute mark). `tap`/`tapxy` switch to
  `Input.dispatchTouchEvent` when `isTouch` is set; if you add pointer input, route
  it through the driver's `pointerAt()` rather than dispatching mouse events.
- **The PWA layer is inert on `file://` by design.** Registration is guarded by
  `location.protocol.indexOf("http") === 0`, because `register()` throws on a `file:`
  origin and opening the file directly stays a supported way to play. Don't "fix" a
  missing worker when testing off disk. (Probing `navigator.serviceWorker
  .getRegistrations()` there throws `SecurityError: ... origin ('null') is not
  supported` — that's the probe failing, not the app.)
- **The document is network-first in `sw.js`,** so an edit to `index.html` shows up on
  the next online load without touching `CACHE`. Everything else is cache-first; bump
  the `CACHE` constant when you need to force old entries out.
- **The play area is not an input surface — tapping it toggles pause.** Movement is
  arrows / `A` `D` / the on-screen `◀ ▶` only; firing is `Space` / `FIRE` only. A
  canvas tap neither moves nor fires, and a tap on the pause backdrop resumes.
  Verify control changes with `shipx` before/after (`tapxy` on the canvas must leave
  it unchanged) rather than trusting a screenshot.
- **There are no on-screen buttons.** Touch play is a `CONTROL_STRIP` — the bottom
  **80px** of the canvas, where the ship sits: drag there to steer, tap there to fire,
  tap anywhere above it to pause. Measured from
  `canvas.getBoundingClientRect().bottom`, so it tracks the layout (portrait canvas
  ends 844 → strip 764-844; landscape 360 → 280-360; desktop 820 → 740-820). To pause
  in a test, stay well above it: `tapxy 550 600`, not `tapxy 550 800`.
- **A drag sets a target, not a position.** `state.targetX` is a destination the ship
  closes on at `SHIP_SPEED` (320px/s, the same cap the arrow keys get), so a fast flick
  leaves the ship behind and it arrives late — verified: a 300px flick in 20ms left the
  ship 26px along, reaching the target ~900ms later. Don't "fix" that lag; pinning the
  ship to the finger would restore the instant repositioning that tap-to-teleport had.
  The target **survives the finger lift** on purpose, and any arrow keypress clears it
  so the keyboard always wins.
- **Consecutive tap toggles need >350ms between them.** `tapTogglePause` debounces,
  so a script that taps to pause and immediately taps to resume sees no change —
  insert `wait 400`. This is not a bug to fix; see the ghost click below.
- **Ghost click: a tap that opens an overlay is followed by a click at the same
  point, hit-tested against what is now there.** Tapping mid-canvas to pause put a
  synthesized click straight onto the freshly-revealed `Resume` (pause+unpause in one
  tap) or `Quit to menu` (run thrown away). `preventDefault()` on `pointerdown` does
  NOT suppress it. The fix is a capture-phase click swallow on `#pauseOverlay` inside
  a 350ms window. When touching this code, test by tapping **exactly on the button
  coordinates** — `tapxy 550 410` (Resume) and `tapxy 550 470` (Quit) at 1100x820 —
  a tap at y=200 lands on inert backdrop and passes either way. The smoke script
  covers both.
- **One tap emits three events under touch emulation:**
  `canvas:pointerdown:touch`, `canvas:touchstart`, then `overlay:click:<whatever is
  now under the point>`. Worth remembering before assuming "one gesture, one
  handler".
- **The HUD wraps to two rows in portrait.** At 390px wide, `#hud`'s `flex-wrap`
  pushes `.hud-right` (`?` and `❚❚`) onto a second line below the brand, making the
  top bar ~99px tall. Only visible with touch emulation on, so earlier mobile shots
  never showed it.
- **Canvas coordinates are CSS px, the backing store is device px**
  (`canvas.width = W * DPR`, `DPR = min(devicePixelRatio, 2)`). The driver forces
  DPR 1 for desktop shots so the two agree; under `viewport ... true` (DPR 2) they
  don't — `shipx` reports device px, so a centred ship on a 390px-wide phone reads
  `390`, not `195`.
- **`getComputedStyle(...).display`, not `style.display`,** for
  `#gameOverScreen` / `#pauseOverlay` / `#canvasWrap` — several are toggled via
  inline styles set at runtime, others via a `.show` class.
- **Only two HUD controls ride above the intro overlay.** During the countdown
  `showKeyIntro` adds `key-intro` to `#app`, which lifts `#hud` to z-index 23 (over
  the overlay's 22) and sets `.hud-left`/`.hud-stats` to `visibility:hidden` — so
  the `?` and `❚❚` buttons are visible and tappable while the score, key name, and
  lives stay hidden. `#hud` is its own stacking context, which is why the whole HUD
  has to be lifted and the rest hidden rather than just raising `.hud-right`.
  `press Escape` pauses as well, and the peek modal (23) renders above the intro.
  Expect `getComputedStyle('.hud-left').visibility === 'hidden'` mid-countdown; it
  flips back to `visible` when the countdown ends *or* while paused.
- **`click` cannot detect overlay-blocking bugs** — `el.click()` fires the handler
  no matter what is on top. Any "is this actually clickable" question needs `tap`.
- **Pause deliberately shows the play area, not a dark screen.** The pause scrim
  is only 42%, and `togglePause` puts a `paused` class on `#app` which suppresses
  the key-intro overlay's background and content (`#app.paused #keyIntroOverlay`)
  — pausing is when you study the clef and key signature, so both overlays get
  out of the way. A `shot` while paused showing the staff and notes through the
  scrim is correct. The countdown state is untouched and resumes mid-tick, so
  `#keyIntroCount` still reads e.g. `3` while paused even though it's invisible.
- **AudioContext is created on `startGame`.** Headless has no audio sink; the
  driver passes `--mute-audio` and the game's `beep()` is try/caught, so this is
  silent — but a synthetic `.click()` is not a user gesture, so audio may stay
  suspended. Don't try to verify sound.
- **A stale browser on the debug port used to be driven silently.** Chrome whose
  `--remote-debugging-port` is taken starts anyway and never listens, so the
  driver would attach to whatever *was* there — wrong flags, wrong viewport, and
  `quit` killing the wrong process. It now refuses to start in that case; if you
  write another CDP tool here, do the same pre-flight check.
- **Screenshots always differ pixel-to-pixel** — the starfield twinkles off
  `performance.now()`. Diffing PNGs between runs won't work; assert on DOM text
  or seam state instead.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `click #startArcadeBtn -> clicked` but `si running` is `false` | The listener race above. Use `nav` (which waits for `__si`), don't hand-roll the readiness check. |
| `ERR port 9333 is already serving Chrome/...` | A stale browser is on the port. Kill it with a **self-excluding** pattern: `pids=$(pgrep -f "user-data-dir=/tmp/si-chrom[e]"); kill $pids`. The `[e]` bracket stops the pattern from matching your own shell's command line — a plain `pkill -f "remote-debugging-port=9333"` matches the very command running it and kills the session (exit 144; I did this twice). Or just run with `SI_PORT=9334`. |
| `shipx -> -1` | No gold hull pixels in the band — the game isn't actually running (see the race), or you're mid-countdown before the ship is drawn. |
| `ERR ... SyntaxError: Unexpected number` | A bare number at the end of an `until` expression got joined into the JS. Prefix timeouts with `@`. |
| Blank page, `errors -> none` | Syntax error in the inline script — run the parse check under **Build**. |
| `ERR si key -> ReferenceError: __si is not defined` | You used `nav plain` (or your own query). Bare `nav` adds `?sitest`. |
