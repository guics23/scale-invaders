#!/usr/bin/env node
/**
 * Scale Invaders driver — launches headless Chrome, drives index.html over the
 * DevTools Protocol, saves screenshots.
 *
 * There is no chromium-cli / playwright / puppeteer in this container, so this
 * speaks raw CDP over node 22's built-in WebSocket. No dependencies, no install.
 *
 * Usage: pipe commands on stdin, one per line.
 *
 *   node .claude/skills/run-scale-invaders/driver.mjs <<'EOF'
 *   nav
 *   click #startArcadeBtn
 *   until __si.locked() === false
 *   shot gameplay
 *   errors
 *   EOF
 *
 * Every command echoes `<cmd> -> <result>`; a failing command prints ERR and
 * exits non-zero, so a piped script fails loudly instead of silently going on.
 * Screenshots land in $SI_SHOTS (default /tmp/scale-invaders-shots).
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { createInterface } from "readline";
import { tmpdir } from "os";
import { join } from "path";

const APP = process.env.SI_APP || new URL("../../../index.html", import.meta.url).pathname;
const SHOTS = process.env.SI_SHOTS || "/tmp/scale-invaders-shots";
const PORT = Number(process.env.SI_PORT || 9333);
const PROFILE = join(tmpdir(), `si-chrome-${process.pid}`);
const BINARIES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

/* ---------- refuse to hijack a browser already on the port ----------
   Chrome whose debug port is taken starts anyway but never listens, so we'd
   silently attach to the *other* browser — wrong flags, wrong viewport, and our
   `quit` wouldn't even kill it. Fail loudly instead. */
let squatter = null;
try { squatter = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
if (squatter) {
  console.error(`ERR port ${PORT} is already serving ${squatter.Browser}.`);
  console.error(`    Kill it:  pids=$(pgrep -f "user-data-dir=/tmp/si-chrom[e]"); kill $pids`);
  console.error(`    Or run:   SI_PORT=${PORT + 1} ...`);
  process.exit(1);
}

/* ---------- launch Chrome ---------- */
let chrome, bin;
for (const b of BINARIES) {
  chrome = spawn(b, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-sandbox",              // container has no user namespaces
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--mute-audio",              // the game builds an AudioContext; no sink here
  ], { stdio: "ignore" });
  const failed = await new Promise(r => {
    chrome.once("error", () => r(true));
    setTimeout(() => r(false), 400);
  });
  if (!failed) { bin = b; break; }
}
if (!bin) { console.error("ERR no chrome binary found; tried: " + BINARIES.join(", ")); process.exit(1); }

let version;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(250); }
}
if (!version) { console.error("ERR chrome never opened the debug port"); process.exit(1); }
console.log(`# ${bin} ${version.Browser}  shots -> ${SHOTS}`);

/* ---------- CDP plumbing ---------- */
const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));

