"""Assemble the static site into public/ (served at utkarshagarwal.dev/oval/).

Every asset URL gets a ?v= stamp from a hash of the source files, so a browser never mixes
a new page with cached old styles or scripts.
"""
import hashlib
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "public"
ASSETS = ["style.css", "app.js", "model.js", "plan.js", "races.json"]


def build() -> Path:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "web", OUT)
    shutil.copy(ROOT / "data" / "races.json", OUT / "races.json")
    h = hashlib.sha1()
    for name in ASSETS:
        h.update((OUT / name).read_bytes())
    v = h.hexdigest()[:10]
    for name in ["index.html", "app.js", "plan.js"]:
        p = OUT / name
        text = p.read_text()
        # href="style.css", src="app.js", './model.js', 'races.json'
        text = re.sub(r"""(["'])(\./)?(style\.css|app\.js|model\.js|plan\.js|races\.json)\1""",
                      lambda m: f"{m.group(1)}{m.group(2) or ''}{m.group(3)}?v={v}{m.group(1)}", text)
        p.write_text(text)
    return OUT


if __name__ == "__main__":
    print(build())
