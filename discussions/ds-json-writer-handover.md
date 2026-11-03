\---

name: ds-json-writer-handover

description: Handover for building the writer that turns Picture Sorter step-2 export data into the downstream system's (DS) import zip (datasetCollection.json + picture folder). What was tested with the real DS, the format, decisions, plan, open items.

status: current

document\_type: handover

session\_date: 2026-11-03

base\_version: v1.147.0

\---



\# Handover: DS import writer (2026-11-03)



\*\*Nothing of the writer is built.\*\* No code was changed in this session. The user asks for it as the next piece of work; wait for his "go" if he has not said it in the new session. The format below was reverse-engineered from real DS exports, and one hand-edited file was imported successfully.



\## 1. Goal

\- The DS is a ResNet-based detector the user trains by hand-drawing one \*\*upright\*\* rectangle with a class (OK / NG) per picture. He believed it could not import boxes.

\- \*\*It can.\*\* DS exports and imports a zip with `datasetCollection.json` (boxes + classes) plus a picture folder. So Step 2 of the app (Box module, goldens) can write that zip, and he stops drawing rectangles by hand.

\- The writer must produce a zip he can import into a fresh DS project in one step.



\## 2. Repo state (read this first)

\- Repo: `Brona13/picture-sorter-for-NN-training` (public). Claude's clone is read-only; changes go out as a patch.

\- At the time of writing: \*\*v1.147.0\*\*, code head `2cb6e82`, docs head `afe0ea2` (2026-11-02). Read `CLAUDE.md`, `docs/current-project.md`, `README.md` section "Two steps", `plans/two-step-solution.md`, `memory/2026-11-02-two-step-solution-session.md`.

\- Step 2 already has: Ingest OK/NG, \*\*Box\*\* (`box\_module.py`), Classifier (goldens, Mute), \*\*Export\*\* (v1.146.0, `export\_box.py`, `versions.py`). The Export writes folders `OK` and `NG` with the originals of the goldens, plus `boxes.csv` (`versions.\_write\_rectangles`, rectangle numbers frozen with the version, layouts `corners` x1,y1,x2,y2 or `size` x,y,width,height; `export\_box.BOX\_FORMATS`).

\- The user said `boxes.csv` is of no use to him in that form. His Windows laptop may not have v1.146+ yet (needs `git pull --ff-only`, restart, and a `frontend-dist-vX.Y.Z.zip`, not built so far).

\- Not seen on real pictures yet: Box cut-outs, scores, Export on his real camera.



\## 3. DS file format (observed; all \[Certain] unless marked)

Zip layout: `datasetCollection.json` and one folder side by side at the zip root. The folder name is the sub-dataset `Name` (the user chose `200` in the export dialog). The user unzipped his export; I never saw the folder listing.



Top-level JSON keys (compact JSON, no spaces; keep this key order \[Likely safest]):

\- `Name`, `Note`, `NormalizedName` (upper-case of Name), `AvatarImage` (base64 PNG, an Axis logo placeholder, same string in every sample), `Tags` (\[]),

\- `ObjectDetectionLabelDefinitions`: object keyed by class ID (as string). Each entry: `NodeId`, `Name`, `Note` (same as Name), `NormalizedName` (upper-case), `AvatarImage` (base64 PNG, same Axis placeholder), `LabelDefinitionScope: 1`, `Tags: \[]`, `RChannel`, `GChannel`, `BChannel`, `DatasetNodeId: null`.

\- `SegmentationLabelDefinitions: {}`, `ClassificationLabelDefinitions: {}`,

\- `ObjectDetectionArchiveDatasets`: a list with one dataset: `Images`, `NodeId`, `NormalizedName`, `Name`, `Note`, `Tags`, `AvatarImage` (base64 \*\*JPEG\*\*, a small picture),

\- `SegmentationArchiveDatasets: \[]`, `ClassificationArchiveDatasets: \[]`.



Each image: `LabelObjectDetectionBoundingBoxes` (list), `Name`, `NormalizedName`, `FolderPath`, `Type: 17`, `Storage: 2`, `Width`, `Height`.

