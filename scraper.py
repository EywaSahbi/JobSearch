"""Job-Scraper für den Raum Dortmund / Ruhrgebiet (basiert auf JobSpy).

    python scraper.py            # Ansicht starten: http://127.0.0.1:8765
                                 # (dort "Neu scrapen" klicken, Strg+C beendet)
    python scraper.py --scrape   # nur im Terminal scrapen, ohne Ansicht

Optionen für beide Varianten:
    --hours 24                   # nur Jobs der letzten 24 Stunden
    --fast                       # ohne LinkedIn-Beschreibungen (schneller)
    --sites indeed linkedin      # nur bestimmte Boards
"""
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

# ---- Einstellungen (anpassen) --------------------------------------------
SEARCH_TERMS = [
    "Software Engineer",
    "Softwareentwickler",
    "DevOps",
    "Systemadministrator",
    "IT Support",
    "Fachinformatiker",
]
# Zentren + Umkreis decken auch Bochum, Duisburg, Gelsenkirchen, Wuppertal,
# Hagen, Mülheim, Oberhausen, Neuss usw. ab.
LOCATIONS = ["Dortmund", "Essen", "Düsseldorf"]
RADIUS_KM = 30
COUNTRY = "Germany"
SITES = ["indeed", "linkedin", "glassdoor"]
RESULTS_PER_SEARCH = 30   # pro Suchbegriff, Stadt und Board
HOURS_OLD = 168           # nur Jobs der letzten N Stunden
KEEP_DAYS = 45            # ältere Einträge fliegen aus der Datenbank
MAX_LINKEDIN_DETAILS = 200  # Beschreibungen pro Lauf nachladen

# Titelfilter: Jobs mit einem dieser Wörter im Titel werden gelöscht.
# Groß/Klein ist egal. Ohne Stern zählt nur das ganze Wort ("Lead" trifft
# nicht "Leadership"), mit Stern auch Wortteile ("*ausbildung*" trifft
# "Ausbildungsstart" und "Berufsausbildung").
EXCLUDE_TITLE = [
    "*ausbildung*", "Auszubildende*", "Azubi*",    # Ausbildungen
    "Senior", "Sr", "Principal", "Lead", "Head of",  # Senior-Positionen
]
# Ausnahme: Titel mit diesen Wörtern bleiben, z. B. "(Junior/Senior) Entwickler".
KEEP_TITLE = ["Junior"]

PORT = 8765
# --------------------------------------------------------------------------

ROOT = Path(__file__).parent
OUTPUT_DIR = ROOT / "output"
DB_FILE = OUTPUT_DIR / "jobs.json"
JS_FILE = OUTPUT_DIR / "jobs.js"
VIEWER = ROOT / "viewer.html"

NO_CITY = {"north rhine-westphalia", "nordrhein-westfalen", "nw", "germany", "deutschland", "de"}
INTERVALS = {"yearly": "Jahr", "monthly": "Monat", "weekly": "Woche", "daily": "Tag", "hourly": "Stunde"}


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
    """Gleicher Titel + Firma + Stadt = derselbe Job, egal von welchem Board."""
    parts = (re.sub(r"[^a-z0-9äöüß]+", " ", (s or "").lower()).strip() for s in (title, company, city))
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()[:12]


def salary_of(row):
    amounts = sorted({int(a) for a in (row.get("min_amount"), row.get("max_amount")) if a})
    if not amounts:
        return None
    text = " – ".join(f"{a:,}".replace(",", ".") for a in amounts)
    text += f" {row.get('currency') or 'EUR'}"
    interval = INTERVALS.get(row.get("interval"))
    return f"{text} / {interval}" if interval else text


