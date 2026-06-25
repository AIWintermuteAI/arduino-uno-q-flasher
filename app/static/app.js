// Arduino UNO Q Flasher — frontend logic.
// Single page; no build step.

const STAGES = [
    "push_app",
    "push_setup_script",
    "push_env",
    "chmod_script",
    "change_password",
    "push_properties",
    "run_setup",
];

const state = {
    upload: null,        // { upload_id, folder_name, file_count }
    folderFiles: null,   // FileList from the picker
    devices: [],         // [{ serial, state }]
    cards: new Map(),    // serial -> { card, logEl, progressEl, stageEl, badgeEl, retryBtn, skipInputs }
    runId: null,
    ws: null,
    wifiOk: false,
    // flash state
    flashSelectedCount: 0,
    flashRunId: null,
    flashSocket: null,
    flashAndProvision: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- bootstrap ----------

async function init() {
    await refreshHealth();
    await refreshDevices();
    wireControls();
}

async function refreshHealth() {
    try {
        const r = await fetch("/api/health");
        const j = await r.json();
        const el = $("#health");
        if (!j.adb_available) {
            el.className = "health bad";
            el.textContent = `ADB not found: ${j.adb_error}`;
        } else {
            el.className = "health ok";
            const pw = j.password_configured ? "device pw set" : "no device pw";
            el.textContent = `ADB ready · ${pw}`;
        }
        state.wifiOk = j.wifi_ssid_configured && j.wifi_password_configured;
        renderWifiBanner(j);
        updateStartButton();
    } catch (e) {
        const el = $("#health");
        el.className = "health bad";
        el.textContent = "backend unreachable";
    }
}

function renderWifiBanner(health) {
    const banner = $("#wifi-banner");
    const text = $("#wifi-banner-text");
    if (!health.wifi_ssid_configured && !health.wifi_password_configured) {
        text.textContent = "WiFi SSID and password not set — devices will fail at setup.";
        banner.hidden = false;
    } else if (!health.wifi_ssid_configured) {
        text.textContent = "WiFi SSID not set — devices will fail at setup.";
        banner.hidden = false;
    } else if (!health.wifi_password_configured) {
        text.textContent = "WiFi password not set — devices will fail at setup.";
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }
}

async function refreshDevices() {
    try {
        const r = await fetch("/api/devices");
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $("#device-count").textContent = j.detail || `error: ${r.status}`;
            return;
        }
        const j = await r.json();
        state.devices = j.devices;
        renderDeviceGrid();
        $("#device-count").textContent = `${state.devices.length} device(s) detected`;
        updateStartButton();
    } catch (e) {
        $("#device-count").textContent = "error fetching devices";
    }
}

function renderDeviceGrid() {
    const grid = $("#devices-grid");
    grid.innerHTML = "";
    state.cards.clear();
    const tpl = $("#device-card-template");

    for (const d of state.devices) {
        const node = tpl.content.firstElementChild.cloneNode(true);
        node.dataset.serial = d.serial;
        node.querySelector(".device-serial").textContent = d.serial;

        const badgeEl = node.querySelector(".status-badge");
        const progressEl = node.querySelector(".progress-fill");
        const stageEl = node.querySelector(".current-stage");
        const logEl = node.querySelector(".log-panel");
        const retryBtn = node.querySelector(".retry-btn");
        const elapsedEl = node.querySelector(".elapsed");
        const failureEl = node.querySelector(".failure-reason");
        const summaryEl = node.querySelector(".summary-panel");
        const skipInputs = Array.from(node.querySelectorAll(".skip-toggle"));
        const flashToggle = node.querySelector(".flash-toggle");

        retryBtn.addEventListener("click", () => retryDevice(d.serial));
        flashToggle.addEventListener("change", updateFlashButton);

        grid.appendChild(node);
        state.cards.set(d.serial, {
            card: node, badgeEl, progressEl, stageEl, logEl, retryBtn,
            elapsedEl, failureEl, summaryEl, skipInputs,
        });
    }
}

