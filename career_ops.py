"""Schickt Jobs in die Inbox von career-ops (https://github.com/career-ops-hq/career-ops).

Pro Job entsteht dort eine Datei jds/<firma>-<titel>-<id>.md mit dem Stellentext
und eine Zeile in data/pipeline.md, die auf diese Datei zeigt. In career-ops
bewertet "/career-ops pipeline" dann alles, was in der Inbox liegt.
"""
import json
import os
import re

SITES = {"indeed": "Indeed", "linkedin": "LinkedIn", "glassdoor": "Glassdoor"}
PENDING = ("## Pending", "## Pendientes", "## Offen")
PROCESSED = ("## Processed", "## Procesadas", "## Verarbeitet")
SKELETON = (
    "# Pipeline — Pending URLs\n\n"
    "Paste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.\n\n"
    "## Pending\n\n"
    "## Processed\n"
)
NO_COMPANY = "Firma unbekannt"
NO_DESCRIPTION = "_Für diesen Job wurde keine Beschreibung geladen. Der Stellentext steht nur auf der Originalseite._"
UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
ID_RE = re.compile(r"[0-9a-f]{12}")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
SENT_RE = re.compile(r"-([0-9a-f]{12})\.md$")


def is_ready(root):
    """Liegt unter root wirklich ein career-ops?"""
    return (root / "modes").is_dir() and (root / "package.json").is_file()


def sent_ids(root):
    """IDs der Jobs, die schon in career-ops liegen (stehen im Dateinamen)."""
    jds = root / "jds"
    if not jds.is_dir():
        return set()
    return {m.group(1) for m in (SENT_RE.search(f.name) for f in jds.iterdir()) if m}


def one_line(value):
    return " ".join(value.split()) if isinstance(value, str) else ""


def clean(job):
    """Bringt einen Eintrag aus der Ansicht in feste Form. None, wenn er unbrauchbar ist."""
    if not isinstance(job, dict):
        return None
    job_id, title = job.get("id"), one_line(job.get("title"))
    if not isinstance(job_id, str) or not ID_RE.fullmatch(job_id) or not title:
        return None
    links = job.get("links") if isinstance(job.get("links"), dict) else {}
    links = {one_line(site): one_line(url) for site, url in links.items()}
    date = one_line(job.get("date_posted"))
    description = job.get("description")
    return {
        "id": job_id,
        "title": title,
        "company": one_line(job.get("company")),
        "location": one_line(job.get("location")),
        "date_posted": date if DATE_RE.fullmatch(date) else "",
        "salary": one_line(job.get("salary")),
        "job_type": one_line(job.get("job_type")),
        "is_remote": bool(job.get("is_remote")),
        "description": description.strip() if isinstance(description, str) else "",
        "links": {site: url for site, url in links.items() if re.fullmatch(r"https?://\S+", url)},
    }


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().translate(UMLAUTS)).strip("-")


def jd_name(job):
    # kurz halten: Windows-Pfade enden bei 260 Zeichen
    return f"{slug(job['company'] + ' ' + job['title'])[:80].strip('-')}-{job['id']}.md"


def jd_text(job, today):
    links = job["links"]
    facts = [
        ("Ort", job["location"]),
        ("Veröffentlicht", job["date_posted"]),
        ("Gehalt", job["salary"]),
        ("Art", job["job_type"]),
        ("Remote", "ja" if job["is_remote"] else ""),
        *((SITES.get(site, site), url) for site, url in links.items()),
    ]
    head = {
        "title": job["title"],
        "company": job["company"],
        "url": next(iter(links.values()), ""),
        "location": job["location"],
        "scraped": today,
        "source": "jobsearch",
    }
    return "\n".join([
        "---",
        *(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in head.items()),
        "---",
        "",
        f"# {job['title']} — {job['company'] or NO_COMPANY}",
        "",
        *(f"- {name}: {value}" for name, value in facts if value),
        "",
        job["description"] or NO_DESCRIPTION,
        "",
    ])


def cell(value):
    """Wie sanitizeMarkdownField in scan.mjs von career-ops: "|" würde die Zeile in falsche Spalten teilen."""
    for char in "\\[]":
        value = value.replace(char, "\\" + char)
    return value.replace("|", "/")


def pipeline_line(job, name):
    cells = [f"local:jds/{name}", cell(job["company"] or NO_COMPANY), cell(job["title"])]
    if job["location"]:
        cells.append(cell(job["location"]))
    if job["date_posted"]:
        cells.append(f"posted: {job['date_posted']}")
    return "- [ ] " + " | ".join(cells)


def write(path, text):
    """Erst daneben schreiben, dann ersetzen: so bleibt nie eine halbe Datei zurück."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def add_pending(path, lines):
    """Hängt lines ans Ende des Abschnitts "Pending" von data/pipeline.md."""
    text = path.read_text(encoding="utf-8") if path.exists() else SKELETON
    marker = next((m for m in PENDING if m in text), None)
    if marker is None:
        marker = PENDING[0]
        cut = min((i for i in map(text.find, PROCESSED) if i != -1), default=len(text))
        before = text[:cut].rstrip("\n")
        text = (before + "\n\n" if before else "") + marker + "\n\n" + text[cut:]
    start = text.index(marker) + len(marker)
    end = text.find("\n## ", start)
    end = len(text) if end == -1 else end
    head, tail = text[:end].rstrip("\n"), text[end:].lstrip("\n")
    gap = "\n\n" if head.endswith(marker) else "\n"
    write(path, head + gap + "\n".join(lines) + "\n" + ("\n" + tail if tail else ""))


def send(root, jobs, today):
    """Legt jobs in die Inbox. Gibt die IDs der neu gesendeten Jobs zurück."""
    known = sent_ids(root)
    files, lines, new = [], [], []
    try:
        for job in map(clean, jobs):
            if job is None or job["id"] in known:
                continue
            name = jd_name(job)
            files.append(root / "jds" / name)
            write(files[-1], jd_text(job, today))
            lines.append(pipeline_line(job, name))
            known.add(job["id"])
            new.append(job["id"])
        if lines:
            add_pending(root / "data" / "pipeline.md", lines)
    except OSError:
        # ohne Zeile in der Inbox darf kein Job als gesendet gelten
        for file in files:
            file.unlink(missing_ok=True)
        raise
    return new
