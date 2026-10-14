import base64
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

STEPSTONE_STATE = re.compile(r'window\.__PRELOADED_STATE__\["app-unifiedResultlist"\]\s*=\s*')
LD_JSON = re.compile(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S)
UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
INTERVALS = {"Annually": "yearly", "Monthly": "monthly", "Hourly": "hourly"}
EMPLOYMENT = {"FULL_TIME": "fulltime", "PART_TIME": "parttime", "INTERN": "internship", "CONTRACTOR": "contract", "TEMPORARY": "temporary"}

CITIES = {
    "dortmund": (51.514, 7.465),
    "essen": (51.455, 7.012),
    "düsseldorf": (51.227, 6.773),
    "bochum": (51.482, 7.216),
    "duisburg": (51.434, 6.762),
    "gelsenkirchen": (51.518, 7.086),
    "wuppertal": (51.256, 7.151),
    "hagen": (51.367, 7.463),
    "mülheim an der ruhr": (51.431, 6.881),
    "oberhausen": (51.496, 6.864),
    "neuss": (51.198, 6.692),
    "herne": (51.538, 7.226),
    "witten": (51.444, 7.335),
    "recklinghausen": (51.614, 7.198),
    "bottrop": (51.524, 6.929),
    "castrop-rauxel": (51.556, 7.311),
    "lünen": (51.617, 7.528),
    "unna": (51.538, 7.688),
    "ratingen": (51.297, 6.850),
    "hilden": (51.168, 6.930),
    "mettmann": (51.250, 6.975),
    "krefeld": (51.339, 6.586),
    "solingen": (51.171, 7.083),
    "remscheid": (51.179, 7.189),
    "velbert": (51.339, 7.044),
    "gladbeck": (51.571, 6.985),
    "herten": (51.596, 7.137),
    "marl": (51.657, 7.090),
    "dorsten": (51.660, 6.965),
    "moers": (51.451, 6.626),
    "kamen": (51.592, 7.664),
    "schwerte": (51.446, 7.565),
    "iserlohn": (51.376, 7.695),
    "hattingen": (51.399, 7.186),
    "meerbusch": (51.267, 6.688),
    "erkrath": (51.223, 6.908),
    "langenfeld": (51.108, 6.948),
    "monheim am rhein": (51.091, 6.892),
    "dormagen": (51.096, 6.840),
    "leverkusen": (51.046, 6.984),
    "köln": (50.938, 6.960),
    "mönchengladbach": (51.185, 6.442),
    "bergkamen": (51.617, 7.633),
    "hamm": (51.681, 7.817),
    "datteln": (51.654, 7.342),
    "waltrop": (51.624, 7.398),
    "herdecke": (51.400, 7.433),
    "wetter": (51.387, 7.395),
    "gevelsberg": (51.319, 7.339),
    "schwelm": (51.286, 7.294),
    "ennepetal": (51.297, 7.343),
    "sprockhövel": (51.347, 7.244),
    "dinslaken": (51.567, 6.739),
    "kaarst": (51.228, 6.619),
    "willich": (51.263, 6.549),
    "haan": (51.193, 7.012),
    "heiligenhaus": (51.327, 6.971),
    "wülfrath": (51.283, 7.036),
    "oer-erkenschwick": (51.642, 7.251),
    "holzwickede": (51.500, 7.617),
    "selm": (51.697, 7.468),
    "werne": (51.664, 7.635),
    "menden": (51.443, 7.776),
    "fröndenberg": (51.472, 7.766),
    "kamp-lintfort": (51.500, 6.545),
    "neukirchen-vluyn": (51.441, 6.547),
    "grevenbroich": (51.090, 6.588),
    "münster": (51.962, 7.626),
}

def get(url, **kwargs):
    headers = {"User-Agent": USER_AGENT, **kwargs.pop("headers", {})}
    res = requests.get(url, headers=headers, timeout=TIMEOUT, **kwargs)
    res.raise_for_status()
    return res


def cutoff(hours_old):
    return datetime.now(timezone.utc) - timedelta(hours=hours_old)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().translate(UMLAUTS)).strip("-")


def place(text):
    return re.sub(r"\s+", " ", re.sub(r"[\d()]+", " ", text or "")).strip()


def distance(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def area(location, radius_km):
    center = CITIES.get(location.lower())
    names = {location.lower()}
    if center:
        names.update(name for name, point in CITIES.items() if distance(center, point) <= radius_km)
    return names


def in_area(text, names):
    parts = [place(part).lower() for part in re.split(r"[,/;]", text or "")]
    return any(
        part == name or part.startswith((name + " ", name + "-")) or name.startswith(part + " ")
        for part in parts if part
        for name in names
    )


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


def search_arbeitsagentur(term, location, radius_km, hours_old, limit):
    params = {
        "was": term,
        "wo": location,
        "umkreis": radius_km,
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


def stepstone_rows(page, location, stop, names=None):
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
        city = (
            next((c for c in cities if c.lower() == location.lower()), None)
            or next((c for c in cities if names and in_area(c, names)), None)
            or (cities[0] if cities else "")
        )
        if names and city and not in_area(city, names) and in_area(city, CITIES):
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


def stepstone_fields(page):
    for block in LD_JSON.findall(page):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        for item in data if isinstance(data, list) else [data]:
            if isinstance(item, dict) and item.get("@type") == "JobPosting" and item.get("description"):
                kind = item.get("employmentType")
                kind = kind[0] if isinstance(kind, list) and kind else kind
                return {"description": markdown(item["description"]), "job_type": EMPLOYMENT.get(kind) if isinstance(kind, str) else None}
    return {}


def search_stepstone(term, location, radius_km, hours_old, limit):
    page = get(stepstone_url(term, location)).text
    return stepstone_rows(page, location, cutoff(hours_old), area(location, radius_km))[:limit]


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


SEARCH = {
    "arbeitsagentur": search_arbeitsagentur,
    "stepstone": search_stepstone,
}
DETAILS = {
    "arbeitsagentur": details_arbeitsagentur,
    "stepstone": details_stepstone,
}
