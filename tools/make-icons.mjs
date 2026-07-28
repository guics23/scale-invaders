#!/usr/bin/env node
/**
 * Generates the PWA icon set into icons/ from the eighth-note artwork that the
 * inline favicon in index.html already uses, so every icon matches the tab icon.
 *
 *   node tools/make-icons.mjs
 *
 * Rendering goes through headless Chrome (the same engine that draws the game)
 * rather than ImageMagick's SVG delegate, which mangles the note's flag path.
 * Requires google-chrome on PATH; no npm dependencies.
 *
 * Three shapes, because the platforms mask differently:
 *   any       — rounded corners baked in, artwork at ~62% (browser tab / desktop)
 *   maskable  — full bleed, artwork at ~50% so it survives Android's circle crop
 *   apple     — full bleed, artwork at ~62%; iOS applies its own squircle mask
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "icons");
const PORT = Number(process.env.SI_ICON_PORT || 9444);
const PROFILE = join(tmpdir(), `si-icons-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const BG = "#161029", GOLD = "#eab54c";

/* The note, same geometry as the favicon in index.html. BOX is the artwork's real
   bounding box inside that 64x64 coordinate space — the shapes sit left of centre
   and low, so centring the viewBox instead of the box visibly off-centres the note. */
const NOTE = `
  <ellipse cx="23" cy="45" rx="11" ry="8" fill="${GOLD}"/>
  <rect x="32" y="15" width="4" height="32" fill="${GOLD}"/>
  <path d="M32 15c14 2 15 15 7 22 6-11-1-18-7-15z" fill="${GOLD}"/>`;
const BOX = { x: 12, y: 15, w: 28, h: 38 };

// scale: artwork share of the icon's shorter side; radius: corner rounding (0 = square)
const icon = (size, scale, radius) => {
  const s = (size * scale) / Math.max(BOX.w, BOX.h);
  const tx = size / 2 - (BOX.x + BOX.w / 2) * s;
  const ty = size / 2 - (BOX.y + BOX.h / 2) * s;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/>
    <g transform="translate(${tx} ${ty}) scale(${s})">${NOTE}</g>
  </svg>`;
};

const TARGETS = [
  { file: "icon-192.png",          size: 192, scale: 0.62, radius: 42 },
  { file: "icon-512.png",          size: 512, scale: 0.62, radius: 112 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.50, radius: 0 },
  { file: "apple-touch-icon.png",  size: 180, scale: 0.62, radius: 0 },
];

/* ---------- headless Chrome over CDP ---------- */
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
], { stdio: "ignore" });

let version;
for (let i = 0; i < 60 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
  catch { await sleep(250); }
}
if (!version) { console.error("ERR chrome never opened the debug port"); process.exit(1); }

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});

await send("Page.enable");
for (const t of TARGETS) {
  const svg = icon(t.size, t.scale, t.radius);
  const html = `<style>html,body{margin:0;padding:0;background:transparent}</style>${svg}`;
  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
  await sleep(250);
  await send("Emulation.setDeviceMetricsOverride", {
    width: t.size, height: t.size, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(120);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, t.file), Buffer.from(shot.result.data, "base64"));
  console.log(`icons/${t.file}  ${t.size}x${t.size}  artwork ${Math.round(t.scale * 100)}%`);
}

ws.close();
chrome.kill("SIGTERM");
await sleep(200);
chrome.kill("SIGKILL");
process.exit(0);
