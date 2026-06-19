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

## Using the UI

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