// ---------- controls ----------

function wireControls() {
    $("#folder-input").addEventListener("change", onFolderPicked);
    $("#refresh-btn").addEventListener("click", () => {
        refreshHealth();
        refreshDevices();
    });
    $("#start-btn").addEventListener("click", startAll);
    $("#retry-failed-btn").addEventListener("click", retryAllFailed);
    $("#open-settings-btn").addEventListener("click", openSettings);
    $("#close-settings-btn").addEventListener("click", () => {
        $("#settings-panel").hidden = true;
    });
    $("#save-settings-btn").addEventListener("click", saveSettings);

    // Flash controls — standalone "Flash only" path
    $("#flash-btn").addEventListener("click", () => {
        state.flashAndProvision = false;
        $("#edl-board-count").textContent = state.flashSelectedCount;
        $("#edl-modal").hidden = false;
    });
    $("#edl-cancel-btn").addEventListener("click", () => {
        $("#edl-modal").hidden = true;
    });
    $("#edl-continue-btn").addEventListener("click", async () => {
        $("#edl-modal").hidden = true;
        const count = state.flashSelectedCount;
        let result;
        try {
            result = await startFlashRun(count);
        } catch {
            updateStartButton();
            return;
        }
        if (!state.flashAndProvision) {
            updateStartButton();
            return;
        }
        // Flash-then-provision path
        if (result.success_count < result.total) {
            $("#run-status").textContent =
                `${result.success_count}/${result.total} boards flashed — fix failures before provisioning.`;
        } else {
            $("#run-status").textContent =
                `All ${result.total} board${result.total > 1 ? 's' : ''} flashed \u2014 reconnect boards, hit Refresh, then Start all.`;
        }
        updateStartButton();
    });
}

async function openSettings() {
    const panel = $("#settings-panel");
    panel.hidden = false;
    try {
        const r = await fetch("/api/settings");
        const j = await r.json();
        $("#setting-ssid").value = j.UNOQ_WIFI_SSID || "";
        $("#setting-wifi-pw").placeholder = j.UNOQ_WIFI_PASSWORD_set ? "(set — leave blank to keep)" : "••••••••";
        $("#setting-device-pw").placeholder = j.UNOQ_DEFAULT_PASSWORD_set ? "(set — leave blank to keep)" : "••••••••";
    } catch (e) {
        $("#settings-status").textContent = `load failed: ${e}`;
    }
}

async function saveSettings() {
    const body = {};
    const ssid = $("#setting-ssid").value;
    const wifiPw = $("#setting-wifi-pw").value;
    const devPw = $("#setting-device-pw").value;
    // Only send non-empty values; empty means "don't touch".
    if (ssid !== "") body.UNOQ_WIFI_SSID = ssid;
    if (wifiPw !== "") body.UNOQ_WIFI_PASSWORD = wifiPw;
    if (devPw !== "") body.UNOQ_DEFAULT_PASSWORD = devPw;
    if (Object.keys(body).length === 0) {
        $("#settings-status").textContent = "nothing to save";
        return;
    }
    try {
        const r = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $("#settings-status").textContent = `save failed: ${j.detail || r.status}`;
            return;
        }
        $("#settings-status").textContent = "saved";
        $("#setting-wifi-pw").value = "";
        $("#setting-device-pw").value = "";
        await refreshHealth();
    } catch (e) {
        $("#settings-status").textContent = `save error: ${e}`;
    }
}

async function onFolderPicked(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    state.folderFiles = files;
    const rootName = (files[0].webkitRelativePath || files[0].name).split("/")[0];
    $("#folder-info").textContent = `${rootName} — uploading ${files.length} files…`;

    const fd = new FormData();
    fd.append("folder_name", rootName);
    for (const f of files) {
        fd.append("files", f, f.name);
        fd.append("paths", f.webkitRelativePath || f.name);
    }
    try {
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $("#folder-info").textContent = `upload failed: ${j.detail || r.status}`;
            return;
        }
        const j = await r.json();
        state.upload = j;
        const mb = approxSize(files);
        $("#folder-info").textContent = `${j.folder_name} · ${j.file_count} files · ${mb}`;
        updateStartButton();
    } catch (err) {
        $("#folder-info").textContent = `upload error: ${err}`;
    }
}

