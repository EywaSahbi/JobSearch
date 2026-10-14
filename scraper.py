import argparse
import hashlib
import json
import re
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jobspy import scrape_jobs

import career_ops
import sources

SEARCH_TERMS = [
    "Software Engineer",
    "Softwareentwickler",
    "DevOps",
    "Systemadministrator",
    "IT Support",
    "Fachinformatiker",
]
LOCATIONS = ["Dortmund", "Essen", "Düsseldorf"]
RADIUS_KM = 30
COUNTRY = "Germany"
SITES = ["indeed", "linkedin", "glassdoor", "arbeitsagentur", "stepstone"]
RESULTS_PER_SEARCH = 30
HOURS_OLD = 168
KEEP_DAYS = 45
MAX_DETAILS = 200

EXCLUDE_TITLE = [
    "*ausbildung*", "Auszubildende*", "Azubi*",
    "Senior", "Sr", "Principal", "Lead", "Head of",
]
KEEP_TITLE = ["Junior"]

PORT = 8765

ROOT = Path(__file__).parent
OUTPUT_DIR = ROOT / "output"
DB_FILE = OUTPUT_DIR / "jobs.json"
JS_FILE = OUTPUT_DIR / "jobs.js"
VIEWER = ROOT / "viewer.html"
CAREER_OPS_DIR = ROOT / "career-ops"

NO_CITY = {"north rhine-westphalia", "nordrhein-westfalen", "nw", "germany", "deutschland", "de"}
INTERVALS = {"yearly": "year", "monthly": "month", "weekly": "week", "daily": "day", "hourly": "hour"}


def title_pattern(words):
    parts = []
    for word in words:
        core = re.escape(word.strip("*"))
        parts.append(("" if word.startswith("*") else r"\b") + core + ("" if word.endswith("*") else r"\b"))
    return re.compile("|".join(parts) or r"(?!)", re.IGNORECASE)


EXCLUDE_RE = title_pattern(EXCLUDE_TITLE)
KEEP_RE = title_pattern(KEEP_TITLE)


def excluded(title):
    title = title or ""
    return bool(EXCLUDE_RE.search(title)) and not KEEP_RE.search(title)


def city_of(location):
    first = (location or "").split(",")[0].strip()
    return "" if first.lower() in NO_CITY else first


def job_id(title, company, city):
    parts = (re.sub(r"[^a-z0-9äöüß]+", " ", (s or "").lower()).strip() for s in (title, company, city))
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()[:12]


def salary_of(row):
    amounts = sorted({int(a) for a in (row.get("min_amount"), row.get("max_amount")) if a})
    if not amounts:
        return None
    text = " – ".join(f"{a:,}" for a in amounts)
    text += f" {row.get('currency') or 'EUR'}"
    interval = INTERVALS.get(row.get("interval"))
    return f"{text} / {interval}" if interval else text


def to_record(row, term, now):
    city = city_of(row.get("location"))
    return {
        "id": job_id(row.get("title"), row.get("company"), city),
        "title": row.get("title") or "(untitled)",
        "company": row.get("company") or "",
        "city": city,
        "location": row.get("location") or "",
        "date_posted": str(row["date_posted"]) if row.get("date_posted") else None,
        "job_type": row.get("job_type"),
        "job_level": row.get("job_level"),
        "is_remote": bool(row.get("is_remote")),
        "salary": salary_of(row),
        "description": row.get("description"),
        "links": {row["site"]: row["job_url"]},
        "terms": [term],
        "first_seen": now,
    }


def merge(db, rec):
    old = db.get(rec["id"])
    if old is None:
        db[rec["id"]] = rec
        return True
    old["links"].update(rec["links"])
    old["terms"] = sorted(set(old["terms"]) | set(rec["terms"]))
    old["is_remote"] = old["is_remote"] or rec["is_remote"]
    for field in ("description", "salary", "job_type", "job_level", "date_posted"):
        if not old.get(field) and rec.get(field):
            old[field] = rec[field]
    return False


def search(site, term, location, hours_old):
    if site in sources.SEARCH:
        return sources.SEARCH[site](term, location, RADIUS_KM, hours_old, RESULTS_PER_SEARCH)
    df = scrape_jobs(
        site_name=[site],
        search_term=term,
        location=location,
        distance=round(RADIUS_KM / 1.609),
        results_wanted=RESULTS_PER_SEARCH,
        hours_old=hours_old,
        country_indeed=COUNTRY,
        fetch_description=(site == "glassdoor"),
        description_format="markdown",
        verbose=0,
    )
    return df.astype(object).where(df.notna(), None).to_dict("records")


