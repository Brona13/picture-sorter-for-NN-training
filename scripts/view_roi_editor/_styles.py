"""Inline CSS for the ROI editor — kept separate from render code."""

# Let the product multiselect on each ROI card read as bare chips rather than a
# form field, and colour them as scope info (blue) instead of the theme's accent
# red, which reads like a warning. Purely cosmetic: if a future Streamlit renames
# these hooks the widget simply falls back to default styling.
MULTISELECT_CHIPS_CSS = (
    "<style>"
    "[data-testid='stMultiSelect'] div[data-baseweb='select'] > div{"
    "background:transparent;border-color:transparent;min-height:32px}"
    "[data-testid='stMultiSelect'] span[data-baseweb='tag']{"
    "background-color:#185fa5}"
    "</style>"
)