\- `Name` has no file extension. Picture file on disk is probably `<Name>.jpg` \[Likely; the uploaded files were `.jpg` and the first export's `Name` equalled their stems].

\- `FolderPath` was `ObjectDetectionArchiveDatasetImages/1540` while the zip folder was `200`, and the import worked, so DS \*\*ignores FolderPath\*\* \[Likely]. Copy the pattern.



Each box: `{"X1","X2","Y1","Y2","LabelDefinitionNodeId"}`, integers.

\- \*\*Absolute pixels, top-left origin, upright only\*\* (no angle field).

\- \*\*Maximum is 199 for a 200 px picture\*\* (0-based indices, i.e. width-1 / height-1). A box dragged to the corner exported `X2:199, Y2:199`. Whether 200 is accepted is untested, so \*\*clamp to 0..W-1 and 0..H-1\*\* \[Likely].

\- A picture with no box is listed with an empty box list. A picture can have several boxes with different classes.



Colours seen: NG RGB(244,67,54), OK RGB(6,229,43), test RGB(32,84,238).



\## 4. What the real DS tests showed

Sample: 7 pictures, 200x200 px, classes NG, OK, test (created in that order), boxes at corners and extremes, one picture with two classes, one without boxes.

\- \*\*Round trip with a hand-edited JSON works.\*\* One box (test class, picture `...15.10.2026 05.55.27`) was changed from X1 72 / X2 137 to 102 / 167 and re-zipped; the box moved 30 px right, everything else was intact. So DS reads absolute pixels as described.

\- \*\*DS renames on import:\*\* `Name` becomes a UUID, picture IDs and class IDs are renumbered (1957-1959 became 1960-1962; dataset 1540 became 1541). Consequence: the writer may choose its own IDs \[Likely], but a DS export \*\*cannot be matched back to original file names\*\*. The app keeps its own mapping (the frozen version).

\- The order of images in the JSON was kept, the DS grid shows another order. Never match by order or ID.

\- The long original names with spaces and dots (`3120264030138\_\_01\_M13-podvozek\_PEAQ\_LZ\_naprava-sroub\_2-ANO\_MB\_M13\_PODVOZEK\_B\_2\_15.10.2026 05.55.27`) were accepted.



\## 5. Not tested (do not assume)

\- Whether the `AvatarImage` fields are optional (test: set them to `""`, first dataset-level, then classes). If the writer needs them, copy the strings from a real export; the sample JSON files are not in the repo, so the user must attach one (see 8).

\- Folder file names and extension inside `200` (assumed `<Name>.jpg`).

\- `X2 = 200` (avoided by clamping), picture sizes other than 200x200, PNG pictures, several products.

\- Import of a file produced by the writer. This is the real test; do it first.



\## 6. Decisions by the user

\- Build \*\*option A\*\*: a new export layout on the step-2 \*\*Export page\*\*, next to what exists. It writes the zip from the frozen version.

\- \*\*Fields the user fills in:\*\*

&#x20; 1. Dataset name (`Name` and `Note` of the collection; default camera name, e.g. `200\_M13\_podvozek\_test`).

&#x20; 2. Picture folder name (sub-dataset `Name`/`Note` and the zip folder; default `200` or the camera name).

&#x20; 3. Class names: one for the OK dot, one for the NG dot. \*\*Default `OK` and `NG`.\*\* Decided: plain OK / NG for now, no product prefixes (product + class, e.g. `ProductA\_OK`, may come later).

&#x20; 4. Class colours, optional (defaults as in 3 above).

&#x20; 5. Pictures without a rectangle: include with an empty list or leave out. Default: leave out.

&#x20; 6. Zip file name. Default dataset name plus version number.

\- \*\*Taken from the app, not asked:\*\* originals of the goldens (as today's Export), rectangles from the frozen Box numbers (clamped), width/height read from each picture, fixed values `Type:17`, `Storage:2`, `LabelDefinitionScope:1`, generated IDs, avatars.

\- \*\*Left out on purpose:\*\* tags and notes per picture (untestable, would be guesses).

\- `boxes.csv` stays as it is or may be dropped; the user has no use for it. Do not spend work on it.



\## 7. Suggested plan

1\. Read the Export code (`export\_box.py`, `versions.py` export, the Export page in `views/`), the frozen `rectangles` data and `plans/two-step-solution.md`.

2\. Add one backend module for the DS layout (own file, pure function: frozen rows + picture list + field values in, zip out). Write a unit test that builds the 7-picture sample and compares the JSON structure with the real export (keys, order, types, clamping).

3\. Add the layout and the fields to the Export page; check that the Export refuses with a clear message when a picture has no rectangle and the option says so.

4\. Docs: entry in `docs/current-project.md`, README "Two steps", `docs/data-model.md` if a rule changes. Bump `app/backend/appinfo.py`.

5\. Deliver `picture-sorter-vX.Y.Z.patch` and, because the frontend changes, `frontend-dist-vX.Y.Z.zip`. Say plainly what was not clicked through in a real browser or imported into DS.

6\. User test: import the produced zip into a \*\*fresh\*\* DS project; paste any error. Then the avatar test if wanted.



\## 8. Working with this user

\- Short answers, no praise openers, one question at a time; he asks "what should I test" style questions and wants numbered steps. State the deciding point first. Rate claims \[Certain] / \[Likely] / \[Guessing].

\- He applies, commits and pushes patches himself (Claude never pushes; the "unpushed commits" hook message is expected). Windows laptop: no npm, so the frontend dist zip is mandatory when frontend code changes.

\- Standing rules: bump the version every code change; patch and zip names carry the version; docs-only changes ride with the next code patch; use a temporary camera root for tests (`CURATION\_CAMERAS\_ROOT`, `CURATION\_DATA\_DIR`), never the real data.

\- He gets annoyed when asked for something he already gave. Search the conversation first. He already gave: the 7 original file names (all `.jpg`, long names with spaces and dots) and the JSON of two exports.

\- \*\*Attach in the new session\*\* (the files only exist in this conversation): `datasetCollection.json` of the first export (original names, class IDs 1957-1959) and of the re-export (UUID names, box at 199). The avatar strings are in both.

