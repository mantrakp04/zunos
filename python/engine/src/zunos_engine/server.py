"""JSON-lines protocol between the zunos app and the local engine, over stdin/stdout.

Request:  {"id": 1, "cmd": "transcribe", ...args}
Response: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "...", "code": "..."}
Progress: {"id": 1, "event": "clip", "data": {...}} (zero or more, before the response)

Commands:
  hello                                  → {"version"}
  load        {model, fast?: bool}       → {"model"}; loads (and warms up) the model once
  transcribe  {path, beams?}             → {"text", "lang", "seconds", "elapsed"}; path is any wav
  eval        {model?, clips, beams?}    → {"rows", "scores"}; clips = [{id, lang, text, path}]
  segment     {path, marks, lines, out_dir, id_prefix} → {"clips": [{id, start, end, seconds, text, path_16k, path_48k}]}
  pack        {out, langs, clips, prompts, recordings, cfg?} → {"path", "bytes", "clips"}; training dataset
  unpack      {archive, dest}            → {"path"}; extracts a downloaded model tar
"""
import json
import os
import sys
import time
import traceback

VERSION = "0.1.0"


class EngineError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Engine:
    def __init__(self, out):
        self.out = out
        self.model = None

    def emit(self, msg):
        self.out.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.out.flush()

    def ensure_model(self, path=None, fast=False):
        if path and (self.model is None or self.model.path != path):
            from .model import FastModel, Model

            self.model = FastModel(path) if fast else Model(path)
            self.model.warmup()
        if self.model is None:
            raise EngineError("no_model", "No model loaded. Send `load` first.")
        return self.model

    def cmd_hello(self, req):
        return {"version": VERSION}

    def cmd_load(self, req):
        m = self.ensure_model(req["model"], req.get("fast", False))
        return {"model": m.path}

    def cmd_transcribe(self, req):
        import soundfile as sf

        from .audio import to_16k
        from .model import check_level

        audio, rate = sf.read(req["path"], dtype="float32", always_2d=True)
        audio = to_16k(audio.mean(axis=1), rate)
        if err := check_level(audio):
            raise EngineError(err, "The recording is silent." if err == "mic_blocked" else "The recording is too quiet.")
        t0 = time.time()
        text, lang = self.ensure_model().transcribe(audio, beams=req.get("beams"))
        return {"text": text, "lang": lang, "seconds": round(len(audio) / 16000, 2), "elapsed": round(time.time() - t0, 2)}

    def cmd_eval(self, req):
        from .eval import evaluate

        model = self.ensure_model(req.get("model"))
        return evaluate(model, req["clips"], req.get("beams", 4), on_clip=lambda r: self.emit({"id": req["id"], "event": "clip", "data": r}))

    def cmd_segment(self, req):
        from .segment import segment

        return {"clips": segment(req["path"], req["marks"], req["out_dir"], req["id_prefix"], req["lines"])}

    def cmd_pack(self, req):
        from .pack import pack

        return pack(req["out"], req["langs"], req["clips"], req["prompts"], req["recordings"], req.get("cfg"))

    def cmd_unpack(self, req):
        import tarfile

        with tarfile.open(req["archive"]) as t:
            names = t.getnames()
            t.extractall(req["dest"], filter="data")
        top = names[0].split("/")[0] if names else ""
        return {"path": os.path.join(req["dest"], top)}

    def handle(self, req):
        fn = getattr(self, f"cmd_{req.get('cmd')}", None)
        if fn is None:
            raise EngineError("unknown_cmd", f"Unknown command {req.get('cmd')!r}")
        return fn(req)


def main():
    # Keep stdout for protocol messages only; libraries that print go to stderr.
    out, sys.stdout = sys.stdout, sys.stderr
    engine = Engine(out)
    engine.emit({"event": "ready", "data": {"version": VERSION}})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            engine.emit({"id": req.get("id"), "ok": True, "result": engine.handle(req)})
        except EngineError as e:
            engine.emit({"id": req.get("id"), "ok": False, "code": e.code, "error": str(e)})
        except Exception as e:  # report and keep serving
            traceback.print_exc()
            engine.emit({"id": req.get("id"), "ok": False, "code": "internal", "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
