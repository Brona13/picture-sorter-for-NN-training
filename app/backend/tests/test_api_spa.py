from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import create_app


class SpaServingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="picture-sorter-dist-")
        dist = Path(self.tmp.name) / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<html>app</html>")
        (dist / "assets" / "app.js").write_text("console.log(1)")
        (Path(self.tmp.name) / "secret.txt").write_text("outside dist")
        self._old = os.environ.get("CURATION_FRONTEND_DIST")
        os.environ["CURATION_FRONTEND_DIST"] = str(dist)
        self.client = TestClient(create_app())

    def tearDown(self) -> None:
        if self._old is None:
            os.environ.pop("CURATION_FRONTEND_DIST", None)
        else:
            os.environ["CURATION_FRONTEND_DIST"] = self._old
        self.tmp.cleanup()

    def test_root_and_client_routes_get_index(self) -> None:
        for path in ("/", "/classify", "/roi", "/some/deep/link"):
            r = self.client.get(path)
            self.assertEqual((r.status_code, r.text), (200, "<html>app</html>"), path)

    def test_real_assets_are_served(self) -> None:
        r = self.client.get("/assets/app.js")
        self.assertEqual((r.status_code, r.text), (200, "console.log(1)"))

    def test_unknown_api_paths_are_json_404_not_index(self) -> None:
        r = self.client.get("/api/nope")
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("<html>", r.text)
        self.assertEqual(self.client.get("/api/health").json(), {"status": "ok"})

    def test_cannot_escape_the_dist_directory(self) -> None:
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"):
            self.assertNotIn("outside dist", self.client.get(path).text, path)

    def test_no_frontend_build_means_api_only(self) -> None:
        os.environ["CURATION_FRONTEND_DIST"] = str(Path(self.tmp.name) / "missing")
        client = TestClient(create_app())
        self.assertEqual(client.get("/api/health").status_code, 200)
        self.assertEqual(client.get("/").status_code, 404)
