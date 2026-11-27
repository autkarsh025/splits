"""End-to-end checks for every feature of Oval, in several browser setups.

Usage: python3 tools/e2e.py [config ...]   (configs: desk-light desk-dark phone-light phone-dark tablet)
Serves public/ locally, drives Chrome with Playwright, prints every failed check, exits non-zero on failure.
"""
import asyncio, datetime, json, math, os, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8811
CONFIGS = {
    "desk-light": dict(viewport={"width": 1280, "height": 900}, color_scheme="light"),
    "desk-dark": dict(viewport={"width": 1440, "height": 900}, color_scheme="dark"),
    "phone-light": dict(viewport={"width": 390, "height": 844}, color_scheme="light", is_mobile=True, has_touch=True),
    "phone-dark": dict(viewport={"width": 360, "height": 740}, color_scheme="dark", is_mobile=True, has_touch=True),
    "tablet": dict(viewport={"width": 820, "height": 1180}, color_scheme="light", has_touch=True),
}
SHOTS = "/tmp/e2e"


def fixtures():
    os.makedirs(SHOTS, exist_ok=True)
    lat0, lon0, pts, t = 37.8716, -122.2727, [], datetime.datetime(2026, 11, 24, 15, 0, 0)
    for i in range(0, 1001):  # 10 km north, a fast middle section, a hill
        d = i * 10
        dt = 2.7 if not (300 <= i < 500) else 2.3
        t += datetime.timedelta(seconds=dt)
        pts.append(f'<trkpt lat="{lat0 + d / 111195:.6f}" lon="{lon0 + 0.002 * math.sin(d / 1500):.6f}"><ele>{50 + 25 * math.sin(d / 2500):.1f}</ele><time>{t.isoformat()}Z</time></trkpt>')
    open(f"{SHOTS}/run.gpx", "w").write('<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Tempo by the bay</name><trkseg>' + "".join(pts) + "</trkseg></trk></gpx>")
    open(f"{SHOTS}/activities.csv", "w").write(
        "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time,Elevation Gain\n"
        '1,"Nov 10, 2026, 3:00:00 PM","Easy, recovery",Run,2700,8.0,2650,30\n'
        '2,"Nov 15, 2026, 7:00:00 AM",Long run,Run,6000,19.3,5900,120\n'
        '3,"Nov 18, 2026, 7:00:00 AM",Spin,Ride,3600,30,3600,100\n')
    open(f"{SHOTS}/junk.gpx", "w").write("<gpx></gpx>")


class Run:
    def __init__(self, name):
        self.name, self.fails, self.n = name, [], 0

    def check(self, ok, what):
        self.n += 1
        if not ok:
            self.fails.append(what)


async def text(pg, sel):
    return (await pg.text_content(sel)) or ""


async def visible(pg, sel):
    try:
        return await pg.is_visible(sel)
    except Exception:
        return False


async def no_overflow(pg, r, where):
    w = await pg.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    r.check(w[0] <= w[1] + 1, f"{where}: page scrolls sideways ({w[0]} > {w[1]})")


async def tab(pg, name):
    await pg.click(f"#tab-{name}", force=True)
    await pg.wait_for_timeout(250)