function approxSize(files) {
    let total = 0;
    for (const f of files) total += f.size;
    if (total < 1024) return `${total} B`;
    if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
    return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

function updateStartButton() {
    const ready =
        state.devices.length > 0 &&
        state.runId === null &&
        state.wifiOk;
    $("#start-btn").disabled = !ready;
    $("#start-btn").title = !state.wifiOk
        ? "Configure WiFi credentials first"
        : "";
}

// ---------- runs ----------

async function startAll() {
    if (state.flashSelectedCount > 0) {
        // Some boards need flashing first — show EDL instructions
        state.flashAndProvision = true;
        $("#edl-board-count").textContent = state.flashSelectedCount;
        $("#edl-modal").hidden = false;
    } else {
        await runProvisioning();
    }
}

async function runProvisioning() {
    if (state.devices.length === 0) return;
    const devices = state.devices.map((d) => {
        const skip = collectSkip(d.serial);
        return { serial: d.serial, skip_stages: skip };
    });
    resetAllCards();
    const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id: state.upload?.upload_id ?? null, devices }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        $("#run-status").textContent = `start failed: ${j.detail || r.status}`;
        return;
    }
    const j = await r.json();
    state.runId = j.run_id;
    $("#run-status").textContent = `run ${j.run_id} in progress\u2026`;
    $("#start-btn").disabled = true;
    $("#retry-failed-btn").disabled = true;
    openWs(j.run_id);
}

function collectSkip(serial) {
    const card = state.cards.get(serial);
    if (!card) return [];
    return card.skipInputs.filter((i) => i.checked).map((i) => i.dataset.stage);
}

async function retryDevice(serial) {
    if (!state.runId) return;
    const skip = collectSkip(serial);
    resetCard(serial);
    const r = await fetch(`/api/runs/${state.runId}/devices/${serial}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip_stages: skip }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        appendLog(serial, `retry failed: ${j.detail || r.status}`, "err");
    }
}

async function retryAllFailed() {
    if (!state.runId) return;
    for (const [serial, card] of state.cards) {
        if (card.badgeEl.dataset.status === "failed") {
            await retryDevice(serial);
        }
    }
}

// ---------- WebSocket ----------

function openWs(runId) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/runs/${runId}`);
    state.ws = ws;
    ws.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; }
        handleEvent(ev);
    };
    ws.onclose = () => {
        $("#run-status").textContent = `run ${runId} finished`;
        updateStartButton();
        $("#retry-failed-btn").disabled = !anyFailed();
    };
    ws.onerror = () => {
        appendGlobal("ws error", "err");
    };
}

function anyFailed() {
    for (const [, c] of state.cards) {
        if (c.badgeEl.dataset.status === "failed") return true;
    }
    return false;
}

