# Picture Sorter: lifecycle, rounds and testing set

Summary of the 2026-10-29 voice discussion. Ideas only, nothing decided as code. Confidence tags: \[Certain\] hard evidence (project docs or your statements), \[Likely\] strong inference, \[Guessing\] general practice, not checked against your data.

## 1. Core idea

- The app is a workbench that turns piles of near-identical frames into a small, trusted, labeled dataset. The human stays responsible for every label. \[Certain\]
- It is not a one-time tool. It is the gatekeeper between production and training, used again every retraining round. \[Certain, your statement\]
- Direction: a tightening, not a pivot. Every rule you set by hand now (a relation between boxes, a threshold) is a seed of later automation. \[Certain, north-star handover\]
- Risk to avoid: building ever more manual tools without closing the loop. Keep the human decision final while making "what deserves attention" smarter. \[Likely\]

## 2. Embedding and goldens

- ResNet-50 is the only active method, chosen because downstream uses the same network. ResNet-18 and the classical family exist but are switched off. \[Certain\]
- A pretrained ResNet is a generic yardstick, not a judge. Good for near-duplicates and "looks like my golden OK", possibly blind to subtle NG. \[Likely\]
- Goldens are the ground truth for scoring: every score is a distance to the frames you vouched for. Quality of goldens decides quality of everything after. \[Certain\]
- Wanted: per-class golden suggestion with no goldens needed first (a few typical frames near the class centre plus some border cases). Algorithm suggests the count, you override. \[Certain, north-star handover; not built\]
- A second opinion tuned to your data should stay separate, never blended with ResNet. \[Certain, project invariant\]

## 3. Lifecycle

### Round 1 (cold start)

1. Ingest pictures, define ROIs, remove duplicates, delete junk.
2. Label everything OK or NG.
3. Pick goldens (the training set).
4. Freeze a version, export goldens only.
5. Downstream trains the network.

Labeled non-golden pictures become the testing set, because the network never saw them. Export is golden-only, so this is enforced by the app. \[Certain\]

### Round 2, 3, 4 (the same loop)

1. Ingest new pictures into the same camera. Content-hash duplicates are skipped. Do not delete the old set: goldens and frozen versions depend on it.
2. Score them. Pretrained ResNet at first, later the downstream model.
3. Triage: skip confident matches, mute near-duplicates, label only what is uncertain, odd or wrong.
4. Measure the trained model on labeled pictures it never saw (old testing set plus new non-golden labeled ones).
5. Choose new goldens (mix of a few old and new), demote old ones that are wrong or redundant.
6. Freeze, export, downstream retrains. Repeat.

- No need to start over: labels, goldens and ROIs stay; the pretrained network never changes. \[Certain\]
- Freeze a version before changing goldens so you can return to the previous state. \[Likely\]
- Round two deliberately leaves some pictures unlabeled. "Zero unlabeled" is only true for round one. \[Certain\]
- Same camera with pictures from another period stays one camera. The risk is drift (lighting, part changes); novel frames flag it. \[Likely\]

### Goldens across rounds

- Round-one goldens were trained on, so they cannot measure the model, but still work as similarity references. \[Certain\]
- Reasons to remove a golden: label turns out wrong, redundant, production look changed. Demote rather than delete, after a freeze. \[Likely\]
- Keep a record of which goldens each training round used. \[Likely\]

## 4. Testing set

- Needs coverage of awkward cases, and enough NG examples for a miss rate to mean something. Small sets give noisy numbers. \[Likely\]
- It need not be goldens: most labeled pictures kept out of training qualify. \[Certain\]
- Keep a frozen core that never changes, plus newer pictures on top. Report trend on the core, current state on the full set. \[Likely\]
- If a test picture is later promoted to golden, the measurement is flattered. The app does not protect against this after the fact. \[Likely\]
- Pictures chosen by uncertainty give a biased testing set. Know where each picture came from. \[Guessing, general practice\]

## 5. Using the downstream trained model

- Idea: import the network trained downstream and use it as another separate scoring opinion. Its fingerprints are a better similarity measure; its disagreements with your labels give a ranked list of suspect labels or hard frames. \[Likely\]
- Cautions: it will look great on its own goldens, so judge on the protected testing set. It should flag, you decide. \[Likely\]
- Depends on the export format downstream can provide. \[Open\]

## 6. Organization and tags

Principle: round is a property of the picture, a freeze is a property of the labels. Keep them separate.

- Round tag per picture, filled automatically from ingest date (the ingest time already exists; picture tags are prepared in the design but not built). \[Certain\]
- Named freeze per round answers "what did round one train on". \[Likely\]
- Epoch marker for criterion changes: a name on a freeze ("criterion A", "criterion B"). \[Likely\]
- Other suggested tags (keep only those that change a decision): source (line, shift, folder), production conditions (product batch, lighting), origin in the loop (random sample vs pulled in by uncertainty or model disagreement), reason for hard cases (borderline, label disputed, odd lighting), used in training and in which round. \[Guessing, general practice\]
- Open: do picture tags share the camera tags' vocabulary? \[Certain, listed open in project doc\]

