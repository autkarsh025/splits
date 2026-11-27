"""Reduce open marathon results (CC BY 4.0) to compact distributions for the Splits page.

Sources:
  Marathon Data 2000-2019, Colorado School of Mines, Zenodo 10.5281/zenodo.6959864 (CC BY 4.0)
  London Marathon Data 2018-2023, University College Cork, Zenodo 10.5281/zenodo.10960982 (CC BY 4.0)
  National Running Club Database v2.0.0 (college club XC, track and road), Zenodo 10.5281/zenodo.20578527 (CC BY 4.0)
Runs in GitHub Actions (needs the internet). Writes data/races.json (small) and prints the schema it found.
"""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parent / "races.json"
SOURCES = {
    "us": ("https://zenodo.org/records/6959864/files/all_marathons_final.csv?download=1", "csv"),
    "london": ("https://zenodo.org/records/10960982/files/Respository%20London%20Marathon%2018-23.xlsx?download=1", "xlsx"),
}
Q = np.linspace(0, 1, 1001)  # 0.1% resolution


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "splits-data-build"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def to_seconds(s: pd.Series) -> pd.Series:
    """Accept 'H:MM:SS', 'MM:SS', seconds, or minutes; return seconds (float)."""
    if pd.api.types.is_numeric_dtype(s):
        v = s.astype(float)
        return v * 60 if v.median() < 1000 else v
    def one(x):
        if pd.isna(x):
            return np.nan
        x = str(x).strip()
        m = re.match(r"^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$", x)
        if m:
            return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
        m = re.match(r"^(\d+):(\d{1,2}(?:\.\d+)?)$", x)
        if m:
            return int(m[1]) * 60 + float(m[2])
        try:
            return float(x)
        except ValueError:
            return np.nan
    return s.map(one)


def pick(cols, *pats):
    low = {c: str(c).lower().replace(" ", "").replace("_", "") for c in cols}
    for p in pats:
        for c, l in low.items():
            if re.search(p, l):
                return c
    return None


def normalize(df: pd.DataFrame, name: str) -> pd.DataFrame:
    cols = list(df.columns)
    print(f"[{name}] {len(df):,} rows; columns: {cols}")
    print(df.head(3).to_string()[:1500])
    tcol = pick(cols, r"^full$", r"^fulltime$", r"^chip", r"nettime", r"^net", r"chiptime", r"finish", r"^time$", r"officialtime", r"gun", r"time")
    gcol = pick(cols, r"^gender", r"^sex", r"^mf$", r"^g$", r"category")
    acol = pick(cols, r"^age$", r"agegroup", r"^ag$", r"age")
    ycol = pick(cols, r"^year$", r"racedate", r"year")
    rcol = pick(cols, r"^marathon$", r"^race$", r"marathonname", r"event")
    print(f"[{name}] using time={tcol} gender={gcol} age={acol} year={ycol} race={rcol}")
    out = pd.DataFrame({"t": to_seconds(df[tcol])})
    if gcol and pd.api.types.is_numeric_dtype(df[gcol]):  # London sheets: "Male 1 and Female 0"
        out["g"] = df[gcol].map({1: "M", 0: "F"})
    else:
        out["g"] = df[gcol].astype(str).str.upper().str[0].map({"M": "M", "F": "F", "W": "F"}) if gcol else np.nan
    out["age"] = pd.to_numeric(df[acol], errors="coerce") if acol else np.nan
    if tcol is None:
        raise SystemExit(f"[{name}] no time column found")
    out["year"] = pd.to_numeric(df[ycol].astype(str).str[:4], errors="coerce") if ycol else np.nan
    out["race"] = df[rcol].astype(str) if rcol else name
    out = out[(out.t > 2 * 3600) & (out.t < 8 * 3600)]
    print(f"[{name}] kept {len(out):,} finishes")
    return out


def quant(t: pd.Series) -> list[int]:
    return [int(round(v)) for v in np.quantile(t.values, Q)] if len(t) else []


NRCD_URL = "https://zenodo.org/api/records/20578527"


def nrcd_events() -> dict:
    """College club results: per event and gender, finish-time quantiles. Prints the file layout it finds."""
    meta = json.loads(fetch(NRCD_URL))
    f = next(x for x in meta["files"] if x["key"].endswith(".zip"))
    raw = fetch(f["links"]["self"])
    print(f"[nrcd] downloaded {len(raw) / 1e6:.1f} MB: {f['key']}")
    z = zipfile.ZipFile(io.BytesIO(raw))
    tables = {}
    for name in z.namelist():
        if name.lower().endswith(".csv"):
            df = pd.read_csv(z.open(name), low_memory=False)
            tables[name] = df
            print(f"[nrcd] {name}: {len(df):,} rows; columns: {list(df.columns)[:30]}")
            print(df.head(2).to_string()[:900])
    return tables


