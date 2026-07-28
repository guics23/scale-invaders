#!/usr/bin/env bash
# Full end-to-end smoke: both modes, both tonalities, the key-change countdown,
# real keyboard input, a scored hit, game over, and two mobile viewports.
# Screenshots land in $SI_SHOTS (default /tmp/scale-invaders-shots).
#
#   bash .claude/skills/run-scale-invaders/smoke.sh
#
# Exits non-zero on the first failed step (the driver bails on any ERR).
set -euo pipefail
cd "$(dirname "$0")/../../.."          # -> repo root, so the file:// path resolves
DRIVER=.claude/skills/run-scale-invaders/driver.mjs

node "$DRIVER" <<'EOF'
# ---------- arcade, major: key-change countdown ----------
nav
click #startArcadeBtn
until document.getElementById('keyIntroOverlay').classList.contains('show') @3000
text #keyIntroOverlay
si key
# the peek/pause buttons ride above the overlay; the rest of the HUD does not
until getComputedStyle(document.querySelector('.hud-right')).visibility === 'visible' @1000
until getComputedStyle(document.querySelector('.hud-left')).visibility === 'hidden' @1000
tap #scaleHelpBtn
until document.getElementById('scaleModal').classList.contains('show') @1000
tap #scaleModal
wait 150
shot 01-key-intro-major
# firing is blocked while the countdown holds the notes
press Space
si locked
until !document.getElementById('keyIntroOverlay').classList.contains('show') @6000

# ---------- real keyboard input reaches the game loop ----------
shipx
hold ArrowLeft 700
shipx
hold ArrowRight 1200
shipx
until __si.noteYs()[0] > 120 @9000
press Space
wait 250
shot 02-gameplay-major

# ---------- scoring through the real hit path ----------
si win
until __si.score() > 0 @3000
si score
si streak

# ---------- game over ----------
si miss
si miss
si miss
until __si.lives() === 0 @3000
until getComputedStyle(document.getElementById('gameOverScreen')).display === 'flex' @5000
shot 03-game-over
text #gameOverScreen

# ---------- arcade, minor: level-1 pool is the relative minors of F/G/D + A ----------
click #menuBtn
click [data-ton="minor"]
si tonality
click #startArcadeBtn
until document.getElementById('keyIntroOverlay').classList.contains('show') @3000
si key
# asserts (until throws on timeout): whatever was drawn must be in the level-1 pool
until ["A","D","E","B"].includes(__si.key()) @1000
shot 04-key-intro-minor

# ---------- pause uncovers the staff instead of hiding it ----------
# `tap`, not `click`: proves the button is really reachable under the opaque intro
tap #pauseBtn
wait 150
until document.getElementById('app').classList.contains('paused') @1000
until getComputedStyle(document.getElementById('keyIntroOverlay')).backgroundImage === 'none' @1000
shot 05-paused
click #resumeBtn
# the countdown survives the pause untouched
until !document.getElementById('app').classList.contains('paused') @1000
until document.getElementById('keyIntroOverlay').classList.contains('show') @1000

# ---------- tap-to-pause, and the ghost click that used to break it ----------
# A tap that opens the overlay is followed by a click at the same point, landing on
# whatever pause button appeared there. Tap ON the Resume/Quit coordinates: if the
# capture-phase swallow regresses, the run resumes or quits to menu instead.
tapxy 400 30
until document.getElementById('app').classList.contains('paused') @1000
eval JSON.stringify({resumeTop:Math.round(document.getElementById('resumeBtn').getBoundingClientRect().top),quitTop:Math.round(document.getElementById('quitBtn').getBoundingClientRect().top)})
until __si.running() @1000
shot 06-tap-paused
# backdrop tap toggles back — consecutive tap toggles need >350ms (ghost-click guard)
wait 400
tapxy 550 200
until !document.getElementById('app').classList.contains('paused') @1000
# tap the top bar again — must still be in the game afterwards
wait 400
tapxy 400 30
until document.getElementById('app').classList.contains('paused') @1000
until __si.running() @1000
until getComputedStyle(document.getElementById('startScreen')).display === 'none' @1000
# after the ghost-click window the real buttons work
wait 500
tap #resumeBtn
until !document.getElementById('app').classList.contains('paused') @1000
# ---------- the whole play area steers and fires; nothing on it pauses ----------
# The countdown blocks firing by design, and the pause tests above froze it mid-tick,
# so let it finish before asserting anything about bullets.
until !document.getElementById('keyIntroOverlay').classList.contains('show') @9000
until __si.locked() === false @2000
si bullets
# a tap high up on the canvas — where a thumb rests, clear of the iPhone home bar —
# must fire and must NOT pause (this is the bug the phone test found)
tapxy 550 300
wait 150
until __si.bullets() > 0 @1000
until !document.getElementById('app').classList.contains('paused') @1000
tapxy 550 800
wait 150
until !document.getElementById('app').classList.contains('paused') @1000
# a drag sets a target the ship closes on at its own speed — never a teleport
si shipX
# expectations are derived from the canvas rect, not hardcoded, so they survive a
# change to #app's max-width (which is exactly what broke them once already)
drag 550 300 420 300 10 300
until __si.targetX() === null @5000
until Math.abs(__si.shipX() - (420 - document.getElementById('gameCanvas').getBoundingClientRect().left)) < 8 @1000
# a fast flick must NOT jump the ship: it is still short of target right afterwards
drag 420 300 750 300 2 20
eval JSON.stringify({flickTarget: __si.targetX(), shipStillBehind: __si.shipX() < __si.targetX() - 50})
# the keyboard takes over from a pending drag target
press ArrowLeft
until __si.targetX() === null @1000
hold ArrowLeft 300
press Space
wait 150
until __si.bullets() > 0 @1000
# pause lives on the top bar now (desktop HUD is ~0-60)
wait 400
tapxy 400 30
wait 400
until document.getElementById('app').classList.contains('paused') @1000
wait 400
tap #resumeBtn
until !document.getElementById('app').classList.contains('paused') @1000
# ...and its buttons still act as buttons, not as pause
wait 400
tap #scaleHelpBtn
until document.getElementById('scaleModal').classList.contains('show') @1000
until !document.getElementById('app').classList.contains('paused') @1000
tap #scaleModal

# ---------- practice mode ----------
click #pauseBtn
click #quitBtn
click #startPracticeBtn
until __si.running() @3000
si key
wait 250
shot 07-practice

# ---------- mobile viewports ----------
viewport 390 844 true
nav
click #startArcadeBtn
until document.getElementById('keyIntroOverlay').classList.contains('show') @3000
wait 250
shot 08-phone-portrait
viewport 740 360 true
nav
click #startArcadeBtn
until document.getElementById('keyIntroOverlay').classList.contains('show') @3000
wait 250
shot 09-phone-landscape
# landscape: the whole canvas steers and fires, top bar pauses
until !document.getElementById('keyIntroOverlay').classList.contains('show') @8000
tapxy 370 150
wait 150
until __si.bullets() > 0 @1000
until !document.getElementById('app').classList.contains('paused') @1000
drag 370 150 220 150 10 300
until __si.targetX() === null @5000
until Math.abs(__si.shipX() - (220 - document.getElementById('gameCanvas').getBoundingClientRect().left)) < 8 @1000
wait 400
tapxy 370 12
wait 400
until document.getElementById('app').classList.contains('paused') @1000

errors
quit
EOF
