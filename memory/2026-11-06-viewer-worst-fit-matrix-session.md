---
name: viewer-worst-fit-matrix-session
description: Session 2026-11-06 (v1.157.14-v1.160.0) - picture viewer without the empty gap (hold the old picture, prefetch a whole grid page), Order by Worst fit first, Insights moved into the step-2 Classifier as a confusion matrix in the options pane (ResNet50 only), what is still open
status: current
document_type: memory
session_date: 2026-11-06
---

# Session 2026-11-06 (cloud session, user on the work laptop): viewer, Worst fit first, confusion matrix, v1.157.14 - v1.160.0

Behaviour now: `docs/current-project.md` (section *Confusion matrix*, *Open work*). Per-version details and tests: `docs/changelog.md`.

## Done (one version per commit)
- **v1.157.14** - the Classify picture viewer showed an empty gap between pictures: the `<img>` had `key={frame}` (a new element, blank until loaded) and the Picture edits cut-out is rendered on request and sent `no-cache` with no validator. `FramePane` now keeps the old picture until the next is loaded and decoded; `FrameViewer` preloads neighbours; `pictureCache.ts` holds fetched pictures as blobs.
- **v1.157.15** - the viewer prefetches a whole grid page (up to 160 pictures, nearest first, three requests at a time, a new list replaces the queue, a 404 is not retried, only the four nearest are decoded). The hold logic is off in a DOM without `Image.decode` (the test DOM): the one-render lag made four `FrameViewer` tests intermittent.
- **v1.158.0** - Grid *Order by* gains **Worst fit first**: the bar of the picture's own label (`nearest distance / the label's distance`, the number the card bars show), lowest first; ties go to the larger distance to the label's goldens; unlabeled pictures and goldens last.
- **v1.159.0** - the old Insights page is removed. The confusion matrix became a view of a step-2 Classifier and each cell a **Show entry** of the one Grid (`classify_view.matrix_view_name`), so there is no second card list.
- **v1.160.0** - the matrix is the **first region of the options pane** in every Classify view (Grid, Scatter, Outliers), **ResNet50 only** (`classify_view.MATRIX_METHOD`), read again on Refresh scores, greyed out with a note while the goldens or pictures are newer than the scores, with a hint where it cannot be calculated (ResNet50 off, goldens in one class only, no test pictures, no scores).

## Agreed with the user (his words, short)
- **OK is the positive class.** Labeled OK and the model says NG = false negative; labeled NG and the model says OK = false positive (so a missed defect is his false positive). He asked for the computer-vision terms; the entry names add the plain meaning in brackets so the words cannot mislead.
- Matrix cells are reached only by clicking a cell; the four entries live in the **Show** box (Show = filter; nothing is added to *Order by*), and it must be obvious that a cell was clicked: the Show box names it.
- The Grid is the only card grid code for this; he does not want several grids. The coloured label border stays on the step-2 Classifier only (it is the Grid's own, so the matrix cells get it for free).
- Matrix: ResNet50 only for now; dealing with several methods or computations is for later.
- He wants a design confirmed in words before any code, and codes only on his signal ("go"). When a term is unfamiliar (here *positive class*) he wants it explained in plain words, with his own two-picture example, before a choice is asked.
- Everything valuable must travel with the project in Git (database and the `.gitignore`d files excepted): Claude's chat memory is not read by his Linux Claude Code.

## Open (also in `docs/current-project.md`, *Open work*, newest section)
- Click through v1.157.14-v1.160.0 in a real browser; none of it was clicked through, and the matrix was never run on real ResNet50 scores (tests used the classical method).
- **Deleting modules leaves labels behind.** On 2026-11-06 he deleted every module (Classifiers included) on a camera and a Dedup scatter still showed labels. Deleting a Classifier purges its labels (`labels.purge_feature`), but a Dedup box with no Classifier reads the pseudo-feature `whole-frame` (`dedup_box.label_source`), which no ROI deletion purges; labels set there in earlier versions stay. Not verified on his database. He had all labels of `m13-podvozek-meb-feat-24` removed by hand (backup first). Proposal, not decided: purge `whole-frame` with the last Classifier, or a "Clear all labels" button that shows a count and asks first.
- Matrix for several methods or computations; matrix stored with a frozen version (so a freeze records what its goldens achieved); a server-side cache of rendered viewer pictures and a lighter format than full-size PNG (need the render time measured first).

## How the work was delivered
- Claude's clone is read-only; the user applies the patches with `git am` and pushes. The Stop hook ("N unpushed commits, please push") can only be answered with that fact.
- After the user pushed v1.157.14 and v1.157.15 the clone showed *ahead 4, behind 2*: the same patches under new hashes. Fix: `git rebase --onto origin/main <last duplicate commit> main` (the trees are equal, so it is clean).
- A scratch venv (`pip install -r requirements.txt -r requirements-dev.txt scikit-learn`) runs the whole backend suite in about four minutes (1074 passed, 5 skipped); without `scikit-learn` the dedup API tests fail with `no_sklearn`.
