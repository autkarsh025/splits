"""Assemble the static site into public/ (served at utkarshagarwal.dev/splits/)."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "public"


def build() -> Path:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "web", OUT)
    shutil.copy(ROOT / "data" / "races.json", OUT / "races.json")
    return OUT


if __name__ == "__main__":
    print(build())
