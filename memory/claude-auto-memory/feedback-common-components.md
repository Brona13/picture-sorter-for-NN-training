---
name: feedback-common-components
description: The user wants one shared implementation of any behaviour that appears on several pages (viewer, grid, painting, cursor); build or extract the shared piece instead of copying
metadata:
  type: feedback
---

When a behaviour exists (or will exist) on more than one page, make it one shared piece that the pages parametrise, not a copy. The user said it directly three times on 2026-10-18: the picture viewer ("make it common ... develop it once, use it more than once"), the painting and its cursor, and the card grid ("every grid should have the same functionality, only the keys, colours and what an action does differ").

**Why:** the user tests in the browser page by page and notices every inconsistency (a hand cursor instead of the colour dot, a file name at the top of one viewer, a grid that cannot be swept). Duplicated code is how those drift apart.

**How to apply:** before adding behaviour to a page, check for the shared piece (`PictureViewer`, `FramePane`, `useBrowse`, `CardGrid`, `useGridCard`, `painter.ts`) and use or extend it; when a second copy would appear, extract the shared piece first and port the first user. Differences go in as props or callbacks. Update the shared piece's tests, not just the page's. Related: [[feedback-agree-before-building]].