def no_progress(phase, done, total, text):
    pass


def scrape(db, sites, hours_old, now, progress=no_progress):
    new = dropped = done = 0
    total = len(SEARCH_TERMS) * len(LOCATIONS) * len(sites)
    for term in SEARCH_TERMS:
        for location in LOCATIONS:
            counts = []
            for site in sites:
                progress("search", done, total, f"Searching: {term} · {location} ({site})")
                done += 1
                try:
                    rows = search(site, term, location, hours_old)
                except Exception as exc:
                    counts.append(f"{site}: error ({str(exc)[:60]})")
                    continue
                wanted = [row for row in rows if not excluded(row.get("title"))]
                dropped += len(rows) - len(wanted)
                new += sum(merge(db, to_record(row, term, now)) for row in wanted)
                counts.append(f"{site} {len(wanted)}")
            print(f"[{done:>2}/{total}] {term} · {location}: {', '.join(counts)}", flush=True)
    print(f"{dropped} results dropped by the title filter")
    return new


def linkedin_loader():
    try:
        from jobspy.linkedin import LinkedIn
        from jobspy.model import ScraperInput, Site
        scraper = LinkedIn()
        scraper.scraper_input = ScraperInput(site_type=[Site.LINKEDIN])
    except Exception as exc:
        print(f"Skipping LinkedIn descriptions: {exc}")
        return None

    def load(url):
        match = re.search(r"(\d+)/?$", url)
        details = scraper._fetch_details(match.group(1)) if match else {}
        kinds = details.get("job_type")
        return {
            "description": details.get("description"),
            "job_level": details.get("job_level"),
            "job_type": kinds[0].value[0] if kinds else None,
        }

    return load


def detail_loaders():
    loaders = dict(sources.DETAILS)
    linkedin = linkedin_loader()
    if linkedin:
        loaders["linkedin"] = linkedin
    return loaders


def fetch_details(db, loaders, limit, progress=no_progress, pause=0.4):
    todo, counts = [], {}
    for job in db.values():
        if job.get("description") or job.get("detail_tries", 0) >= 2:
            continue
        site = next((name for name in loaders if name in job["links"]), None)
        if site and counts.get(site, 0) < limit:
            counts[site] = counts.get(site, 0) + 1
            todo.append((site, job))
    if not todo:
        return

    print(f"Loading {len(todo)} descriptions ...", flush=True)
    loaded, streaks, blocked = 0, {}, set()
    for i, (site, job) in enumerate(todo, 1):
        progress("details", i - 1, len(todo), f"Descriptions: {i} of {len(todo)}")
        if site in blocked:
            continue
        try:
            fields = loaders[site](job["links"][site]) or {}
        except Exception:
            fields = {}
        job["detail_tries"] = job.get("detail_tries", 0) + 1
        if fields.get("description"):
            loaded += 1
            streaks[site] = []
            for key in ("description", "job_level", "job_type"):
                if fields.get(key) and not job.get(key):
                    job[key] = fields[key]
        else:
            streak = streaks.setdefault(site, [])
            streak.append(job)
            if len(streak) >= 5:
                for skipped in streak:
                    skipped["detail_tries"] -= 1
                blocked.add(site)
                print(f"  {site} is blocking right now, the rest follows on the next run.")
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}", flush=True)
        time.sleep(pause)
    print(f"  {loaded} descriptions loaded")


def read_db():
    if not DB_FILE.exists():
        return {}, None
    data = json.loads(DB_FILE.read_text(encoding="utf-8"))
    cutoff = (datetime.now() - timedelta(days=KEEP_DAYS)).isoformat()
    db = {j["id"]: j for j in data["jobs"] if j["first_seen"] >= cutoff and not excluded(j["title"])}
    return db, data.get("generated")


def save(db, generated):
    data = {
        "generated": generated,
        "terms": SEARCH_TERMS,
        "locations": LOCATIONS,
        "radius_km": RADIUS_KM,
        "jobs": list(db.values()),
    }
    text = json.dumps(data, ensure_ascii=False)
    OUTPUT_DIR.mkdir(exist_ok=True)
    DB_FILE.write_text(text, encoding="utf-8")
    JS_FILE.write_text("window.JOBS_DATA = " + text.replace("</", "<\\/") + ";\n", encoding="utf-8")


def run_scrape(sites, hours_old, fast, progress=no_progress):
    now = datetime.now().isoformat(timespec="seconds")
    db, _ = read_db()
    new = scrape(db, sites, hours_old, now, progress)
    save(db, now)
    if not fast:
        fetch_details(db, detail_loaders(), MAX_DETAILS, progress)
        save(db, now)
    print(f"{new} new jobs, {len(db)} in total in {DB_FILE}", flush=True)
    return new, len(db)


