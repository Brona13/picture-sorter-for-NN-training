---
name: methodology
description: Stable technical reference for ROI comparison, class distance, novelty, margin, and scoring methods
status: current
document_type: methodology
last_updated: 2026-07-29
---

# Scoring methodology

This document explains how the application compares images and how its scores should be interpreted.

The scoring system is a human-review aid. It does not train the final classifier and does not replace human labels.

For the surrounding entities and invariants, see [[data-model]].

## Comparison unit

All comparisons operate on a feature’s ROI cutout, not on the full source frame.

For one feature:

1. Load the source frame.
2. Crop the feature’s ROI.
3. Extract the representations required by each available scoring method.
4. Compare the candidate representation with trusted golden representations.

Using an ROI focuses the comparison on the inspected component and avoids unrelated areas of the frame.

ROI coordinates are normalized fractions of image dimensions. Pixel-based representations are resized to a common size before comparison.

## Labels and goldens

A label is the human decision for one frame within one feature.

A golden is a trusted labeled frame used as a reference for its current class.

Goldens are divided by class:

```text
class A → golden cutouts for class A
class B → golden cutouts for class B
...
```

Goldens are not scored as candidates. They define the reference space against which other frames are evaluated.

A class without a golden set cannot receive a distance for that scoring method.

## Independent scoring methods

The application presents several independent opinions:

```text
cpu
resnet18
resnet50
```

The methods are not blended into one hidden verdict.

For every candidate, each method independently determines:

- Distance to the nearest golden of each represented class
- Which represented class is nearest
- The margin between the two nearest classes
- Distance to the nearest golden across all classes

The nearest golden can differ between methods.

## Classical CPU method

The `cpu` method combines three classical image distances:

- HSV histogram distance
- Mean squared error
- Structural dissimilarity

These distances operate on two precomputed representations:

- A normalized HSV histogram
- A standardized grayscale cutout

### HSV histogram distance

The cutout is converted from BGR to HSV.

A three-dimensional histogram is calculated over:

```text
Hue:        50 bins
Saturation: 60 bins
Value:       3 bins
```

The histogram is normalized and flattened.

Two histograms are compared with OpenCV’s Bhattacharyya distance:

```text
0 = identical distributions
1 = maximally different distributions
```

This metric captures changes in overall color and brightness distribution while largely ignoring where those values occur within the ROI.

It can detect lighting or color changes but may miss spatial rearrangements.

### Mean squared error

The cutout is:

1. Converted to grayscale
2. Resized to `256 × 256`
3. Scaled to floating-point values in `[0, 1]`

For standardized grayscale images `A` and `B`:

```text
MSE(A, B) = mean((A - B)²)
```

Because both inputs are in `[0, 1]`, MSE is also in `[0, 1]`.

```text
0 = identical pixels
higher = greater average pixel difference
```

MSE is sensitive to position. A small shift can affect many pixels even when the physical object has not meaningfully changed.

On the currently measured data, MSE values have been small enough to contribute little to the final classical ranking.

### Structural dissimilarity

Structural Similarity Index Measure compares local structure, contrast, and luminance.

The application converts similarity into distance:

```text
SSIM distance = clamp(1 - SSIM(A, B), 0, 1)
```

```text
0 = structurally identical
higher = greater structural difference
```

SSIM can respond to missing components, edge changes, and texture differences.

On the currently measured data, its numerical range has been substantially larger than the histogram and MSE ranges. It therefore dominates much of the classical ranking despite equal configured weights.

### Classical combination

Let the three classical distances between candidate `C` and reference `G` be:

```text
d_hist(C, G)
d_mse(C, G)
d_ssim(C, G)
```

The combined CPU distance is a weighted average:

```text
d_cpu(C, G) =
    (w_hist × d_hist
   + w_mse  × d_mse
   + w_ssim × d_ssim)
   ÷
    (w_hist + w_mse + w_ssim)
```

Weights are defined in:

```text
app/backend/config.py → METRIC_WEIGHTS
```

The current configured weights are equal.

Equal configured weights do not guarantee equal practical influence. Metrics whose observed values occupy a larger range contribute more strongly to the combined distance.

## Neural ResNet methods

The optional neural methods use pretrained ImageNet ResNet backbones:

- ResNet18
- ResNet50

They do not train on the project’s data.

For each cutout:

1. Convert BGR to RGB.
2. Apply the preprocessing associated with the pretrained weights.
3. Run the frozen network without gradients.
4. Remove the classification head.
5. Use the penultimate network representation as an embedding.
6. Normalize the embedding to unit length.

Candidate and golden embeddings are compared using scaled cosine distance:

```text
d(C, G) = (1 - dot(C, G)) ÷ 2
```

The implementation clamps the result to `[0, 1]`.

```text
0 = same embedding direction
higher = less similar embedding direction
```

ResNet18 and ResNet50 remain separate methods. Their embeddings are never averaged together.

Neural methods can be more tolerant of small image shifts and can capture higher-level visual similarity. They may also ignore subtle inspection details that are important to this specific industrial task.

PyTorch is optional. When it is unavailable, the application continues with the classical CPU method.

## Distance to one class

For candidate `C`, scoring method `M`, and class `K` with golden set:

```text
G(K) = {G₁, G₂, ..., Gₙ}
```

the class distance is the nearest-golden distance:

```text
d_M(C, K) = min d_M(C, G)
                G ∈ G(K)
```

The minimum is used because a candidate is represented by a class if it is close to at least one trusted example of that class.

A large golden set provides broader reference coverage but increases comparison cost linearly.

## Multi-class result

Assume a candidate has valid class distances:

