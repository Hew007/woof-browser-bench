// Measure Underdog's own in-browser Woof demo (WebGPU, 31.7 MB one-voice model) with the same sentences.
// Latency = click "Say it" -> first audio actually scheduled to play (AudioBufferSourceNode.start / media.play).
// Usage: node measure_official.mjs [--rounds 3]
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { SENTENCES } from "./sentences.mjs";

const args = process.argv.slice(2);
const ROUNDS = Number(args[args.indexOf("--rounds") + 1]) || 3;
const browser = await chromium.launch({ channel: process.env.CHANNEL || "chrome", headless: false,
  args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
await context.addInitScript(() => {
  window.__audio = [];
  const S = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    const ctx = this.context;
    const delay = Math.max(0, when - ctx.currentTime) * 1000;
    window.__audio.push({ t: performance.now() + delay, dur: this.buffer ? this.buffer.duration : 0, kind: "buffer" });
    return S.call(this, when, ...rest);
  };
  const P = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__audio.push({ t: performance.now(), dur: this.duration, kind: "media" }); return P.call(this); };
});
const page = await context.newPage();
let bytes = 0;
page.on("response", async (r) => { const l = Number(r.headers()["content-length"] || 0); bytes += l; });
const t0 = Date.now();
await page.goto("https://underdog.ai/woof", { timeout: 120000, waitUntil: "load" });
const adapter = await page.evaluate(async () => { const a = navigator.gpu && await navigator.gpu.requestAdapter(); return a ? { vendor: a.info?.vendor, arch: a.info?.architecture, desc: a.info?.description } : null; });
console.log("webgpu adapter", adapter);

const box = page.locator("textarea").first();
const say = page.getByRole("button", { name: "Say it" });
async function speak(text) {
  await box.fill(text);
  const n = await page.evaluate(() => window.__audio.length);
  const tClick = await page.evaluate(() => performance.now());
  await say.click();
  await page.waitForFunction((n) => window.__audio.length > n, n, { timeout: 300000 });
  // wait until no new audio is scheduled for 3 s (multi-sentence input may arrive in pieces)
  let last = -1;
  for (;;) { await page.waitForTimeout(3000); const c = await page.evaluate(() => window.__audio.length); if (c === last) break; last = c; }
  const a = await page.evaluate((n) => window.__audio.slice(n), n);
  const audioSec = a.reduce((s, x) => s + (x.dur || 0), 0);
  return { firstMs: a[0].t - tClick, audioSec, chunks: a.length, kinds: [...new Set(a.map((x) => x.kind))] };
}

// warm-up: first click also downloads/compiles the model
const warm = await speak("Hello.");
const coldMs = Date.now() - t0;
console.log("first utterance incl. model load", warm, `wall ${coldMs} ms`, `bytes ~${(bytes / 1e6).toFixed(1)} MB`);
await context.setOffline(true);
const results = [];
for (let r = 0; r < ROUNDS; r++) for (const [label, text] of SENTENCES) {
  const res = await speak(text);
  results.push({ label, round: r, chars: text.length, ...res });
  console.log(label, `r${r}`, `first ${res.firstMs.toFixed(0)}ms`, `audio ${res.audioSec.toFixed(2)}s`, `chunks ${res.chunks}`, res.kinds);
}
await writeFile("results/official.json", JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), adapter, warm, coldMs, bytes, results }, null, 2));
await browser.close();
