# woof-browser-bench

Underdog Woof 文本转语音模型的浏览器实测：前端不调云端 API，直接在网页里生成语音，到底有多快。

同一台电脑、同样 3 句英文、模型加载后断网，对比两种跑法：

1. **官方 Demo**（[underdog.ai/woof](https://underdog.ai/woof)）：31.7MB 单音色模型，WebGPU。
2. **开源版**（[ConwayResearch/Underdog-Woof](https://huggingface.co/ConwayResearch/Underdog-Woof)）：40.6MB 双音色模型，官方 numpy 运行时，用 [Pyodide](https://pyodide.org)（WebAssembly 版 CPython）原样跑在网页的 Web Worker 里，单线程 CPU。

## 结果

测试机：Intel Core i7-10700T @ 2.0GHz（低功耗台式机）、Intel UHD 核显（WebGPU，gen-9）、Windows 11、Chrome 156。数值取中位数。

**首音延迟**（点击生成 → 第一段声音开始播放）：

| 文本 | 官方 Demo（WebGPU） | 开源版（CPU / WASM，juno） |
|---|---|---|
| 短句，25 字符 | 0.50 s | 6.3 s |
| 中句，75 字符 | 0.92 s | 20.8 s |
| 长段，3 句 226 字符 | 1.30 s | 18.4 s |

**生成速度**：开源 CPU/WASM 版的实时倍率（音频时长 ÷ 计算时间）是 juno 0.28×、mira 0.16–0.33×，也就是生成比播放慢 3 倍以上，长段落播放时会卡顿等待。官方 WebGPU 版流式输出，同一句话内部的音频块间隔只有 6–10 ms，播放连续。

**冷启动**（只发生一次，主要取决于 CDN 速度）：

- 官方 Demo：首次点击到出声约 29 s（含模型下载和 WebGPU 初始化）。
- 开源版：Pyodide + numpy 启动 11–150 s、模型下载 29–77 s、权重加载约 1.4–1.6 s。两次测试差别很大，都是 jsDelivr 和 Hugging Face 的网速波动。

**离线**：两种方式在模型加载后断网都能继续生成；开源版页面统计推理期网络请求为 **0**。

原始数据：[results/bench.json](results/bench.json)（开源版，2 音色 × 2 轮）、[results/official.json](results/official.json)（官方 Demo，2 轮）。

### 怎么理解

- 体积已经不是门槛：30–40MB 一次下载，之后断网照样能用。
- 推理后端决定体验：同系列模型，WebGPU 和 CPU/WASM 的首音延迟差 12–23 倍。numpy 运行时的热点是逐帧自回归的小矩阵运算，在 WASM 里没有多线程和 BLAS 加速，Python 解释器的开销也被放大。
- 官方宣称的“单 CPU 线程 18 倍实时”是 Apple M5 Max 上的原生 Python，和浏览器里的 WASM 不可比。本仓库没有跑原生 Python 对照。
- 前端落地建议：优先 WebGPU，按句流式播放，CPU/WASM 只当兜底。

### 限制

- 只测了一台机器、一个浏览器。WebGPU 的速度和显卡强相关。
- 官方 Demo 是 31.7MB 单音色模型，开源仓库是 40.6MB 双音色模型，不是同一个文件。
- 官方 Demo 的首音延迟是通过拦截 `AudioBufferSourceNode.start` 测的（点击按钮 → 第一个音频块排期播放的时刻）。
- mira 音色的短句会触发官方运行时的“重抽”逻辑（检测到停顿过长就重新生成，最多 4 次），所以耗时 35 s，比中句还长。
- Woof 只支持英文。

## 自己跑

需要 Node.js 18+ 和 Chrome。

```bash
npm install
```

```bash
npm run serve
```

然后打开 http://localhost:8787 ，点“加载模型”，再点“生成并播放”。

自动化基准（会启动 Chrome，断网后跑完所有句子，结果写到 `results/`）：

```bash
npm run bench
```

```bash
npm run official
```

录制并合成短视频（需要先跑完上面两个基准；`ffmpeg-static` 的二进制如果没装上，执行 `node node_modules/ffmpeg-static/install.js`）：

```bash
npm run record
```

```bash
npm run video
```

成片输出到 `video/woof-browser-test.mp4`，口播稿和分镜见 [SCRIPT.md](SCRIPT.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` / `worker.js` | 测试页面。Worker 里加载 Pyodide + numpy，从 Hugging Face（固定提交 `be70296`）下载 Woof 官方代码和权重，逐句生成并回传音频 |
| `bench.mjs` | 开源版自动基准 |
| `measure_official.mjs` | 官方 Demo 自动测量 |
| `record.mjs` / `make_video.mjs` / `cards.html` | 录屏、捕获音频、合成 9:16 短视频 |
| `native_baseline.py` | 原生 Python 对照脚本（本次未运行） |

## 许可

本仓库代码 MIT。仓库**不包含** Woof 的代码和权重，页面运行时从 Hugging Face 下载。Woof 使用 Underdog Non-Commercial License 1.0：个人、研究、教学和非营利可免费使用，商用需要联系 Underdog 授权。

来源：[TechCrunch，2026-11-06](https://techcrunch.com/2026/11/06/underdog-shows-off-a-32mb-speech-model-in-new-demo/)、[Hugging Face 模型卡](https://huggingface.co/ConwayResearch/Underdog-Woof)。
