"""Terminal styling for the start-up screen: colours, boxes, a spinner. Falls back to plain text when output is not a terminal.

Everything here is cosmetic. ``fancy()`` is false for pipes, files, tests and terminals that cannot do ANSI, and the
callers then print the plain lines they always printed.
"""
from __future__ import annotations

import itertools
import os
import sys
import threading
import time

RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
GREEN, RED, YELLOW, CYAN, BLUE, GREY = "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[34m", "\033[90m"
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def fancy() -> bool:
    """True when stdout is an interactive terminal that understands ANSI codes and UTF-8."""
    out = sys.stdout
    if not getattr(out, "isatty", lambda: False)() or os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        return False
    if sys.platform == "win32" and not (os.environ.get("WT_SESSION") or os.environ.get("TERM_PROGRAM")):
        return False  # the old Windows console shows the codes as text
    return "utf" in (getattr(out, "encoding", "") or "").lower()


def paint(text: str, *codes: str) -> str:
    return "".join(codes) + text + RESET


def link(url: str) -> str:
    """A clickable hyperlink in terminals that support OSC 8 (others show the plain text)."""
    return f"\033]8;;{url}\033\\{url}\033]8;;\033\\"


def box(rows: list[tuple[str, str]], colour: str, indent: str = "  ") -> str:
    """A rounded box. Each row is (plain text, styled text); the plain text decides the width."""
    width = max(len(plain) for plain, _ in rows) + 2
    lines = [f"{indent}{colour}╭{'─' * width}╮{RESET}"]
    lines += [f"{indent}{colour}│{RESET} {styled}{' ' * (width - 1 - len(plain))}{colour}│{RESET}" for plain, styled in rows]
    lines.append(f"{indent}{colour}╰{'─' * width}╯{RESET}")
    return "\n".join(lines)


class Spinner:
    """Animates one line ("<frame> <text>") on the current terminal row until stopped; ``with`` also hides the cursor."""

    def __init__(self, text: str) -> None:
        self.text, self._stop, self._t0 = text, threading.Event(), time.perf_counter()
        self._thread = threading.Thread(target=self._spin, name="spinner", daemon=True)

    def _spin(self) -> None:
        for frame in itertools.cycle(SPINNER):
            if self._stop.is_set():
                return
            elapsed = time.perf_counter() - self._t0
            sys.stdout.write(f"\r\033[2K  {paint(frame, CYAN)} {self.text} {paint(f'{elapsed:.1f} s', GREY)}")
            sys.stdout.flush()
            self._stop.wait(0.08)

    def __enter__(self) -> "Spinner":
        sys.stdout.write("\033[?25l")
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join()
        sys.stdout.write("\r\033[2K\033[?25h")
        sys.stdout.flush()
