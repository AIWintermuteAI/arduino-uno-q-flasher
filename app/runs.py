"""In-memory registry of active runs + WebSocket event broker.

Each run has:
  - a FlasherContext (paths, password)
  - one DeviceState per device
  - a list of subscriber queues; events are fanned out to every subscriber
  - a replay buffer so a freshly-connected WS gets prior events
"""
from __future__ import annotations

import asyncio
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .events import (
    DeviceFinishedEvent,
    DeviceState,
    Event,
    FlashEvent,
    FlashRunFinishedEvent,
    FlashSlotFinishedEvent,
    FlashSlotStartedEvent,
    FlashSlotState,
    LogEvent,
    RunFinishedEvent,
    Stage,
    StageEvent,
)
from .flasher import FlasherContext, flash_device


@dataclass
class Upload:
    upload_id: str
    folder: Path  # path to staged folder on disk
    name: str  # original folder name


@dataclass
class Run:
    run_id: str
    ctx: FlasherContext
    devices: dict[str, DeviceState] = field(default_factory=dict)
    subscribers: list[asyncio.Queue[Event]] = field(default_factory=list)
    event_log: list[Event] = field(default_factory=list)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    upload: Upload | None = None
    _tasks: dict[str, asyncio.Task] = field(default_factory=dict)


class Registry:
    def __init__(self, uploads_dir: Path) -> None:
        self.uploads_dir = uploads_dir
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self._uploads: dict[str, Upload] = {}
        self._runs: dict[str, Run] = {}
        self._flash_runs: dict[str, FlashRun] = {}

    # ---------- uploads ----------

    def new_upload_dir(self) -> tuple[str, Path]:
        upload_id = uuid.uuid4().hex[:12]
        target = self.uploads_dir / upload_id
        target.mkdir(parents=True, exist_ok=True)
        return upload_id, target

    def register_upload(self, upload_id: str, folder: Path, name: str) -> Upload:
        upload = Upload(upload_id=upload_id, folder=folder, name=name)
        self._uploads[upload_id] = upload
        return upload

    def get_upload(self, upload_id: str) -> Upload | None:
        return self._uploads.get(upload_id)

    def cleanup_upload(self, upload_id: str) -> None:
        upload = self._uploads.pop(upload_id, None)
        if upload and upload.folder.exists():
            shutil.rmtree(upload.folder, ignore_errors=True)

    # ---------- runs ----------

    def create_run(self, ctx: FlasherContext, upload: Upload | None) -> Run:
        run_id = uuid.uuid4().hex[:12]
        run = Run(run_id=run_id, ctx=ctx, upload=upload)
        self._runs[run_id] = run
        return run

    def get_run(self, run_id: str) -> Run | None:
        return self._runs.get(run_id)

    # ---------- pub/sub ----------

    async def emit(self, run: Run, event: Event) -> None:
        run.event_log.append(event)
        self._apply_to_device_state(run, event)
        for q in list(run.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe(self, run: Run) -> asyncio.Queue[Event]:
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=10_000)
        # replay
        for ev in run.event_log:
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                break
        run.subscribers.append(q)
        return q

    def unsubscribe(self, run: Run, q: asyncio.Queue[Event]) -> None:
        if q in run.subscribers:
            run.subscribers.remove(q)

    def _apply_to_device_state(self, run: Run, event: Event) -> None:
        if isinstance(event, StageEvent):
            d = run.devices.get(event.device)
            if not d:
                return
            d.stages[event.stage] = event.status
            if event.status == "started":
                d.current_stage = event.stage
                d.status = "running"
        elif isinstance(event, DeviceFinishedEvent):
            d = run.devices.get(event.device)
            if not d:
                return
            d.status = event.result  # type: ignore[assignment]
            d.current_stage = None
            d.elapsed_seconds = event.elapsed_seconds
            d.failure_reason = event.failure_reason

    # ---------- run lifecycle ----------

    async def run_devices(
        self,
        run: Run,
        device_configs: list[tuple[str, set[Stage]]],
    ) -> None:
        """Kick off all devices in parallel and wait for completion."""
        for serial, skip in device_configs:
            run.devices[serial] = DeviceState(
                serial=serial,
                status="idle",
                skip_stages=list(skip),
            )

        async def run_one(serial: str, skip: set[Stage]) -> str:
            ok = await flash_device(
                serial,
                run.ctx,
                skip,
                lambda ev: self.emit(run, ev),
            )
            return "success" if ok else "failed"

        tasks: dict[str, asyncio.Task] = {}
        for serial, skip in device_configs:
            t = asyncio.create_task(run_one(serial, skip))
            tasks[serial] = t
            run._tasks[serial] = t

        results = await asyncio.gather(*tasks.values(), return_exceptions=True)

        successful: list[str] = []
        failed: list[str] = []
        for serial, res in zip(tasks.keys(), results):
            if isinstance(res, Exception):
                failed.append(serial)
                await self.emit(
                    run,
                    LogEvent(
                        device=serial,
                        line=f"Unhandled exception: {res!r}",
                        stream="stderr",
                    ),
                )
                await self.emit(
                    run,
                    DeviceFinishedEvent(device=serial, result="failed"),
                )
            elif res == "success":
                successful.append(serial)
            else:
                failed.append(serial)

        await self.emit(
            run,
            RunFinishedEvent(successful=successful, failed=failed),
        )

        run.finished.set()

        # Only auto-cleanup when every device succeeded. If any failed, keep
        # the staged upload around so the user can hit Retry.
        if not failed and run.upload is not None:
            self.cleanup_upload(run.upload.upload_id)
            run.upload = None

    async def retry_device(
        self, run: Run, serial: str, skip: set[Stage]
    ) -> None:
        """Re-run a single device using the same context."""
        if serial in run._tasks and not run._tasks[serial].done():
            return  # already running
        run.devices[serial] = DeviceState(
            serial=serial,
            status="idle",
            skip_stages=list(skip),
        )

        async def run_one() -> None:
            await flash_device(
                serial,
                run.ctx,
                skip,
                lambda ev: self.emit(run, ev),
            )

        t = asyncio.create_task(run_one())
        run._tasks[serial] = t