EVENT_M = {"800m": 800, "1500m": 1500, "1600m": 1600, "mile": 1609.344, "3000m": 3000, "3200m": 3200, "5000m": 5000,
           "6000m": 6000, "8000m": 8000, "10000m": 10000, "half marathon": 21097.5}


def college(tables: dict) -> dict:
    """Best time per athlete per event (individual results only), quantiles by gender."""
    j = next(v for k, v in tables.items() if k.endswith("joined.csv"))
    r = next(v for k, v in tables.items() if k.endswith("result.csv"))
    solo = set(r.loc[r["athlete_id_2"].isna(), "result_id"])
    j = j[j["result_id"].isin(solo)].copy()
    ev = j["event_name"].astype(str).str.strip().str.lower()
    print("[nrcd] event names:", sorted(ev.unique())[:60])
    j["m"] = ev.map(EVENT_M)
    j["t"] = to_seconds(j["result_time"].astype(str))
    j["kind"] = np.where(j["sport_name"].astype(str).str.lower().str.contains("cross"), "xc",
                         np.where(j["sport_name"].astype(str).str.lower().str.contains("road"), "road", "track"))
    j = j.dropna(subset=["m", "t", "athlete_id"])
    j = j[j["t"] > 60]
    out = {}
    for (kind, m, g), grp in j.groupby(["kind", "m", "gender"]):
        best = grp.groupby("athlete_id")["t"].min()
        if len(best) < 120:
            continue
        key = f"{kind}:{int(round(m))}"
        out.setdefault(key, {})[g] = {"n": int(len(best)), "q": [round(float(v), 2) for v in np.quantile(best.values, np.linspace(0, 1, 201))]}
    print("[nrcd] events kept:", {k: {g: v["n"] for g, v in d.items()} for k, d in out.items()})
    return out


def main() -> None:
    frames = []
    for name, (url, kind) in SOURCES.items():
        try:
            raw = fetch(url)
        except Exception as e:
            print(f"[{name}] download failed: {e}", file=sys.stderr)
            continue
        print(f"[{name}] downloaded {len(raw) / 1e6:.1f} MB")
        if kind == "csv":
            frames.append(normalize(pd.read_csv(io.BytesIO(raw), low_memory=False), name))
        else:
            for sheet, df in pd.read_excel(io.BytesIO(raw), sheet_name=None).items():
                n = normalize(df, f"london/{sheet}")
                if n["race"].eq(f"london/{sheet}").all():
                    n["race"] = "London"
                if n["year"].isna().all():
                    m = re.search(r"(20\d\d)", str(sheet))
                    n["year"] = int(m[1]) if m else np.nan
                frames.append(n)
    if not frames:
        sys.exit("no data downloaded")
    d = pd.concat(frames, ignore_index=True)
    d["race"] = d["race"].str.strip().str.title()
    races = []
    for r, grp in d.groupby("race"):
        if len(grp) < 5000:
            continue
        races.append({"name": r, "n": int(len(grp)), "years": sorted({int(y) for y in grp.year.dropna().unique()}),
                      "q": [int(round(v)) for v in np.quantile(grp.t.values, np.linspace(0, 1, 201))]})
    races.sort(key=lambda x: -x["n"])
    by_year = d.dropna(subset=["year"]).groupby("year").t.agg(["median", "count"])
    out = {
        "n": int(len(d)),
        "all": quant(d.t), "men": quant(d[d.g == "M"].t), "women": quant(d[d.g == "F"].t),
        "n_men": int((d.g == "M").sum()), "n_women": int((d.g == "F").sum()),
        "races": races,
        "median_by_year": [[int(y), int(r["median"]), int(r["count"])] for y, r in by_year.iterrows() if r["count"] > 10000],
        "age": [],
        "sources": ["Marathon Data 2000-2019, Colorado School of Mines, Zenodo, CC BY 4.0",
                    "London Marathon Data 2018-2023, University College Cork, Zenodo, CC BY 4.0"],
    }
    a = d.dropna(subset=["age"])
    a = a[(a.age >= 16) & (a.age <= 85)]
    if len(a) > 50000:
        for lo in range(18, 80, 5):
            grp = a[(a.age >= lo) & (a.age < lo + 5)]
            if len(grp) > 2000:
                out["age"].append([lo, int(grp.t.median()), int(len(grp))])
    try:
        out["college"] = college(nrcd_events())
        out["sources"].append("National Running Club Database v2.0.0, Zenodo, CC BY 4.0")
    except Exception as e:
        print(f"[nrcd] skipped: {e}", file=sys.stderr)
        out["college"] = {}
    names = {"Nyc": "New York City", "Marinecorps": "Marine Corps", "La": "Los Angeles", "Twin_Cities": "Twin Cities",
             "Grandmas": "Grandma's", "California_International": "California International"}
    for r_ in out["races"]:
        r_["name"] = names.get(r_["name"], r_["name"])
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} KB): {out['n']:,} finishes, {len(races)} races")


if __name__ == "__main__":
    main()
