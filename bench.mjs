// Headless benchmark: cold start + a set of sentences, both voices, in real Chromium.
// Usage: node bench.mjs [--rounds 3] [--headed]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { SENTENCES } from "./sentences.mjs";

const args = process.argv.slice(2);
const ROUNDS = Number(args[args.indexOf("--rounds") + 1]) || 3;
const PORT = 8790;
const server = spawn(process.execPath, ["serve.mjs", String(PORT)], { cwd: new URL(".", import.meta.url), stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));


const browser = await chromium.launch({ channel: process.env.CHANNEL || "chrome", headless: !args.includes("--headed"), args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
await page.goto(`http://localhost:${PORT}/?autoload`);
await page.waitForFunction(() => window.__bench.ready, null, { timeout: 300000 });
const ready = await page.evaluate(() => window.__bench.ready);
console.log("cold start", ready);

await page.context().setOffline(true);          // prove inference needs no network
const results = [];
for (const voice of ["juno", "mira"]) {
  await page.selectOption("#voice", voice);
  for (let r = 0; r < ROUNDS; r++) {
    for (const [label, text] of SENTENCES) {
      await page.fill("#txt", text);
      const before = await page.evaluate(() => window.__bench.runs.length);
      await page.click("#go");
      await page.waitForFunction((n) => window.__bench.runs.length > n, before, { timeout: 300000 });
      const run = await page.evaluate(() => window.__bench.runs.at(-1));
      run.label = label; run.round = r;
      results.push(run);
      console.log(voice, label, `r${r}`, `first ${run.firstMs.toFixed(0)}ms`, `audio ${run.audioSec.toFixed(2)}s`,
        `compute ${run.computeMs.toFixed(0)}ms`, `x${run.rtf.toFixed(2)}`);
    }
  }
}
const netDuringInference = await page.evaluate(() => document.getElementById("pReq").textContent);
const out = {
  date: new Date().toISOString(), browser: `${process.env.CHANNEL || "chrome"} ${browser.version()}`,
  machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, os: `${os.type()} ${os.release()}` },
  ready, netDuringInference, results,
};
await writeFile("results/bench.json", JSON.stringify(out, null, 2));
console.log(netDuringInference);
await browser.close();
server.kill();
