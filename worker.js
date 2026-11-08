// Runs Underdog Woof's official numpy runtime inside the browser via Pyodide (CPython + numpy compiled to WebAssembly).
// Nothing is sent to a server: the page downloads the model files once, then all synthesis happens in this worker.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
// Pinned to the Hugging Face commit that was tested (2026-11-06).
const REV = "be702960539777fc3f698e54335276a8391b00f9";
const HF = `https://huggingface.co/ConwayResearch/Underdog-Woof/resolve/${REV}/`;
const FILES = [
  "underdog_woof/__init__.py", "underdog_woof/runtime.py", "underdog_woof/normalize.py",
  "underdog_woof/respell.py", "underdog_woof/respell.tsv", "underdog_woof/textsplit.py", "woof_int8.npz",
];

importScripts(PYODIDE + "pyodide.js");
let py, ready = false;
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);

async function fetchWithProgress(url, onBytes, tries = 4) {
  // CDNs drop long downloads now and then: retry the whole file, taking back the bytes already counted
  let counted = 0;
  try {
    return await fetchOnce(url, (b) => { counted += b; onBytes(b); });
  } catch (err) {
    onBytes(-counted);
    if (tries <= 1) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return fetchWithProgress(url, onBytes, tries - 1);
  }
}

async function fetchOnce(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length; onBytes(value.length);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function init() {
  const t0 = performance.now();
  post("stage", { stage: "boot", msg: "启动 Pyodide（WebAssembly 版 Python）" });
  py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage("numpy");
  const tBoot = performance.now() - t0;

  post("stage", { stage: "download", msg: "下载 Woof 模型文件（Hugging Face）" });
  const t1 = performance.now();
  let got = 0;
  py.FS.mkdirTree("/woof/underdog_woof");
  await Promise.all(FILES.map(async (f) => {
    const buf = await fetchWithProgress(HF + f, (b) => { got += b; post("bytes", { got }); });
    py.FS.writeFile("/woof/" + f, buf);
  }));
  const tDl = performance.now() - t1;

  post("stage", { stage: "load", msg: "加载权重（int8 → fp32）" });
  const t2 = performance.now();
  await py.runPythonAsync(`
import sys, time, os
os.environ["WOOF_FIRST_MAX"] = "0"
sys.path.insert(0, "/woof")
import numpy as np
from underdog_woof import Woof
from underdog_woof.textsplit import split_text
_tts = {}
def get_tts(voice):
    if voice not in _tts:
        _tts[voice] = Woof(voice=voice)
    return _tts[voice]
get_tts("juno")
`);
  const tLoad = performance.now() - t2;
  ready = true;
  post("ready", { tBoot, tDl, tLoad, bytes: got, total: performance.now() - t0 });
}

async function synth({ text, voice, seed, id }) {
  // Normalize + split exactly as Woof.__call__ does, but synthesize piece by piece so the page can start
  // playing the first sentence while later ones are still being generated (time-to-first-audio).
  const t0 = performance.now();
  py.globals.set("_text", text); py.globals.set("_voice", voice); py.globals.set("_seed", seed);
  const pieces = py.runPython(`
from underdog_woof.runtime import RNG
_t = get_tts(_voice)
RNG.seed(int(_seed))
_norm = _t.norm(_text) if _t.norm else _text
_pieces = split_text(_norm) or [_norm]
_pieces
`).toJs();
  post("pieces", { id, pieces, normalized: py.globals.get("_norm") });
  for (let i = 0; i < pieces.length; i++) {
    const ts = performance.now();
    py.globals.set("_i", i);
    const arr = py.runPython(`_t._piece(_pieces[_i]).astype(np.float32)`);
    const pcm = arr.toJs(); arr.destroy();
    const te = performance.now();
    post("chunk", {
      id, i, n: pieces.length, text: pieces[i], pcm,
      computeMs: te - ts, sinceStartMs: te - t0, audioSec: pcm.length / 24000,
    }, [pcm.buffer]);
  }
  post("done", { id, totalMs: performance.now() - t0 });
}

self.onmessage = async (e) => {
  try {
    if (e.data.type === "init") await init();
    else if (e.data.type === "synth") { if (!ready) throw new Error("model not ready"); await synth(e.data); }
  } catch (err) { post("error", { msg: String(err && err.message || err) }); }
};
