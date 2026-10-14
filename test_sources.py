import contextlib
import io
import json
import unittest
from datetime import datetime, timezone

import scraper
import sources

STOP = datetime(2026, 10, 7, tzinfo=timezone.utc)

BA_SEARCH = {
    "ergebnisliste": [
        {
            "stellenangebotsTitel": "Softwareentwickler*in (m/w/d)",
            "firma": "Lovion GmbH",
            "referenznummer": "10001-1003815201-S",
            "datumErsteVeroeffentlichung": "2026-10-07",
            "arbeitszeitVollzeit": True,
            "arbeitszeitTeilzeitVormittag": True,
            "homeofficemoeglich": True,
            "stellenlokationen": [{"adresse": {"plz": "44263", "ort": "Dortmund", "region": "NORDRHEIN_WESTFALEN"}}],
        },
        {"stellenangebotsTitel": "Ohne Nummer", "firma": "X"},
        {"stellenangebotsTitel": "Ohne Ort", "firma": "Y", "referenznummer": "10000-1-S"},
    ]
}

STEPSTONE_STATE = {
    "searchResults": {
        "items": [
            {
                "id": 1,
                "title": "Softwareentwickler Java (m/w/d)",
                "url": "https://www.stepstone.de/stellenangebote--Java--1-inline.html?rltr=1_1_25",
                "companyName": "Ratbacher GmbH",
                "datePosted": "2026-10-09T08:03:08.51Z",
                "location": "Düsseldorf, Köln, Dortmund",
                "workFromHome": "2",
                "unifiedSalary": {"salaryType": "Predicted", "min": 51000, "max": 73000, "period": "Annually", "currencyIso": "EUR"},
            },
            {
                "id": 2,
                "title": "DevOps Engineer",
                "url": "https://www.stepstone.de/stellenangebote--DevOps--2-inline.html",
                "companyName": "Beispiel AG",
                "datePosted": "2026-10-08T10:00:00Z",
                "location": "Lünen",
                "workFromHome": "0",
                "unifiedSalary": {"salaryType": "Exact", "min": 60000, "max": 70000, "period": "Annually", "currencyIso": "EUR"},
            },
            {
                "id": 3,
                "title": "Zu alt",
                "url": "https://www.stepstone.de/stellenangebote--Alt--3-inline.html",
                "companyName": "Alt GmbH",
                "datePosted": "2026-09-16T10:00:00Z",
                "location": "Dortmund",
                "workFromHome": "0",
            },
        ]
    }
}


def stepstone_page(first_location=None):
    items = [dict(item) for item in STEPSTONE_STATE["searchResults"]["items"]]
    if first_location:
        items[0]["location"] = first_location
    return (
        "<html><head><script>window.__PRELOADED_STATE__ = window.__PRELOADED_STATE__ || {};"
        'window.__PRELOADED_STATE__["app-unifiedResultlist"] = '
        + json.dumps({"searchResults": {"items": items}})
        + ";</script></head><body></body></html>"
    )


STEPSTONE_PAGE = stepstone_page()
STEPSTONE_JOB = (
    '<html><head><script type="application/ld+json">'
    + json.dumps({
        "@type": "JobPosting",
        "title": "Softwareentwickler Java",
        "employmentType": "FULL_TIME",
        "description": "<p>Werden Sie Teil eines <strong>Teams</strong>.</p><ul><li>Java</li><li>Spring</li></ul>",
    })
    + "</script></head><body>viel mehr Seite</body></html>"
)


class AreaTest(unittest.TestCase):
    def test_area_contains_places_within_the_radius(self):
        names = sources.area("Dortmund", 30)

        self.assertTrue(sources.in_area("Bochum", names))
        self.assertTrue(sources.in_area("44263 Dortmund", names))
        self.assertFalse(sources.in_area("Köln", names))
        self.assertFalse(sources.in_area("", names))

    def test_area_matches_short_and_long_forms_of_a_place(self):
        names = sources.area("Essen", 30)

        self.assertTrue(sources.in_area("45468 Mülheim an der Ruhr", names))
        self.assertTrue(sources.in_area("Mülheim", names))

    def test_unknown_location_is_its_own_area(self):
        self.assertTrue(sources.in_area("Kiel", sources.area("Kiel", 30)))

    def test_slug_writes_umlauts_out(self):
        self.assertEqual(sources.slug("IT Support"), "it-support")
        self.assertEqual(sources.slug("Düsseldorf"), "duesseldorf")