```text
class A → 0.12
class B → 0.18
class C → 0.31
```

Sort the represented classes from nearest to farthest.

### Leaning

Leaning is the nearest represented class:

```text
leaning = class A
```

Leaning is available only when at least two classes have golden references.

It is a nearest-reference opinion, not an automatic label.

### Margin

Margin is the difference between the second-nearest and nearest class distance:

```text
margin = 0.18 - 0.12 = 0.06
```

```text
small margin = the two nearest classes are difficult to separate
large margin = the nearest class is more clearly separated
```

Margin is method-specific and feature-specific. It is not a calibrated
probability and should not be interpreted as percentage confidence.

### Novelty

Novelty is the nearest distance across all represented classes:

```text
novelty = min(0.12, 0.18, 0.31) = 0.12
```

A high novelty value means the candidate is far from every available golden under that method.

A high-novelty frame may represent:

- A genuinely unusual condition
- A missing reference mode
- A new product appearance
- A lighting or alignment change
- An image-quality problem
- A defect
- A limitation of the scoring method

Novelty identifies insufficient reference coverage; it does not determine the cause.

## Cold-start behavior

### No goldens

Without any goldens, candidates can be browsed and labeled, but no meaningful distances can be calculated.

### One represented class

With goldens in only one class:

- Distance to that class is available
- Novelty is available
- Leaning is unavailable
- Margin is unavailable

At least two represented classes are required for relative class preference.

### Missing classes

In a multi-class feature, a class without goldens receives no distance. Leaning and margin use only classes that currently have references.

This means the apparent decision space is incomplete until the relevant classes have representative goldens.

## Method agreement and disagreement

Each scoring method evaluates the candidate independently.

Agreement can strengthen the case that a frame deserves attention, but it does not prove the correct label.

Disagreement is often especially useful because it highlights frames whose appearance depends on the representation being used.

Recommended human-review signals include:

- Methods disagree on leaning
- Margin is very small
- Novelty is high
- A labeled frame leans toward another class
- A common-looking frame remains far from all goldens

## Golden-set strategy

Goldens should represent trusted visual modes, not merely increase the reference count.

Useful golden variation can include:

- Normal position variation
- Expected lighting variation
- Legitimate component variation
- Distinct product appearances
- Distinct defect modes
- Borderline but correctly understood cases

When a clearly understood frame remains highly novel, the golden set may lack that visual mode.

Adding many near-identical goldens provides little new coverage while increasing comparison cost.

## Caching

Feature extraction is more expensive than distance calculation.

The persistent feature cache is keyed by:

```text
frame content hash
feature
normalized ROI coordinates
representation kind
```

Representation kinds include:

```text
hist
gray
resnet18
resnet50
```

Changing a frame’s contents or ROI coordinates produces a different cache key.

Scored-result caches additionally depend on:

- The camera and feature
- The ROI
- The current golden signature
- The current frame-set signature

Therefore, changing goldens can reuse extracted image representations while recomputing the relevant distances.

## Computational cost

For:

```text
C candidates
G goldens
M scoring methods
```

nearest-reference comparison is approximately:

```text
O(C × G × M)
```

The expensive neural feature extraction is cached per frame and ROI, but each new golden configuration still requires distance comparisons.

For the intended modest golden sets this is practical. Very large reference sets may require vectorization, clustering, or representative-reference selection.

## Observed behavior on real data

Measurements on representative project data found:

- Many ROI cutouts are near duplicates.
- ResNet distances can occupy a narrow numerical range.
- CPU and ResNet rankings differ meaningfully.
- SSIM dominates the current equal-weight CPU combination.
- MSE has had little effect on observed ranking.
- OK/NG margins can be extremely small.

These observations support using the scores for review ordering rather than automatic classification.

See [[findings-real-data-method-comparison]] for the recorded measurements.

## Known limitations

### Metric scale mismatch

The classical metrics share a nominal `[0, 1]` range but do not occupy comparable ranges on real project data. Their combined score is therefore not calibrated.

Possible future approaches include:

- Empirical scale normalization per metric
- Robust percentile scaling
- Per-feature calibration
- Validated non-equal weights

### Alignment sensitivity

MSE and SSIM are sensitive to small spatial shifts. Histogram distance ignores most position information but cannot compensate for the other metrics.

Possible future improvements include:

- Template matching
- Phase correlation
- Local alignment
- Carefully constrained registration

Alignment must not hide genuine component displacement.

### Lighting sensitivity

Classical representations can react to illumination changes.

Possible future improvements include:

- CLAHE
- Brightness normalization
- Controlled reference selection

Normalization must not remove lighting changes that are themselves meaningful.

### Candidate redundancy

Distance to goldens measures coverage relative to the reference set. It does not guarantee diversity among candidates selected together.

Several high-novelty candidates may be near duplicates of one another.

Coverage-aware selection or greedy farthest-point sampling could address this:

1. Select the candidate farthest from current references.
2. Temporarily add it to the covered set.
3. Re-rank the remaining candidates.
4. Repeat until the desired set size is reached.

### Domain mismatch

Pretrained ImageNet embeddings were not trained specifically for the inspected components or defects.

They provide a useful second opinion, not guaranteed defect-sensitive features.

## Interpretation rules

Treat the scores according to these rules:

- Leaning is not a label.
- Margin is not probability.
- Novelty is not defect probability.
- Agreement is not proof.
- Disagreement is not failure.
- A method’s absolute score should not be compared blindly across unrelated
  features.
- Human-reviewed labels remain authoritative.

## Related documents

- [[current-project|Current project]]
- [[data-model|Canonical data model]]
- [[findings-real-data-method-comparison|Real-data scoring findings]]
