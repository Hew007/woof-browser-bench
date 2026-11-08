// Builds video/woof-browser-test.mp4 (1080x1920, 30 fps) from: title card, the two recorded live segments
// (trimmed and partly sped up by their marks, with their captured audio), the comparison card and the end card.
// Usage: node make_video.mjs   (after bench.mjs, measure_official.mjs and record.mjs)
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import ffmpeg from "ffmpeg-static";

const SR = 48000;
await mkdir("video/build", { recursive: true });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// ---------------------------------------------------------------- numbers for the comparison card
const bench = JSON.parse(await readFile("results/bench.json", "utf8"));
const official = JSON.parse(await readFile("results/official.json", "utf8"));
const rows = ["short", "medium", "long"].map((label) => ({
  label,
  official: median(official.results.filter((r) => r.label === label).map((r) => r.firstMs)),
  local: median(bench.results.filter((r) => r.label === label && r.voice === "juno").map((r) => r.firstMs)),
}));
const juno = bench.results.filter((r) => r.voice === "juno");
const localRtf = (juno.reduce((s, r) => s + r.audioSec, 0) / (juno.reduce((s, r) => s + r.computeMs, 0) / 1000)).toFixed(2);
const card = {
  rows, localRtf, officialSpeedup: "✓ 流式",
  machine: `测试机：<b>${bench.machine.cpu.replace(/\s+/g, " ")}</b>，Intel 核显（WebGPU）· ${bench.browser.replace("chrome", "Chrome")}<br>
    开源版用 Pyodide 在浏览器里运行官方 numpy 代码（juno 音色，单线程）。官方 Demo 与开源版是同系列的两个模型（31.7MB 单音色 / 40.6MB 双音色）。`,
  points: [
    `体积不是问题：<b>31.7MB</b> 一次下载，之后<b>断网照样出声</b><small>推理全程 0 个网络请求</small>`,
    `后端决定速度：官方 WebGPU 版首音 <b>${(rows[0].official / 1000).toFixed(1)}～${(rows[2].official / 1000).toFixed(1)} 秒</b><small>同模型塞进 CPU/WASM：首音 ${(rows[0].local / 1000).toFixed(0)}～${(rows[1].local / 1000).toFixed(0)} 秒，生成比播放还慢</small>`,
    `前端落地建议：走 WebGPU，做流式播放，CPU 只当兜底<small>英文模型 · 非商业许可，商用需另谈授权</small>`,
  ],
  repo: `测试代码与原始数据：<b>github.com/Hew007/woof-browser-bench</b><br>来源：TechCrunch 2026-11-06；Hugging Face ConwayResearch/Underdog-Woof`,
};
console.log(JSON.stringify(rows), localRtf);

// ---------------------------------------------------------------- render the cards to PNG
const browser = await chromium.launch({ channel: process.env.CHANNEL || "chrome" });
const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
await page.goto("file:///" + process.cwd().replace(/\\/g, "/") + "/cards.html");
await page.evaluate((d) => render(d), card);
for (const id of ["title", "compare", "end"]) {
  await page.evaluate((id) => show(id), id);
  await page.screenshot({ path: `video/build/${id}.png` });
}
await browser.close();

// ---------------------------------------------------------------- audio track for each recorded segment
function wav(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const segs = {};
for (const name of ["official", "local"]) {
  const { marks, audio } = JSON.parse(await readFile(`video/raw/${name}.json`, "utf8"));
  const endMs = marks.at(-1).t + 2000;
  const out = new Float32Array(Math.ceil(endMs / 1000 * SR));
  for (const c of audio) {                        // linear resample to 48 kHz, mix at the time it started playing
    const ratio = c.sr / SR, n = Math.floor(c.data.length / ratio), o = Math.round(c.at / 1000 * SR);
    for (let i = 0; i < n && o + i < out.length; i++) {
      const x = i * ratio, j = Math.floor(x), f = x - j;
      if (o + i >= 0) out[o + i] += (c.data[j] || 0) * (1 - f) + (c.data[j + 1] || 0) * f;
    }
  }
  await writeFile(`video/build/${name}.wav`, wav(out));
  segs[name] = marks;
}

// ---------------------------------------------------------------- ffmpeg graph
const filters = [], labels = [];
const V = "fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0d0f14,setsar=1,format=yuv420p";
let k = 0;
const inArgs = []; let idx = 0;
const addInput = (...a) => { inArgs.push(...a); return idx++; };
function addStill(png, sec) {
  const i = addInput("-loop", "1", "-framerate", "30", "-t", String(sec), "-i", png);
  filters.push(`[${i}:v]${V}[v${k}]`, `anullsrc=r=${SR}:cl=mono,atrim=duration=${sec}[a${k}]`);
  labels.push(`[v${k}][a${k}]`); k++;
}
function addSegment(name) {
  const vi = addInput("-i", `video/raw/${name}.webm`), ai = addInput("-i", `video/build/${name}.wav`);
  const m = segs[name];
  // sped-up parts are capped at ~6 s on screen, however long the wait was (cold start depends on CDN speed)
  const parts = m.slice(0, -1).map((x, j) => { const a = x.t / 1000, b = m[j + 1].t / 1000; return { a, b, speed: x.speed === 1 ? 1 : +Math.max(x.speed, (b - a) / 6).toFixed(2) }; });
  parts[parts.length - 1].b += 0.3;
  for (const p of parts) {
    const d = (p.b - p.a) / p.speed;
    // Playwright paints the 540x960 viewport into the top-left of the 1080x1920 frame: crop it, then upscale
    filters.push(`[${vi}:v]trim=start=${p.a}:end=${p.b},setpts=(PTS-STARTPTS)/${p.speed},crop=540:960:0:0,scale=1080:1920:flags=lanczos,${V}[v${k}]`);
    filters.push(p.speed === 1
      ? `[${ai}:a]atrim=start=${p.a}:end=${p.b},asetpts=PTS-STARTPTS,apad=whole_dur=${d}[a${k}]`
      : `anullsrc=r=${SR}:cl=mono,atrim=duration=${d}[a${k}]`);
    labels.push(`[v${k}][a${k}]`); k++;
  }
}
addStill("video/build/title.png", 4);
addSegment("official");
addSegment("local");
addStill("video/build/compare.png", 7);
addStill("video/build/end.png", 6);
filters.push(`${labels.join("")}concat=n=${k}:v=1:a=1[v][a]`);
const args = ["-y", ...inArgs, "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  "-movflags", "+faststart", "video/woof-browser-test.mp4"];
const r = spawnSync(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr.slice(-3000)); process.exit(1); }
console.log("wrote video/woof-browser-test.mp4");