let msgId = 0;
const pending = new Map();
const jsErrors = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    jsErrors.push(d.exception?.description || d.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    jsErrors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
  }
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async expr => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text);
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
/* Installed before any page script so the event cannot be missed: Chrome fires
   beforeinstallprompt shortly after load, well before a command could attach. */
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__installPrompt = false;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = true; });`,
});
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });

/* Key events need the full quartet of fields — code alone leaves the game's
   `e.code` handlers working but produces no character, and Space in particular
   is ignored by Chrome without `text`. */
const KEYS = {
  Space:      { key: " ",          text: " ", vk: 32 },
  ArrowLeft:  { key: "ArrowLeft",  vk: 37 },
  ArrowRight: { key: "ArrowRight", vk: 39 },
  KeyA:       { key: "a",          text: "a", vk: 65 },
  KeyD:       { key: "d",          text: "d", vk: 68 },
  Escape:     { key: "Escape",     vk: 27 },   // toggles pause
};
const keyEvent = (type, code) => {
  const k = KEYS[code];
  if (!k) throw new Error(`unknown key code ${code}; known: ${Object.keys(KEYS).join(", ")}`);
  return send("Input.dispatchKeyEvent", {
    type, code, key: k.key, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    ...(type === "keyDown" && k.text ? { text: k.text } : {}),
  });
};

/* ---------- commands ---------- */
/* Under touch emulation, Input.dispatchMouseEvent never acks (the call hangs), so
   pointer input has to go through dispatchTouchEvent instead. `viewport ... true`
   flips this. */
let isTouch = false;
const pointerAt = async (x, y) => {
  if (isTouch) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }
};

const commands = {
  // nav [query]  — default ?sitest, which attaches the window.__si test seam.
  // `nav plain` loads it with no query string, the way a real player gets it.
  async nav(query = "?sitest") {
    query = query.replace(/^["']|["']$/g, "");
    if (query === "plain") query = "";
    // An absolute URL is used as-is — service workers and the manifest need a real
    // http(s) origin, which file:// cannot provide.
    const url = /^https?:\/\//.test(query) ? query : `file://${APP}${query}`;
    await send("Page.navigate", { url });
    await sleep(150);
    // #startArcadeBtn exists in the DOM before the inline script runs, so gating
    // on the element is a race: the click lands with no listener and no-ops
    // silently. __si is attached at the very END of the script (after the
    // listeners), which makes it the real ready signal.
    await commands.until(
      query.includes("sitest") ? "!!window.__si" : "document.readyState === 'complete'",
      "@5000",
    );
    return url;
  },
  async viewport(w, h, mobile = "false") {
    const isMobile = mobile === "true";
    await send("Emulation.setDeviceMetricsOverride", {
      width: +w, height: +h, deviceScaleFactor: isMobile ? 2 : 1, mobile: isMobile,
    });
    // Metrics alone are not enough: the game shows its ◀ FIRE ▶ row only when
    // `'ontouchstart' in window || navigator.maxTouchPoints > 0`, so without touch
    // emulation a "mobile" screenshot is missing the footer a real phone shows.
    // The check runs at load, so set the viewport BEFORE nav.
    await send("Emulation.setTouchEmulationEnabled", { enabled: isMobile, maxTouchPoints: isMobile ? 5 : 1 });
    await send("Emulation.setEmitTouchEventsForMouse", { enabled: isMobile, configuration: "mobile" });
    isTouch = isMobile;
    return `${w}x${h}${isMobile ? " (touch)" : ""}`;
  },
  async click(...sel) {
    const s = sel.join(" ");
    return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});
      if(!e) throw new Error('no element '+${JSON.stringify(s)}); e.click(); return 'clicked';})()`);
  },
  // tap <selector> — a REAL mouse click at the element's centre, so it goes
  // through hit-testing. `click` calls el.click() and ignores anything covering
  // the element; use `tap` when the question is "can a user actually reach this".
  async tap(...sel) {
    const s = sel.join(" ");
    const box = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});
      if(!e) throw new Error('no element '+${JSON.stringify(s)});
      const r=e.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
    const { x, y } = JSON.parse(box);
    // what the pointer would actually hit at that spot
    const hit = await evaluate(`(()=>{const e=document.elementFromPoint(${x},${y});
      return e ? (e.id||e.tagName)+(e.className?'.'+String(e.className).split(' ')[0]:'') : 'null';})()`);
    await pointerAt(x, y);
    return `${s} at ${x},${y} (hit: ${hit})`;
  },
  // tapxy <x> <y> — real click at CSS coordinates, for canvas taps (no element to
  // select). Reports what the pointer hit, so you can tell dead zones apart.
  async tapxy(x, y) {
    const hit = await evaluate(`(()=>{const e=document.elementFromPoint(${+x},${+y});
      return e ? (e.id||e.tagName)+(e.className?'.'+String(e.className).split(' ')[0]:'') : 'null';})()`);
    await pointerAt(+x, +y);
    return `${x},${y} (hit: ${hit})`;
  },
  press: async code => { await keyEvent("keyDown", code); await keyEvent("keyUp", code); return code; },
  hold: async (code, ms = "500") => {
    await keyEvent("keyDown", code); await sleep(+ms); await keyEvent("keyUp", code);
    return `${code} ${ms}ms`;
  },
  eval: (...js) => evaluate(js.join(" ")),
  // si <method>  — call the ?sitest seam, e.g. `si key`, `si noteYs`, `si win`
  si: async (...call) => {
    const c = call.join(" ");
    return evaluate(`JSON.stringify(__si.${c.endsWith(")") ? c : c + "()"})`);
  },
  text: async (...sel) => evaluate(`document.querySelector(${JSON.stringify(sel.join(" "))}).innerText.replace(/\\n/g,' | ')`),
  wait: async ms => { await sleep(+ms); return `${ms}ms`; },
  // until <js expr> [@timeoutMs]  — poll every 50ms; the app is frame-driven, so
  // this is how you wait, never a bare `wait`. The timeout needs the `@` sigil:
  // a bare trailing number is part of the expression (`until __si.score() > 0`).
  async until(...args) {
    let timeout = 10000;
    if (args.length > 1 && /^@\d+$/.test(args.at(-1))) timeout = +args.pop().slice(1);
    const expr = args.join(" ");
    for (let waited = 0; waited < timeout; waited += 50) {
      if (await evaluate(`!!(${expr})`)) return `true after ${waited}ms`;
      await sleep(50);
    }
    throw new Error(`timeout after ${timeout}ms waiting for: ${expr}`);
  },
  async shot(name = "shot") {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(r.result.data, "base64"));
    return path;
  },
  // shipx — the ship's x in canvas px, read back off the canvas. There is no
  // state accessor for it, and this is how you prove arrow keys actually reach
  // the game loop rather than trusting that dispatchKeyEvent landed.
  shipx: async () => evaluate(`(()=>{
    const c=document.getElementById('gameCanvas'), g=c.getContext('2d');
    const band=g.getImageData(0, c.height-90, c.width, 60).data;   // ship sits ~78px up
    let sum=0,n=0;
    for(let i=0;i<band.length;i+=4){
      const r=band[i],gr=band[i+1],b=band[i+2];
      if(r>180&&gr>140&&b<130){ const px=(i/4)%c.width; sum+=px; n++; }   // gold hull
    }
    return n ? Math.round(sum/n) : -1;
  })()`),
  // offline on|off — for testing that the service worker really serves the app
  offline: async (state = "on") => {
    const off = state === "on";
    await send("Network.enable");
    await send("Network.emulateNetworkConditions", {
      offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    return off ? "offline" : "online";
  },
  reload: async () => {
    await send("Page.reload", {});
    await sleep(300);
    return "reloaded";
  },
  // pwa — installability facts: manifest parse, worker state, and whether Chrome
  // actually fired beforeinstallprompt (the only real proof it would install).
  pwa: async () => {
    const m = await send("Page.getAppManifest");
    const r = m.result || {};
    const sw = await evaluate(`(async () => {
      if(!('serviceWorker' in navigator)) return 'unsupported';
      const reg = await navigator.serviceWorker.getRegistration();
      if(!reg) return 'none';
      const w = reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : '?';
      return w + (navigator.serviceWorker.controller ? ' (controlling)' : ' (not controlling)');
    })()`);
    return JSON.stringify({
      manifestUrl: r.url || null,
      manifestErrors: (r.errors || []).map(e => e.message),
      name: r.parsed?.name ?? JSON.parse(r.data || "{}").name ?? null,
      icons: (JSON.parse(r.data || "{}").icons || []).map(i => i.sizes + " " + (i.purpose || "any")),
      serviceWorker: sw,
      beforeinstallprompt: await evaluate("!!window.__installPrompt"),
    });
  },
  errors: async () => (jsErrors.length ? jsErrors.join("\n") : "none"),
  quit: async () => { await shutdown(0); },
};

async function shutdown(code) {
  try { ws.close(); } catch {}
  chrome.kill("SIGTERM");
  await sleep(200);
  chrome.kill("SIGKILL");
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

/* ---------- read commands from stdin ---------- */
const rl = createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  const src = line.trim();
  if (!src || src.startsWith("#")) continue;
  const [name, ...args] = src.split(/\s+/);
  const fn = commands[name];
  if (!fn) { console.error(`ERR unknown command: ${name} (have: ${Object.keys(commands).join(", ")})`); await shutdown(1); }
  try {
    console.log(`${src} -> ${await fn(...args)}`);
  } catch (err) {
    console.error(`ERR ${src} -> ${err.message}`);
    await shutdown(1);
  }
}
await shutdown(0);
