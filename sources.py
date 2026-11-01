import base64
import html
import json
import math
import re
from datetime import datetime, timedelta, timezone

import requests
from markdownify import markdownify

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
TIMEOUT = 25
STEPSTONE_PAGE_LIMIT = 400_000

BA_API = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc"
BA_KEY = {"X-API-Key": "jobboerse-jobsuche"}
BA_PAGE = "https://www.arbeitsagentur.de/jobsuche/jobdetail/"

ABSOLVENTA = "https://www.absolventa.de"
ABSOLVENTA_PAGE_SIZE = 20

STEPSTONE_STATE = re.compile(r'window\.__PRELOADED_STATE__\["app-unifiedResultlist"\]\s*=\s*')
ABSOLVENTA_CARD = re.compile(r'<a [^>]*id="teaser_job_offer_\d+"[^>]*href="(/stellenangebote/[^"]+)"[^>]*>(.*?)</a>', re.S)
ABSOLVENTA_TITLE = re.compile(r"<h2[^>]*>(.*?)</h2>", re.S)
ABSOLVENTA_COMPANY = re.compile(r'<span class="[^"]*\bt-small\b[^"]*">(.*?)</span>', re.S)
ABSOLVENTA_CITY = re.compile(r"<span><span>(.*?)</span></span>", re.S)
LD_JSON = re.compile(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S)
UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
INTERVALS = {"Annually": "yearly", "Monthly": "monthly", "Hourly": "hourly"}
EMPLOYMENT = {"FULL_TIME": "fulltime", "PART_TIME": "parttime", "INTERN": "internship", "CONTRACTOR": "contract", "TEMPORARY": "temporary"}

COUNTRIES = {"arbeitsagentur": {"de"}, "stepstone": {"de"}, "absolventa": {"de"}}


def get(url, **kwargs):
    headers = {"User-Agent": USER_AGENT, **kwargs.pop("headers", {})}
    res = requests.get(url, headers=headers, timeout=TIMEOUT, **kwargs)
    res.raise_for_status()
    return res


def cutoff(hours_old):
    return datetime.now(timezone.utc) - timedelta(hours=hours_old)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().translate(UMLAUTS)).strip("-")


def choose_city(cities, location, inside):
    if not cities:
        return "", True
    exact = next((city for city in cities if city.lower() == location.lower()), None)
    if exact or not inside:
        return exact or cities[0], True
    first = None
    for number, city in enumerate(cities):
        verdict = inside(city)
        if number == 0:
            first = verdict
        if verdict:
            return city, True
    return cities[0], first is not False


def markdown(text):
    return markdownify(text, heading_style="ATX", bullets="-").strip()


def row(site, title, company, city, url, date, **extra):
    return {
        "site": site,
        "title": title,
        "company": company or "",
        "location": f"{city}, Germany" if city else "",
        "job_url": url,
        "date_posted": date,
        "job_type": None,
        "job_level": None,
        "is_remote": False,
        "description": None,
        **extra,
    }


def arbeitsagentur_rows(payload):
    rows = []
    for item in payload.get("ergebnisliste") or []:
        title, ref = item.get("stellenangebotsTitel"), item.get("referenznummer")
        if not title or not ref:
            continue
        address = ((item.get("stellenlokationen") or [{}])[0] or {}).get("adresse") or {}
        part_time = any(value for key, value in item.items() if key.startswith("arbeitszeitTeilzeit"))
        types = [name for name, on in (("fulltime", item.get("arbeitszeitVollzeit")), ("parttime", part_time)) if on]
        rows.append(row(
            "arbeitsagentur", title, item.get("firma"), address.get("ort") or "", BA_PAGE + ref,
            item.get("datumErsteVeroeffentlichung"),
            job_type=", ".join(types) or None,
            is_remote=bool(item.get("homeofficemoeglich")),
        ))
    return rows


def arbeitsagentur_detail_url(page_url):
    ref = page_url.rstrip("/").rsplit("/", 1)[-1]
    return f"{BA_API}/v4/jobdetails/{base64.b64encode(ref.encode()).decode()}"


def search_arbeitsagentur(term, location, hours_old, limit, inside=None):
    params = {
        "was": term,
        "wo": location["name"],
        "umkreis": location["radius_km"],
        "angebotsart": 1,
        "veroeffentlichtseit": min(100, max(1, math.ceil(hours_old / 24))),
        "size": min(limit, 100),
        "page": 1,
    }
    return arbeitsagentur_rows(get(f"{BA_API}/v6/jobs", params=params, headers=BA_KEY).json())


