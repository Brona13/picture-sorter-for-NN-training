---
name: handover-training-and-docs-cleanup
description: Using a trained model, hardware, the golden rename and docs cleanup - conceptual discussion, nothing to code unless stated
status: draft-for-next-session
document_type: handover
last_updated: 2026-10-21
---

# Handover: trained models, hardware, "golden" rename, docs cleanup

Created: 2026-10-21. Conceptual discussion, nothing here is to be coded now unless stated.

## 1. Using a trained model (concept)

- The model file is trained weights plus the network architecture. Code loads it once and runs each picture through it (inference). It sees only pixels, not folders.
- Per picture: crop the ROI, resize to the training size, normalize like in training, make a tensor, one forward pass.
- A classifier outputs one raw score per class. Softmax turns them into probabilities. The highest is the predicted class. The probability is a confidence, not calibrated.
- A folder is processed in a loop, in batches (for example 32), and each result is stored as metadata, like the current scores.
- Preprocessing must match training exactly (crop, size, normalization), otherwise answers drift.
- The app already runs ResNet through PyTorch for embeddings. A trained model would read the final class output instead of the penultimate vector.
- Today's app uses the generic pretrained ResNet. It only describes how a picture looks, and the app compares vectors. A trained model is the same architecture with weights adjusted on production pictures, and its last layer gives OK / NG directly.

## 2. Training (what it means)

- Fine-tuning: start from the pretrained ResNet, replace the last layer with one for your classes, show it labeled pictures many times. Retraining later with new labeled pictures works the same way.
- Needs: labeled pictures, a GPU, a few settings.
- Main settings: epochs (often 10 to 50), batch size (4 to 64, limited by VRAM), learning rate (small for fine-tuning, the most important one).
- Others: optimizer (Adam or SGD), weight decay, augmentation (small shifts, brightness), mixed precision (faster, less memory).
- Defaults work well. Mostly tune epochs and learning rate.

## 3. Hardware

- A proper GPU is roughly 10 to 100 times faster than a CPU for training. Integrated graphics would mostly fall back to the CPU.
- The RX 7800 XT with ROCm already works for ResNet (16 GB VRAM, enough for fine-tuning at the current picture sizes).
- The possible work machine with an Nvidia 4080 (16 GB) is faster, and CUDA is the best-supported path.
- Planned split: the app and development stay on the laptop. Only the training job runs on the 4080 machine, reached over the network.
  - Export the training folders as now, copy them over, start a training script over SSH, fetch the finished model file (small).
  - Use tmux (or a background or scheduled process on Windows) so a dropped connection does not kill a run.
  - A small script over SSH is enough at first. A training service with its own API is not needed.
- Check with IT before installing software and keeping data on that work machine.
- This keeps training outside the app and matches the rule that the tool prepares data and does not train the final classifier.

## 4. Importing a model from the downstream system

- Some formats store class names and order inside (many PyTorch checkpoints, ONNX with metadata). Others hold only weights, and the classes come from a labels file or the training script.
- If missing, the output layer size gives the number of classes, but not which is which.
- Plan: read the class count, record the actual class names and order, create the classes on the app side and map model index to app class.
- A wrong mapping silently flips OK and NG. Safeguard: run a few known OK and NG goldens through the model and confirm the mapping before trusting it.
- Keep the class order written down next to the model file.

## 5. To-do: rename "golden" to "reference" (step one only)

Decision: do **step one only**.

- Rename in **visible text only**: labels, buttons, hints, info tips, docs wording. Candidate wording: "reference", or "trusted reference" where clearer.
- Leave unchanged: database tables and columns, API routes and fields, settings keys, code identifiers, frontend types, tests.
- No internal rename, no database migration.
- Reason: "golden" in testing usually means a trusted expected output. Internals are invisible, so renaming them costs risk and brings nothing. Frozen versions and exports also carry the old name.

## 6. To-do: documentation cleanup (later, no date)

Goal: about 100 to 200 md files stay organized for both the user and Claude.

Approach:

1. Make `docs/current-project.md` accurate first. Accurate matters more than complete. Details that live in the code can stay out.
2. Build an inventory table before judging anything: one row per file with path, size, last-changed date, type (plan, handover, session note, reference).
3. Review per document, not per feature. For each file ask whether its claims are still true, superseded, or unique. Unique content is rescued into a current file.
4. Never delete in the first pass. Move files to an archive folder with a "historical" marker on top, kept in git.
5. Merge files that say the same thing. Delete only fully superseded ones.
6. Repeat every few weeks or after a milestone.
7. Keep the first-read files (CLAUDE.md) short, pointing to the rest.

## 7. To-do: split current-project.md into three layers

The file is long mainly because it mixes how a feature works today with version-by-version change notes.

- **Index:** short, one or two lines per feature, with links.
- **Feature detail files:** about 10 to 15, grouped sensibly (for example Chain and measurement boxes, Classify, Detector, Ingest, Versions). Each describes how it works today, no history. Avoid many tiny files.
- **Changelog:** holds the version entries so nothing is lost.

## 8. To-do: rebuild the changelog

- Git history is the best source: dates, commit messages, changed files.
- A script groups commits by app version and drafts the file. Notes, plans and the version entries in current-project.md fill in the why.
- Expect gaps for early versions that need a manual pass.
- Keep it to one to three lines per version. Detail goes in the feature files.
- Not yet confirmed by the user: whether to add this to the cleanup to-do list. It was offered and the user moved on, so treat it as part of section 6.