def to_record(row, term, now):
    city = city_of(row.get("location"))
    return {
        "id": job_id(row.get("title"), row.get("company"), city),
        "title": row.get("title") or "(ohne Titel)",
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
    """Fügt rec in db ein. Gibt True zurück, wenn der Job neu ist."""
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
    df = scrape_jobs(
        site_name=[site],
        search_term=term,
        location=location,
        distance=round(RADIUS_KM / 1.609),  # JobSpy rechnet in Meilen
        results_wanted=RESULTS_PER_SEARCH,
        hours_old=hours_old,
        country_indeed=COUNTRY,
        # LinkedIn-Beschreibungen laden wir später nur für neue Jobs nach
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
                progress("search", done, total, f"Suche: {term} · {location} ({site})")
                done += 1
                try:
                    rows = search(site, term, location, hours_old)
                except Exception as exc:  # ein Board darf nicht alles abbrechen
                    counts.append(f"{site}: Fehler ({str(exc)[:60]})")
                    continue
                wanted = [row for row in rows if not excluded(row.get("title"))]
                dropped += len(rows) - len(wanted)
                new += sum(merge(db, to_record(row, term, now)) for row in wanted)
                counts.append(f"{site} {len(wanted)}")
            print(f"[{done:>2}/{total}] {term} · {location}: {', '.join(counts)}", flush=True)
    print(f"{dropped} Treffer durch den Titelfilter verworfen")
    return new


def fetch_linkedin_details(db, limit, progress=no_progress):
    """LinkedIn liefert in der Suche keine Beschreibung, also pro Job nachladen."""
    todo = [
        j for j in db.values()
        if "linkedin" in j["links"] and not j.get("description") and j.get("detail_tries", 0) < 2
    ][:limit]
    if not todo:
        return
    try:
        # interne JobSpy-API: kann sich mit einem Update ändern
        from jobspy.linkedin import LinkedIn
        from jobspy.model import ScraperInput, Site
        scraper = LinkedIn()
        scraper.scraper_input = ScraperInput(site_type=[Site.LINKEDIN])
    except Exception as exc:
        print(f"LinkedIn-Beschreibungen übersprungen: {exc}")
        return

    print(f"Lade {len(todo)} LinkedIn-Beschreibungen ...", flush=True)
    loaded = misses = 0
    for i, job in enumerate(todo, 1):
        progress("details", i - 1, len(todo), f"LinkedIn-Beschreibungen: {i} von {len(todo)}")
        match = re.search(r"(\d+)/?$", job["links"]["linkedin"])
        try:
            details = scraper._fetch_details(match.group(1)) if match else {}
        except Exception:
            details = {}
        job["detail_tries"] = job.get("detail_tries", 0) + 1
        if details.get("description"):
            misses = 0
            loaded += 1
            job["description"] = details["description"]
            job["job_level"] = job.get("job_level") or details.get("job_level")
            if details.get("job_type") and not job.get("job_type"):
                job["job_type"] = details["job_type"][0].value[0]
        else:
            misses += 1
            if misses >= 5:
                # die übersprungenen Jobs sollen beim nächsten Lauf nicht als Fehlversuch zählen
                for skipped in todo[i - misses:i]:
                    skipped["detail_tries"] -= 1
                print("  LinkedIn blockt gerade, Rest folgt beim nächsten Lauf.")
                break
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}", flush=True)
        time.sleep(0.4)
    print(f"  {loaded} Beschreibungen geladen")


def read_db():
    """Lädt die Datenbank ohne veraltete und herausgefilterte Jobs."""
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
    # viewer.html lädt diese Datei per <script>; "</" darf darin nicht vorkommen
    JS_FILE.write_text("window.JOBS_DATA = " + text.replace("</", "<\\/") + ";\n", encoding="utf-8")


def run_scrape(sites, hours_old, fast, progress=no_progress):
    """Ein kompletter Lauf. Gibt (neue Jobs, Jobs insgesamt) zurück."""
    now = datetime.now().isoformat(timespec="seconds")
    db, _ = read_db()
    new = scrape(db, sites, hours_old, now, progress)
    save(db, now)  # Zwischenstand, falls das Nachladen abgebrochen wird
    if not fast:
        fetch_linkedin_details(db, MAX_LINKEDIN_DETAILS, progress)
        save(db, now)
    print(f"{new} neue Jobs, {len(db)} insgesamt in {DB_FILE}", flush=True)
    return new, len(db)


# ---- Lokaler Server für viewer.html (Knopf "Neu scrapen") ------------------
STATE = {"running": False, "percent": 0, "text": "", "new": None, "total": None, "error": None}
STATE_LOCK = threading.Lock()


def start_scrape(args):
    with STATE_LOCK:
        if STATE["running"]:
            return
        STATE.update(running=True, percent=0, text="Starte …", new=None, total=None, error=None)

    def progress(phase, done, total, text):
        share = done / total if total else 1
        # Suche und Beschreibungen teilen sich den Balken je zur Hälfte
        percent = share * 100 if args.fast else share * 50 + (50 if phase == "details" else 0)
        STATE.update(percent=round(percent, 1), text=text)

    def work():
        try:
            new, total = run_scrape(args.sites, args.hours, args.fast, progress)
            STATE.update(new=new, total=total, percent=100, text="Fertig")
        except Exception as exc:
            print(f"Fehler beim Scrapen: {exc!r}", flush=True)
            STATE.update(error=str(exc) or type(exc).__name__)
        finally:
            STATE["running"] = False

    threading.Thread(target=work, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    args = None
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
        """Nur die eigene Seite darf anfragen, keine fremden Webseiten."""
        own = (f"127.0.0.1:{PORT}", f"localhost:{PORT}")
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in own and (not origin or origin.removeprefix("http://") in own)

    def do_GET(self):
        path = self.path.split("?")[0]
        if not self.is_local():
            return self.send_error(403)
        if path == "/api/status":
            return self.reply(json.dumps(STATE).encode("utf-8"), "application/json")
        file, content_type = self.files.get(path, (None, None))
        if file is None or not file.exists():
            return self.send_error(404)
        self.reply(file.read_bytes(), content_type)

    def do_POST(self):
        if not self.is_local():
            return self.send_error(403)
        if self.path != "/api/scrape":
            return self.send_error(404)
        start_scrape(self.args)
        self.reply(json.dumps(STATE).encode("utf-8"), "application/json")

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    # sonst lässt Windows zwei Server auf demselben Port zu
    allow_reuse_address = False


def serve(args):
    url = f"http://127.0.0.1:{PORT}/"
    Handler.args = args
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Läuft schon: {url}")
        if not args.no_open:
            webbrowser.open(url)
        return

    db, generated = read_db()
    if generated:
        save(db, generated)  # Titelfilter auch auf schon gespeicherte Jobs anwenden
    print(f"Ansicht: {url}  (Strg+C beendet)", flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Beendet.")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(description="Jobs im Raum Dortmund scrapen")
    p.add_argument("--scrape", action="store_true", help="nur im Terminal scrapen, ohne Ansicht")
    p.add_argument("--hours", type=int, default=HOURS_OLD, help="nur Jobs der letzten N Stunden")
    p.add_argument("--sites", nargs="+", default=SITES)
    p.add_argument("--fast", action="store_true", help="LinkedIn-Beschreibungen nicht nachladen")
    p.add_argument("--csv", action="store_true", help="mit --scrape: zusätzlich output/jobs.csv schreiben")
    p.add_argument("--no-open", action="store_true", help="Browser nicht öffnen")
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
