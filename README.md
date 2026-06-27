# Arduino UNO Q Flasher (Web UI)

A web app that flashes multiple Arduino UNO Q boards in parallel over `adb`,
with live per-device logs and real-time status. Replaces the original
`unoq-flash-all.sh` bash workflow.

## Prerequisites

- **Python 3.11+**
- **adb** (Android platform-tools) on your `PATH`
  - macOS: `brew install android-platform-tools`
  - Windows: download from <https://developer.android.com/studio/releases/platform-tools>
  - Linux: `sudo apt install adb`
- **`unoq-setup.sh`** present at the project root (pushed to each device).
- Optional **`.env`** at the project root with:
  ```
  UNOQ_DEFAULT_PASSWORD=your-new-password
  ```
  You can also pin the expected `arduino-app-cli` version so setup fails fast
  if the wrong version is installed on a board:
  ```
  UNOQ_APP_CLI_VERSION=0.11.1
  ```
- Optional **`properties.msgpack`** at the project root or inside the chosen
  app folder. If present, it is pushed to `/var/lib/arduino-app-cli/properties.msgpack`.

## Install & run

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -e .
python -m app
```

Open <http://localhost:8000>.

## Flashing OS images (EDL mode)

Use this when boards need a fresh OS image before provisioning.

### Preparation

Download the latest UNO Q Debian image from
<https://www.arduino.cc/en/software/linux-images/> and place it in the project
root **before** starting the app. The flasher picks up any file matching
`arduino-unoq-debian-image-*.tar.zst` automatically; if none is found it falls
back to downloading `latest` each time (slow). Example filename:

```
arduino-unoq-debian-image-20260528-558.tar.zst
```

You also need the `arduino-flasher-cli` binary in the project root. When it is
present the **Flash EDL boards** button appears automatically.

### Steps

1. Put all boards into EDL mode (install the flashing jumper, then power-cycle).
2. Click **Flash EDL boards**.
3. A log panel opens showing live output. Each board takes roughly 5 minutes;
   detailed per-board progress is not shown during the flash, only overall log
   lines.
4. When flashing is done, remove the EDL jumpers and reboot each board.
5. Wait for the boards to finish booting (≈ 1–2 min).
6. Click **Refresh devices** to detect them.
7. Proceed with provisioning below.

> **Tip:** boards are flashed one at a time, identified by their USB serial
> number, so you can safely have multiple boards in EDL mode simultaneously.

---

## Provisioning

1. **Connect** your UNO Q boards via USB. Click **Refresh devices**.
2. Click **Choose app folder** and pick the folder you want pushed to
   `/home/arduino/ArduinoApps/` on each device. The folder is uploaded once
   and reused for all selected devices.
3. (Optional) Per device, tick **skip password** and/or **skip properties**.
4. Click **Start all**. Each device card shows:
   - status badge (idle / running / success / failed)
   - progress bar across the 7 stages
   - live-tailing log panel
5. If a device fails, click **Retry** on its card.
6. The LED on each board lights **green** on success or **red** on failure.

The staged upload is removed from disk automatically once the run finishes.

## Workflow (per device)

The web app runs the same 7-step workflow as the original bash script:

1. `push_app` — push chosen folder to `/home/arduino/ArduinoApps/`
2. `push_setup_script` — push `unoq-setup.sh` to `/home/arduino/.unoq-setup.sh`
3. `push_env` — push `.env` (if present locally)
4. `chmod_script` — make the setup script executable
5. `change_password` — set the arduino user's password from `UNOQ_DEFAULT_PASSWORD`
   (skippable; handles the "already-changed" case gracefully)
6. `push_properties` — push `properties.msgpack` so on-device setup-wizard markers
   are in place before setup runs (skippable; skipped if absent)
7. `run_setup` — execute the remote setup script (WiFi, DNS, system update)
