/**
 * What a Classify screen offers, by the step of its Classifier (the two-step solution, `plans/two-step-solution.md`).
 * Step 1 decides OK / NG: labeling and delete, no goldens. Step 2 chooses the pictures: the labels come from the freeze
 * and are final, so there are goldens and Mute, no labeling and no camera-wide delete.
 */
export interface ClassifyMode {
  /** Class buttons, label keys, painting, batch labeling and the tools that label many pictures. */
  labeling: boolean;
  /** The golden star and key, and the tools that suggest or promote goldens. */
  goldens: boolean;
  /** The camera-wide delete (and restore of a deleted picture). */
  deleting: boolean;
  /** Mute for this Classifier only (step 2). */
  muting: boolean;
}

/** A server that does not say the step (or a screen that does not know it yet) gets everything, as before the two steps. */
export const ALL_ON: ClassifyMode = { labeling: true, goldens: true, deleting: true, muting: false };

export const modeOfStep = (step: 1 | 2 | undefined): ClassifyMode =>
  step === 2
    ? { labeling: false, goldens: true, deleting: false, muting: true }
    : step === 1
      ? { labeling: true, goldens: false, deleting: true, muting: false }
      : ALL_ON;

/** The line a step-2 Classify screen shows where labeling would be. */
export const STEP_TWO_HINT = "Step 2: the labels come from the last freeze of step 1 and are final here. Wrong label? Change it in step 1 and Freeze again; Mute takes a picture out of this Classifier only.";
