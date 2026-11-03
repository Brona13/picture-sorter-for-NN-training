---
name: dataset-collection-and-model-handover
description: Session 2026-11-03 - combining per-camera datasets into one DS dataset collection (format verified by import), the trained-model file format and how to run it (verified on the work laptop), held-out test results, Windows laptop setup (proxy, CUDA torch), proposed phases. Discussion and testing outside the app only, no app code changed.
status: current
document_type: memory
session_date: 2026-11-03
---

# Dataset collection and model verification (2026-11-03)

**No app code was changed.** All testing ran outside the app with small scripts on the work Windows laptop. The user wants to build a plan from this file. Phase 1 = build and export a dataset collection from several per-camera datasets (new page or similar). Model handling is later phases. Confidence tags: [Certain] = seen in a test or file, [Likely] = strong inference, [Guessing] = gap-filling.

## 1. Context and what changed since 2026-11-02

- The app already exports (a) OK/NG folders with original pictures and (b) **a DS-compatible labelled dataset with boxes and labels, one dataset per camera project**.
- The downstream system ("DS", a ResNet-based detector trainer) can now **train one model on several datasets**. The user needs control over how datasets are combined.
- **This supersedes one statement in `session-handover-2026-11-02-two-step-solution.md`** ("downstream cannot import labels or pre-made boxes"): DS imports a *dataset collection* zip with boxes and labels. Verified by import on 2026-11-03 (section 2) [Certain].
- DS renames imported files anyway, and the user imports with unique names [stated].
- The user's picture of the whole life cycle: **round one** = everything the app does today (clean, decide OK/NG, choose pictures, export). **Round two and later** = train in DS, bring the trained model back, verify newly arriving pictures against it, repeat until detection is good enough.

## 2. DS dataset collection format (verified)

A real sample (`datasetCollection.json`) and a synthetic test collection were used.

**Zip layout** [Certain]
- Root: `datasetCollection.json` plus **one folder per sub-dataset**, folder name = the sub-dataset `Name` exactly.
- Inside each folder: `<image Name>.jpg`. The image `Name` in the JSON has **no extension**.
- The JSON `FolderPath` (`ObjectDetectionArchiveDatasetImages/<NodeId>`) does **not** match the zip folder names, and DS does not care: the synthetic test imported with all pictures found. DS resolves pictures by `Name` inside the sub-dataset folder [Likely].

**JSON structure** [Certain, from the sample]
- Top level: `Name`, `Note`, `NormalizedName` (upper case), `AvatarImage` (base64 jpg), `Tags` [], `ObjectDetectionLabelDefinitions` (a **dict keyed by NodeId as string**), `SegmentationLabelDefinitions` {}, `ClassificationLabelDefinitions` {}, `ObjectDetectionArchiveDatasets` (list), `SegmentationArchiveDatasets` [], `ClassificationArchiveDatasets` [].
- Class (label definition): `NodeId`, `Name`, `Note`, `NormalizedName`, `AvatarImage`, `LabelDefinitionScope` 1, `Tags`, `RChannel`/`GChannel`/`BChannel`, `DatasetNodeId` null.
- Sub-dataset: `Images`, `NodeId`, `NormalizedName`, `Name`, `Note`, `Tags`, `AvatarImage`.
- Image: `LabelObjectDetectionBoundingBoxes` [{`X1`,`X2`,`Y1`,`Y2`,`LabelDefinitionNodeId`}], `Name`, `NormalizedName`, `FolderPath`, `Type` 17, `Storage` 2, `Width`, `Height`.
- **OK/NG exists only as the class** (`LabelDefinitionNodeId`), not in folders. Class names are per feature: `plocha-plus-sroub-OK`, `plocha-plus-sroub-NG`, `tlumic-OK`, `tlumic-NG`.

**The real sample** (collection `200_M13_podvozek_MEB_BM_V02`): two sub-datasets, `plocha-sroub-naprava-LZ` (NodeId 1538, 38 pictures) and `tlumic_na_trnu_predni_levy` (1526, 59 pictures). Classes 1955 plocha-OK (38,207,49), 1956 plocha-NG (244,67,54), 1930 tlumic-OK (2,242,62), 1931 tlumic-NG (244,67,54). All pictures 200x200, exactly one box each. Picture names look like `<serial>__<station text>_<dd.mm.yyyy>_<hh.mm.ss>`; the same serial can occur in different sub-datasets (different stations).

