"""JSON-lines protocol between the zunos app and the local engine, over stdin/stdout.

Request:  {"id": 1, "cmd": "transcribe", ...args}
Response: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "...", "code": "..."}
Progress: {"id": 1, "event": "clip", "data": {...}} (zero or more, before the response)

Commands:
  hello                                  → {"version"}
  load        {model, fast?: bool}       → {"model"}; loads (and warms up) the model once
  transcribe  {path, beams?}             → {"text", "lang", "seconds", "elapsed"}; path is any wav
  eval        {model?, clips, beams?}    → {"rows", "scores"}; clips = [{id, lang, text, path}]
  segment     {path, marks, lines, out_dir, id_prefix, clean_path?, noise_db?, read?}; read = lines the reader got through
                                         → {"clips": [{id, start, end, seconds, text, path_16k, path_48k, path_48k_clean, quality}]}
  measure     {path, room?}              → measurements of a WAV (enhance.measure); room = [start, end] seconds of room tone
  enhance     {path, out, dir, lang?, lines?, marks?, read?, room?, check?} → {path, raw, clean, strength, wanted, applied, reason, ...};
                                           cleans a take's background noise into `out` (the raw file is untouched);
                                           events "progress" {"phase": measuring|downloading|cleaning|checking|done, "progress"}
  enhance_status   {dir}                 → {"denoiser", "asr"}: whether the models are downloaded into dir
  enhance_download {dir}                 → {"denoiser", "asr"} paths; background (other commands keep working)
  pack        {out, langs, clips, prompts, recordings, cfg?} → {"path", "bytes", "clips"}; training dataset
  unpack      {archive, dest}            → {"path"}; extracts a downloaded model tar
  cleanup_status   {dir}                 → {"downloaded", "totalBytes", "loaded"}; the transcript-cleanup LLM
  cleanup_download {dir}                 → {"path"}; runs in the background (other commands keep working),
                                           events "progress" {"done", "total"} in bytes
  cleanup_load     {dir}                 → {"model"}; loads (and warms up) the cleanup model
  cleanup          {text, style?, vocabulary?, hints?} → {"text", "used", "elapsed"}; used=false means the raw
                                           text came back; hints = [[heard, meant], ...] from the user's corrections
"""
import json
import os
import sys
import threading
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
        self.cleaner = None
        self.lock = threading.Lock()  # background commands emit from their own thread

    def emit(self, msg):
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        with self.lock:
            self.out.write(line)
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

        return {"clips": segment(req["path"], req["marks"], req["out_dir"], req["id_prefix"], req["lines"],
                                 req.get("clean_path"), req.get("noise_db"), req.get("read"))}

    def cmd_measure(self, req):
        import soundfile as sf

        from .enhance import measure

        x, sr = sf.read(req["path"], dtype="float32", always_2d=True)
        return measure(x.mean(axis=1), sr, req.get("room"))

    def cmd_enhance(self, req):
        from .enhance import enhance

        on_progress = lambda phase, frac: self.emit({"id": req["id"], "event": "progress", "data": {"phase": phase, "progress": round(frac, 3)}})
        return enhance(req["path"], req["out"], req["dir"], req.get("lang"), req.get("lines"), req.get("marks"), req.get("room"),
                       on_progress, req.get("check", True), read=req.get("read"))

    def cmd_enhance_status(self, req):
        from .enhance import models_ready

        dn, asr = models_ready(req["dir"])
        return {"denoiser": dn, "asr": asr}

    def background_enhance_download(self, req):
        from .enhance import download

        return download(req["dir"])

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

    def cmd_cleanup_status(self, req):
        from . import cleanup

        have = cleanup.downloaded(req["dir"])
        total = None
        if not have:
            try:
                total = cleanup.total_bytes()
            except Exception:  # offline: the app shows the download without a size
                pass
        return {"downloaded": have, "totalBytes": total, "loaded": self.cleaner is not None}

    def background_cleanup_download(self, req):
        from . import cleanup

        on_progress = lambda done, total: self.emit({"id": req["id"], "event": "progress", "data": {"done": done, "total": total}})
        return {"path": cleanup.download(req["dir"], on_progress)}

    def cmd_cleanup_load(self, req):
        from . import cleanup

        path = cleanup.model_dir(req["dir"])
        if not cleanup.downloaded(req["dir"]):
            raise EngineError("not_downloaded", "The cleanup model isn't downloaded yet.")
        if self.cleaner is None or self.cleaner.path != path:
            self.cleaner = cleanup.Cleaner(path)
            self.cleaner.warmup()
        return {"model": cleanup.MODEL_REPO}

    def cmd_cleanup(self, req):
        if self.cleaner is None:
            raise EngineError("no_cleanup_model", "The cleanup model isn't loaded. Send `cleanup_load` first.")
        t0 = time.time()
        text, used = self.cleaner.clean(req["text"], req.get("style", "light"), req.get("vocabulary") or (), req.get("hints") or ())
        return {"text": text, "used": used, "elapsed": round(time.time() - t0, 2)}

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
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        bg = getattr(engine, f"background_{req.get('cmd')}", None)
        if bg:  # long network work that must not hold up transcription
            threading.Thread(target=respond, args=(engine, req, bg), daemon=True).start()
        else:
            respond(engine, req, engine.handle)


def respond(engine, req, fn):
    try:
        engine.emit({"id": req.get("id"), "ok": True, "result": fn(req)})
    except EngineError as e:
        engine.emit({"id": req.get("id"), "ok": False, "code": e.code, "error": str(e)})
    except Exception as e:  # report and keep serving
        traceback.print_exc()
        engine.emit({"id": req.get("id"), "ok": False, "code": "internal", "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
