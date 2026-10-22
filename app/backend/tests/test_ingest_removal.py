"""Pictures removed at Ingest are hidden in every module, even the bin; nothing is deleted."""
from __future__ import annotations

import datamodel
import db
import ingest
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camR"


class IngestRemovalTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 4)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1)])
        for f in self.frames[:3]:
            labels.set_label(CAM, "seal", f, "OK")
        self.base = f"/api/cameras/{CAM}/ingest"

    def test_the_overview_has_a_size_and_a_time_for_every_picture(self) -> None:
        rows = self.client.get(f"{self.base}/overview").json()["frames"]
        self.assertEqual(sorted(r["frame"] for r in rows), sorted(self.frames))
        self.assertTrue(all(r["width"] and r["height"] and r["created"] and r["removed"] is False for r in rows))

    def test_a_removed_picture_vanishes_from_the_modules_but_stays_on_disk_with_its_label(self) -> None:
        gone = self.frames[0]
        r = self.client.post(f"{self.base}/remove", json={"frames": [gone]})
        self.assertEqual(r.json(), {"removed": 1})
        self.assertNotIn(gone, [p.name for p in datamodel.list_unsorted(CAM)])
        self.assertIn(gone, [p.name for p in datamodel.list_unsorted(CAM, include_removed=True)])
        self.assertTrue((datamodel.unsorted_dir(CAM) / gone).exists())  # the source frame is untouched
        self.assertNotIn(gone, labels.current_labels(CAM, "seal"))  # counts, exports and versions do not see it
        self.assertNotIn(gone, db.deleted_frames_of(CAM))  # and it is not in the bin either
        self.assertNotIn(gone, [x["frame"] for x in self.client.get(f"{self.base}/frames").json()["frames"]])
        self.assertEqual(self.client.post(f"{self.base}/bring-back", json={"frames": [gone]}).json(), {"restored": 1})
        self.assertEqual(labels.current_labels(CAM, "seal")[gone], "OK")  # the label came back with it

    def test_keep_only_removes_every_other_picture_in_use(self) -> None:
        r = self.client.post(f"{self.base}/keep-only", json={"frames": self.frames[:1]})
        self.assertEqual(r.json(), {"removed": 3})
        self.assertEqual([p.name for p in datamodel.list_unsorted(CAM)], self.frames[:1])

    def test_unknown_pictures_are_refused(self) -> None:
        self.assertEqual(self.client.post(f"{self.base}/remove", json={"frames": ["nope.png"]}).status_code, 404)

    def test_a_catalog_rebuild_keeps_the_removal_and_the_sizes(self) -> None:
        self.client.get(f"{self.base}/overview")
        self.client.post(f"{self.base}/remove", json={"frames": [self.frames[1]]})
        ingest.rebuild_index(CAM)
        rows = {r["frame"]: r for r in db.frame_rows(CAM)}
        self.assertIsNotNone(rows[self.frames[1]]["removed"])
        self.assertTrue(rows[self.frames[0]]["width"])