@dataclass
class FlashRun:
    flash_run_id: str
    board_count: int
    slots: dict[int, FlashSlotState] = field(default_factory=dict)
    subscribers: list[asyncio.Queue[FlashEvent]] = field(default_factory=list)
    event_log: list[FlashEvent] = field(default_factory=list)
    finished: asyncio.Event = field(default_factory=asyncio.Event)


def _apply_to_flash_slot_state(run: FlashRun, event: FlashEvent) -> None:
    if isinstance(event, FlashSlotStartedEvent):
        s = run.slots.get(event.slot)
        if s:
            s.status = "running"
    elif isinstance(event, FlashSlotFinishedEvent):
        s = run.slots.get(event.slot)
        if s:
            s.status = event.result  # type: ignore[assignment]


def _add_flash_run_methods(cls: type) -> type:
    """Attach flash-run methods to Registry at module load time."""

    def create_flash_run(self, board_count: int) -> FlashRun:
        flash_run_id = uuid.uuid4().hex[:12]
        run = FlashRun(flash_run_id=flash_run_id, board_count=board_count)
        for i in range(board_count):
            run.slots[i] = FlashSlotState(slot=i)
        self._flash_runs[flash_run_id] = run
        return run

    def get_flash_run(self, flash_run_id: str) -> FlashRun | None:
        return self._flash_runs.get(flash_run_id)

    async def emit_flash(self, run: FlashRun, event: FlashEvent) -> None:
        run.event_log.append(event)
        _apply_to_flash_slot_state(run, event)
        for q in list(run.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe_flash(self, run: FlashRun) -> asyncio.Queue[FlashEvent]:
        q: asyncio.Queue[FlashEvent] = asyncio.Queue(maxsize=10_000)
        for ev in run.event_log:
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                break
        run.subscribers.append(q)
        return q

    def unsubscribe_flash(self, run: FlashRun, q: asyncio.Queue[FlashEvent]) -> None:
        if q in run.subscribers:
            run.subscribers.remove(q)

    async def run_flash(self, run: FlashRun) -> None:
        from .image_flasher import flash_boards
        success_count, total = await flash_boards(
            run.board_count,
            lambda ev: self.emit_flash(run, ev),
        )
        await self.emit_flash(run, FlashRunFinishedEvent(success_count=success_count, total=total))
        run.finished.set()

    cls.create_flash_run = create_flash_run
    cls.get_flash_run = get_flash_run
    cls.emit_flash = emit_flash
    cls.subscribe_flash = subscribe_flash
    cls.unsubscribe_flash = unsubscribe_flash
    cls.run_flash = run_flash
    return cls


_add_flash_run_methods(Registry)