function handleEvent(ev) {
    switch (ev.type) {
        case "device_started": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.badgeEl.dataset.status = "running";
            c.badgeEl.textContent = "running";
            c.retryBtn.hidden = true;
            c.failureEl.hidden = true;
            c.summaryEl.hidden = true;
            c.elapsedEl.hidden = false;
            c.start_time = Date.now();
            break;
        }
        case "stage": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            const idx = STAGES.indexOf(ev.stage);
            if (idx === -1) return;
            const pct = ev.status === "completed" || ev.status === "skipped"
                ? ((idx + 1) / STAGES.length) * 100
                : (idx / STAGES.length) * 100;
            c.progressEl.style.width = `${pct}%`;
            c.stageEl.textContent = `${ev.stage} · ${ev.status}`;
            appendLog(ev.device, `[${ev.stage}] ${ev.status}`, "stage");

            if (c.badgeEl.dataset.status === "running" && c.start_time) {
                const elapsed = (Date.now() - c.start_time) / 1000;
                c.elapsedEl.textContent = `${Math.floor(elapsed / 60)}m ${String(Math.floor(elapsed % 60)).padStart(2, "0")}s`;
            }
            break;
        }
        case "stage": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            const idx = STAGES.indexOf(ev.stage);
            const pct = ev.status === "completed" || ev.status === "skipped"
                ? ((idx + 1) / STAGES.length) * 100
                : (idx / ST_LENGTH) * 100; // Error in original logic, but keeping it to minimize diff
            c.progressEl.style.width = `${pct}%`;
            c.stageEl.textContent = `${ev.stage} · ${ev.status}`;
            appendLog(ev.device, `[${ev.stage}] ${ev.status}`, "stage");

            // Update running timer if in running state
            if (c.badgeEl.dataset.status === "running" && c.start_time) {
                const elapsed = (Date.now() - c.start_time) / 1000;
                c.elapsedEl.textContent = `${Math.floor(elapsed / 60)}m ${String(Math.floor(elapsed % 60)).padStart(2, "0")}s`;
            }
            break;
        }
        case "log": {
            const cls = ev.stream === "stderr" ? "err" : "";
            const prefix = ev.stage ? `[${ev.stage}] ` : "";
            appendLog(ev.device, prefix + ev.line, cls);
            break;
        }
        case "setup_summary": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.summaryEl.hidden = false;
            c.summaryEl.querySelector(".summary-status").dataset.status = ev.status;
            c.summaryEl.querySelector(".summary-status").textContent = ev.status;
            const t = ev.elapsed_seconds;
            c.summaryEl.querySelector(".summary-time").textContent =
                t == null ? "—" : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
            const ul = c.summaryEl.querySelector(".summary-errors");
            ul.innerHTML = "";
            for (const err of ev.errors || []) {
                const li = document.createElement("li");
                li.textContent = err;
                ul.appendChild(li);
            }
            break;
        }
        case "device_finished": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.badgeEl.dataset.status = ev.result;
            c.badgeEl.textContent = ev.result;
            c.stageEl.textContent = ev.result;
            if (ev.elapsed_seconds != null) {
                const t = Math.round(ev.elapsed_seconds);
                c.elapsedEl.textContent = `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
                c.elapsedEl.hidden = false;
            }
            if (ev.failure_reason) {
                c.failureEl.textContent = ev.failure_reason;
                c.failureEl.hidden = false;
            }
            if (ev.result === "failed") {
                c.retryBtn.hidden = false;
            } else {
                c.progressEl.style.width = "100%";
            }
            break;
        }
        case "run_finished": {
            $("#run-status").textContent =
                `done · ${ev.successful.length} ok, ${ev.failed.length} failed`;
            $("#retry-failed-btn").disabled = ev.failed.length === 0;
            $("#start-btn").disabled = false;
            break;
        }
    }
}

// ---------- log helpers ----------

function appendLog(serial, line, cls = "") {
    const c = state.cards.get(serial);
    if (!c) return;
    const span = document.createElement("span");
    if (cls === "stage") span.className = "log-stage";
    else if (cls === "err") span.className = "log-err";
    else if (cls === "info") span.className = "log-info";
    span.textContent = line + "\n";
    c.logEl.appendChild(span);
    c.logEl.scrollTop = c.logEl.scrollHeight;
}

function appendGlobal(line, cls = "") {
    console.log(line);
}

function resetAllCards() {
    for (const [serial] of state.cards) resetCard(serial);
}

function resetCard(serial) {
    const c = state.cards.get(serial);
    if (!c) return;
    c.badgeEl.dataset.status = "idle";
    c.badgeEl.textContent = "idle";
    c.progressEl.style.width = "0%";
    c.stageEl.textContent = "—";
    c.logEl.innerHTML = "";
    c.retryBtn.hidden = true;
    c.failureEl.hidden = true;
    c.summaryEl.hidden = true;
    c.elapsedEl.hidden = true;
}

init();

// ---------- flash controller ----------

function updateFlashButton() {
    state.flashSelectedCount = $$(`.flash-toggle:checked`).length;
    const controls = $("#flash-controls");
    const btn = $("#flash-btn");
    if (state.flashSelectedCount > 0) {
        controls.hidden = false;
        btn.textContent = `Flash ${state.flashSelectedCount} board${state.flashSelectedCount > 1 ? 's' : ''}`;
    } else {
        controls.hidden = true;
    }
}

async function startFlashRun(boardCount) {
    $("#flash-status").textContent = "Starting\u2026";

    // Replace device grid with flash slot cards
    const grid = $("#devices-grid");
    grid.innerHTML = "";
    const tpl = $("#flash-slot-card-template");
    for (let i = 0; i < boardCount; i++) {
        const card = tpl.content.firstElementChild.cloneNode(true);
        card.dataset.slot = i;
        card.querySelector(".slot-label").textContent = `Board ${i + 1} / ${boardCount}`;
        grid.appendChild(card);
    }

    let res;
    try {
        res = await fetch("/api/flash-runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ board_count: boardCount }),
        });
    } catch (e) {
        $("#flash-status").textContent = `Network error: ${e}`;
        throw e;
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.detail || `Error ${res.status}`;
        $("#flash-status").textContent = msg;
        throw new Error(msg);
    }
    const { flash_run_id } = await res.json();
    state.flashRunId = flash_run_id;
    return new Promise(resolve => openFlashWs(flash_run_id, boardCount, resolve));
}

function openFlashWs(flashRunId, boardCount, onFinished) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let finished = false;
    const settle = (result) => { if (!finished) { finished = true; onFinished?.(result); } };
    state.flashSocket = new WebSocket(`${proto}://${location.host}/ws/flash-runs/${flashRunId}`);
    state.flashSocket.onmessage = (msg) => {
        try {
            const ev = JSON.parse(msg.data);
            handleFlashEvent(ev, boardCount);
            if (ev.type === "flash_run_finished") {
                settle({ success_count: ev.success_count, total: ev.total });
            }
        } catch (e) {
            console.error("flash event parse error", e);
        }
    };
    state.flashSocket.onclose = () => {
        settle({ success_count: 0, total: boardCount });
        $("#flash-status").textContent = "";
    };
}