class ArbeitsagenturTest(unittest.TestCase):
    def test_rows_carry_the_fields_the_scraper_needs(self):
        row = sources.arbeitsagentur_rows(BA_SEARCH)[0]

        self.assertEqual(row["site"], "arbeitsagentur")
        self.assertEqual(row["title"], "Softwareentwickler*in (m/w/d)")
        self.assertEqual(row["company"], "Lovion GmbH")
        self.assertEqual(row["location"], "Dortmund, Germany")
        self.assertEqual(row["date_posted"], "2026-10-07")
        self.assertEqual(row["job_url"], "https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1003815201-S")
        self.assertEqual(row["job_type"], "fulltime, parttime")
        self.assertTrue(row["is_remote"])

    def test_entries_without_reference_number_are_skipped(self):
        titles = [row["title"] for row in sources.arbeitsagentur_rows(BA_SEARCH)]

        self.assertEqual(titles, ["Softwareentwickler*in (m/w/d)", "Ohne Ort"])

    def test_entry_without_address_has_no_location(self):
        self.assertEqual(sources.arbeitsagentur_rows(BA_SEARCH)[1]["location"], "")

    def test_empty_answer_gives_no_rows(self):
        self.assertEqual(sources.arbeitsagentur_rows({}), [])

    def test_detail_address_encodes_the_reference_number(self):
        url = sources.arbeitsagentur_detail_url("https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1003815201-S")

        self.assertTrue(url.endswith("/v4/jobdetails/MTAwMDEtMTAwMzgxNTIwMS1T"), url)

    def test_rows_fit_the_scraper_record(self):
        row = sources.arbeitsagentur_rows(BA_SEARCH)[0]

        record = scraper.to_record(row, "Softwareentwickler", "2026-10-14T10:00:00")

        self.assertEqual(record["city"], "Dortmund")
        self.assertEqual(record["links"], {"arbeitsagentur": row["job_url"]})
        self.assertIsNone(record["salary"])


class StepstoneTest(unittest.TestCase):
    def rows(self):
        return sources.stepstone_rows(STEPSTONE_PAGE, "Dortmund", STOP)

    def test_address_is_built_from_term_and_location(self):
        self.assertEqual(
            sources.stepstone_url("IT Support", "Düsseldorf"),
            "https://www.stepstone.de/jobs/it-support/in-duesseldorf",
        )

    def test_rows_come_from_the_embedded_result_list(self):
        self.assertEqual([row["title"] for row in self.rows()], ["Softwareentwickler Java (m/w/d)", "DevOps Engineer"])

    def test_row_fields(self):
        row = self.rows()[0]

        self.assertEqual(row["site"], "stepstone")
        self.assertEqual(row["company"], "Ratbacher GmbH")
        self.assertEqual(row["date_posted"], "2026-10-09")
        self.assertEqual(row["job_url"], "https://www.stepstone.de/stellenangebote--Java--1-inline.html")
        self.assertTrue(row["is_remote"])

    def test_searched_city_wins_when_a_job_lists_several(self):
        self.assertEqual(self.rows()[0]["location"], "Dortmund, Germany")
        self.assertEqual(self.rows()[1]["location"], "Lünen, Germany")

    def test_a_city_inside_the_area_wins_when_the_searched_city_is_not_listed(self):
        page = stepstone_page("Köln, Bochum, München")

        row = sources.stepstone_rows(page, "Dortmund", STOP, sources.area("Dortmund", 30))[0]

        self.assertEqual(row["location"], "Bochum, Germany")

    def test_jobs_in_a_known_city_outside_the_area_are_dropped(self):
        page = stepstone_page("Köln")

        rows = sources.stepstone_rows(page, "Dortmund", STOP, sources.area("Dortmund", 30))

        self.assertEqual([row["title"] for row in rows], ["DevOps Engineer"])

    def test_jobs_in_an_unknown_city_are_kept(self):
        page = stepstone_page("Kleinkleckersdorf")

        rows = sources.stepstone_rows(page, "Dortmund", STOP, sources.area("Dortmund", 30))

        self.assertEqual(rows[0]["location"], "Kleinkleckersdorf, Germany")

    def test_only_stated_salaries_are_kept(self):
        guessed, stated = self.rows()

        self.assertIsNone(guessed.get("min_amount"))
        self.assertEqual((stated["min_amount"], stated["max_amount"], stated["currency"], stated["interval"]), (60000, 70000, "EUR", "yearly"))

    def test_page_without_result_list_gives_no_rows(self):
        self.assertEqual(sources.stepstone_rows("<html></html>", "Dortmund", STOP), [])

    def test_description_comes_from_the_structured_data_as_markdown(self):
        fields = sources.stepstone_fields(STEPSTONE_JOB)

        self.assertIn("**Teams**", fields["description"])
        self.assertIn("Java", fields["description"])
        self.assertNotIn("<li>", fields["description"])
        self.assertEqual(fields["job_type"], "fulltime")

    def test_job_page_without_structured_data_gives_nothing(self):
        self.assertEqual(sources.stepstone_fields("<html></html>"), {})