STATE = {"running": False, "percent": 0, "text": "", "new": None, "total": None, "error": None}
STATE_LOCK = threading.Lock()


def start_scrape(args):
    with STATE_LOCK:
        if STATE["running"]:
            return
        STATE.update(running=True, percent=0, text="Starting …", new=None, total=None, error=None)

    def progress(phase, done, total, text):
        share = done / total if total else 1
        percent = share * 100 if args.fast else share * 50 + (50 if phase == "details" else 0)
        STATE.update(percent=round(percent, 1), text=text)

    def work():
        try:
            new, total = run_scrape(args.sites, args.hours, args.fast, progress)
            STATE.update(new=new, total=total, percent=100, text="Done")
        except Exception as exc:
            print(f"Scraping failed: {exc!r}", flush=True)
            STATE.update(error=str(exc) or type(exc).__name__)
        finally:
            STATE["running"] = False

    threading.Thread(target=work, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    args = None
    career_ops_dir = CAREER_OPS_DIR
    files = {
        "/": (VIEWER, "text/html"),
        "/viewer.html": (VIEWER, "text/html"),
        "/output/jobs.js": (JS_FILE, "text/javascript"),
    }

    def reply(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def is_local(self):
        own = (f"127.0.0.1:{PORT}", f"localhost:{PORT}")
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in own and (not origin or origin.removeprefix("http://") in own)

    def do_GET(self):
        path = self.path.split("?")[0]
        if not self.is_local():
            return self.send_error(403)
        if path == "/api/status":
            return self.reply(json.dumps(STATE).encode("utf-8"), "application/json")
        if path == "/api/career-ops":
            return self.reply_career_ops()
        file, content_type = self.files.get(path, (None, None))
        if file is None or not file.exists():
            return self.send_error(404)
        self.reply(file.read_bytes(), content_type)

    def do_POST(self):
        if not self.is_local():
            return self.send_error(403)
        if self.path == "/api/career-ops":
            return self.send_to_career_ops()
        if self.path != "/api/scrape":
            return self.send_error(404)
        start_scrape(self.args)
        self.reply(json.dumps(STATE).encode("utf-8"), "application/json")

    def reply_career_ops(self, **result):
        root = self.career_ops_dir
        ready = career_ops.is_ready(root)
        state = {"ready": ready, "sent": sorted(career_ops.sent_ids(root)) if ready else [], **result}
        self.reply(json.dumps(state).encode("utf-8"), "application/json")

    def send_to_career_ops(self):
        try:
            jobs = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))["jobs"]
        except (ValueError, KeyError, TypeError):
            jobs = None
        if not isinstance(jobs, list):
            return self.send_error(400)
        new, error = [], None
        if career_ops.is_ready(self.career_ops_dir):
            try:
                new = career_ops.send(self.career_ops_dir, jobs, datetime.now().date().isoformat())
            except OSError as exc:
                error = str(exc) or type(exc).__name__
        self.reply_career_ops(new=new, error=error)

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    allow_reuse_address = False


def serve(args):
    url = f"http://127.0.0.1:{PORT}/"
    Handler.args = args
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Already running: {url}")
        if not args.no_open:
            webbrowser.open(url)
        return

    db, generated = read_db()
    if generated:
        save(db, generated)
    print(f"Viewer: {url}  (Ctrl+C to quit)", flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Beendet.")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(description="Scrape job boards and browse the results")
    p.add_argument("--scrape", action="store_true", help="scrape in the terminal only, without the viewer")
    p.add_argument("--hours", type=int, default=HOURS_OLD, help="only jobs posted in the last N hours")
    p.add_argument("--sites", nargs="+", default=SITES, help="sources to query, default: all in SITES")
    p.add_argument("--fast", action="store_true", help="do not load job descriptions after the search")
    p.add_argument("--csv", action="store_true", help="with --scrape: also write output/jobs.csv")
    p.add_argument("--no-open", action="store_true", help="do not open the browser")
    args = p.parse_args()

    if not args.scrape:
        return serve(args)

    run_scrape(args.sites, args.hours, args.fast)
    if args.csv:
        import pandas as pd
        db, _ = read_db()
        rows = [{**j, "links": " ".join(j["links"].values()), "terms": ", ".join(j["terms"])} for j in db.values()]
        pd.DataFrame(rows).to_csv(OUTPUT_DIR / "jobs.csv", index=False, encoding="utf-8-sig")


if __name__ == "__main__":
    main()
