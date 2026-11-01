import copy
import json
import math
import os
import re

SOURCES = {
    "indeed": "Indeed",
    "linkedin": "LinkedIn",
    "glassdoor": "Glassdoor",
    "arbeitsagentur": "Arbeitsagentur",
    "stepstone": "StepStone",
    "absolventa": "Absolventa",
}
MAX_LOCATIONS = 20
MAX_TERMS = 50
MAX_WORDS = 100
MAX_TEXT = 100
RADIUS_KM = (5, 200)

def nrw(name, lat, lon):
    return {"name": name, "region": "North Rhine-Westphalia", "country": "de", "country_name": "Germany", "lat": lat, "lon": lon, "radius_km": 30}


DEFAULTS = {
    "locations": [nrw("Dortmund", 51.514, 7.465), nrw("Essen", 51.455, 7.012), nrw("Düsseldorf", 51.227, 6.773)],
    "terms": ["Software Engineer", "Softwareentwickler", "DevOps", "Systemadministrator", "IT Support", "Fachinformatiker"],
    "sites": list(SOURCES),
    "exclude_title": ["*ausbildung*", "Auszubildende*", "Azubi*", "Senior", "Sr", "Principal", "Lead", "Head of"],
    "keep_title": ["Junior"],
}


def one_line(value):
    return " ".join(value.split())[:MAX_TEXT] if isinstance(value, str) else ""


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def unique(values):
    seen, kept = set(), []
    for value in map(one_line, values if isinstance(values, list) else []):
        if value and value.lower() not in seen:
            seen.add(value.lower())
            kept.append(value)
    return kept


def clean_location(item, number, errors):
    if not isinstance(item, dict):
        errors.append(f"Location {number} is not valid.")
        return None
    name = one_line(item.get("name"))
    label = f"“{name}”" if name else f"Location {number}"
    place = {
        "name": name,
        "region": one_line(item.get("region")),
        "country": item.get("country") if isinstance(item.get("country"), str) else "",
        "country_name": one_line(item.get("country_name")),
        "lat": item.get("lat"),
        "lon": item.get("lon"),
        "radius_km": item.get("radius_km"),
    }
    before = len(errors)
    if not name:
        errors.append(f"{label}: the name is missing.")
    if not re.fullmatch(r"[a-z]{2}", place["country"]):
        errors.append(f"{label}: the country is not valid.")
    if not (is_number(place["lat"]) and -90 <= place["lat"] <= 90 and is_number(place["lon"]) and -180 <= place["lon"] <= 180):
        errors.append(f"{label}: the position on the map is not valid.")
    low, high = RADIUS_KM
    if not (is_number(place["radius_km"]) and low <= round(place["radius_km"]) <= high):
        errors.append(f"{label}: the radius must be between {low} and {high} km.")
    if len(errors) > before:
        return None
    place["radius_km"] = round(place["radius_km"])
    return place


def validate(data):
    if not isinstance(data, dict):
        return None, ["The settings are not valid."]
    errors = []

    items = data.get("locations") if isinstance(data.get("locations"), list) else []
    locations, seen = [], set()
    for number, item in enumerate(items, 1):
        place = clean_location(item, number, errors)
        if place is None:
            continue
        key = (place["name"].lower(), place["country"])
        if key in seen:
            errors.append(f"“{place['name']}” is on the map twice.")
        seen.add(key)
        locations.append(place)
    if not items:
        errors.append("Add at least one location.")
    elif len(items) > MAX_LOCATIONS:
        errors.append(f"Use at most {MAX_LOCATIONS} locations.")

    terms = unique(data.get("terms"))
    if not terms:
        errors.append("Add at least one search term.")
    elif len(terms) > MAX_TERMS:
        errors.append(f"Use at most {MAX_TERMS} search terms.")

    wanted = data.get("sites") if isinstance(data.get("sites"), list) else []
    unknown = [site for site in wanted if site not in SOURCES]
    sites = [site for site in SOURCES if site in wanted]
    if unknown:
        errors.append("Unknown source: " + ", ".join(map(str, unknown)) + ".")
    elif not sites:
        errors.append("Choose at least one source.")

    filters = {}
    for key in ("exclude_title", "keep_title"):
        words = unique(data.get(key))
        if len(words) > MAX_WORDS:
            errors.append(f"Use at most {MAX_WORDS} words per title filter.")
        bad = [word for word in words if not re.search(r"\w", word.strip("*"))]
        if bad:
            errors.append("Title filter words need a letter or digit: " + ", ".join(bad))
        filters[key] = words

    if errors:
        return None, errors
    return {"locations": locations, "terms": terms, "sites": sites, **filters}, []


def load(path):
    if not path.exists():
        return copy.deepcopy(DEFAULTS)
    try:
        settings, errors = validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        settings, errors = None, [str(exc)]
    if settings is None:
        print(f"{path.name} could not be used ({errors[0]}), using the example search instead.", flush=True)
        return copy.deepcopy(DEFAULTS)
    return settings


def save(path, settings):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
