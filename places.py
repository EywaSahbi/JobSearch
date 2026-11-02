import json
import math
import os
import re
import threading
import time

import requests

NOMINATIM = "https://nominatim.openstreetmap.org"
USER_AGENT = "JobSearch/1.0 (personal job search tool, run locally)"
TIMEOUT = 15
PAUSE = 1.0
MAX_FAILURES = 3

class PlaceError(Exception):
    pass


def place(text):
    return re.sub(r"\s+", " ", re.sub(r"[\d()]+", " ", text or "")).strip()


def key(text):
    return place(text).lower()


def distance(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def point_of(item):
    try:
        return round(float(item["lat"]), 4), round(float(item["lon"]), 4)
    except (KeyError, TypeError, ValueError):
        return None


def parse(item):
    if not isinstance(item, dict):
        return None
    address = item.get("address") or {}
    name = (item.get("namedetails") or {}).get("name") or item.get("name") or ""
    country = str(address.get("country_code") or "").lower()
    point = point_of(item)
    if not name or not point or not re.fullmatch(r"[a-z]{2}", country):
        return None
    return {
        "name": name,
        "region": address.get("state") or address.get("region") or address.get("county") or "",
        "country": country,
        "country_name": address.get("country") or country.upper(),
        "lat": point[0],
        "lon": point[1],
    }


class Places:
    def __init__(self, path, get=requests.get, clock=time.monotonic, sleep=time.sleep):
        self.path = path
        self.get = get
        self.clock = clock
        self.sleep = sleep
        self.lock = threading.RLock()
        self.last = None
        self.blocked = False
        self.failures = 0
        self.cache = self.read()

    def read(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        cache = {}
        for country, entries in (data.items() if isinstance(data, dict) else []):
            for name, point in (entries.items() if isinstance(entries, dict) else []):
                usable = isinstance(point, list) and len(point) == 2 and all(isinstance(v, (int, float)) for v in point)
                if point is None or usable:
                    cache.setdefault(country, {})[name] = tuple(point) if point else None
        return cache

    def write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(self.cache, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.path)

    def request(self, path, params):
        with self.lock:
            if self.last is not None:
                wait = self.last + PAUSE - self.clock()
                if wait > 0:
                    self.sleep(wait)
            try:
                res = self.get(
                    NOMINATIM + path,
                    params={**params, "format": "jsonv2"},
                    headers={"User-Agent": USER_AGENT},
                    timeout=TIMEOUT,
                )
            except requests.RequestException as exc:
                raise PlaceError(f"place lookup failed: {exc}") from exc
            finally:
                self.last = self.clock()
            if res.status_code in (403, 429):
                self.blocked = True
            if res.status_code != 200:
                raise PlaceError(f"place lookup failed with HTTP {res.status_code}")
            try:
                return res.json()
            except ValueError as exc:
                raise PlaceError("place lookup gave no readable answer") from exc

    def reset(self):
        with self.lock:
            self.blocked = False
            self.failures = 0

    def search(self, text):
        items = self.request("/search", {
            "q": text, "featureType": "settlement", "limit": 5,
            "addressdetails": 1, "namedetails": 1, "accept-language": "en",
        })
        found, seen = [], set()
        for result in map(parse, items if isinstance(items, list) else []):
            if result and (result["name"], result["region"], result["country"]) not in seen:
                seen.add((result["name"], result["region"], result["country"]))
                found.append(result)
        return found

    def nearest(self, lat, lon):
        item = self.request("/reverse", {
            "lat": lat, "lon": lon, "zoom": 10,
            "addressdetails": 1, "namedetails": 1, "accept-language": "en",
        })
        return None if not isinstance(item, dict) or "error" in item else parse(item)

    def known(self, country):
        return dict(self.cache.get(country, {}))

    @staticmethod
    def local_match(name, known):
        found = {n: p for n, p in known.items() if p}
        longer = [n for n in found if name.startswith((n + " ", n + "-"))]
        if longer:
            return found[max(longer, key=len)]
        shorter = [n for n in found if n.startswith(name + " ")]
        return found[shorter[0]] if len(shorter) == 1 else None

    def within(self, location):
        center = (location["lat"], location["lon"])

        def inside(text):
            verdict = None
            for part in re.split(r"[,/;]", text or ""):
                point = self.coordinates(part, location["country"])
                if point is None:
                    continue
                if distance(center, point) <= location["radius_km"]:
                    return True
                verdict = False
            return verdict

        return inside

    def coordinates(self, text, country):
        name = key(text)
        if not name:
            return None
        with self.lock:
            known = self.known(country)
            if name in known:
                return known[name]
            match = self.local_match(name, known)
            if match or self.blocked:
                return match
            try:
                items = self.request("/search", {"q": place(text), "countrycodes": country, "featureType": "settlement", "limit": 1})
            except PlaceError:
                self.failures += 1
                if self.failures >= MAX_FAILURES:
                    self.blocked = True
                return None
            self.failures = 0
            point = point_of(items[0]) if isinstance(items, list) and items else None
            self.cache.setdefault(country, {})[name] = point
            self.write()
            return point
