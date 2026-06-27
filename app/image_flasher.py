"""Runs flash-edl.sh and streams its output line by line.

The script handles EDL device detection, image selection, and flashing.
This module is responsible only for subprocess management and output streaming.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from collections.abc import Awaitable, Callable

from .events import FlashLogEvent, FlashSlotFinishedEvent, FlashSlotStartedEvent

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_FLASH_SCRIPT = _PROJECT_ROOT / "flash-edl.sh"
_FLASHER_CLI = _PROJECT_ROOT / "arduino-flasher-cli"


def flasher_cli_available() -> bool:
    return _FLASHER_CLI.is_file()


async def flash_boards(
    emit: Callable[
        [FlashSlotStartedEvent | FlashLogEvent | FlashSlotFinishedEvent],
        Awaitable[None],
    ],
) -> tuple[int, int]:
    """Run flash-edl.sh, stream all output, return (success, total) as (0|1, 1)."""
    await emit(FlashSlotStartedEvent(slot=0, total=1))

    proc = await asyncio.create_subprocess_exec(
        "bash", str(_FLASH_SCRIPT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,  # merge stderr into single stream
        cwd=str(_PROJECT_ROOT),
    )

    buf = b""
    while True:
        chunk = await proc.stdout.read(256)  # type: ignore[union-attr]
        if not chunk:
            if buf:
                line = buf.decode(errors="replace").rstrip()
                if line:
                    await emit(FlashLogEvent(slot=0, line=line, stream="stdout"))
            break
        buf += chunk
        while True:
            nl = buf.find(b"\n")
            cr = buf.find(b"\r")
            if nl == -1 and cr == -1:
                break
            if nl == -1:
                pos = cr
            elif cr == -1:
                pos = nl
            else:
                pos = min(nl, cr)
            line = buf[:pos].decode(errors="replace").rstrip()
            buf = buf[pos + 1:]
            if line:
                await emit(FlashLogEvent(slot=0, line=line, stream="stdout"))

    await proc.wait()
    success = proc.returncode == 0
    await emit(FlashSlotFinishedEvent(slot=0, result="success" if success else "failed"))
    return (1, 1) if success else (0, 1)