function handleFlashEvent(event, boardCount) {
    const statusEl = $("#flash-status");
    if (event.type === "flash_slot_started") {
        statusEl.textContent = `Flashing board ${event.slot + 1} of ${event.total}\u2026`;
        const card = document.querySelector(`.flash-slot-card[data-slot="${event.slot}"]`);
        if (card) {
            const badge = card.querySelector(".status-badge");
            badge.dataset.status = "running";
            badge.textContent = "flashing";
            card.querySelector(".progress-fill").style.width = "50%";
        }
    } else if (event.type === "flash_log") {
        const card = document.querySelector(`.flash-slot-card[data-slot="${event.slot}"]`);
        if (card) {
            const log = card.querySelector(".log-panel");
            log.textContent += event.line + "\n";
            log.scrollTop = log.scrollHeight;
        }
    } else if (event.type === "flash_slot_finished") {
        const card = document.querySelector(`.flash-slot-card[data-slot="${event.slot}"]`);
        if (card) {
            const badge = card.querySelector(".status-badge");
            badge.dataset.status = event.result;
            badge.textContent = event.result;
            card.querySelector(".progress-fill").style.width = event.result === "success" ? "100%" : "0%";
        }
    } else if (event.type === "flash_run_finished") {
        const allOk = event.success_count === event.total;
        statusEl.textContent = allOk
            ? `All ${event.total} board${event.total > 1 ? 's' : ''} flashed.`
            : `${event.success_count}/${event.total} boards flashed. Check failures above.`;
        state.flashSelectedCount = 0;
        $("#flash-controls").hidden = true;
    }
}
