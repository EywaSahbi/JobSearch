# JobSearch

Scrapes job boards for your search terms around the places you pick on a map, lists the results on a page in your browser, and can pass jobs to [career-ops](https://github.com/career-ops-hq/career-ops), which scores them against your CV.

Everything runs on your machine. No account is needed.

This file is the only documentation of the project, including the bundled `career-ops/` folder. The code has no comments.

## How it works

1. **Choose:** In the viewer, “Search settings” sets the places (pins with a radius on a map), the search terms, the title filter and the sources.
2. **Collect:** `scraper.py` queries the job boards for every search term and place and merges the results.
3. **Review:** `viewer.html` lists the jobs with filters, a search box and keyboard shortcuts.
4. **Evaluate:** One click sends a job and its description to the career-ops inbox, where it is scored against your CV.

## Getting started

Requires Python 3.10 or newer.

```
pip install python-jobspy
python scraper.py
```

The viewer opens at `http://127.0.0.1:8765`. The “Search settings” button sets what to search for, the “Scrape now” button starts a run; `Ctrl+C` in the terminal stops the server.

| Command | Effect |
|---|---|
| `python scraper.py` | start the viewer |
| `python scraper.py --scrape` | scrape in the terminal only, without the viewer |
| `--hours 24` | only jobs posted in the last 24 hours |
| `--fast` | do not load job descriptions after the search |
| `--sites indeed linkedin` | query only these sources instead of those chosen in the search settings, see [Sources](#sources) for the names |
| `--csv` | with `--scrape`: also write `output/jobs.csv` |
| `--no-open` | do not open the browser |

## Project layout

| Path | Content |
|---|---|
| `scraper.py` | scraper and local server |
| `viewer.html` | viewer, a single file without a build step |
| `settings.js` | the “Search settings” window |
| `config.py` | loads, checks and saves the search settings |
| `places.py` | place lookup with OpenStreetMap and the distance check |
| `sources.py` | sources that do not go through JobSpy |
| `career_ops.py` | sends jobs to career-ops |
| `vendor/leaflet/` | the map library, see [Third-party code](#third-party-code) |
| `settings.json` | your search settings, written on the first save, not in Git |
| `output/jobs.json` | all collected jobs |
| `output/jobs.js` | the same data as a script for the viewer |
| `output/places.json` | places already looked up, not in Git |
| `career-ops/` | career-ops, see [Third-party code](#third-party-code) |

## Search settings

The “Search settings” button in the viewer opens a window with a world map. What you set there is saved in `settings.json` next to `scraper.py`, and `python scraper.py --scrape` uses the same file. Without the file an example search applies: Dortmund, Essen and Düsseldorf with 30 km each, some IT job titles and all sources.

| Setting | Meaning |
|---|---|
| Locations | places to search from, each with its own radius of 5 to 200 km |
| Search terms | job titles or keywords, one per line; every term is searched at every place |
| Title filter | words that drop a job by its title, and words that keep it anyway |
| Sources | job boards to query |

- **Pins:** A click on the map sets a pin on the nearest town, because the job boards search by place name, not by coordinates. A dragged pin moves to the nearest town where it is dropped. The slider under each place sets its radius, and the circle on the map follows.
- **City search:** The search box lists up to five matching towns, for example the Cambridge in England and the one in the USA. It searches when you press Enter, not while you type, because OpenStreetMap allows one lookup per second.
- **Place names:** The job boards get the name in the place's own language, for example “München” rather than “Munich”.
- **Searches per run:** The window counts the searches a run makes: search terms times places times the sources that cover each place.
- **Saving:** “Save” applies from the next run, “Save and scrape” starts one right away. While a run is going, saving is blocked. Settings without a place, a search term or a source are not saved; the window says why.
- **Broken file:** If `settings.json` cannot be read, the terminal says so and the example search applies until you save again.
- **Command line:** `--sites` replaces the chosen sources for that run. A viewer started with `--sites` uses it for every run it starts.

### Other settings

The remaining settings are constants at the top of `scraper.py`.

| Name | Meaning |
|---|---|
| `RESULTS_PER_SEARCH` | results per search term, place and source |
| `HOURS_OLD` | maximum age of a posting, in hours |
| `KEEP_DAYS` | after how many days an entry is removed |
| `MAX_DETAILS` | maximum number of descriptions loaded per source and run |
| `PORT` | port of the local server |
| `CAREER_OPS_DIR` | folder that contains career-ops |

### Title filter

- Matching ignores case.
- Without an asterisk only the whole word counts: `Lead` does not match “Leadership”.
- With an asterisk part of a word counts too: `*trainee*` matches “Traineeship” and “Graduate-Trainee”.
- The words that keep a job win. With `Junior` among them, “(Junior/Senior) Developer” is kept even though `Senior` is excluded.
- Every word needs a letter or digit; a lone `*` would drop every job.
- The filter also applies to stored jobs: when the viewer starts and when the settings are saved, jobs that no longer pass it are removed. Saved and applied jobs stay visible anyway, see [The viewer](#the-viewer).

### Place lookup

- **Service:** Places are looked up with Nominatim, the free search service of OpenStreetMap. No account is needed. All lookups go through the local server, which names the program and waits at least a second between two lookups, as Nominatim's usage policy requires.
- **Remembered places:** Every answer, including “not found”, is stored in `output/places.json` and not asked again. The 70 or so cities in North Rhine-Westphalia that the project knew before are known from the start.
- **Failing lookups:** A failed lookup is not stored and is tried again next time. If Nominatim refuses requests or three lookups in a row fail, the run asks no more for its remaining searches; jobs whose town is unknown are kept.

## The scraper

- **One job, one entry:** Same title, same company and same city count as the same job, whichever board it came from. This is also how the job ID is built. The links of all boards are collected in that entry. Titles in other scripts, such as Japanese or Cyrillic, get IDs of their own and do not merge.
- **City:** The city of a job is the first part of its location. A location that only names a country, such as “Netherlands”, or only the state of North Rhine-Westphalia counts as no city.
- **Failing source:** If a query fails, the run continues. The error is printed in the terminal.
- **Loading descriptions:** LinkedIn, the Arbeitsagentur, StepStone and Absolventa return no description in their search results. The scraper loads it afterwards, one job at a time, at most twice per job and at most `MAX_DETAILS` jobs per source and run. If a job is listed on several sources, the Arbeitsagentur, StepStone and Absolventa are asked first and LinkedIn last. A posting date found on the job page fills in a missing one.
- **Blocking source:** After five failed requests in a row the scraper leaves that source alone for the rest of the run. The remaining jobs follow on the next run.
- **JobSpy dependency:** Loading LinkedIn descriptions uses an internal JobSpy function, which may change with a library update. If it does, LinkedIn is skipped when loading descriptions and everything else keeps working.
- **Checkpoints:** The data is saved once after the search and again after loading descriptions, so an interrupted run loses no results.
- **Clean-up:** Entries older than `KEEP_DAYS` are removed when the data is loaded.

### Sources

| Name | Website | Countries | Access | Radius | Description |
|---|---|---|---|---|---|
| `indeed` | indeed.com, the site of the place's country | about 70 | JobSpy | the place's radius | in the search results |
| `linkedin` | linkedin.com | all | JobSpy | the place's radius | loaded afterwards |
| `glassdoor` | glassdoor.com, the site of the place's country | about 20 | JobSpy | the place's radius | in the search results |
| `arbeitsagentur` | arbeitsagentur.de | Germany | job search API | the place's radius | loaded afterwards |
| `stepstone` | stepstone.de | Germany | result page | fixed by StepStone, then checked by distance | loaded afterwards |
| `absolventa` | absolventa.de | Germany | result pages | fixed by Absolventa, then checked by distance | loaded afterwards |

- **JobSpy:** Indeed, LinkedIn and Glassdoor are queried through the JobSpy library. Indeed and Glassdoor have one site per country; the scraper uses the site of the place's country and skips the source where JobSpy knows no site. LinkedIn gets the place with its country, for example “Amsterdam, Netherlands”. JobSpy works in miles, so the radius is converted.
- **Germany only:** The Arbeitsagentur (the German Federal Employment Agency), StepStone and Absolventa only list jobs in Germany and are only asked for places in Germany. The settings window shows for each place which of the chosen sources are skipped there.
- **Arbeitsagentur:** The search uses the API behind the job search on arbeitsagentur.de. It is not officially documented and may change. Apprenticeships are excluded.
- **StepStone:** There is no API. The scraper reads the first result page per search term and place, so at most 25 jobs, and only requests addresses without query parameters, as StepStone's `robots.txt` allows. If StepStone changes its page layout, the source returns nothing until `sources.py` is updated. Salaries estimated by StepStone are ignored; only salaries stated by the employer are kept.
- **Absolventa:** A job board for graduates and entry-level jobs. There is no API. The scraper reads the result pages per search term and place, 20 jobs per page, and moves on to the next page only while a page is full and `RESULTS_PER_SEARCH` is not reached. Absolventa sorts by distance and shows no posting date in its results, so `--hours` and `HOURS_OLD` do not apply to it; the date is taken from the job page when its description is loaded. A trailing “...” that some advertisers add to their titles is removed.
- **Distance check:** StepStone and Absolventa search with their own fixed radius. The scraper therefore looks up the town of each of their results, see [Place lookup](#place-lookup), and drops jobs farther from the pin than its radius. A job that names several towns is kept when one of them is inside. Jobs whose town cannot be found are kept.
- **Not included:** Google Jobs currently returns no data through JobSpy, XING requires a login, and Arbeitnow and service.bund.de offer no search and returned very few relevant jobs. Berufsstart.de was tested in October 2026: across all search terms it listed at most 33 jobs nationwide and almost none in the Dortmund, Essen and Düsseldorf area.

## The local server

| Route | Effect |
|---|---|
| `GET /` | viewer |
| `GET /output/jobs.js` | data for the viewer |
| `GET /api/status` | progress of the running scrape |
| `POST /api/scrape` | start a run |
| `GET /api/career-ops` | whether career-ops was found and which jobs were already sent |
| `POST /api/career-ops` | send jobs to career-ops |
| `GET /api/settings` | the search settings, the sources and the countries each source covers |
| `POST /api/settings` | check and save the search settings |
| `GET /api/places?q=…` | towns matching a name |
| `GET /api/places/nearest?lat=…&lon=…` | the town nearest to a point on the map |
| `GET /settings.js`, `GET /vendor/leaflet/…` | the settings window and the map library |

- **Local only:** The server listens on `127.0.0.1` and only accepts requests from its own page. Other websites cannot reach it.
- **One server per port:** If an instance is already running, a second start only opens the browser. On Windows a second server could otherwise bind the same port.
- **Progress bar:** The search and the loading of descriptions each take half of the bar. With `--fast` it belongs to the search alone.

## The viewer

- Views: Open, New in last run, Saved, Applied, Hidden
- Filters by city, search term, source, posting date and remote
- Search in title, company and description
- Light or dark colors, depending on the system setting

| Key | Effect |
|---|---|
| `↑` `↓` or `K` `J` | browse |
| `O` | open the posting |
| `S` | save |
| `B` | mark as applied |
| `X` | hide |
| `C` | send to career-ops |
| `/` | search |

- **Data:** The viewer loads `output/jobs.js` as a script, so `viewer.html` also works when opened as a file. The “Search settings”, “Scrape now” and “Send to career-ops” buttons need the running server, though.
- **Map:** The map images come from the OpenStreetMap tile servers and need an internet connection. They are shown with muted colors, and inverted in dark mode. The keyboard shortcuts are off while the settings window is open.
- **Your marks:** Saved, applied, hidden and read are stored in the browser's localStorage, so they apply to that browser only.
- **Removed jobs:** Saved and applied jobs keep a copy in the browser. They stay visible even after the scraper has removed them after `KEEP_DAYS`. If storage runs full, the copies are kept without descriptions.
- **Next job:** When a job leaves the list because you hid it or applied, the next one is selected.
- **Reload:** After “Show results” the viewer returns to the job you had open.
- **Descriptions:** Descriptions arrive as Markdown from the job boards. The viewer escapes the whole text first and then builds only a fixed set of formatting. HTML inside a posting is therefore shown as text and never executed.

## Sending jobs to career-ops

career-ops scores a job against your CV, writes an adapted CV and keeps track of your applications. Its own scanner does not search Indeed, LinkedIn or Glassdoor.

The “Send to career-ops” button (or “Send all to career-ops” in the Saved view) creates two things per job:

- a file `career-ops/jds/<company>-<title>-<id>.md` with the job's details, its links and the full description
- a line at the end of the “Pending” section of `career-ops/data/pipeline.md` that points to this file

```
- [ ] local:jds/<file> | Company | Title | Location | posted: 2026-10-06
```

career-ops then reads the description locally and does not have to fetch the posting itself.

- **Already sent:** The job ID is part of the file name, which is how the server knows what is already in career-ops. A job is sent only once and carries a “career-ops” tag in the list. Deleting its file in `jds/` makes it sendable again.
- **Content comes from the viewer:** The viewer sends the job itself, not just its ID, so saved jobs can be sent even after the scraper has removed them.
- **Input checks:** The server only accepts entries with a valid ID and a title. All fields are collapsed to one line, and links must start with `http` or `https`.
- **Inbox line:** A `|` in a title or company name would split the line into the wrong columns and is replaced with `/`. Square brackets are escaped. This matches what career-ops does when it writes the inbox itself.
- **Section names:** The inbox section may be called “Pending” (English), “Pendientes” (Spanish) or “Offen” (German). If the file is missing it is created with career-ops' skeleton; if only the section is missing it is added before “Processed”.
- **File names:** German umlauts and ß are transliterated and names are shortened, because Windows paths end at 260 characters.
- **Job without description:** The file then holds the details and links and notes that no description was loaded.
- **No half-written files:** Each file is written next to its target and then moved into place. If writing the inbox fails, the files just created are deleted again; otherwise a job would count as sent without being in the inbox.
- **Missing folder:** If there is no career-ops in `CAREER_OPS_DIR`, nothing is sent and the viewer shows a notice.

## Using career-ops

career-ops has no user interface of its own. You open Claude Code (or a similar AI command-line tool) in the `career-ops/` folder, and it follows the instructions and runs the scripts there. It never submits an application; it prepares it, and you send it yourself.

### Setup

Once, with Node.js 22.13 or newer:

```
cd career-ops
npm install
npm run doctor
```

`npm install` also downloads Chromium, which is needed to create PDFs. `npm run doctor` lists what is still missing.

Your own files that career-ops expects:

| File | Content | Template |
|---|---|---|
| `cv.md` | your CV in Markdown | `examples/cv-example.md` |
| `config/profile.yml` | name, contact details, target roles, salary range | `config/profile.example.yml` |
| `modes/_profile.md` | your priorities for the evaluation | `modes/_profile.template.md` |
| `portals.yml` | companies and searches for the built-in scanner | `templates/portals.example.yml` |

Put existing documents such as your CV as a PDF into `documents/cv/`. `/career-ops intake` reads them and proposes the content for `cv.md`, the profile and `modes/_profile.md`; nothing is written without your confirmation. The `documents/` folder is excluded from Git.

On first start the AI CLI asks for any missing information and creates the files. All paths are relative to `career-ops/`.

### Commands

In Claude Code, in the `career-ops/` folder:

| Command | Effect |
|---|---|
| `/career-ops pipeline` | evaluate everything in the inbox, including jobs sent from JobSearch |
| `/career-ops` followed by a link or job text | evaluate a single job and create a report and a CV |
| `/career-ops oferta` | evaluate only, without a CV |
| `/career-ops ofertas` | compare several jobs |
| `/career-ops pdf` | create a PDF of the CV adapted to a job |
| `/career-ops cover` | draft a cover letter |
| `/career-ops apply` | help fill in an application form |
| `/career-ops tracker` | show and update the application tracker |
| `/career-ops followup` | list and draft due follow-ups |
| `/career-ops deep` | research a company |
| `/career-ops interview-prep` | prepare for an interview |
| `/career-ops scan` | run the built-in scanner over the companies in `portals.yml` |

`/career-ops` on its own shows the full menu. A plain sentence works as well, for example “Evaluate the jobs in the pipeline”.

### Postings in other languages

career-ops ships instructions for several job markets under `modes/<language>/`, for example `modes/de/` for German-language postings, which know terms such as probation period, notice period and collective agreements. Activate them per session with a sentence like:

> From now on use the modes in `modes/de/`.

### Results

| Path | Content |
|---|---|
| `data/pipeline.md` | inbox: pending and processed jobs |
| `jds/` | stored job descriptions, including those from JobSearch |
| `reports/` | evaluation reports, one per job, scored from 1 to 5 |
| `output/` | generated CVs and cover letters |
| `data/applications.md` | application tracker |

These files, your CV and your profile are excluded by career-ops' `.gitignore`. They stay on your machine and never end up in the repository.

### Updating

The built-in career-ops updater only works in its own Git checkout and refuses to run in this folder. To update, clone the original again and replace the folder, keeping your own files from the two tables above.

## Tests

The project has no automated tests. The career-ops test suite is not included in this repository either.

## Third-party code

- The `career-ops/` folder contains the open-source project [career-ops](https://github.com/career-ops-hq/career-ops) by Santiago Fernández de Valderrama, version 1.36.0, under the MIT license, see `career-ops/LICENSE`. Its documentation, images, tests and comments have been removed; the code itself is unchanged. The license files are kept.
- Job boards are queried with the [JobSpy](https://pypi.org/project/python-jobspy/) library (MIT license).
- The map uses [Leaflet](https://leafletjs.com) 1.9.4 (BSD 2-Clause license), stored unchanged in `vendor/leaflet/` together with its license.
- Map images and place data come from [OpenStreetMap](https://www.openstreetmap.org/copyright) (© OpenStreetMap contributors, Open Database License); the map shows this credit. Places are looked up with OpenStreetMap's Nominatim service under its usage policy.

The scraper, the viewer, the search settings and the career-ops integration are this project's own code.
