# Picture Sorter: UI navigation handover

## 1. App frame
- Picture sorter: ingest messy raw pictures (including bad or wrong ones) into a camera, then narrow them down to the most relevant set for training the downstream neural network.

## 2. Navigation decisions
- Four top-level items: **Overview**, **Management** (new camera, ingest pictures), **Manipulation**, **Export**.
- Export includes freezing versions.
- **Configuration** is a separate button, not in the list.
- Manipulation opens a second-level navigation along the top of the page.
- Each tool gets its own icon: muted two-tone when unused, colorful once used in the project.
- Tools are grouped by purpose (duplicates, noise, rule-based). Names and grouping are not final.
- The header showing project and frame position moves to a slim fixed status bar at the bottom.
- The progress bar will be reworked later.

## 3. Dedup page
- Idea: scatter plot first, cluster browser below.
- Current order was not confirmed. Check in the app.

## 4. Shared picture grid
- Unify the picture grids so labeling and deleting go through one shared component.
- This gives a single place to hook events such as "frames changed".

## 5. Parked ideas (revisit later)
- Precompute scatter and clustering in the background, without a button press.
  - Trigger: user navigates away from the grid. Alternative: debounce after the last change.
  - Incremental recompute is possible, since only added or removed frames change the result.
- A small, quiet "ready / needs refresh" indicator near the scatter.
- Other pages could be precomputed the same way. Not yet reviewed.

## 6. General UI principles discussed
- Progressive disclosure
- Group by task, not data type
- Consistent placement (spatial memory)
- Clear visual hierarchy
- Sensible defaults
- Fast feedback

## 7. Open items
- Final names for Management and Manipulation.
- Whether any current sidebar items need a home outside the four.
- The Detector page is the least developed and needs a fresh look.
- Visual design (colors, style) comes later in Claude Design.
