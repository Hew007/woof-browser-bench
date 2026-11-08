"""Native CPython + numpy baseline on the same machine, same sentences, same piece-by-piece timing as the web page.
Usage: python native_baseline.py <dir containing underdog_woof/ and woof_int8.npz> [threads]
Set threads=1 to match the single-threaded WebAssembly run."""
import json, os, sys, time

src = os.path.abspath(sys.argv[1])
threads = sys.argv[2] if len(sys.argv) > 2 else "1"
for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[k] = threads
sys.path.insert(0, src)
import numpy as np  # noqa: E402
from underdog_woof import Woof  # noqa: E402
from underdog_woof.runtime import RNG  # noqa: E402
from underdog_woof.textsplit import split_text  # noqa: E402

SENTENCES = [
    ("short", "Hi there, how can I help?"),
    ("medium", "Your order ships on March 3rd, and the total comes to $42.50 including tax."),
    ("long", "Welcome back! Today we are testing a tiny speech model that runs entirely inside the browser. "
             "There is no server, no API key, and no network call once the page has loaded. "
             "Let's see how fast it really is on an ordinary laptop."),
]
rounds = 3
out = []
for voice in ("juno", "mira"):
    t = time.perf_counter()
    tts = Woof(voice=voice)
    print(voice, "load", round(time.perf_counter() - t, 2), "s", flush=True)
    for r in range(rounds):
        for label, text in SENTENCES:
            RNG.seed(0)
            t0 = time.perf_counter()
            pieces = split_text(tts.norm(text)) or [text]
            first, audio = None, 0.0
            for p in pieces:
                wav = tts._piece(p)
                audio += len(wav) / 24000
                if first is None:
                    first = time.perf_counter() - t0
            total = time.perf_counter() - t0
            row = dict(voice=voice, label=label, round=r, firstMs=first * 1000, audioSec=audio, computeMs=total * 1000, rtf=audio / total)
            out.append(row)
            print(voice, label, r, f"first {first*1000:.0f}ms audio {audio:.2f}s compute {total*1000:.0f}ms x{audio/total:.2f}", flush=True)
json.dump(dict(numpy=np.__version__, threads=threads, results=out), open(f"results/native_t{threads}.json", "w"), indent=2)
