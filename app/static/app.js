// Arduino UNO Q Flasher — frontend logic.
// Single page; no build step.

const STAGES = [
    "push_app",
    "push_setup_script",
    "push_env",
    "chmod_script",
    "change_password",
    "run_setup",
    "push_properties",
];

const state = {
    upload: null,        // { upload_id, folder_name, file_count }
    folderFiles: null,   // FileList from the picker
    devices: [],         // [{ serial, state }]
    cards: new Map(),    // serial -> { card, logEl, progressEl, stageEl, badgeEl, retryBtn, skipInputs }
    runId: null,
    ws: null,
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
            const pw = j.password_configured ? "pw configured" : "no password (.env)";
            el.textContent = `ADB ready · ${pw}`;
        }
    } catch (e) {
        const el = $("#health");
        el.className = "health bad";
        el.textContent = "backend unreachable";
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
        const skipInputs = Array.from(node.querySelectorAll(".skip-toggle"));

        retryBtn.addEventListener("click", () => retryDevice(d.serial));

        grid.appendChild(node);
        state.cards.set(d.serial, {
            card: node, badgeEl, progressEl, stageEl, logEl, retryBtn, skipInputs,
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
    $("#start-btn").addEventListener("click", startRun);
    $("#retry-failed-btn").addEventListener("click", retryAllFailed);
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
    const ready = state.upload && state.devices.length > 0 && state.runId === null;
    $("#start-btn").disabled = !ready;
}

// ---------- runs ----------

async function startRun() {
    if (!state.upload || state.devices.length === 0) return;
    const devices = state.devices.map((d) => {
        const skip = collectSkip(d.serial);
        return { serial: d.serial, skip_stages: skip };
    });
    resetAllCards();
    const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id: state.upload.upload_id, devices }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        $("#run-status").textContent = `start failed: ${j.detail || r.status}`;
        return;
    }
    const j = await r.json();
    state.runId = j.run_id;
    $("#run-status").textContent = `run ${j.run_id} in progress…`;
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
            break;
        }
        case "stage": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            const idx = STAGES.indexOf(ev.stage);
            const pct = ev.status === "completed" || ev.status === "skipped"
                ? ((idx + 1) / STAGES.length) * 100
                : (idx / STAGES.length) * 100;
            c.progressEl.style.width = `${pct}%`;
            c.stageEl.textContent = `${ev.stage} · ${ev.status}`;
            appendLog(ev.device, `[${ev.stage}] ${ev.status}`, "stage");
            break;
        }
        case "log": {
            const cls = ev.stream === "stderr" ? "err" : "";
            const prefix = ev.stage ? `[${ev.stage}] ` : "";
            appendLog(ev.device, prefix + ev.line, cls);
            break;
        }
        case "device_finished": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.badgeEl.dataset.status = ev.result;
            c.badgeEl.textContent = ev.result;
            c.stageEl.textContent = ev.result;
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
}

init();
