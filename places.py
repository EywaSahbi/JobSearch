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

SEEDS = {
    "de": {
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
    },
}


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
        return {**SEEDS.get(country, {}), **self.cache.get(country, {})}

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