**Import test with a synthetic collection** [Certain]: `test_collection_v1.zip` (2 sub-datasets x 5 pictures, 4 classes, 200x200 jpg with a drawn rectangle = the box, synthetic avatars, NodeIds 9001/9002, 9101/9102, 9201/9202) imported cleanly: collection and both sub-datasets created with their notes, pictures in the right sub-dataset, classes kept separate with names and colours, **boxes sit exactly on the rectangles**. DS gave its own IDs to the images (about 44765224 and up), so it probably renumbers on import [Guessing, the dataset and class IDs are not visible in its UI].

**Not tested yet**
- Collision behaviour: import the same zip a second time, or reuse a NodeId that already exists in DS (duplicate, merge, reject?).
- A collection where two sub-datasets **share one class pair** (same class `NodeId`, plain `OK`/`NG`). The format allows it; DS behaviour unknown.
- How the app's own exporter assigns NodeIds (stable per camera or new per export), and whether its output is a zip with the JSON in the root. The user has not answered this yet.

## 3. Phase 1: dataset collection builder (requirements gathered)

The user's idea (voice, 2026-11-03): a **new page** where frozen datasets can be put into a model.
- **Resolution filter** (for example 200x200): only datasets of that resolution are listed.
- Tick or drag the wanted datasets into the model.
- Per dataset in the model: control over the **dataset's name, its class names, and colours**. Naming two classes the same is allowed and means one shared class.
- The model is **a new object in the system database**, saved and named, rebuilt on demand, one version per round [agreed].

Gaps I raised, all accepted as sensible [Likely]:
1. **Manifest** per build: picture name, camera, version, class. DS renames files, so this is the only trace afterwards.
2. **Staleness**: the page says when a camera has a newer frozen version than the one in the model.
3. **Overlap check**: the same picture in two datasets is counted twice.
4. **Balance view**: OK and NG counts per dataset and in total, so one camera does not dominate.
5. **Name clashes**: duplicate sub-dataset names get a warning or an automatic prefix.
6. **Class merge**: equal class names get one class id and one colour.
7. **Resolution** must be **verified at freeze time** from the pictures, not taken from the camera setting.

**Build step** (design leaning): reuse each camera's existing DS dataset export and merge. Renumber or check NodeIds (datasets and classes) so they are unique across cameras, make sub-dataset folder names unique, remap merged classes, copy the original `.jpg` frames **byte for byte** (camera frames are already jpg), write the manifest. Lean toward a **new object** (Model / training set: named list of pinned camera + frozen version pairs) rather than an Export-box mode, because the Export box lives inside one camera's Chain [Guessing].

Risks: NodeId or name collisions across cameras; mixed resolutions; the user's note that one resolution for a model is recommended (not verified by him); in the real sample the box sizes differ between OK and NG pictures, which can be a learnable shortcut [Likely]; class imbalance (real sample 38 and 59 pictures; held-out data have far fewer NG than OK).

## 4. Later phases (model handling)

Nothing here is designed in detail; the user will ask for the plan in chat.
- **Model object per round** holds: the dataset selection (frozen versions, names, class mapping), the built collection and manifest, the **trained model file** coming back from DS (plus training date), and verification results on new pictures.
- **Round two use**: new pictures run through the trained model; its disagreement with the user's labels is the list of pictures to look at (label wrong or model wrong). Fits the existing rule that a model's opinion is never blended into a hidden verdict.
- **Traceability across rounds**: a picture used in round one must be known in round two (never counted twice, never relabelled).
- **Comparison** round N against N-1 on the same verification pictures.
- The trained model's config carries `experiment_id` = the collection name (section 5), so the imported model can be **linked automatically to the collection build record** [Likely].
- Import a model into the app: store the `.model` (about 160 MB each), keep its class mapping, choose it when testing.

## 5. Trained model file (verified on the user's real model)

