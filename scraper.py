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
from urllib.parse import parse_qs, urlsplit

from jobspy import scrape_jobs
from jobspy.model import Country

import career_ops
import config
import places
import sources

RESULTS_PER_SEARCH = 30
HOURS_OLD = 168
KEEP_DAYS = 45
MAX_DETAILS = 200

PORT = 8765

ROOT = Path(__file__).parent
OUTPUT_DIR = ROOT / "output"
DB_FILE = OUTPUT_DIR / "jobs.json"
JS_FILE = OUTPUT_DIR / "jobs.js"
VIEWER = ROOT / "viewer.html"
SETTINGS_FILE = ROOT / "settings.json"
CAREER_OPS_DIR = ROOT / "career-ops"
PLACES = places.Places(OUTPUT_DIR / "places.json")

JOBSPY_COUNTRIES = {
    country.value[1].split(":")[-1]: country
    for country in Country
    if country not in (Country.US_CANADA, Country.WORLDWIDE)
}
COUNTRIES = {
    "indeed": set(JOBSPY_COUNTRIES),
    "glassdoor": {code for code, country in JOBSPY_COUNTRIES.items() if len(country.value) > 2},
    **sources.COUNTRIES,
}

CITY_STATES = {"singapore", "hong kong", "luxembourg"}
NO_CITY = {"north rhine-westphalia", "nordrhein-westfalen", "nw", "germany", "deutschland", "de"} | {
    name.strip() for country in Country for name in country.value[0].split(",")
} - CITY_STATES
INTERVALS = {"yearly": "year", "monthly": "month", "weekly": "week", "daily": "day", "hourly": "hour"}


def title_pattern(words):
    parts = []
    for word in words:
        core = re.escape(word.strip("*"))
        parts.append(("" if word.startswith("*") else r"\b") + core + ("" if word.endswith("*") else r"\b"))
    return re.compile("|".join(parts) or r"(?!)", re.IGNORECASE)


def title_rules(settings):
    return title_pattern(settings["exclude_title"]), title_pattern(settings["keep_title"])


def excluded(title, rules):
    exclude, keep = rules
    title = title or ""
    return bool(exclude.search(title)) and not keep.search(title)


def city_of(location):
    first = (location or "").split(",")[0].strip()
    return "" if first.lower() in NO_CITY else first


def normalize(text):
    text = (text or "").lower()
    return re.sub(r"[^a-z0-9äöüß]+", " ", text).strip() or re.sub(r"[\W_]+", " ", text).strip()


def job_id(title, company, city):
    return hashlib.md5("|".join(map(normalize, (title, company, city))).encode("utf-8")).hexdigest()[:12]


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


def covers(site, country):
    allowed = COUNTRIES.get(site)
    return allowed is None or country in allowed


def plan(settings, sites):
    groups = []
    for term in settings["terms"]:
        for location in settings["locations"]:
            here = [site for site in sites if covers(site, location["country"])]
            if here:
                groups.append((term, location, here))
    return groups


def search(site, term, location, hours_old, inside=None):
    if site in sources.SEARCH:
        return sources.SEARCH[site](term, location, hours_old, RESULTS_PER_SEARCH, inside)
    country = JOBSPY_COUNTRIES.get(location["country"])
    named = site == "linkedin" and location.get("country_name")
    df = scrape_jobs(
        site_name=[site],
        search_term=term,
        location=f"{location['name']}, {location['country_name']}" if named else location["name"],
        distance=round(location["radius_km"] / 1.609),
        results_wanted=RESULTS_PER_SEARCH,
        hours_old=hours_old,
        country_indeed=country.value[0].split(",")[0] if country else "worldwide",
        fetch_description=(site == "glassdoor"),
        description_format="markdown",
        verbose=0,
    )
    return df.astype(object).where(df.notna(), None).to_dict("records")


def no_progress(phase, done, total, text):
    pass


