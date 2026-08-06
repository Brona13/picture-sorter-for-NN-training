"""Static JS/CSS blobs injected into the Classify view.

Kept out of the render code so an unrelated edit doesn't pay the token cost of
re-encoding a 50-line HTML string every time the surrounding lines are read.
"""

# --- OK-in-green tint ---
# Streamlit primary buttons all take the theme's primary colour (red here), and
# CSS can't select a button by its text content, so a plain `<style>` block
# would tint every primary button — including NG-active, Refresh, and the class
# buttons on the product ROI. A tiny component script running in the parent
# document adds a marker class to just the primary `OK` buttons; the styling
# then rides on that class. Runs once per rerun; a MutationObserver catches
# subsequent DOM churn (e.g. a page turn) without a heavy poll.
OK_TINT_JS = """
<script>
(function () {
  const doc = window.parent.document;
  const STYLE_ID = 'classify-ok-tint';
  const CLASS = 'classify-ok-active';

  if (!doc.getElementById(STYLE_ID)) {
    const s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      button.${CLASS},
      button.${CLASS}:focus {
        background-color: #1a7f37 !important;
        border-color:     #1a7f37 !important;
        color: #fff !important;
      }
      button.${CLASS}:hover {
        background-color: #146428 !important;
        border-color:     #146428 !important;
      }
    `;
    doc.head.appendChild(s);
  }

  const paint = () => {
    doc.querySelectorAll('button').forEach((b) => {
      const on = b.getAttribute('kind') === 'primary'
              && b.textContent.trim() === 'OK';
      b.classList.toggle(CLASS, on);
    });
  };
  paint();
  if (!window.__classifyOkObserver) {
    window.__classifyOkObserver = new MutationObserver(paint);
    window.__classifyOkObserver.observe(doc.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['kind'],
    });
  }
})();
</script>
"""