**Container** [Certain]
- A `.model` file is a **zip** (rename a copy to `.zip` to open it) with `config.json` and `model.hdf5` (165,768,727 bytes in the example).
- **`model.hdf5` is not HDF5.** It is itself a zip: a `torch.save` archive (`data.pkl`, `data/0` to `data/294`, `version`, `byteorder`, `.format_version`, `.storage_alignment`). h5py fails with "file signature not found". `torch.load` reads the file directly, no extraction needed.
- `data.pkl` is a plain `OrderedDict` state_dict (only `collections.OrderedDict` and torch's tensor rebuild function in the pickle): loads with `torch.load(path, map_location="cpu", weights_only=True)` and needs **no DS code**. Keys are prefixed `model.`.

**Architecture** [Certain from key names and tensor sizes]: torchvision **Faster R-CNN, ResNet-50 FPN, v1** (box head `fc6`/`fc7`, 3 anchors per location), **5 outputs = 4 classes + background**.

**config.json** (example): `classes` = 4 UUIDs (DS-internal ids, **not** the dataset NodeIds), `target_size` [200, 200] (not used by inference), `pretrained` false, `architecture` 2, `metadata`: `uuid`, `model_version` "1", `experiment_id` `200_M13_podvozek_MEB_BM_V02` (= the collection name).

**Inference settings that reproduce the known boxes** [Certain on the 20 training pictures tested]
- torchvision defaults: resize min side 800, max 1333 (a 200 px picture is upscaled), ImageNet mean/std, default anchors (32 to 512, ratios 0.5/1/2), `num_classes=5`.
- Other variants failed: resize 200 and 400 find almost nothing, small anchors find nothing, no normalisation raises extra detections (IoU 0.84 instead of 0.95).
- Result on 20 training pictures: recall at IoU 0.5 = 1.00, mean best IoU 0.95, exactly one detection per picture, class correct on all 20.
- **Label order**: label `i` = `classes[i-1]` of `config.json` = the i-th class **name in alphabetical order** of the collection: 1 `plocha-plus-sroub-NG`, 2 `plocha-plus-sroub-OK`, 3 `tlumic-NG`, 4 `tlumic-OK`. The alphabetical rule is [Likely] and verified for this model only. **Check the mapping for every new model** (the UUIDs cannot be mapped to names from the files).
- CPU and GPU give the same result for the best setting.

**Minimal loader (what the scripts do)**

```python
import torch, torchvision.transforms.functional as TF
from torchvision.models.detection import fasterrcnn_resnet50_fpn

sd = torch.load(path, map_location="cpu", weights_only=True)
sd = {(k[6:] if k.startswith("model.") else k): v for k, v in sd.items()}   # strip "model."
m = fasterrcnn_resnet50_fpn(weights=None, weights_backbone=None, num_classes=5)  # 4 classes + background
res = m.load_state_dict(sd, strict=False)   # only *.num_batches_tracked may be missing
m.eval().to(device)
with torch.no_grad():
    o = m([TF.to_tensor(img.convert("RGB")).to(device)])[0]   # o["boxes"], o["labels"], o["scores"]
```

`num_classes` = number of `classes` in `config.json` plus 1. Loading with `weights_only=True` also keeps a foreign file from running code.

**Speed** [Certain]: 20 pictures at 800 px took 39 s on CPU and 2 s on the GPU (about 0.1 s per picture on the RTX A2000, about 2 s on CPU). Only about 1.7 GB of the 4 GB VRAM is free (Windows uses about 2.4 GB), so one picture at a time.

## 6. Held-out test (new pictures, user's own OK/NG labels)

1473 pictures exported from the app into OK/NG folders, none of them in the training collection (the script checks file names), all 200x200, one picture per serial. Verdict rule used: NG if the NG-class detection of that feature has score >= threshold, else OK if an OK detection has score >= threshold, else "none". Threshold 0.5.

| Feature | OK pictures | NG pictures | NG caught at 0.5 | OK wrongly flagged at 0.5 |
|---|---|---|---|---|
| `plocha-sroub-naprava-LZ` | 882 | 254 | 120 (47%) | 0 |
| `tlumic_na_trnu_predni_levy` | 311 | 26 | 18 (69%) | 58 (19%) |

Threshold sweep from the stored per-picture scores (`heldout_details.csv`, columns ok_score, ng_score), threshold applied to the NG score alone:

| NG threshold | plocha NG caught | plocha OK flagged | tlumic NG caught | tlumic OK flagged |
|---|---|---|---|---|
| 0.9 | 4% | 0 | 46% | 1% |
| 0.8 | 7% | 0 | 58% | 4% |
| 0.5 | 47% | 0 | 69% | 19% |
| 0.3 | 79% | 0.2% (2) | 77% | 40% |
| 0.2 | 91% | 1% (10) | 92% | 53% |
| 0.1 | 98% | 22% | 96% | 77% |

Findings [Certain unless tagged]
- The default threshold 0.5 is not usable as a defect check.
- **plocha**: the NG score separates the classes well (AUC 0.98). Most misses sit just below 0.5; a lower threshold fixes much of it. At 0.2, 9% of NG are still missed, which is the user's decision to accept or not.
- **tlumic**: weak (AUC 0.84), no threshold is good, and only 26 NG pictures were tested, so every percentage has a wide margin of error.
- The model puts **both an OK box and an NG box** on the same picture, with a high OK score even on NG pictures (median 0.94). **The verdict must be a threshold on the NG score, not "the class with the higher score"**: that rule caught only 18 of 254 NG on plocha.
- The thresholds above were chosen by looking at the same pictures they were measured on, so they are optimistic.
- The model was trained on only 97 pictures: this is an ordinary round-one result [Likely].
- A disagreement can mean the model or the user's label is wrong. Both are worth finding.

**Not done** (was proposed, the user stopped the testing): split the held-out pictures randomly 50/50 per feature and per class, choose the threshold on one half and report on the other; copy disagreements to a `to_review` folder. A serial split is not needed (each serial occurs once per feature).

**Design consequences for the app** [Likely]: the verdict threshold is a **setting per model and per feature**, stored with the model, chosen on held-out pictures, not hard-coded at 0.5. The list of disagreements is the round-two work queue.

## 7. Work Windows laptop: what is needed (from this session)

- **Machine**: HP ZBook Fury G8, NVIDIA RTX A2000 Laptop GPU 4 GB, driver 573.86, CUDA 12.8. Python 3.13 (the app's venv reports 3.13.2). No npm (frontend is delivered as a dist zip). PowerShell is **5.1** (older): `Format-Hex` has no `-Count`; use .NET to read the first bytes. `Expand-Archive` needs a `.zip` extension, so copy the `.model` to `.zip` first.
- **Proxy**: github.com and PyPI are not reachable directly. pip works through the local proxy: `pip install <pkg> --proxy http://localhost:9001`. Permanent for pip: `pip config set global.proxy http://localhost:9001` (check with `pip config list`). For other tools set `HTTPS_PROXY` and `HTTP_PROXY` as user environment variables (new terminals only). The PyTorch download site `download.pytorch.org` is **allowed** through this proxy; a 2.7 GB wheel downloaded fine.
- **PyTorch**: plain `pip install torch torchvision` on Windows gives the **CPU build** (it installed `2.15.0+cpu`, `torch.cuda.is_available()` false, "Torch not compiled with CUDA enabled"). For the GPU:

  ```powershell
  pip uninstall -y torch torchvision
  pip install torch==2.11.0 torchvision --index-url https://download.pytorch.org/whl/cu128
  python -c "import torch;print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
  ```

  Expected: `2.11.0+cu128 True NVIDIA RTX A2000 Laptop GPU`. The `cu128` index offers torch 2.11.0 (not 2.15). If pip cannot find a dependency such as numpy or pillow, add `--extra-index-url https://pypi.org/simple`. `cu130` builds do not fit (driver tops out at CUDA 12.8). Check the GPU with `nvidia-smi`.
- **Packages used by the test scripts**: `torch`, `torchvision` (matching), `Pillow`. `h5py` was installed only to look into the file and is not needed. The testbed ran in the user-level Python 3.13 (`AppData\Roaming\Python\Python313\site-packages`), **separate from the app's `.venv`**. Check what the app's `requirements` already contain: the app uses torch already; `torchvision` may need adding [Guessing].
- **Second PC** (RTX A5000, driver 537.70 = CUDA 12.2, not elevated, cannot update the driver): the `cu128` build does **not** fit there; an older CUDA build (`cu121` or `cu118`) would be needed [Guessing]. Already noted in `topics/work-environment` memory.

### Testbed procedure (repeatable for every DS run)

The collection and the model **must come from the same training run**. Folder (the user works in `C:\Brona\Python\picsorted_test`; the layout below is the recommended one, any base folder works):

```
<testbed>\verify_model.py
<testbed>\verify_heldout.py
<testbed>\run1\collection\   datasetCollection.json + one folder per sub-dataset (the .jpg files)
<testbed>\run1\model\        config.json + model.hdf5   (do not extract model.hdf5)
<testbed>\run1\heldout\<sub-dataset name>\OK\*.jpg   and   ...\NG\*.jpg
```

1. In DS download the collection used for training (zip) and the trained model (`.model`).
2. `Expand-Archive "<collection>.zip" -DestinationPath <testbed>\run1\collection`. The JSON must sit directly in `run1\collection`; if everything ended up one level deeper, move it up.
3. `Copy-Item "<file>.model" <testbed>\run1\model.zip`, then `Expand-Archive <testbed>\run1\model.zip -DestinationPath <testbed>\run1\model`.
4. Check the pair matches (the two printed names must be identical):

   ```powershell
   python -c "import json;print(json.load(open('run1/collection/datasetCollection.json',encoding='utf-8'))['Name']);print(json.load(open('run1/model/config.json'))['config']['InferenceConfigurationV1']['metadata']['experiment_id'])"
   ```

5. Training-picture check (settings and class mapping; 20 pictures, writes `verify_report.txt`, rename it per run, for example `report_run1.txt`):

   ```powershell
   python verify_model.py --model run1\model\model.hdf5 --collection run1\collection\datasetCollection.json --root run1\collection --config run1\model\config.json --n 10
   ```

   `--device auto|cpu|cuda` (default auto). It tries 12 combinations of resize, normalisation and anchors and prints which model label index belongs to which class.
6. Held-out folders (names must equal the sub-dataset names of the collection):

   ```powershell
   foreach ($d in "plocha-sroub-naprava-LZ","tlumic_na_trnu_predni_levy") { foreach ($c in "OK","NG") { mkdir "<testbed>\run1\heldout\$d\$c" } }
   ```

   Export pictures that were **not** in the training collection from the app into these folders.
7. Held-out test (writes `heldout_report.txt` and `heldout_details.csv`, `;` separated, one row per picture with both scores):

   ```powershell
   python verify_heldout.py --model run1\model\model.hdf5 --collection run1\collection\datasetCollection.json --pictures run1\heldout
   ```

   Option `--thr` (default 0.5). Pictures whose name is in the training collection are skipped and counted.

The training-picture check only proves loading, preprocessing and class order. It says nothing about quality on new pictures.

**Scripts delivered in this session** (copies are in the user's testbed, not in the repo): `make_test_collection.py` (builds the synthetic collection), `verify_model.py`, `verify_heldout.py`. The loader above is the part to reuse in the app. Whether to keep the scripts in the repo (for example a `tools/` folder) is not decided.

## 8. Open questions and next steps

1. How does the app's exporter set NodeIds, and is its output a zip with the JSON in the root? (unanswered)
2. Collision test (second import of the same zip) and the shared-class test (`OK`/`NG` common to two sub-datasets): not run.
3. Class order of a new model: is alphabetical always the rule? Check per model.
4. Verdict threshold: how chosen (per model and feature, on held-out pictures), and where stored.
5. Where model files live (about 160 MB each: database or a folder), and inference as a background job on the GPU (one picture at a time with 1.7 GB free).
6. Torch and torchvision in the app's requirements; the second PC's older driver.
7. From 2026-11-02, still unanswered: what NG means physically.
8. **The plan is not written.** The user will ask for it in chat. Proposed order: (1) Model object and collection builder with manifest and class merge (export is phase 1); (2) import and store a trained model with class mapping check; (3) verify new pictures with the model, thresholds per model and feature, disagreement queue; (4) round comparison.

## 9. Working with this user

Short answers, no praise, the deciding point or one question first, one way instead of alternatives. He discusses step by step and says when code may be changed. He applies and tests patches himself, and commits and pushes himself. A docs-only change rides with the next code patch (no commit of its own). Work laptop has no npm, so frontend changes need a built dist zip.
