"""Runs arduino-flasher-cli flash latest once per requested slot.

Each call streams stdout/stderr lines to a callback and auto-answers
the interactive download prompt with 'y'.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from collections.abc import Awaitable, Callable

from .events import FlashLogEvent, FlashSlotFinishedEvent, FlashSlotStartedEvent

FLASHER_CLI = "arduino-flasher-cli"
_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _flasher_cli_path() -> Path:
    return _PROJECT_ROOT / FLASHER_CLI


def flasher_cli_available() -> bool:
    return _flasher_cli_path().is_file()


async def flash_slot(
    slot: int,
    total: int,
    emit: Callable[
        [FlashSlotStartedEvent | FlashLogEvent | FlashSlotFinishedEvent],
        Awaitable[None],
    ],
) -> bool:
    """Run the CLI tool for one slot. Returns True on success."""
    await emit(FlashSlotStartedEvent(slot=slot, total=total))

    temp_dir = _PROJECT_ROOT / ".flash-tmp"
    temp_dir.mkdir(exist_ok=True)

    proc = await asyncio.create_subprocess_exec(
        str(_flasher_cli_path()), "flash", "latest", "--yes",
        "--temp-dir", str(temp_dir),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(_PROJECT_ROOT),
    )

    async def drain(stream: asyncio.StreamReader, stream_name: str) -> None:
        buf = b""
        while True:
            chunk = await stream.read(256)
            if not chunk:
                # Flush any remaining buffered content.
                if buf:
                    line = buf.decode(errors="replace").rstrip()
                    if line:
                        await emit(FlashLogEvent(slot=slot, line=line, stream=stream_name))  # type: ignore[arg-type]
                break
            buf += chunk
            # Split on both \n and \r so progress-bar updates emit immediately.
            while True:
                nl = buf.find(b"\n")
                cr = buf.find(b"\r")
                if nl == -1 and cr == -1:
                    break
                if nl == -1:
                    pos, skip = cr, 1
                elif cr == -1:
                    pos, skip = nl, 1
                else:
                    pos, skip = (nl, 1) if nl < cr else (cr, 1)
                line = buf[:pos].decode(errors="replace").rstrip()
                buf = buf[pos + skip:]
                if line:
                    await emit(FlashLogEvent(slot=slot, line=line, stream=stream_name))  # type: ignore[arg-type]

    await asyncio.gather(
        drain(proc.stdout, "stdout"),  # type: ignore[arg-type]
        drain(proc.stderr, "stderr"),  # type: ignore[arg-type]
    )
    await proc.wait()

    success = proc.returncode == 0
    await emit(FlashSlotFinishedEvent(slot=slot, result="success" if success else "failed"))
    return success


async def flash_boards(
    board_count: int,
    emit: Callable[
        [FlashSlotStartedEvent | FlashLogEvent | FlashSlotFinishedEvent],
        Awaitable[None],
    ],
) -> tuple[int, int]:
    """Flash `board_count` boards sequentially. Returns (success_count, total)."""
    success_count = 0
    for slot in range(board_count):
        ok = await flash_slot(slot, board_count, emit)
        if ok:
            success_count += 1
    return success_count, board_count