def details_arbeitsagentur(url):
    payload = get(arbeitsagentur_detail_url(url), headers=BA_KEY).json()
    return {"description": payload.get("stellenangebotsBeschreibung")}


def stepstone_url(term, location):
    return f"https://www.stepstone.de/jobs/{slug(term)}/in-{slug(location)}"


def stepstone_rows(page, location, stop, inside=None):
    match = STEPSTONE_STATE.search(page)
    if not match:
        return []
    state, _ = json.JSONDecoder().raw_decode(page, match.end())
    oldest = stop.date().isoformat()
    rows = []
    for item in (state.get("searchResults") or {}).get("items") or []:
        posted = (item.get("datePosted") or "")[:10]
        if not item.get("title") or not item.get("url") or (posted and posted < oldest):
            continue
        cities = [city.strip() for city in (item.get("location") or "").split(",") if city.strip()]
        city, keep = choose_city(cities, location, inside)
        if not keep:
            continue
        salary = item.get("unifiedSalary") or {}
        pay = {}
        if salary.get("min") and salary.get("salaryType") not in (None, "Predicted"):
            pay = {
                "min_amount": salary.get("min"),
                "max_amount": salary.get("max"),
                "currency": salary.get("currencyIso"),
                "interval": INTERVALS.get(salary.get("period")),
            }
        rows.append(row(
            "stepstone", item["title"], item.get("companyName"), city, item["url"].split("?")[0], posted or None,
            is_remote=item.get("workFromHome") not in (None, "", "0", 0),
            **pay,
        ))
    return rows


def job_posting(page):
    for block in LD_JSON.findall(page):
        try:
            data = json.loads(block, strict=False)
        except ValueError:
            continue
        for item in data if isinstance(data, list) else [data]:
            if isinstance(item, dict) and item.get("@type") == "JobPosting" and item.get("description"):
                return item
    return None


def employment(item):
    kind = item.get("employmentType")
    kind = kind[0] if isinstance(kind, list) and kind else kind
    return EMPLOYMENT.get(kind.strip("[]").split(",")[0].strip()) if isinstance(kind, str) else None


def stepstone_fields(page):
    item = job_posting(page)
    if not item:
        return {}
    return {"description": markdown(item["description"]), "job_type": employment(item)}


def search_stepstone(term, location, hours_old, limit, inside=None):
    page = get(stepstone_url(term, location["name"])).text
    return stepstone_rows(page, location["name"], cutoff(hours_old), inside)[:limit]


def details_stepstone(url):
    page = ""
    with requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT, stream=True) as res:
        res.raise_for_status()
        res.encoding = "utf-8"
        for chunk in res.iter_content(16384, decode_unicode=True):
            page += chunk
            if len(page) > STEPSTONE_PAGE_LIMIT or stepstone_fields(page):
                break
    return stepstone_fields(page)


def text_of(pattern, fragment):
    match = pattern.search(fragment)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", match.group(1)))).strip() if match else ""


def absolventa_rows(page, location, inside=None):
    rows = []
    for href, card in ABSOLVENTA_CARD.findall(page):
        title = re.sub(r"\s*(\.\.\.|…)$", "", text_of(ABSOLVENTA_TITLE, card))
        if not title:
            continue
        city = text_of(ABSOLVENTA_CITY, card)
        if not choose_city([city] if city else [], location, inside)[1]:
            continue
        rows.append(row(
            "absolventa", title, text_of(ABSOLVENTA_COMPANY, card), city, ABSOLVENTA + href, None,
            is_remote="Homeoffice" in card,
        ))
    return rows


def absolventa_fields(page):
    item = job_posting(page)
    if not item:
        return {}
    return {
        "description": markdown(html.unescape(item["description"])),
        "job_type": employment(item),
        "date_posted": (item.get("datePosted") or "")[:10] or None,
    }


def search_absolventa(term, location, hours_old, limit, inside=None):
    rows = []
    for number in range(1, math.ceil(limit / ABSOLVENTA_PAGE_SIZE) + 1):
        page = get(f"{ABSOLVENTA}/jobs", params={"text": term, "location": location["name"], "page": number}).text
        rows += absolventa_rows(page, location["name"], inside)
        if len(ABSOLVENTA_CARD.findall(page)) < ABSOLVENTA_PAGE_SIZE:
            break
    return rows[:limit]


def details_absolventa(url):
    return absolventa_fields(get(url).text)


SEARCH = {
    "arbeitsagentur": search_arbeitsagentur,
    "stepstone": search_stepstone,
    "absolventa": search_absolventa,
}
DETAILS = {
    "arbeitsagentur": details_arbeitsagentur,
    "stepstone": details_stepstone,
    "absolventa": details_absolventa,
}