## 7. Criterion changes

Scenario: bosses or supervisors change what counts as OK or NG once production runs.

- Do not start from scratch. Pictures are facts, labels are opinion. \[Likely\]
- Freeze the old state as the old criterion, then re-judge. Only borderline pictures need re-judging, mostly; clear OK and clear NG keep their labels. \[Likely\]
- Find borderline pictures by: near the class boundary, methods disagree, Evaluation measurement close to tolerance. If the rule is a number, Evaluation recomputes the verdict automatically. \[Likely\]
- A changed criterion invalidates the old testing set; relabel before trusting any score. \[Likely\]
- The change may be numeric or a human judgment call (you said both).

## 8. Calibration (future idea, per your wish: leave as a note)

- Real-world units (mm, degrees) must be converted to pixels, and left and right cameras are not symmetrical, so settings cannot be copied between them.
- Idea: store the criterion once in real units, with a separate per-camera (maybe per-detail) conversion, so one edit updates all cameras. Pixels per mm from a known feature; angles mostly independent of scale.
- Today Evaluation takes nominal and tolerance directly per box. A single scale factor is only approximate because of perspective. \[Likely\]
- Status: optional, later. You were trying to avoid it.

## 9. Progress tracking across model versions

- A newer model can be worse. Keep a table: one row per round; columns: round and date, number of goldens, model version, results on the same fixed testing set (NG caught, OK wrongly rejected, accuracy), notes (new goldens, criterion change). \[Likely\]
- Compare only on the same testing set. At a criterion change start a new table or mark a clear break.
- Keep one confusion matrix per round on the same testing set; the table summarizes them. Missed NG is the costly direction in production. \[Likely\]
- Existing: Versions can store downstream results (metric, number, day, note) and compare them; Insights draws confusion matrices per scoring method with clickable cells. Missing: fixed columns, a saved matrix per round for the downstream model, a trend view. \[Certain\]

## 10. Background and masking: two-step plan

- Problem: a network on a rectangle also sees background, lighting and neighbours, which can outweigh a tiny defect. Your measurement boxes work on the part, not the surroundings.
- Ways to reduce it: tight crop (anchored ROIs follow the found box), mask background (rectangle, circle, polygon on the Detector page), straighten the part first (planned, not built). \[Certain\]
- Your plan: step 1, work on the masked part only until OK and NG are cleanly separable and labels are trusted. Step 2, choose goldens from full rectangles including background, among pictures whose labels you already trust, so goldens match what the network sees.
- Watch for accidental clues in the background (OK and NG from different shift or lighting): choose goldens so both classes cover the same backgrounds; a source or conditions tag would allow checking. \[Guessing, general practice\]
- Evaluation labelling a Classifier (v1.119.0) starts to cover "step-one verdict as the label, step-two crop as the view". \[Likely\]

## 11. What the app lacks today

- Round marker per picture (only ingest date and day filter exist).
- Stored record of which goldens each training round used (a freeze at export covers part of it).
- Protected testing set that cannot slip into goldens.
- One readout for a new batch (for example "90 percent redundant, 10 percent new") and a single ranked triage list.
- Import of the downstream trained model.
- Per-class golden suggestion without existing goldens; class-separation check.
- Fixed benchmark columns and a trend view across rounds.
- Calibration per camera.

## 12. Open points

1. Export format of the downstream model.
2. Do downstream training pictures use masks or plain rectangles? (asked, unanswered)
3. Do two targets on the same spot go to the detector review list? (open from the previous session)
4. Golden in which ROI, fate of the old Versions export next to the Export box, pictures without product label (open from the Export box notes).
5. How "worth labeling" signals combine into one ordering without a hidden blended verdict.
6. Scan depth dial (quick triage versus full re-scan): not designed.
7. Pseudo-label trust level for labels imported from downstream: proposal, needs your confirmation.
8. Class-separation check: a number, a plot, or both.

## 13. Details to verify

- Most of the app since v1.31 has been tested only with a mocked API and synthetic pictures, not in a browser on real cameras. Validate before building on it.
- The two-hole chain (detectors, Calculate, Evaluation) is unchecked on real frames, including angle precision.
- Statements about PatchCore, PaDiM, DINOv2, CLIP, and tag suggestions come from general knowledge, not from your data or the literature.
- I could not write to your repo or memory from this call. Calibration and other notes should be filed when you are at your desk.

## 14. Agreed way of working

Ideas now, discussion in detail later, then a plan, separate steps, then code changes.