def scrape(db, settings, sites, hours_old, now, progress=no_progress, places=PLACES):
    rules = title_rules(settings)
    groups = plan(settings, sites)
    total = sum(len(here) for _, _, here in groups)
    new = dropped = done = 0
    for term, location, here in groups:
        inside = places.within(location)
        counts = []
        for site in here:
            progress("search", done, total, f"Searching: {term} · {location['name']} ({site})")
            done += 1
            try:
                rows = search(site, term, location, hours_old, inside)
            except Exception as exc:
                counts.append(f"{site}: error ({str(exc)[:60]})")
                continue
            wanted = [row for row in rows if not excluded(row.get("title"), rules)]
            dropped += len(rows) - len(wanted)
            new += sum(merge(db, to_record(row, term, now)) for row in wanted)
            counts.append(f"{site} {len(wanted)}")
        print(f"[{done:>2}/{total}] {term} · {location['name']}: {', '.join(counts)}", flush=True)
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
            for key in ("description", "job_level", "job_type", "date_posted"):
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


def read_db(rules):
    if not DB_FILE.exists():
        return {}, None
    data = json.loads(DB_FILE.read_text(encoding="utf-8"))
    cutoff = (datetime.now() - timedelta(days=KEEP_DAYS)).isoformat()
    db = {j["id"]: j for j in data["jobs"] if j["first_seen"] >= cutoff and not excluded(j["title"], rules)}
    return db, data.get("generated")


def save(db, generated, settings):
    data = {
        "generated": generated,
        "terms": settings["terms"],
        "locations": [{"name": place["name"], "radius_km": place["radius_km"]} for place in settings["locations"]],
        "jobs": list(db.values()),
    }
    text = json.dumps(data, ensure_ascii=False)
    OUTPUT_DIR.mkdir(exist_ok=True)
    DB_FILE.write_text(text, encoding="utf-8")
    JS_FILE.write_text("window.JOBS_DATA = " + text.replace("</", "<\\/") + ";\n", encoding="utf-8")


def run_scrape(settings, sites, hours_old, fast, progress=no_progress):
    now = datetime.now().isoformat(timespec="seconds")
    db, _ = read_db(title_rules(settings))
    PLACES.reset()
    new = scrape(db, settings, sites, hours_old, now, progress)
    save(db, now, settings)
    if not fast:
        fetch_details(db, detail_loaders(), MAX_DETAILS, progress)
        save(db, now, settings)
    print(f"{new} new jobs, {len(db)} in total in {DB_FILE}", flush=True)
    return new, len(db)


STATE = {"running": False, "percent": 0, "text": "", "new": None, "total": None, "error": None}
STATE_LOCK = threading.Lock()


