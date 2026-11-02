(() => {
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RADIUS = { min: 5, max: 200, step: 5, first: 30 };
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const LOOKUP_FAILED = 'The place lookup failed. Check your internet connection and try again.';
const DARK = matchMedia('(prefers-color-scheme: dark)');
const STILL = matchMedia('(prefers-reduced-motion: reduce)');

let dialog = null;
let map = null;
let sources = [];
let state = null;
let onDone = null;
let busy = false;
let running = false;
const shapes = new Map();

function note(text, kind) {
  const el = $('#ss-msg');
  el.textContent = text || '';
  el.classList.toggle('error', kind === 'error');
}

function lines(sel) {
  const seen = new Set();
  return $(sel).value.split('\n').map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => {
    const key = s.toLowerCase();
    if (!s || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sourceOf = (name) => sources.find((s) => s.name === name);
const covers = (name, country) => { const s = sourceOf(name); return !s || !s.countries || s.countries.includes(country); };
const chosenSites = () => [...dialog.querySelectorAll('#ss-sources input:checked')].map((box) => box.value);
const samePlace = (a, b) => a.name.toLowerCase() === b.name.toLowerCase() && a.country === b.country;
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0f766e';

function build() {
  dialog = document.createElement('dialog');
  dialog.id = 'search-settings';
  dialog.setAttribute('aria-labelledby', 'ss-title');
  dialog.innerHTML = `
    <form method="dialog" class="ss">
      <div class="ss-head">
        <h2 id="ss-title">Search settings</h2>
        <button class="btn ss-x" value="cancel" aria-label="Close">✕</button>
      </div>
      <div class="ss-body">
        <section class="ss-where" aria-label="Locations">
          <div id="ss-map" class="ss-map"></div>
          <div class="ss-places">
            <h3>Locations</h3>
            <div class="ss-find">
              <input id="ss-q" type="search" placeholder="Search city …" aria-label="Search city" autocomplete="off">
              <button type="button" class="btn" id="ss-go">Search</button>
            </div>
            <ul id="ss-hits" class="ss-hits" hidden></ul>
            <p class="ss-hint">Or click the map to add a pin. Drag a pin to move it.</p>
            <ul id="ss-list" class="ss-list"></ul>
          </div>
        </section>
        <section class="ss-what">
          <label class="ss-field"><span>Search terms <small>one per line</small></span>
            <textarea id="ss-terms" rows="8" spellcheck="false"></textarea></label>
          <div class="ss-field">
            <span>Title filter <small>one word per line; * also matches part of a word, e.g. *trainee*</small></span>
            <label class="ss-sub">Drop jobs whose title contains<textarea id="ss-exclude" rows="4" spellcheck="false"></textarea></label>
            <label class="ss-sub">… unless the title contains<textarea id="ss-keep" rows="2" spellcheck="false"></textarea></label>
          </div>
          <fieldset class="ss-field ss-sources"><legend>Sources</legend><div id="ss-sources"></div></fieldset>
        </section>
      </div>
      <div class="ss-foot">
        <p id="ss-msg" class="ss-msg" role="status"></p>
        <span id="ss-count" class="n"></span>
        <button class="btn" value="cancel">Cancel</button>
        <button type="button" class="btn" id="ss-save">Save</button>
        <button type="button" class="btn primary" id="ss-run">Save and scrape</button>
      </div>
    </form>`;
  document.body.append(dialog);

  $('#ss-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  $('#ss-go').addEventListener('click', find);
  $('#ss-hits').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-hit]');
    if (!hit) return;
    add(JSON.parse(hit.dataset.hit));
    $('#ss-hits').hidden = true;
    $('#ss-q').value = '';
  });
  $('#ss-list').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    const item = e.target.closest('[data-i]');
    if (!act || !item) return;
    const place = state.locations[Number(item.dataset.i)];
    if (act.dataset.act === 'focus') focus(place);
    if (act.dataset.act === 'remove') {
      state.locations.splice(Number(item.dataset.i), 1);
      render();
      draw();
    }
  });
  $('#ss-list').addEventListener('input', (e) => {
    if (e.target.dataset.act !== 'radius') return;
    const item = e.target.closest('[data-i]');
    const place = state.locations[Number(item.dataset.i)];
    place.radius_km = Number(e.target.value);
    item.querySelector('output').textContent = `${place.radius_km} km`;
    const shape = shapes.get(place);
    if (shape) shape.circle.setRadius(place.radius_km * 1000);
  });
  $('#ss-sources').addEventListener('change', render);
  $('#ss-terms').addEventListener('input', count);
  $('#ss-save').addEventListener('click', () => save(false));
  $('#ss-run').addEventListener('click', () => save(true));
}

function setupMap() {
  if (typeof L === 'undefined') {
    $('#ss-map').innerHTML = '<p class="ss-nomap">The map could not be loaded. Search for cities instead.</p>';
    return;
  }
  map = L.map('ss-map', { worldCopyJump: true }).setView([30, 10], 2);
  L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
  DARK.addEventListener('change', draw);
  map.on('click', (e) => addAt(e.latlng.wrap()));
}

function draw() {
  if (!map || !state) return;
  for (const { marker, circle } of shapes.values()) { marker.remove(); circle.remove(); }
  shapes.clear();
  const color = accent();
  const icon = L.divIcon({ className: 'ss-pin', iconSize: [18, 18], iconAnchor: [9, 9] });
  for (const place of state.locations) {
    const circle = L.circle([place.lat, place.lon], {
      radius: place.radius_km * 1000, color, weight: 1.5, fillColor: color, fillOpacity: 0.12, interactive: false,
    }).addTo(map);
    const marker = L.marker([place.lat, place.lon], { icon, draggable: true, title: place.name, alt: place.name }).addTo(map);
    marker.bindTooltip(esc(place.name), { direction: 'top', offset: [0, -10] });
    marker.on('drag', (e) => circle.setLatLng(e.target.getLatLng()));
    marker.on('dragend', (e) => moveTo(place, e.target.getLatLng().wrap()));
    marker.on('click', () => focus(place));
    shapes.set(place, { marker, circle });
  }
}

function fit() {
  if (!map) return;
  map.invalidateSize();
  const circles = [...shapes.values()].map((s) => s.circle);
  if (circles.length) map.fitBounds(L.featureGroup(circles).getBounds(), { padding: [24, 24], maxZoom: 11, animate: false });
  else map.setView([30, 10], 2, { animate: false });
}

function focus(place) {
  const shape = shapes.get(place);
  if (map && shape) map.fitBounds(shape.circle.getBounds(), { padding: [24, 24], maxZoom: 11, animate: !STILL.matches });
  for (const el of dialog.querySelectorAll('.ss-place')) {
    const on = state.locations[Number(el.dataset.i)] === place;
    el.classList.toggle('on', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  }
}

function render() {
  if (!state) return;
  const sites = chosenSites();
  const label = (name) => (sourceOf(name) || {}).label || name;
  $('#ss-list').innerHTML = state.locations.map((place, i) => {
    const where = [place.region && place.region !== place.name ? place.region : '', place.country_name].filter(Boolean).join(', ');
    const skipped = sites.filter((site) => !covers(site, place.country)).map(label);
    return `<li class="ss-place" data-i="${i}">
      <div class="ss-place-top">
        <button type="button" class="ss-name" data-act="focus" title="Show on the map">${esc(place.name)}</button>
        <span class="ss-region">${esc(where)}</span>
        <button type="button" class="ss-del" data-act="remove" aria-label="Remove ${esc(place.name)}" title="Remove">✕</button>
      </div>
      <label class="ss-radius"><input type="range" min="${RADIUS.min}" max="${RADIUS.max}" step="${RADIUS.step}" value="${place.radius_km}"
        data-act="radius" aria-label="Radius around ${esc(place.name)}"><output>${place.radius_km} km</output></label>
      ${skipped.length ? `<p class="ss-skip">Not searched here: ${esc(skipped.join(', '))}</p>` : ''}
    </li>`;
  }).join('') || '<li class="ss-empty">No locations yet. Search for a city or click the map.</li>';
  count();
}

function count() {
  if (!state) return;
  const sites = chosenSites();
  const perTerm = state.locations.reduce((n, place) => n + sites.filter((site) => covers(site, place.country)).length, 0);
  const total = perTerm * lines('#ss-terms').length;
  $('#ss-count').textContent = `${total} ${total === 1 ? 'search' : 'searches'} per run`;
}

function fill() {
  $('#ss-terms').value = state.terms.join('\n');
  $('#ss-exclude').value = state.exclude_title.join('\n');
  $('#ss-keep').value = state.keep_title.join('\n');
  $('#ss-sources').innerHTML = sources.map((s) => {
    const only = s.countries && s.countries.length === 1 && s.countries[0] === 'de' ? ' <small>Germany only</small>' : '';
    return `<label><input type="checkbox" value="${esc(s.name)}"${state.sites.includes(s.name) ? ' checked' : ''}> ${esc(s.label)}${only}</label>`;
  }).join('');
  $('#ss-q').value = '';
  $('#ss-hits').hidden = true;
}

async function lookup(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (res.ok) return data;
    note(res.status === 502 ? LOOKUP_FAILED : data.error || LOOKUP_FAILED, 'error');
  } catch {
    note(LOOKUP_FAILED, 'error');
  }
  return null;
}

async function find() {
  const q = $('#ss-q').value.trim();
  if (!q || busy) return;
  busy = true;
  $('#ss-hits').hidden = true;
  note('Searching …');
  const data = await lookup(`/api/places?q=${encodeURIComponent(q)}`);
  busy = false;
  if (!data) return;
  if (!data.places.length) { note(`No town found for “${q}”.`, 'error'); return; }
  note('');
  if (data.places.length === 1) {
    add(data.places[0]);
    $('#ss-q').value = '';
    return;
  }
  $('#ss-hits').innerHTML = data.places.map((place) => `<li><button type="button" data-hit="${esc(JSON.stringify(place))}">
    <b>${esc(place.name)}</b> <span>${esc([place.region, place.country_name].filter(Boolean).join(', '))}</span></button></li>`).join('');
  $('#ss-hits').hidden = false;
}

function add(place) {
  const same = state.locations.find((p) => samePlace(p, place));
  if (same) { focus(same); note(`${place.name} is already on the map.`); return; }
  const last = state.locations[state.locations.length - 1];
  const entry = { ...place, radius_km: last ? last.radius_km : RADIUS.first };
  state.locations.push(entry);
  render();
  draw();
  focus(entry);
  note(`Added ${place.name}.`);
}

async function addAt(latlng) {
  if (busy) return;
  busy = true;
  note('Looking up the nearest town …');
  const data = await lookup(`/api/places/nearest?lat=${latlng.lat.toFixed(5)}&lon=${latlng.lng.toFixed(5)}`);
  busy = false;
  if (!data) return;
  if (!data.place) { note('No town found here. Click closer to a town.', 'error'); return; }
  add(data.place);
}

async function moveTo(place, latlng) {
  busy = true;
  note('Looking up the nearest town …');
  const data = await lookup(`/api/places/nearest?lat=${latlng.lat.toFixed(5)}&lon=${latlng.lng.toFixed(5)}`);
  busy = false;
  const target = data && data.place;
  if (data && !target) note('No town found there, so the pin went back.', 'error');
  else if (target && state.locations.some((p) => p !== place && samePlace(p, target))) note(`${target.name} is already on the map, so the pin went back.`, 'error');
  else if (target) {
    Object.assign(place, target);
    note(`Moved the pin to ${target.name}.`);
    render();
  }
  draw();
}

function setRunning(on) {
  running = on;
  $('#ss-save').disabled = on;
  $('#ss-run').disabled = on;
}

function collect() {
  return {
    locations: state.locations.map(({ name, region, country, country_name, lat, lon, radius_km }) => ({ name, region, country, country_name, lat, lon, radius_km })),
    terms: lines('#ss-terms'),
    sites: chosenSites(),
    exclude_title: lines('#ss-exclude'),
    keep_title: lines('#ss-keep'),
  };
}

async function save(scrape) {
  if (busy || running) return;
  busy = true;
  note('Saving …');
  let res;
  let data;
  try {
    res = await fetch('/api/settings', { method: 'POST', body: JSON.stringify(collect()) });
    data = await res.json();
  } catch {
    busy = false;
    note('Saving failed. Is scraper.py still running?', 'error');
    return;
  }
  busy = false;
  if (!res.ok) {
    if (res.status === 409) setRunning(true);
    note((data.errors || ['Saving failed.']).join(' '), 'error');
    return;
  }
  dialog.close();
  if (onDone) onDone(scrape);
}

async function open(done) {
  onDone = done;
  if (!dialog) build();
  state = null;
  note('Loading …');
  $('#ss-list').innerHTML = '';
  dialog.showModal();
  let data;
  try {
    data = await (await fetch('/api/settings', { cache: 'no-store' })).json();
  } catch {
    note('The settings could not be loaded. Is scraper.py still running?', 'error');
    setRunning(true);
    return;
  }
  sources = data.sources;
  state = JSON.parse(JSON.stringify(data.settings));
  fill();
  if (!map) setupMap();
  render();
  draw();
  fit();
  setRunning(data.running);
  note(data.running ? 'A scrape is running. You can save when it has finished.' : '');
}

window.SearchSettings = { open };
})();
