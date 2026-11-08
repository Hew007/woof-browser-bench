// Records the two live segments of the short video (9:16, 1080x1920) with Playwright, and captures every audio
// buffer the page plays so it can be muxed back in (Playwright's screen recording has no sound).
// Output: video/raw/<seg>.webm, video/raw/<seg>.json (marks + audio chunks). Then run: node make_video.mjs
// Usage: node record.mjs [official|local|all]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir, rename, rm } from "node:fs/promises";

const which = process.argv[2] || "all";
const W = 540, H = 960;
await mkdir("video/raw", { recursive: true });

const HOOK = () => {
  window.__rec = [];
  const S = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    try {
      const b = this.buffer, delay = Math.max(0, when - this.context.currentTime) * 1000;
      if (b) window.__rec.push({ at: Date.now() + delay, sr: b.sampleRate, data: Array.from(b.getChannelData(0)) });
    } catch (e) {}
    return S.call(this, when, ...rest);
  };
};
const OVERLAY = () => {
  window.__cap = (top, bottom) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div"); el.id = "__cap";
      el.innerHTML = `<div class="t"></div><div class="b"></div>`;
      const st = document.createElement("style");
      st.textContent = `#__cap{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:"Microsoft YaHei","PingFang SC",sans-serif}
#__cap .t{position:absolute;top:10px;left:10px;right:10px;text-align:center}
#__cap .t span{display:inline-block;background:#ffb547;color:#1a1205;font-weight:700;font-size:17px;padding:5px 12px;border-radius:7px}
#__cap .b{position:absolute;bottom:22px;left:12px;right:12px;text-align:center}
#__cap .b span{display:inline-block;background:rgba(0,0,0,.82);color:#fff;font-weight:700;font-size:21px;line-height:1.35;padding:8px 14px;border-radius:9px}`;
      document.documentElement.append(st, el);
    }
    el.querySelector(".t").innerHTML = top ? `<span>${top}</span>` : "";
    el.querySelector(".b").innerHTML = bottom ? `<span>${bottom}</span>` : "";
  };
};

async function segment(name, fn, ctxOpts = {}) {
  const browser = await chromium.launch({ channel: process.env.CHANNEL || "chrome", headless: false,
    args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
  const dir = `video/raw/tmp_${name}`;
  await rm(dir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, bypassCSP: true,
    recordVideo: { dir, size: { width: 1080, height: 1920 } }, ...ctxOpts });
  await context.addInitScript(HOOK);
  await context.addInitScript(OVERLAY);
  const t0 = Date.now();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  pageerror", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("  console", m.text()));
  const marks = [];
  const mark = (label, speed = 1) => { marks.push({ label, t: Date.now() - t0, speed }); console.log(name, label, Date.now() - t0); };
  const cap = (top, bottom) => page.evaluate(([a, b]) => window.__cap && window.__cap(a, b), [top, bottom]).catch(() => {});
  await fn({ page, context, mark, cap });
  mark("end");
  const audio = (await page.evaluate(() => window.__rec)).map((c) => ({ ...c, at: c.at - t0 }));
  await context.close(); await browser.close();
  const f = (await readdir(dir)).find((x) => x.endsWith(".webm"));
  await rename(`${dir}/${f}`, `video/raw/${name}.webm`);
  await rm(dir, { recursive: true, force: true });
  await writeFile(`video/raw/${name}.json`, JSON.stringify({ marks, audio }));
}

const waitAudio = async (page, n, quietMs = 1500) => {
  while ((await page.evaluate(() => window.__rec.length)) <= n) await page.waitForTimeout(100);
  let last = -1;  // wait until playback has been scheduled completely and finished
  for (;;) {
    const s = await page.evaluate(() => { const r = window.__rec; const e = r.at(-1); return { n: r.length, end: e.at + e.data.length / e.sr * 1000 }; });
    if (s.n === last && Date.now() > s.end + 400) break;
    last = s.n; await page.waitForTimeout(quietMs);
  }
};

// ---------------------------------------------------------------- segment 1: Underdog's official WebGPU page
if (which === "all" || which === "official") {
  // warm the HTTP cache first so the recording does not sit through the 30 MB download
  await segment("official", async ({ page, context, mark, cap }) => {
    await page.goto("https://underdog.ai/woof", { waitUntil: "load", timeout: 120000 });
    await cap("官方 Demo · WebGPU · 31.7MB", "首次打开：先下载模型");
    mark("load", 6);
    const box = page.locator("textarea").first(), say = page.getByRole("button", { name: "Say it" });
    await box.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -120));
    await box.fill("Hello.");
    let n = await page.evaluate(() => window.__rec.length);
    await say.click();
    await waitAudio(page, n, 1000);           // first click: download + compile
    await context.setOffline(true);
    await cap("官方 Demo · WebGPU · 31.7MB", "✈ 现在断网");
    mark("offline");
    await page.waitForTimeout(1500);
    for (const t of ["Hi there, how can I help?", "Your order ships on March 3rd, and the total comes to $42.50 including tax."]) {
      await box.fill(t);
      await cap("官方 Demo · WebGPU · 断网中", "点击 → 出声 约 0.5～1 秒");
      n = await page.evaluate(() => window.__rec.length);
      await say.click();
      await waitAudio(page, n);
      await page.waitForTimeout(600);
    }
  });
}

// ---------------------------------------------------------------- segment 2: our page, open-source numpy runtime on Pyodide
if (which === "all" || which === "local") {
  const server = spawn(process.execPath, ["serve.mjs", "8791"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  await segment("local", async ({ page, context, mark, cap }) => {
    await page.goto("http://localhost:8791/");
    await page.addStyleTag({ content: "main{padding-top:52px}" });   // room for the caption tag
    await cap("开源版 · 纯 CPU · WebAssembly", "同一个模型，换成开源的 numpy 运行时");
    mark("intro");
    await page.waitForTimeout(2500);
    await page.click("#init");
    await cap("开源版 · 纯 CPU · WebAssembly", "冷启动：Python 运行时 + 40.6MB 权重（快进）");
    mark("coldstart", 10);
    for (let i = 0; !(await page.evaluate(() => window.__bench.ready)); i++) { await page.waitForTimeout(300); const st = await page.evaluate(() => document.getElementById("stage").textContent + " " + document.getElementById("sDl").textContent); if (st.includes("出错")) throw new Error(st); if (i % 33 === 0) console.log("  stage:", st); }
    await context.setOffline(true);
    await cap("开源版 · 纯 CPU · WebAssembly", "✈ 断网，开始生成");
    mark("ready");
    await page.waitForTimeout(2000);
    await page.fill("#txt", "Hi there, how can I help?");
    await cap("开源版 · 纯 CPU · 断网中", "生成中…（快进 4×）");
    let n = await page.evaluate(() => window.__rec.length);
    await page.click("#go");
    mark("gen1", 4);
    while ((await page.evaluate(() => window.__rec.length)) <= n) await page.waitForTimeout(100);
    const first = await page.evaluate(() => document.getElementById("rFirst").textContent);
    await cap("开源版 · 纯 CPU · 断网中", `2 秒的话，等了 ${first} 才出声`);
    mark("play1");
    await waitAudio(page, n);
    await page.waitForTimeout(1500);
  });
  server.kill();
}
