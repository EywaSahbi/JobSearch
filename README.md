# JobSearch

Scrapes job boards for your search terms and cities, lists the results on a page in your browser, and can pass jobs to [career-ops](https://github.com/career-ops-hq/career-ops), which scores them against your CV.

Everything runs on your machine. No account is needed.

This file is the only documentation of the project, including the bundled `career-ops/` folder. The code has no comments.

## How it works

1. **Collect:** `scraper.py` queries the job boards for every search term and city and merges the results.
2. **Review:** `viewer.html` lists the jobs with filters, a search box and keyboard shortcuts.
3. **Evaluate:** One click sends a job and its description to the career-ops inbox, where it is scored against your CV.

## Getting started

Requires Python 3.10 or newer.

```
pip install python-jobspy
python scraper.py
```

The viewer opens at `http://127.0.0.1:8765`. The “Scrape now” button starts a run; `Ctrl+C` in the terminal stops the server.

| Command | Effect |
|---|---|
| `python scraper.py` | start the viewer |
| `python scraper.py --scrape` | scrape in the terminal only, without the viewer |
| `--hours 24` | only jobs posted in the last 24 hours |
| `--fast` | do not load job descriptions after the search |
| `--sites indeed linkedin` | query only these sources, see [Sources](#sources) for the names |
| `--csv` | with `--scrape`: also write `output/jobs.csv` |
| `--no-open` | do not open the browser |

## Project layout

| Path | Content |
|---|---|
| `scraper.py` | scraper and local server |
| `viewer.html` | viewer, a single file without a build step |
| `sources.py` | sources that do not go through JobSpy |
| `career_ops.py` | sends jobs to career-ops |
| `test_sources.py` | tests for the sources and for loading descriptions |
| `test_career_ops.py` | tests for sending to career-ops and for the server routes |
| `output/jobs.json` | all collected jobs |
| `output/jobs.js` | the same data as a script for the viewer |
| `career-ops/` | career-ops, see [Third-party code](#third-party-code) |

## Configuration

All settings are constants at the top of `scraper.py`. The values that ship with the project are an example; set them to your own search.

| Name | Meaning |
|---|---|
| `SEARCH_TERMS` | job titles or keywords to search for |
| `LOCATIONS` | cities to search from |
| `RADIUS_KM` | search radius around each city |
| `COUNTRY` | country for Indeed and Glassdoor |
| `SITES` | sources to query |
| `RESULTS_PER_SEARCH` | results per search term, city and source |
| `HOURS_OLD` | maximum age of a posting, in hours |
| `KEEP_DAYS` | after how many days an entry is removed |
| `MAX_DETAILS` | maximum number of descriptions loaded per source and run |
| `EXCLUDE_TITLE` | jobs whose title contains one of these words are dropped |
| `KEEP_TITLE` | exception: titles with one of these words are always kept |
| `PORT` | port of the local server |
| `CAREER_OPS_DIR` | folder that contains career-ops |

### Title filter

- Matching ignores case.
- Without an asterisk only the whole word counts: `Lead` does not match “Leadership”.
- With an asterisk part of a word counts too: `*trainee*` matches “Traineeship” and “Graduate-Trainee”.
- `KEEP_TITLE` wins. With `Junior` in it, “(Junior/Senior) Developer” is kept even though `Senior` is excluded.
- The filter also applies to stored jobs: when the viewer starts, jobs that no longer pass it are removed.

## The scraper

- **One job, one entry:** Same title, same company and same city count as the same job, whichever board it came from. This is also how the job ID is built. The links of all boards are collected in that entry.
- **Failing source:** If a query fails, the run continues. The error is printed in the terminal.
- **Loading descriptions:** LinkedIn, the Arbeitsagentur and StepStone return no description in their search results. The scraper loads it afterwards, one job at a time, at most twice per job and at most `MAX_DETAILS` jobs per source and run. If a job is listed on several sources, the Arbeitsagentur and StepStone are asked first and LinkedIn last.
- **Blocking source:** After five failed requests in a row the scraper leaves that source alone for the rest of the run. The remaining jobs follow on the next run.
- **JobSpy dependency:** Loading LinkedIn descriptions uses an internal JobSpy function, which may change with a library update. If it does, LinkedIn is skipped when loading descriptions and everything else keeps working.
- **Checkpoints:** The data is saved once after the search and again after loading descriptions, so an interrupted run loses no results.
- **Clean-up:** Entries older than `KEEP_DAYS` are removed when the data is loaded.

### Sources

| Name in `SITES` | Website | Access | Radius | Description |
|---|---|---|---|---|
| `indeed` | indeed.com, country from `COUNTRY` | JobSpy | `RADIUS_KM` | in the search results |
| `linkedin` | linkedin.com | JobSpy | `RADIUS_KM` | loaded afterwards |
| `glassdoor` | glassdoor.com, country from `COUNTRY` | JobSpy | `RADIUS_KM` | in the search results |
| `arbeitsagentur` | arbeitsagentur.de | job search API | `RADIUS_KM` | loaded afterwards |
| `stepstone` | stepstone.de | result page | fixed by StepStone, then checked against the city table | loaded afterwards |

- **JobSpy:** Indeed, LinkedIn and Glassdoor are queried through the JobSpy library, which supports many countries. It works in miles, so `RADIUS_KM` is converted.
- **Germany only:** The Arbeitsagentur (the German Federal Employment Agency) and StepStone only list jobs in Germany. Remove them from `SITES` when you search elsewhere.
- **Arbeitsagentur:** The search uses the API behind the job search on arbeitsagentur.de. It is not officially documented and may change. Apprenticeships are excluded.
- **StepStone:** There is no API. The scraper reads the first result page per search term and city, so at most 25 jobs, and only requests addresses without query parameters, as StepStone's `robots.txt` allows. If StepStone changes its page layout, the source returns nothing until `sources.py` is updated. Salaries estimated by StepStone are ignored; only salaries stated by the employer are kept.
- **City table:** StepStone searches with its own fixed radius. `sources.py` therefore holds a table of about 70 cities with coordinates and drops results from known cities outside `RADIUS_KM`. Results from cities not in the table are kept. The table covers North Rhine-Westphalia and can be extended for other regions.
- **Not included:** Google Jobs currently returns no data through JobSpy, XING requires a login, and Arbeitnow and service.bund.de offer no search and returned very few relevant jobs.

## The local server

| Route | Effect |
|---|---|
| `GET /` | viewer |
| `GET /output/jobs.js` | data for the viewer |
| `GET /api/status` | progress of the running scrape |
| `POST /api/scrape` | start a run |
| `GET /api/career-ops` | whether career-ops was found and which jobs were already sent |
| `POST /api/career-ops` | send jobs to career-ops |

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

- **Data:** The viewer loads `output/jobs.js` as a script, so `viewer.html` also works when opened as a file. The “Scrape now” and “Send to career-ops” buttons need the running server, though.
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

```
python -m unittest
```

The tests write to a temporary folder and do not touch `career-ops/`. The server tests start the server on a free port and pretend to be its own address, because it rejects other requests.

The source tests use stored sample responses and do not go online.

The career-ops test suite is not included in this repository.

## Third-party code

- The `career-ops/` folder contains the open-source project [career-ops](https://github.com/career-ops-hq/career-ops) by Santiago Fernández de Valderrama, version 1.36.0, under the MIT license, see `career-ops/LICENSE`. Its documentation, images, tests and comments have been removed; the code itself is unchanged. The license files are kept.
- Job boards are queried with the [JobSpy](https://pypi.org/project/python-jobspy/) library (MIT license).

The scraper, the viewer, the career-ops integration and the tests are this project's own code.
