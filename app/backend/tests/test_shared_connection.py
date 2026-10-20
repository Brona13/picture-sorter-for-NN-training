from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

import config
import db


class SharedConnectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="picture-sorter-shared-con-")
        root = Path(self.tmp.name)
        self.old = (config.DATA_DIR, config.CAMERAS_ROOT)
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"

    def tearDown(self) -> None:
        config.DATA_DIR, config.CAMERAS_ROOT = self.old
        self.tmp.cleanup()

    def test_one_connection_serves_every_connect_in_the_block(self):
        with db.shared_connection():
            first = db.connect()
            first.close()
            second = db.connect()
            self.assertIs(first, second)
            db.set_setting("cam", "k", "v")
            self.assertEqual(db.get_setting("cam", "k"), "v")
        self.assertIsNot(db.connect(), first)

    def test_close_does_not_end_the_shared_connection(self):
        with db.shared_connection():
            db.connect().close()
            self.assertEqual(db.get_setting("cam", "missing", "d"), "d")

    def test_close_drops_unsaved_work(self):
        with db.shared_connection():
            con = db.connect()
            con.execute("INSERT INTO settings(camera,key,value) VALUES('cam','x','1')")
            con.close()
            self.assertIsNone(db.get_setting("cam", "x"))

    def test_committed_work_survives_after_the_block(self):
        with db.shared_connection():
            db.set_setting("cam", "k", "v")
        self.assertEqual(db.get_setting("cam", "k"), "v")

    def test_other_threads_get_their_own_connection(self):
        seen: list[object] = []
        with db.shared_connection():
            mine = db.connect()

            def work() -> None:
                con = db.connect()
                seen.append(con)
                con.close()

            t = threading.Thread(target=work)
            t.start()
            t.join()
        self.assertEqual(len(seen), 1)
        self.assertIsNot(seen[0], mine)

    def test_nested_blocks_share_the_outer_connection(self):
        with db.shared_connection():
            outer = db.connect()
            with db.shared_connection():
                self.assertIs(db.connect(), outer)
            self.assertIs(db.connect(), outer)


if __name__ == "__main__":
    unittest.main()
