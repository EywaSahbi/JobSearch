"""Tests für career_ops.py.

    python -m unittest
"""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import career_ops
import scraper

JOB = {
    "id": "5161b3ea8000",
    "title": "Frontend / UX / UI Engineer (m/w/d)",
    "company": "ITS Informationstechnik Service GmbH",
    "city": "Dortmund",
    "location": "Dortmund, NW, Germany",
    "date_posted": "2026-10-06",
    "job_type": "fulltime",
    "job_level": None,
    "is_remote": False,
    "salary": "50.000 – 60.000 EUR / Jahr",
    "description": "#### Deine Aufgaben\n\n- React\n- TypeScript",
    "links": {
        "indeed": "https://de.indeed.com/viewjob?jk=52849898160a8bc9",
        "linkedin": "https://www.linkedin.com/jobs/view/4474054206",
    },
    "terms": ["Software Engineer"],
    "first_seen": "2026-10-09T22:49:06",
}
JD_NAME = "its-informationstechnik-service-gmbh-frontend-ux-ui-engineer-m-w-d-5161b3ea8000.md"
TODAY = "2026-10-10"


class CareerOpsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "modes").mkdir()
        (self.root / "package.json").write_text("{}", encoding="utf-8")

    def pipeline(self):
        return (self.root / "data" / "pipeline.md").read_text(encoding="utf-8")

    def pending_lines(self):
        return [line for line in self.pipeline().splitlines() if line.startswith("- [ ]")]

    def test_send_writes_the_description_into_a_jds_file(self):
        career_ops.send(self.root, [JOB], TODAY)

        files = list((self.root / "jds").iterdir())
        self.assertEqual([f.name for f in files], [JD_NAME])
        text = files[0].read_text(encoding="utf-8")
        self.assertIn("# Frontend / UX / UI Engineer (m/w/d) — ITS Informationstechnik Service GmbH", text)
        self.assertIn("- React\n- TypeScript", text)
        self.assertIn("https://de.indeed.com/viewjob?jk=52849898160a8bc9", text)
        self.assertIn("https://www.linkedin.com/jobs/view/4474054206", text)
        self.assertIn("50.000 – 60.000 EUR / Jahr", text)

    def test_send_adds_a_pending_line_that_points_at_the_jds_file(self):
        career_ops.send(self.root, [JOB], TODAY)

        line = (
            f"- [ ] local:jds/{JD_NAME} | ITS Informationstechnik Service GmbH"
            " | Frontend / UX / UI Engineer (m/w/d) | Dortmund, NW, Germany | posted: 2026-10-06"
        )
        self.assertEqual(self.pending_lines(), [line])
        text = self.pipeline()
        self.assertLess(text.index("## Pending"), text.index(line))
        self.assertLess(text.index(line), text.index("## Processed"))

    def test_send_returns_the_ids_it_sent(self):
        self.assertEqual(career_ops.send(self.root, [JOB], TODAY), ["5161b3ea8000"])

    def test_sent_ids_lists_jobs_that_are_already_in_career_ops(self):
        self.assertEqual(career_ops.sent_ids(self.root), set())

        career_ops.send(self.root, [JOB], TODAY)

        self.assertEqual(career_ops.sent_ids(self.root), {"5161b3ea8000"})

    def test_sending_a_job_twice_adds_it_only_once(self):
        career_ops.send(self.root, [JOB], TODAY)

        self.assertEqual(career_ops.send(self.root, [JOB], TODAY), [])
        self.assertEqual(len(self.pending_lines()), 1)

    def test_job_without_company_description_and_links_is_still_sent(self):
        career_ops.send(self.root, [{"id": "aaaaaaaaaaaa", "title": "IT Support"}], TODAY)

        self.assertEqual(self.pending_lines(), ["- [ ] local:jds/it-support-aaaaaaaaaaaa.md | Firma unbekannt | IT Support"])
        text = (self.root / "jds" / "it-support-aaaaaaaaaaaa.md").read_text(encoding="utf-8")
        self.assertIn("keine Beschreibung geladen", text)

    def test_pipes_and_line_breaks_cannot_split_the_pending_line(self):
        job = {**JOB, "title": "DevOps | Cloud\nEngineer [m/w/d]", "company": "A|B"}

        career_ops.send(self.root, [job], TODAY)

        (line,) = self.pending_lines()
        self.assertEqual(line.split(" | ")[1:3], ["A/B", "DevOps / Cloud Engineer \\[m/w/d\\]"])

    def test_posted_is_only_written_for_a_real_date(self):
        career_ops.send(self.root, [{**JOB, "date_posted": "gestern | note: x"}], TODAY)

        (line,) = self.pending_lines()
        self.assertTrue(line.endswith("| Dortmund, NW, Germany"), line)

    def test_entries_without_a_valid_id_are_skipped(self):
        bad = [{**JOB, "id": "../../../evil"}, {**JOB, "id": None}, {**JOB, "title": ""}, "kein Job", None]

        self.assertEqual(career_ops.send(self.root, bad, TODAY), [])
        self.assertEqual(career_ops.sent_ids(self.root), set())
        self.assertFalse((self.root / "data" / "pipeline.md").exists())

    def test_long_titles_give_short_file_names(self):
        career_ops.send(self.root, [{**JOB, "title": "Sehr langer Titel " * 30}], TODAY)

        (name,) = [f.name for f in (self.root / "jds").iterdir()]
        self.assertLessEqual(len(name), 100)
        self.assertTrue(name.endswith("-5161b3ea8000.md"), name)

    def test_new_lines_go_to_the_end_of_an_existing_german_inbox(self):
        inbox = self.root / "data" / "pipeline.md"
        inbox.parent.mkdir()
        inbox.write_text(
            "# Pipeline\n\n## Offen\n- [ ] https://example.com/a\n\n"
            "## Verarbeitet\n- [x] #001 | https://example.com/b | Acme | Dev | 4.0/5 | PDF ✅\n",
            encoding="utf-8",
        )

        career_ops.send(self.root, [JOB, {"id": "aaaaaaaaaaaa", "title": "IT Support"}], TODAY)

        self.assertEqual(
            self.pipeline(),
            "# Pipeline\n\n## Offen\n- [ ] https://example.com/a\n"
            f"- [ ] local:jds/{JD_NAME} | ITS Informationstechnik Service GmbH"
            " | Frontend / UX / UI Engineer (m/w/d) | Dortmund, NW, Germany | posted: 2026-10-06\n"
            "- [ ] local:jds/it-support-aaaaaaaaaaaa.md | Firma unbekannt | IT Support\n\n"
            "## Verarbeitet\n- [x] #001 | https://example.com/b | Acme | Dev | 4.0/5 | PDF ✅\n",
        )

    def test_inbox_without_a_pending_section_gets_one_before_processed(self):
        inbox = self.root / "data" / "pipeline.md"
        inbox.parent.mkdir()
        inbox.write_text("# Pipeline\n\n## Processed\n- [x] #001 | https://example.com/b\n", encoding="utf-8")

        career_ops.send(self.root, [{"id": "aaaaaaaaaaaa", "title": "IT Support"}], TODAY)

        self.assertEqual(
            self.pipeline(),
            "# Pipeline\n\n## Pending\n\n"
            "- [ ] local:jds/it-support-aaaaaaaaaaaa.md | Firma unbekannt | IT Support\n\n"
            "## Processed\n- [x] #001 | https://example.com/b\n",
        )

    def test_failed_inbox_write_leaves_no_job_marked_as_sent(self):
        (self.root / "data" / "pipeline.md").mkdir(parents=True)  # lässt sich nicht als Datei schreiben

        with self.assertRaises(OSError):
            career_ops.send(self.root, [JOB], TODAY)

        self.assertEqual(career_ops.sent_ids(self.root), set())

    def test_is_ready_only_for_a_career_ops_folder(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertFalse(career_ops.is_ready(Path(empty)))
        self.assertFalse(career_ops.is_ready(self.root / "gibt-es-nicht"))
        self.assertTrue(career_ops.is_ready(self.root))


class ServerTest(unittest.TestCase):
    """Die Routen /api/career-ops des lokalen Servers aus scraper.py."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "modes").mkdir()
        (self.root / "package.json").write_text("{}", encoding="utf-8")
        self.serve(self.root)

    def serve(self, career_ops_dir):
        handler = type("TestHandler", (scraper.Handler,), {"career_ops_dir": career_ops_dir})
        self.server = scraper.Server(("127.0.0.1", 0), handler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def call(self, method, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        self.addCleanup(conn.close)
        # der Server lässt nur Anfragen an seine eigene Adresse zu
        conn.request(method, "/api/career-ops", body=body, headers={"Host": f"127.0.0.1:{scraper.PORT}"})
        res = conn.getresponse()
        text = res.read().decode("utf-8")
        return res.status, json.loads(text) if res.status == 200 else None

    def test_status_lists_the_jobs_already_sent(self):
        self.assertEqual(self.call("GET"), (200, {"ready": True, "sent": []}))

        career_ops.send(self.root, [JOB], TODAY)

        self.assertEqual(self.call("GET"), (200, {"ready": True, "sent": ["5161b3ea8000"]}))

    def test_status_says_when_career_ops_is_missing(self):
        self.serve(self.root / "gibt-es-nicht")

        self.assertEqual(self.call("GET"), (200, {"ready": False, "sent": []}))

    def test_post_puts_the_jobs_into_the_inbox(self):
        status, data = self.call("POST", json.dumps({"jobs": [JOB]}))

        self.assertEqual(status, 200)
        self.assertEqual(data, {"ready": True, "sent": ["5161b3ea8000"], "new": ["5161b3ea8000"], "error": None})
        inbox = (self.root / "data" / "pipeline.md").read_text(encoding="utf-8")
        self.assertIn(f"- [ ] local:jds/{JD_NAME} | ", inbox)

    def test_post_without_a_job_list_is_rejected(self):
        for body in ("kein JSON", "[]", '{"jobs": 5}'):
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", body)[0], 400)

    def test_post_sends_nothing_when_career_ops_is_missing(self):
        self.serve(self.root / "gibt-es-nicht")

        status, data = self.call("POST", json.dumps({"jobs": [JOB]}))

        self.assertEqual((status, data["ready"], data["new"]), (200, False, []))
        self.assertFalse((self.root / "gibt-es-nicht").exists())

    def test_post_reports_a_failed_write(self):
        (self.root / "data" / "pipeline.md").mkdir(parents=True)  # lässt sich nicht als Datei schreiben

        status, data = self.call("POST", json.dumps({"jobs": [JOB]}))

        self.assertEqual((status, data["new"], data["sent"]), (200, [], []))
        self.assertTrue(data["error"])


if __name__ == "__main__":
    unittest.main()
