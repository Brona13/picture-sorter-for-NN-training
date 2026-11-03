---
name: dataset-collection
description: Plan for the Models section - combine frozen step-2 datasets of several cameras into one DS dataset collection (zip), saved as a named model object with a build per round. Phase 1 only in detail.
status: agreed 2026-11-03, nothing built
document_type: plan
last_updated: 2026-11-03
---

# Dataset collection (Models section): plan (agreed with the user 2026-11-03, nothing built)

## Context
- The downstream system (DS, a ResNet Faster R-CNN detector trainer) can train one model on several datasets. The app so far writes one DS zip per camera (`ds_export.py`, v1.150.0). The user needs to combine several cameras' datasets into one collection and control how they are combined.
- Life cycle (user): **round one** = what the app does today (clean, decide OK/NG, choose pictures, export). **Later rounds** = train in DS, bring the trained model back, verify new pictures against it, repeat. The model object is the spine of that cycle. Only phase 1 is planned in detail here.
- Facts about DS and the trained model: `discussions/session-handover-2026-11-03-dataset-collection-and-model.md` (collection format, `.model` file, verification results, work-laptop setup).

## Verified with the real DS (2026-11-03, synthetic zip `test_shared_class_v1`)
- [Certain] A collection with two sub-datasets that reference the **same class pair** (same class ids) imports as **2 classes in total**; counts add up (OK 6 = 3 + 3, NG 4 = 2 + 2).
- [Certain] A second import of the same zip is **rejected by collection `Name`** ("Dataset collection with name '...' already exists"). Not by ids. So every build needs a unique collection name.
- [Certain] The writer in v1.151.0 hard-codes ids (dataset 1, OK 2, NG 3), one sub-dataset, JSON in the zip root. Two cameras' zips would collide unless the builder renumbers.
- Not tested: whether DS also rejects duplicate sub-dataset names, `AvatarImage` optional, picture names clashing across sub-datasets.

## Decisions (user, 2026-11-03)
- **Own top-bar section "Models"** (working name), independent of the camera picker. A collection spans cameras, so it cannot live in one camera's Chain or Export page.
- **One freeze per camera** in a collection (a camera is one sub-dataset). The freeze is chosen from that camera's step-2 freezes that hold rectangles (default: the latest) and stays **pinned** until the user changes it.
- **Per dataset, the user sets:** the sub-dataset name (default: camera name), the OK class name, the NG class name, and the class colours. **Equal class names across datasets mean one shared class**; different names mean separate classes. Default names are prefixed (`<dataset>-OK`, `<dataset>-NG`) so sharing is always a deliberate rename. The page shows a live list of the classes the collection will have.
- **Classes in phase 1: OK and NG only** (what a freeze holds).
- **Collection name** = the model's name plus an automatic build number (`<name>_v001`, `_v002`, ...), one number per build of the same model object.
- **Resolution filter:** only datasets of the chosen size are listed. Sizes are read from the frozen pictures, not taken from a camera setting. A dataset with **mixed sizes** is hidden while a size is selected, and shown under "All" with a warning and the picture count per size (the user left this choice to us; to be judged after he tests).
- **The builder rebuilds from the pinned freezes**; it does not merge finished per-camera zips (that would lose the link to the freeze and the manifest). Originals are copied byte for byte.
- **The model is a new object in the database**, saved, named and rebuilt on demand, with one build per round.

## Phase 1 stages (each = one version, one patch; backend + frontend + tests + docs)
1. **Sizes of a freeze.** A freeze records the picture sizes (`stats.export`, counts per width x height). Older freezes are read on demand (image header only) and cached. A listing function gives, per camera, the step-2 freezes with rectangles, their OK/NG counts and size summary.
2. **Builder.** `ds_export.py`: split `export()` into collecting the pictures of a freeze and writing; `build_collection` takes N sub-datasets with unique dataset ids, unique folder names (cleaned like `Fields.cleaned`) and class ids; classes with equal names get one id and one colour (a colour clash is reported, the first wins). The single-camera export keeps working and stays covered by `tests/test_ds_export.py`. New tests: the two-dataset sample of `test_shared_class_v1` (structure, ids, shared and separate classes), name clashes, mixed sizes.
3. **Model object and build record.** Stored in the database (new table with a schema migration is the expected route; decide when coding): name, the list of pinned (camera, freeze, sub-dataset name, class names, colours), and the builds (number, time, zip path, **manifest**: picture, camera, freeze, class). The manifest stays in the app because DS renames pictures and ids on import. API under `/api/models/...`.
4. **Models page.** Choose the resolution, tick datasets, per-dataset name and class fields, the live class list, then **Build**. Shown before building: OK/NG count per dataset and in total (balance), the same picture in two cameras (overlap, by content hash), a camera that has a newer freeze than the pinned one (stale), name clashes. Build writes the zip and says where it is.
5. **Docs and delivery.** Entry in `docs/current-project.md`, README, `docs/data-model.md` if an invariant changes; bump `appinfo.py`; patch plus `frontend-dist-vX.Y.Z.zip` (work laptop has no npm). Say plainly what was not clicked through in a browser or imported into DS, and give the user a two-line check.

## Later phases (not designed in detail)
2. Import and store a trained model (`.model`, about 160 MB) with a class-mapping check (label order is the alphabetical order of the collection's class names, verified for one model only); link it to its build through `experiment_id` = collection name.
3. Verify new pictures with the model: a verdict is a **threshold on the NG score**, per model and feature, stored with the model (0.5 is not usable; the class with the higher score is wrong, both boxes appear on one picture); the disagreements with the user's labels are the work queue.
4. Round comparison on the same verification pictures; a picture used in an earlier round is never counted twice.

Open items for those phases (where model files live, GPU inference as a background job with 1.7 GB free VRAM, torch/torchvision in the requirements, the second PC's older driver) are in the handover section 8.

## Risks
- Sharing a class across different parts (plocha and tlumic both "OK") blurs them in one class [Likely]; hence the prefixed defaults.
- A mixed-resolution model is not recommended (user, unverified).
- Class imbalance and box-size shortcuts (OK and NG boxes of different sizes in the real sample) are visible on the page only as counts; they are the user's call.
