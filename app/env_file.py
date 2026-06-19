"""Read and write .env files, preserving comments and unknown keys.

We only touch the keys we own; everything else is passed through unchanged.
"""
from __future__ import annotations

import os
from pathlib import Path

# Keys this app manages via the UI/API.
MANAGED_KEYS = (
    "UNOQ_WIFI_SSID",
    "UNOQ_WIFI_PASSWORD",
    "UNOQ_DEFAULT_PASSWORD",
)


def read_env(path: Path) -> dict[str, str]:
    """Return a flat dict of KEY=VALUE pairs found in the file.

    Empty or comment lines are ignored. Values may be quoted with " or ';
    quotes are stripped.
    """
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        out[key] = value
    return out


def write_env(path: Path, updates: dict[str, str]) -> None:
    """Update `path` in place: replace any line that sets a key in `updates`,
    append the rest. Preserves comments and other keys.
    """
    existing_lines: list[str] = []
    if path.exists():
        existing_lines = path.read_text(encoding="utf-8").splitlines()

    seen: set[str] = set()
    new_lines: list[str] = []
    for line in existing_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            new_lines.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            new_lines.append(f"{key}={_quote(updates[key])}")
            seen.add(key)
        else:
            new_lines.append(line)

    for key, value in updates.items():
        if key not in seen:
            new_lines.append(f"{key}={_quote(value)}")

    path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    # Reflect into the running process immediately.
    for k, v in updates.items():
        os.environ[k] = v


def _quote(value: str) -> str:
    """Quote a .env value if it contains whitespace or special characters."""
    if value == "":
        return ""
    needs_quote = any(c.isspace() or c in "#'\"$" for c in value)
    if not needs_quote:
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