async def one(cfg_name, browser):
    r = Run(cfg_name)
    ctx = await browser.new_context(accept_downloads=True, permissions=["clipboard-read", "clipboard-write"], **CONFIGS[cfg_name])
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errs.append(f"console: {m.text}") if m.type == "error" and "fonts.g" not in m.text and "net::" not in m.text else None)
    base = f"http://localhost:{PORT}/"
    await pg.goto(base)
    await pg.evaluate("localStorage.clear()")
    await pg.goto(base)
    await pg.wait_for_timeout(900)

    # ---------------------------------------------------------------- landing
    r.check(await pg.evaluate("document.body.dataset.state") == "empty", "landing: starts empty")
    r.check(await visible(pg, "#teaser"), "landing: preview visible")
    r.check(await pg.get_attribute("#tab-rank", "aria-disabled") == "true", "landing: rankings locked")
    r.check(await pg.get_attribute("#tab-log", "aria-disabled") != "true", "landing: log not locked")
    await tab(pg, "rank")
    r.check(await pg.get_attribute("#tab-me", "aria-selected") == "true", "landing: locked tab stays on Your times")
    await pg.click("#go")
    r.check("Enter a time" in await text(pg, "#goerr"), "landing: empty submit shows a hint")
    inp = pg.locator("#prs input").first
    for typed, want in [("428", "4:28"), ("1609", "16:09"), ("11900", "1:19:00"), ("4:28", "4:28")]:
        await inp.fill("")
        await inp.press_sequentially(typed, delay=10)
        r.check(await inp.input_value() == want, f"landing: typing {typed} gives {want}, got {await inp.input_value()}")
    r.check(await pg.evaluate("document.body.dataset.state") == "empty", "landing: results wait for submit")
    await inp.fill("")
    await inp.press_sequentially("1609", delay=10)
    await inp.press("Enter")
    await pg.wait_for_timeout(400)
    r.check(await pg.evaluate("document.body.dataset.state") == "ready", "landing: Enter submits")
    r.check(await visible(pg, "#verdict"), "results: verdict visible")
    r.check(len(await pg.query_selector_all("#ranks .rank")) >= 4, "results: at least 4 rank cards")
    r.check("marathon" in (await text(pg, "#v-head")).lower(), "results: headline mentions the marathon")
    r.check(await pg.get_attribute("#tab-rank", "aria-disabled") == "false", "results: tabs unlock")
    await no_overflow(pg, r, "results")
    # add a race, invalid time, remove it
    await pg.click("#addpr")
    rows = pg.locator("#prs .pr")
    r.check(await rows.count() == 2, "races: add another race")
    await rows.nth(1).locator("input").fill("abc")
    await rows.nth(1).locator("input").blur()
    r.check(await rows.nth(1).locator("input").input_value() == "", "races: letters are rejected")
    await rows.nth(1).locator("select").select_option("mile")
    await rows.nth(1).locator("input").press_sequentially("428", delay=10)
    await pg.wait_for_timeout(200)
    r.check(await visible(pg, "#sub-prof"), "races: strengths tab appears with two races")
    await rows.nth(1).locator(".rm").click()
    r.check(await pg.locator("#prs .pr").count() == 1, "races: remove a race")
    # sex and age unlock age grade and Boston
    await pg.select_option("#sex", "men")
    await pg.fill("#age", "34")
    await pg.wait_for_timeout(250)
    ranks = await text(pg, "#ranks")
    r.check("age grade" in ranks, "results: age grade appears with age and sex")
    r.check("Boston" in ranks, "results: Boston qualifying appears")
    r.check("% of your age group" in ranks or "ran that fast" in ranks, "results: Boston share of age group")
    # presets
    await pg.click("[data-preset=me]")
    await pg.wait_for_timeout(300)
    r.check(await pg.locator("#prs .pr").count() == 4, "presets: Utkarsh's PRs load four races")
    # equivalents and strengths subtabs
    r.check(len(await pg.query_selector_all("#equiv tbody tr")) == 11, "equivalents: 11 distances")
    await pg.click("[data-sub=me-prof]")
    r.check(await visible(pg, "#profile .prof"), "strengths: bars visible")
    # card download
    async with pg.expect_download() as dl:
        await pg.click("#card")
    d = await dl.value
    r.check(d.suggested_filename.startswith("oval-"), "card: downloads a PNG")
    # copy link
    await pg.click("#share")
    await pg.wait_for_timeout(300)
    r.check("copied" in (await text(pg, "#share")).lower() or "address" in (await text(pg, "#share")).lower(), "share: gives feedback")

    # ---------------------------------------------------------------- rankings
    await tab(pg, "rank")
    r.check(await visible(pg, "#ctx"), "context bar on other pages")
    r.check(len(await pg.query_selector_all("#fieldtable tbody tr")) >= 12, "rankings: 12 marathons")
    r.check(await visible(pg, "#dist svg"), "rankings: field histogram")
    await pg.click("#distseg [data-f=women]")
    r.check(await pg.get_attribute("#distseg [data-f=women]", "aria-checked") == "true", "rankings: field toggle")
    await pg.click("[data-sub=rk-col]")
    r.check(await visible(pg, "#college svg"), "rankings: college chart")
    await pg.click("[data-sub=rk-hs]")
    r.check(len(await pg.query_selector_all("#hs tbody tr")) == 5, "rankings: CIF table with you")
    await no_overflow(pg, r, "rankings")

    # ---------------------------------------------------------------- ghost race
    await tab(pg, "ghost")
    r.check(await visible(pg, "#track"), "ghost: canvas")
    for dist in ["1500", "5k", "marathon"]:
        await pg.select_option("#gh-dist", dist)
        await pg.wait_for_timeout(150)
        names = " ".join(await pg.eval_on_selector_all("#order .nm", "e => e.map(x => x.textContent)"))
        r.check("World record" in names and "You" in names, f"ghost: {dist} field has you and the WR")
    await pg.select_option("#gh-dist", "5k")
    names = " ".join(await pg.eval_on_selector_all("#order .nm", "e => e.map(x => x.textContent)"))
    r.check("CIF" in names, "ghost: 5K includes the CIF champion")
    await pg.click(".ghostadd")
    r.check("name" in (await text(pg, "#gh-err")).lower(), "ghost: friend needs a name")
    await pg.fill("#gh-fname", "Rohan")
    await pg.locator("#gh-ftime").press_sequentially("1745", delay=10)
    await pg.click(".ghostadd")
    await pg.wait_for_timeout(200)
    r.check("Rohan" in " ".join(await pg.eval_on_selector_all("#order .nm", "e => e.map(x => x.textContent)")), "ghost: friend added")
    await pg.click("#gh-friends [data-rm]")
    await pg.wait_for_timeout(150)
    r.check("Rohan" not in " ".join(await pg.eval_on_selector_all("#order .nm", "e => e.map(x => x.textContent)")), "ghost: friend removed")
    c0 = await text(pg, "#clock")
    await pg.click("#play")
    await pg.wait_for_timeout(1200)
    r.check(await text(pg, "#clock") != c0, "ghost: race clock runs")
    await pg.click("#play")
    r.check(await pg.locator("#speed option").count() >= 8, "ghost: speed options")
    await no_overflow(pg, r, "ghost")

    # ---------------------------------------------------------------- race plan
    await tab(pg, "plan")
    g0 = await text(pg, "#po-goal")
    r.check(":" in g0, "plan: goal shown")
    await pg.click("[data-key=course] [data-v=hilly]")
    await pg.wait_for_timeout(150)
    r.check(await text(pg, "#po-goal") != g0, "plan: hilly course changes the goal")
    await pg.click("[data-key=course] [data-v=flat]")
    await pg.select_option("#plan-dist", "marathon")
    await pg.wait_for_timeout(150)
    r.check(await visible(pg, "#pacing-field"), "plan: pacing choice for long races")
    await pg.select_option("#plan-dist", "5k")
    await pg.wait_for_timeout(150)
    r.check(not await visible(pg, "#pacing-field"), "plan: no pacing choice for short races")
    await pg.fill("#tempf", "85")
    await pg.fill("#dewf", "70")
    await pg.wait_for_timeout(150)
    await pg.click(".why summary")
    r.check("heat" in (await text(pg, "#po-why")).lower(), "plan: heat explained")
    await pg.fill("#tempf", "55")
    await pg.fill("#dewf", "45")
    await pg.click("#po-opts [data-bold=stretch]")
    r.check(await pg.get_attribute("#po-opts [data-bold=stretch]", "aria-pressed") == "true", "plan: stretch option")
    await pg.locator("#plan-time").press_sequentially("1500", delay=10)
    await pg.wait_for_timeout(150)
    r.check("15:00" in await text(pg, "#po-goal"), "plan: own goal")
    await pg.click("[data-sub=po-cps]")
    r.check(len(await pg.query_selector_all("#po-cp tbody tr")) >= 3, "plan: checkpoints")
    await pg.click("[data-sub=po-day]")
    r.check("Warmup" in await text(pg, "#po-morning"), "plan: race morning")
    await no_overflow(pg, r, "race plan")

    # ---------------------------------------------------------------- training: questions and plan
    await tab(pg, "train")
    r.check(await visible(pg, "#quiz"), "training: questions first")
    await pg.click(".choice[data-v=half]")
    race_day = (datetime.date.today() + datetime.timedelta(days=100)).isoformat()
    await pg.fill("#q-in", race_day)
    await pg.click("#q-next")
    await pg.click(".choice[data-v=mi]")
    await pg.fill("#q-in", "-5")
    await pg.click("#q-next")
    r.check("How far" in await text(pg, "#q-q"), "training: negative mileage rejected")
    await pg.fill("#q-in", "15")
    await pg.press("#q-in", "Enter")
    await pg.fill("#q-in", "6")
    await pg.press("#q-in", "Enter")
    for v in ["5", "sun", "regular", "no"]:
        await pg.click(f".choice[data-v='{v}']")
        await pg.wait_for_timeout(80)
    await pg.wait_for_timeout(300)
    r.check(await visible(pg, "#plan"), "training: plan shown after questions")
    r.check("days to go" in await text(pg, "#pl-sub"), "training: countdown")
    bars = await pg.query_selector_all("#season .sbar")
    r.check(13 <= len(bars) <= 16, f"training: season bars ({len(bars)})")
    r.check(await pg.locator("#week li").count() == 7, "training: seven days")
    total = sum(float(x.split()[0]) for x in await pg.eval_on_selector_all("#week .km", "e => e.map(x => x.textContent)") if x.strip() not in ("–", ""))
    r.check(total > 0, "training: week has miles")
    await pg.click("#season .sbar >> nth=3", force=True)
    r.check("Week 4" in await text(pg, "#wk-range"), "training: click a week")
    await pg.click("#wk-prev")
    r.check("Week 3" in await text(pg, "#wk-range"), "training: previous week")
    await pg.click("#season .sbar >> nth=0", force=True)
    await pg.click("#week [data-log] >> nth=0")
    await pg.wait_for_timeout(250)
    r.check(await pg.get_attribute("#tab-log", "aria-selected") == "true", "training: Log button opens the log")
    r.check(await pg.input_value("#lg-dist") != "", "training: Log button fills the distance")
    await pg.locator("#lg-time").press_sequentially("4000", delay=10)
    await pg.click("#logform button[type=submit]")
    await pg.wait_for_timeout(300)
    await tab(pg, "train")
    r.check(await pg.locator("#week .logged").count() >= 1, "training: logged run ticks off the plan")
    await pg.click("#pl-edit")
    r.check(await visible(pg, "#quiz"), "training: change answers")
    await pg.click("#q-back")
    r.check(await visible(pg, "#plan"), "training: cancel goes back to the plan")
    # other training subtabs
    await pg.click("[data-sub=tr-fuel]")
    r.check("carbs" in (await text(pg, "#fuelout")).lower(), "fuel: carbs")
    await pg.fill("#fu-pre", "154")
    await pg.fill("#fu-post", "152.2")
    await pg.fill("#fu-drank", "10")
    await pg.wait_for_timeout(150)
    r.check("/h" in await text(pg, "#fuelout"), "fuel: fluid target from sweat test")
    await pg.click("[data-sub=tr-stretch]")
    r.check(len(await pg.query_selector_all(".routine")) == 3, "stretches: three routines")
    await pg.click("[data-sub=tr-paces]")
    r.check(len(await pg.query_selector_all("#pacetable tr")) >= 5, "paces: table")
    await pg.click("[data-sub=tr-goal]")
    await pg.fill("#goal", "99")
    await pg.dispatch_event("#goal", "input")
    r.check("99" in await text(pg, "#goal-out"), "goal finder: slider")
    await pg.click("[data-sub=tr-conv]")
    await pg.fill("#conv-v", "")
    await pg.locator("#conv-v").press_sequentially("700", delay=10)
    r.check("4:21" in await text(pg, "#convtable"), "converter: 7:00/mi is 4:21/km")
    await pg.click("[data-sub=tr-wx]")
    await pg.fill("#wx-temp", "85")
    await pg.fill("#wx-dew", "72")
    await pg.wait_for_timeout(150)
    r.check("%" in await text(pg, "#wxout"), "weather: slowdown")
    await no_overflow(pg, r, "training")

    # ---------------------------------------------------------------- log
    await tab(pg, "log")
    await pg.fill("#lg-dist", "")
    await pg.click("#logform button[type=submit]")
    r.check("how far" in (await text(pg, "#lg-err")).lower(), "log: distance required")
    await pg.fill("#lg-dist", "5")
    await pg.locator("#lg-time").press_sequentially("9", delay=10)
    await pg.fill("#lg-time", "abc")
    await pg.click("#lg-feel [data-v=great]")
    await pg.fill("#lg-notes", "Track session")
    await pg.click("#logform button[type=submit]")
    await pg.wait_for_timeout(250)
    n_before = await pg.locator("#lg-list > li").count()
    r.check(n_before >= 2, "log: saved runs listed")
    await pg.set_input_files("#lg-file", [f"{SHOTS}/run.gpx", f"{SHOTS}/activities.csv", f"{SHOTS}/junk.gpx"])
    await pg.wait_for_timeout(900)
    imp = await text(pg, "#lg-imp")
    r.check("Added 3" in imp, f"log: import added 3 runs ({imp})")
    r.check("no run data" in imp, "log: bad file reported")
    await pg.set_input_files("#lg-file", [f"{SHOTS}/run.gpx"])
    await pg.wait_for_timeout(500)
    r.check("Skipped 1" in await text(pg, "#lg-imp"), "log: duplicate skipped")
    r.check(await visible(pg, "#lg-fit"), "log: fitness card")
    r.check(await visible(pg, "#lg-chart svg"), "log: weekly chart")
    # race PR offer
    await pg.select_option("#lg-type", "race")
    await pg.fill("#lg-dist", "3.11")
    await pg.locator("#lg-time").press_sequentially("1550", delay=10)
    await pg.click("#logform button[type=submit]")
    await pg.wait_for_timeout(250)
    r.check(await visible(pg, "#lg-pr"), "log: PR offer")
    await pg.click("#lg-pr-add")
    await pg.wait_for_timeout(250)
    r.check("15:50" in " ".join(await pg.eval_on_selector_all("#prs input", "e => e.map(x => x.value)")), "log: PR added to races")
    # delete
    n1 = await pg.locator("#lg-list > li").count()
    await pg.click("#lg-list [data-del] >> nth=0")
    await pg.wait_for_timeout(200)
    r.check(await pg.locator("#lg-list > li").count() == n1 - 1, "log: delete a run")
    await no_overflow(pg, r, "log")

    # ---------------------------------------------------------------- data
    await tab(pg, "data")
    r.check(len(await pg.query_selector_all("#facts > div")) >= 4, "data: facts row")
    r.check(len(await pg.query_selector_all(".three svg")) == 3, "data: three charts")
    await pg.click("[data-sub=dt-src]")
    r.check(len(await pg.query_selector_all("#sources li")) >= 4, "data: sources")
    await no_overflow(pg, r, "data")

    # shared link restores state
    url = pg.url
    pg2 = await ctx.new_page()
    await pg2.goto(url)
    await pg2.wait_for_timeout(800)
    r.check(await pg2.evaluate("document.body.dataset.state") == "ready", "shared link opens results")
    await pg2.close()

    for t in ["me", "rank", "ghost", "plan", "train", "log", "data"]:
        await tab(pg, t)
        await pg.screenshot(path=f"{SHOTS}/{cfg_name}-{t}.png", full_page=True)
    r.check(not errs, "no errors: " + "; ".join(errs[:5]))
    await ctx.close()
    return r


async def main(names):
    fixtures()
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", os.path.join(ROOT, "public")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    bad = 0
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
            for n in names:
                try:
                    r = await one(n, b)
                except Exception as e:
                    print(f"[{n}] CRASH: {str(e)[:400]}")
                    bad += 1
                    continue
                print(f"[{n}] {r.n - len(r.fails)}/{r.n} checks passed")
                for f in r.fails:
                    print(f"   FAIL {f}")
                bad += len(r.fails)
            await b.close()
    finally:
        srv.terminate()
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or list(CONFIGS)))
