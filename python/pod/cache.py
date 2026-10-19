"""Persistent, content-addressed store for generated and judged synthetic speech, per user.

Two levels, both optional:
  - a local directory, ZUNOS_CACHE (default <work>/cache). Point it at a Runpod network volume and every
    pod that mounts it reuses earlier sets.
  - the zunos backend: ZUNOS_CACHE_URL (= <api>/runs/<id>/cache, authenticated with the events token)
    maps names to the user's own blob folder, so sets survive across pods without a volume.

Entries are named `<kind>-<16 hex>.<ext>` where the hex is config.digest() of everything that determines
the content: a synthetic shard (kind "synth") hashes its sentences, engine and engine settings, reference
clips (by audio hash), pace settings and the generator version; a judged list (kind "judged") hashes the
synth key and the judge settings. Same inputs, same name: a variant that changes only training settings
finds everything already made.
"""
import os
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.request

NAME_OK = lambda n: n.split("-", 1)[0].isalpha() and len(n) < 80


class Cache:
    def __init__(self, root, url=None, token=None, log=print):
        self.root, self.url, self.token, self.log = root, url, token, log
        os.makedirs(root, exist_ok=True)

    def _req(self, method, name, data=None):
        h = {"Authorization": f"Bearer {self.token}"}
        if data is not None:
            h["Content-Type"] = "application/octet-stream"
        return urllib.request.Request(f"{self.url}/{name}", data=data, method=method, headers=h)

    def get_dir(self, name):
        """Path to the cached directory `name` (fetched from the backend if needed), or None."""
        assert NAME_OK(name), name
        local = f"{self.root}/{name}"
        if os.path.exists(f"{local}/.complete"):
            return local
        if not self.url:
            return None
        tar = f"{self.root}/.{name}.tar"
        try:
            with urllib.request.urlopen(self._req("GET", f"{name}.tar"), timeout=60) as r, open(tar, "wb") as f:
                shutil.copyfileobj(r, f, 8 << 20)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                self.log(f"cache: GET {name} failed: HTTP {e.code}")
            return None
        except Exception as e:  # the backend is an optimization; never fail a run over it
            self.log(f"cache: GET {name} failed: {e}")
            return None
        shutil.rmtree(local, ignore_errors=True)
        with tarfile.open(tar) as t:
            t.extractall(self.root, filter="data")
        os.remove(tar)
        if not os.path.exists(f"{local}/.complete"):
            shutil.rmtree(local, ignore_errors=True)
            return None
        self.log(f"cache: fetched {name}")
        return local

    def put_dir(self, name, src):
        """Stores directory `src` as `name` (moved into the local cache) and uploads it. Returns the path."""
        assert NAME_OK(name), name
        local = f"{self.root}/{name}"
        if os.path.abspath(src) != os.path.abspath(local):
            shutil.rmtree(local, ignore_errors=True)
            shutil.move(src, local)
        open(f"{local}/.complete", "w").close()
        if self.url:
            tar = f"{self.root}/.{name}.tar"
            with tarfile.open(tar, "w") as t:  # FLAC doesn't compress further
                t.add(local, arcname=name)
            try:
                # curl streams the file (urllib would hold it in memory); the token stays out of argv via -K.
                cfg = f"{self.root}/.curl-{name}"
                with open(cfg, "w") as f:
                    f.write(f'header = "Authorization: Bearer {self.token}"\n')
                os.chmod(cfg, 0o600)
                subprocess.run(["curl", "-fsS", "--retry", "3", "-K", cfg, "-X", "PUT", "-H",
                                "Content-Type: application/x-tar", "-T", tar, f"{self.url}/{name}.tar"],
                               check=True, capture_output=True)
                self.log(f"cache: uploaded {name} ({os.path.getsize(tar) >> 20} MB)")
            except Exception as e:
                self.log(f"cache: upload of {name} failed: {e}")
            finally:
                for p in (tar, f"{self.root}/.curl-{name}"):
                    if os.path.exists(p):
                        os.remove(p)
        return local
