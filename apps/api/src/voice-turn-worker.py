"""Optional local turn worker. Models/features are supplied by the operator, never downloaded here."""
import base64
import json
import os
import sys
import time

# Runtime directory contains verified dependencies, model files and their licenses.
sys.path.insert(0, sys.argv[1])
import numpy as np
import onnxruntime as ort
from _whisper_features import compute_whisper_log_mel_features

RATE = 16000
options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
vad = ort.InferenceSession(os.path.join(sys.argv[1], "silero_vad.onnx"), options,
                           providers=["CPUExecutionProvider"])
turn = ort.InferenceSession(os.path.join(sys.argv[1], "smart-turn-v3.2-cpu.onnx"), options,
                            providers=["CPUExecutionProvider"])
sessions = {}


def new_state():
    return dict(state=np.zeros((2, 1, 128), dtype=np.float32),
                context=np.zeros((1, 64), dtype=np.float32),
                tail=np.zeros(0, dtype=np.float32), audio=np.zeros(0, dtype=np.float32),
                heard=False, silence=0, checked=0, quiet_reset=0, ended=False,
                probability=0.0, at=time.monotonic())


def feed(key, pcm):
    now = time.monotonic()
    for stale in [k for k, v in sessions.items() if now - v["at"] > 60]:
        del sessions[stale]
    if key not in sessions and len(sessions) >= 100:
        raise ValueError("Too many streams")
    s = sessions.setdefault(key, new_state())
    s["at"] = now
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    s["audio"] = np.concatenate((s["audio"], audio))[-8 * RATE:]
    frames = np.concatenate((s["tail"], audio))
    for offset in range(0, len(frames) - 511, 512):
        frame = frames[offset:offset + 512][None, :]
        joined = np.concatenate((s["context"], frame), axis=1)
        probability, s["state"] = vad.run(None, {
            "input": joined, "state": s["state"], "sr": np.array(RATE, dtype=np.int64)})
        s["context"] = frame[:, -64:]
        s["probability"] = float(probability.ravel()[0])
        if s["probability"] >= 0.7 and float(np.sqrt(np.mean(frame ** 2))) > 0.003:
            s["heard"] = True
            s["silence"] = 0
            s["checked"] = 0
            s["quiet_reset"] = 0
            s["ended"] = False
        else:
            s["silence"] += 512
            # Reset recurrent noise history only during sustained quiet.
            if s["silence"] - s["quiet_reset"] >= 2 * RATE:
                s["state"].fill(0)
                s["context"].fill(0)
                s["quiet_reset"] = s["silence"]
    s["tail"] = frames[(len(frames) // 512) * 512:]
    silence_ms = s["silence"] * 1000 / RATE
    # A pause to think is not the end of a turn. The caller also applies its own
    # minimum quiet window; only prolonged silence bypasses the semantic model.
    if s["heard"] and silence_ms >= 600 and s["silence"] - s["checked"] >= RATE * 0.4:
        s["checked"] = s["silence"]
        padded = np.pad(s["audio"], (max(0, 8 * RATE - len(s["audio"])), 0))
        features = compute_whisper_log_mel_features(padded, do_normalize=True)[None, ...]
        s["ended"] = float(turn.run(None, {"input_features": features})[0].ravel()[0]) > 0.5
    complete = s["heard"] and (silence_ms >= 12000 or s["ended"])
    return dict(complete=bool(complete), speechProbability=s["probability"], silenceMs=silence_ms)


for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if "close" in request:
            sessions.pop(request["close"], None)
            continue
        pcm = base64.b64decode(request["pcm"], validate=True)
        if len(pcm) > 256000 or len(pcm) % 2:
            raise ValueError("Invalid audio chunk")
        result = feed(request["session"], pcm)
        print(json.dumps(dict(id=request["id"], **result)), flush=True)
    except Exception:
        print(json.dumps(dict(id=request.get("id"), error="Turn detection unavailable")), flush=True)
