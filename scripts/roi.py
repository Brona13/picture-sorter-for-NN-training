"""Region-of-interest definition and cropping.

A ROI is stored in **normalised** coordinates (all in ``[0, 1]``) so the same
definition applies regardless of image resolution — robust if golden and
candidate frames differ slightly in size. A feature is a *named* ROI.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class ROI:
    """A named rectangle in normalised (0-1) coordinates.

    ``x, y`` is the top-left corner; ``w, h`` are width and height, all as
    fractions of the image width/height.

    ``role`` distinguishes the two jobs a ROI can do:

      * ``"quality"`` (default) — an OK/NG-style inspection ROI.
      * ``"classify"`` — the product-sorting ROI whose ``classes`` are the
        product names; it assigns every frame exactly one product.

    ``classes`` is the ROI's own class vocabulary; ``None`` means "use the
    project default" (``config.CLASSES`` = OK/NG).

    ``products`` marks a **shared** camera-level ROI as applying to just those
    products (e.g. a region that looks identical on 4x4 and 4x4RS but not on
    2x4). One ROI, one golden set, one label set, surfaced under each listed
    product. ``None`` = not restricted. It is meaningless on a ROI that already
    carries a product in its name (``"<product>::<roi>"``).

    Optional fields are omitted when they use their defaults, keeping the file
    compact and human-readable.
    """

    name: str
    x: float
    y: float
    w: float
    h: float
    role: str = "quality"
    classes: list[str] | None = None
    products: list[str] | None = None

    # --- (de)serialisation ---------------------------------------------------
    def to_dict(self) -> dict:
        d: dict = {"name": self.name, "x": self.x, "y": self.y, "w": self.w, "h": self.h}
        # Store optional fields only when they deviate from the defaults.
        if self.role != "quality":
            d["role"] = self.role
        if self.classes:
            d["classes"] = list(self.classes)
        if self.products:
            d["products"] = list(self.products)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ROI":
        raw_classes = d.get("classes")
        raw_products = d.get("products")
        return cls(
            name=str(d["name"]),
            x=float(d["x"]),
            y=float(d["y"]),
            w=float(d["w"]),
            h=float(d["h"]),
            role=str(d.get("role", "quality")),
            classes=[str(c) for c in raw_classes] if raw_classes else None,
            products=[str(p) for p in raw_products] if raw_products else None,
        )

    @classmethod
    def full_frame(cls, name: str) -> "ROI":
        """A ROI covering the entire image."""
        return cls(name=name, x=0.0, y=0.0, w=1.0, h=1.0)

    def is_full_frame(self) -> bool:
        return self.x <= 0 and self.y <= 0 and self.w >= 1 and self.h >= 1

    # --- geometry ------------------------------------------------------------
    def to_pixels(self, img_w: int, img_h: int) -> tuple[int, int, int, int]:
        """Return the pixel box ``(x0, y0, x1, y1)`` clamped to the image."""
        x0 = int(round(self.x * img_w))
        y0 = int(round(self.y * img_h))
        x1 = int(round((self.x + self.w) * img_w))
        y1 = int(round((self.y + self.h) * img_h))
        x0 = max(0, min(x0, img_w))
        x1 = max(0, min(x1, img_w))
        y0 = max(0, min(y0, img_h))
        y1 = max(0, min(y1, img_h))
        # Guarantee at least a 1px box even for degenerate definitions.
        if x1 <= x0:
            x1 = min(img_w, x0 + 1)
        if y1 <= y0:
            y1 = min(img_h, y0 + 1)
        return x0, y0, x1, y1

    def crop(self, image: np.ndarray) -> np.ndarray:
        """Crop ``image`` (H x W [x C]) to this ROI and return the cutout."""
        h, w = image.shape[:2]
        x0, y0, x1, y1 = self.to_pixels(w, h)
        return image[y0:y1, x0:x1]
