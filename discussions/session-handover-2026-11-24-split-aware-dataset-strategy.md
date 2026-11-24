# Session handover 2026-11-24: split-aware dataset strategy

Voice-mode session (Broňa driving, video-making context). Conceptual only, no code changed. Purpose: agreed ideas to base a plan on in a new session. Tags: [Broňa] = his statement or decision, [Claude] = my addition. Confidence: [Certain] / [Likely] / [Guessing].

## Trigger
- [Broňa] Learned downstream system trains on 90% and verifies on 10% of the exported pictures. He had assumed 100% training, so he tried to export as few pictures as possible.
- [Broňa] Treat the 90/10 split as random (not controllable).
- [Claude] Consequence [Likely]: with a small hand-picked set, the random 10% can hide rare NG cases from training and make the verification score luck-dependent. Minimizing the set is therefore risky. [Claude] disagreed with "as few as possible".

## Typical first-round size (Broňa's experience)
- About 100 to 150 pictures total, roughly 60-70% OK and 20-30% NG (so ~20-30 NG pictures). A random 10% holds only 2-3 NG pictures, so swings are large regardless. [Certain]

## Option 1 (Claude's, first raised): bigger deliberate first round
- Pick a set large enough that 10% still holds several NG examples per class.

## Option 2 (Broňa's): rough first round, then model-guided rounds
- Round 1 is deliberately not 100%. Freeze and export.
- Import the trained model from the downstream system, run Broňa's pictures against it, add only what it gets wrong in rounds 2 and 3.
- [Claude] Matches the parked dataset-collection plan, phases 2-4 (see `claude/dataset-collection-plan.md`). [Likely]
- [Claude] Catch: only informative if round-1 model is good enough. Earlier held-out test (from project docs, not rechecked this session) had plocha ~0.98 AUC but tlumic much weaker, so tlumic may need a bigger round 1. [Likely]

## Option 3 (Broňa's, chosen to dig into): shuffle simulation of the downstream 90/10 split
- Idea [Broňa]: simulate the downstream random split. Repeatedly draw a random 90% subset, compute the confusion matrix, reshuffle, repeat. Goal: pad the set so that any random 90% still covers what is needed. "110%" in his words was an intuition, not a calculation.
- Arithmetic correction [Claude] [Certain]: reshuffling adds no pictures. To make downstream's 90% equal today's 100%, add about 11% more pictures (1/0.9).
- Run in background, about 50 reshuffles, fast because embeddings are cached (only golden-vs-test comparison is recomputed). [Likely]
- Method name [Claude] [Certain]: repeated random subsampling / Monte Carlo cross-validation.
- Proposed summary shown to Broňa:
  - Per picture: out-of-sample error rate (of runs where it was held out, how often misclassified) and how often it served as a golden.
  - Per class: best, worst, typical accuracy across runs. A big gap between worst and typical means the set needs padding.
  - Show spread, not a single score. NG confidence intervals will be wide with 20-30 pictures.
- Suggestions: ranked hint only, human decides. Related idea: uncertainty sampling from active learning (add neighbours of unstable or borderline pictures). Existing Suggested goldens panel already does a version of this from the class border. [Likely]
- Broňa asked: if there is mathematical background, show it. Answer above. He wants to work on this later.

## Limits to carry into planning
- [Certain] The matrix uses ResNet50 embeddings with goldens; downstream trains Faster R-CNN. Stability in our matrix is a proxy for downstream behaviour, not proof.
- [Certain] With few NG pictures, the simulation's honest answer is likely "add NG first".

## Agreed relationship between options
- Options 2 and 3 are complementary, not competing [Certain]. Sequence: use the shuffle simulation to make round 1 sturdier (labels and embeddings only), then use the imported model's disagreements to tune rounds 2-3.
- Option 1 is effectively what the shuffle summary quantifies (how much padding is enough).

## Open items for the planning session
- Where the shuffle summary lives in the UI (per-camera Chain step vs Models page) and how it reads frozen labels.
- Number of reshuffles (50 proposed) and padding rule, e.g. target worst-case accuracy within some margin of typical.
- Model import format and what the downstream system exposes (not discussed).
- Per-camera sizing, especially tlumic.
- Real browser click-through and real DS import of the existing build are still pending (from earlier handovers).