def start_scrape(args):
    with STATE_LOCK:
        if STATE["running"]:
            return
        STATE.update(running=True, percent=0, text="Starting …", new=None, total=None, error=None)
    settings = config.load(SETTINGS_FILE)
    sites = args.sites or settings["sites"]

    def progress(phase, done, total, text):
        share = done / total if total else 1
        percent = share * 100 if args.fast else share * 50 + (50 if phase == "details" else 0)
        STATE.update(percent=round(percent, 1), text=text)

    def work():
        try:
            new, total = run_scrape(settings, sites, args.hours, args.fast, progress)
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
    settings_file = SETTINGS_FILE
    places = PLACES
    files = {
        "/": (VIEWER, "text/html"),
        "/viewer.html": (VIEWER, "text/html"),
        "/settings.js": (ROOT / "settings.js", "text/javascript"),
        "/vendor/leaflet/leaflet.js": (ROOT / "vendor" / "leaflet" / "leaflet.js", "text/javascript"),
        "/vendor/leaflet/leaflet.css": (ROOT / "vendor" / "leaflet" / "leaflet.css", "text/css"),
        "/output/jobs.js": (JS_FILE, "text/javascript"),
    }

    def reply(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def reply_json(self, data, status=200):
        self.reply(json.dumps(data).encode("utf-8"), "application/json", status)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length)) if 0 < length <= 1_000_000 else None
        except ValueError:
            return None

    def is_local(self):
        own = (f"127.0.0.1:{PORT}", f"localhost:{PORT}")
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in own and (not origin or origin.removeprefix("http://") in own)

    def do_GET(self):
        url = urlsplit(self.path)
        if not self.is_local():
            return self.send_error(403)
        if url.path == "/api/status":
            return self.reply_json(STATE)
        if url.path == "/api/career-ops":
            return self.reply_career_ops()
        if url.path == "/api/settings":
            return self.reply_settings()
        if url.path == "/api/places":
            return self.find_places(parse_qs(url.query))
        if url.path == "/api/places/nearest":
            return self.nearest_place(parse_qs(url.query))
        file, content_type = self.files.get(url.path, (None, None))
        if file is None or not file.exists():
            return self.send_error(404)
        self.reply(file.read_bytes(), content_type)

    def do_POST(self):
        if not self.is_local():
            return self.send_error(403)
        if self.path == "/api/career-ops":
            return self.send_to_career_ops()
        if self.path == "/api/settings":
            return self.save_settings()
        if self.path != "/api/scrape":
            return self.send_error(404)
        start_scrape(self.args)
        self.reply_json(STATE)

    def reply_settings(self):
        offered = [
            {"name": name, "label": label, "countries": sorted(COUNTRIES[name]) if name in COUNTRIES else None}
            for name, label in config.SOURCES.items()
        ]
        self.reply_json({"settings": config.load(self.settings_file), "sources": offered, "running": STATE["running"]})

    def save_settings(self):
        data = self.read_json()
        with STATE_LOCK:
            if STATE["running"]:
                return self.reply_json({"errors": ["A scrape is running. Save again when it has finished."]}, 409)
            settings, errors = config.validate(data)
            if errors:
                return self.reply_json({"errors": errors}, 400)
            try:
                config.save(self.settings_file, settings)
                db, generated = read_db(title_rules(settings))
                if generated:
                    save(db, generated, settings)
            except OSError as exc:
                return self.reply_json({"errors": [f"Saving failed: {exc}"]}, 500)
        self.reply_json({"settings": settings})

    def find_places(self, query):
        text = " ".join((query.get("q") or [""])[0].split())
        if not text or len(text) > config.MAX_TEXT:
            return self.reply_json({"error": "Type the name of a city."}, 400)
        try:
            found = self.places.search(text)
        except places.PlaceError as exc:
            return self.reply_json({"error": str(exc)}, 502)
        self.reply_json({"places": found})

    def nearest_place(self, query):
        try:
            lat, lon = float(query["lat"][0]), float(query["lon"][0])
        except (KeyError, ValueError):
            lat = lon = float("nan")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return self.reply_json({"error": "That is not a position on the map."}, 400)
        try:
            found = self.places.nearest(lat, lon)
        except places.PlaceError as exc:
            return self.reply_json({"error": str(exc)}, 502)
        self.reply_json({"place": found})

    def reply_career_ops(self, **result):
        root = self.career_ops_dir
        ready = career_ops.is_ready(root)
        self.reply_json({"ready": ready, "sent": sorted(career_ops.sent_ids(root)) if ready else [], **result})

    def send_to_career_ops(self):
        data = self.read_json()
        jobs = data.get("jobs") if isinstance(data, dict) else None
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

    settings = config.load(SETTINGS_FILE)
    db, generated = read_db(title_rules(settings))
    if generated:
        save(db, generated, settings)
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
    p.add_argument("--sites", nargs="+", help="sources to query, default: those chosen in the search settings")
    p.add_argument("--fast", action="store_true", help="do not load job descriptions after the search")
    p.add_argument("--csv", action="store_true", help="with --scrape: also write output/jobs.csv")
    p.add_argument("--no-open", action="store_true", help="do not open the browser")
    args = p.parse_args()

    if not args.scrape:
        return serve(args)

    settings = config.load(SETTINGS_FILE)
    run_scrape(settings, args.sites or settings["sites"], args.hours, args.fast)
    if args.csv:
        import pandas as pd
        db, _ = read_db(title_rules(settings))
        rows = [{**j, "links": " ".join(j["links"].values()), "terms": ", ".join(j["terms"])} for j in db.values()]
        pd.DataFrame(rows).to_csv(OUTPUT_DIR / "jobs.csv", index=False, encoding="utf-8-sig")


if __name__ == "__main__":
    main()