class ScraperTest(unittest.TestCase):
    def setUp(self):
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def test_search_hands_known_sources_to_their_own_function(self):
        calls = []
        original = dict(sources.SEARCH)
        self.addCleanup(lambda: (sources.SEARCH.clear(), sources.SEARCH.update(original)))
        sources.SEARCH["arbeitsagentur"] = lambda *args: calls.append(args) or [{"title": "T"}]

        rows = scraper.search("arbeitsagentur", "DevOps", "Essen", 48)

        self.assertEqual(rows, [{"title": "T"}])
        self.assertEqual(calls, [("DevOps", "Essen", scraper.RADIUS_KM, 48, scraper.RESULTS_PER_SEARCH)])

    def test_salaries_are_written_in_english(self):
        self.assertEqual(scraper.salary_of({"min_amount": 50000, "max_amount": 60000, "interval": "yearly"}), "50,000 – 60,000 EUR / year")
        self.assertEqual(scraper.salary_of({"min_amount": 15, "currency": "USD", "interval": "hourly"}), "15 USD / hour")

    def test_jobs_without_title_get_an_english_placeholder(self):
        record = scraper.to_record({"site": "indeed", "job_url": "https://x"}, "DevOps", "2026-10-14T10:00:00")

        self.assertEqual(record["title"], "(untitled)")

    def test_new_sources_are_scraped_by_default(self):
        for site in ("arbeitsagentur", "stepstone"):
            self.assertIn(site, scraper.SITES)
            self.assertIn(site, sources.SEARCH)

    def test_only_working_sources_are_offered(self):
        self.assertEqual(sorted(sources.SEARCH), ["arbeitsagentur", "stepstone"])
        self.assertEqual(scraper.SITES, ["indeed", "linkedin", "glassdoor", "arbeitsagentur", "stepstone"])

    def job(self, number, site="arbeitsagentur", **extra):
        return {"id": f"id{number}", "title": f"Job {number}", "links": {site: f"https://example.com/{number}"}, "description": None, **extra}

    def test_details_fill_missing_descriptions(self):
        db = {"a": self.job(1), "b": self.job(2, description="schon da")}
        seen = []

        def load(url):
            seen.append(url)
            return {"description": "neu", "job_type": "fulltime"}

        scraper.fetch_details(db, {"arbeitsagentur": load}, 10, pause=0)

        self.assertEqual(seen, ["https://example.com/1"])
        self.assertEqual((db["a"]["description"], db["a"]["job_type"]), ("neu", "fulltime"))
        self.assertEqual(db["b"]["description"], "schon da")

    def test_details_respect_the_limit_per_source(self):
        db = {str(n): self.job(n) for n in range(5)}
        db["s"] = self.job(9, site="stepstone")

        scraper.fetch_details(db, {"arbeitsagentur": lambda url: {"description": "x"}, "stepstone": lambda url: {"description": "y"}}, 2, pause=0)

        self.assertEqual(sum(1 for job in db.values() if job["description"] == "x"), 2)
        self.assertEqual(db["s"]["description"], "y")

    def test_details_give_up_on_a_job_after_two_tries(self):
        db = {"a": self.job(1, detail_tries=2)}
        calls = []

        scraper.fetch_details(db, {"arbeitsagentur": lambda url: calls.append(url)}, 10, pause=0)

        self.assertEqual(calls, [])

    def test_details_stop_asking_a_source_that_keeps_failing(self):
        db = {str(n): self.job(n) for n in range(8)}
        db["s"] = self.job(9, site="stepstone")
        calls = []

        def broken(url):
            calls.append(url)
            raise RuntimeError("gesperrt")

        scraper.fetch_details(db, {"arbeitsagentur": broken, "stepstone": lambda url: {"description": "y"}}, 10, pause=0)

        self.assertEqual(len(calls), 5)
        self.assertEqual(db["s"]["description"], "y")
        self.assertTrue(all(job.get("detail_tries", 0) == 0 for key, job in db.items() if key != "s"))

    def test_details_use_the_first_source_that_can_load_a_job(self):
        db = {"a": {**self.job(1, site="linkedin"), "links": {"linkedin": "https://l/1", "stepstone": "https://s/1"}}}
        calls = []
        loaders = {
            "stepstone": lambda url: calls.append(url) or {"description": "von StepStone"},
            "linkedin": lambda url: calls.append(url) or {"description": "von LinkedIn"},
        }

        scraper.fetch_details(db, loaders, 10, pause=0)

        self.assertEqual(calls, ["https://s/1"])
        self.assertEqual(db["a"]["description"], "von StepStone")


if __name__ == "__main__":
    unittest.main()
