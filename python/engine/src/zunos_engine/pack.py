"""Bundle the user's recordings into the dataset a training pod consumes (python/pod/run.py).

dataset.tar.gz:
  manifest.json         {langs, cfg, clips: [...], prompts: [...]}
  clips/16k/<id>.wav    every clip (training input and test set)
  clips/48k/<id>.wav    train clips only (voice-cloning references are cut from these)
  recordings/<id>.wav   full takes behind the train clips (room tone for noise augmentation)
"""
import io
import json
import os
import tarfile


def pack(out, langs, clips, prompts, recordings, cfg=None):
    """clips: [{id, lang, split, text, native_text, seconds, kind, path_16k, path_48k}];
    prompts: [{id, lang, roman, native}]; recordings: [absolute wav paths]."""
    manifest = {
        "langs": langs,
        "cfg": cfg or {},
        "clips": [{k: c.get(k) for k in ("id", "lang", "split", "text", "native_text", "seconds", "kind")} for c in clips],
        "prompts": prompts,
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with tarfile.open(tmp, "w:gz", compresslevel=6) as t:
        data = json.dumps(manifest, ensure_ascii=False).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
        for c in clips:
            t.add(c["path_16k"], arcname=f"clips/16k/{c['id']}.wav")
            if c["split"] == "train" and c.get("path_48k") and os.path.exists(c["path_48k"]):
                t.add(c["path_48k"], arcname=f"clips/48k/{c['id']}.wav")
        for r in recordings:
            if os.path.exists(r):
                t.add(r, arcname=f"recordings/{os.path.basename(r)}")
    os.replace(tmp, out)
    return {"path": out, "bytes": os.path.getsize(out), "clips": len(clips)}
