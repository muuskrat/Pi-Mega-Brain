import json
import os
import threading
import time
from collections import deque

import serial
from flask import Flask, jsonify, render_template, request

# Change this to match what `ls /dev/tty*` shows when the Mega is plugged in.
SERIAL_PORT = "/dev/ttyACM0"
BAUD_RATE = 9600

app = Flask(__name__)

ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
time.sleep(2)  # the Mega resets when the serial port opens - give it a moment

state_lock = threading.Lock()
current_state = "UNKNOWN"
log_lines = deque(maxlen=200)
latest_sensors = {}

# One entry per stage the Mega's state machine actually has right now.
# Add a row here whenever you add a new state to the Mega sketch.
# "through": True means the Mega also accepts THROUGH:<id> - simulating the
# real trigger (IR trip, tags scanned) instead of jumping straight into the
# state. OPTION_A/B are terminal latched states, so there's nothing to force
# past yet.
# "order" mirrors stageOrder() in the Mega sketch - it's how the UI knows
# which stages are already behind the room and greys their Force/Through
# buttons out. OPTION_A/B share a rank since they're alternate endings of
# the same RFID puzzle, not two sequential stages.
STAGES = [
    {"id": "WAIT_IR", "label": "Waiting for IR trip", "through": True, "order": 0},
    {"id": "SCANNING", "label": "RFID scanning", "through": True, "order": 1},
    {"id": "OPTION_A", "label": "Option A (Pin 52)", "through": False, "order": 2},
    {"id": "OPTION_B", "label": "Option B (Pin 44)", "through": False, "order": 2},
]

THROUGH_CAPABLE = {s["id"] for s in STAGES if s["through"]}
STAGE_ORDER = {s["id"]: s["order"] for s in STAGES}

VALID_LOCKS = {"52", "44"}
VALID_LOCK_ACTIONS = {"lock": "LOCK", "unlock": "UNLOCK"}

# Peel-banana easter egg leaderboard - one JSON object per line in a plain
# .txt file on the Pi, not localStorage, so every visitor shares the same
# board instead of each browser having its own. Lives next to app.py.
BANANA_LEADERBOARD_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "banana_leaderboard.txt")
BANANA_MAX_SAVED = 100
banana_lock = threading.Lock()

CONTROL_COMMANDS = {
    "power_on": "POWER_ON",
    "reset": "RESET",
    "reload": "RELOAD",
    "prepare": "PREPARE",
    "start": "START",
    "shutdown": "SHUTDOWN",
}


def parse_sensors_line(line: str) -> dict:
    """'SENSORS:IR=CLEAR;LOCK52=LOCKED;...' -> {'IR': 'CLEAR', 'LOCK52': 'LOCKED', ...}"""
    body = line.split(":", 1)[1]
    result = {}
    for part in body.split(";"):
        if "=" in part:
            key, val = part.split("=", 1)
            result[key] = val
    return result


def serial_reader():
    """Runs forever in the background, reading whatever the Mega sends."""
    global current_state, latest_sensors
    while True:
        try:
            raw = ser.readline()
        except serial.SerialException:
            time.sleep(1)
            continue

        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue

        with state_lock:
            if line.startswith("SENSORS:"):
                # Kept separate from log_lines - it's Commands-page telemetry,
                # not a Control Panel event worth cluttering that log with.
                latest_sensors = parse_sensors_line(line)
            else:
                log_lines.append(line)
                if line.startswith("STATE:"):
                    current_state = line.split(":", 1)[1]


threading.Thread(target=serial_reader, daemon=True).start()


def send_command(cmd: str):
    ser.write((cmd + "\n").encode("utf-8"))


def load_banana_leaderboard() -> list:
    if not os.path.exists(BANANA_LEADERBOARD_FILE):
        return []
    entries = []
    with open(BANANA_LEADERBOARD_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue  # skip a corrupt line rather than losing the whole board
    return entries


def write_banana_leaderboard(entries: list) -> list:
    entries = sorted(entries, key=lambda e: e.get("score", 0), reverse=True)[:BANANA_MAX_SAVED]
    with open(BANANA_LEADERBOARD_FILE, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")
    return entries


@app.route("/")
def index():
    return render_template("index.html", stages=STAGES, active="control")


@app.route("/commands")
def commands_page():
    return render_template("commands.html", active="commands")


@app.route("/settings")
def settings_page():
    return render_template("settings.html", active="settings")


@app.route("/state")
def state():
    with state_lock:
        return jsonify({
            "state": current_state,
            "stage_order": STAGE_ORDER.get(current_state, -1),
            "log": list(log_lines)[-40:],
        })


@app.route("/command/<cmd>", methods=["POST"])
def command(cmd):
    if cmd not in CONTROL_COMMANDS:
        return jsonify({"ok": False, "error": "unknown command"}), 400
    send_command(CONTROL_COMMANDS[cmd])
    return jsonify({"ok": True})


@app.route("/force/<stage_id>", methods=["POST"])
def force(stage_id):
    if stage_id not in [s["id"] for s in STAGES]:
        return jsonify({"ok": False, "error": "unknown stage"}), 400
    send_command(f"FORCE:{stage_id}")
    return jsonify({"ok": True})


@app.route("/through/<stage_id>", methods=["POST"])
def force_through(stage_id):
    if stage_id not in THROUGH_CAPABLE:
        return jsonify({"ok": False, "error": "no force-through for this stage"}), 400
    send_command(f"THROUGH:{stage_id}")
    return jsonify({"ok": True})


# --- Commands page: raw hardware control, no effect on game state ---

@app.route("/raw/lock/<lock_id>/<action>", methods=["POST"])
def raw_lock(lock_id, action):
    if lock_id not in VALID_LOCKS or action not in VALID_LOCK_ACTIONS:
        return jsonify({"ok": False, "error": "invalid lock or action"}), 400
    send_command(f"RAW:LOCK:{lock_id}:{VALID_LOCK_ACTIONS[action]}")
    return jsonify({"ok": True})


@app.route("/raw/led", methods=["POST"])
def raw_led():
    data = request.get_json(force=True, silent=True) or {}
    hex_color = str(data.get("color", "")).lstrip("#")
    if len(hex_color) != 6 or any(c not in "0123456789abcdefABCDEF" for c in hex_color):
        return jsonify({"ok": False, "error": "invalid color"}), 400
    try:
        brightness = max(0, min(255, int(data.get("brightness", 0))))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid brightness"}), 400
    send_command(f"RAW:LED:{hex_color}:{brightness}")
    return jsonify({"ok": True})


@app.route("/raw/led/off", methods=["POST"])
def raw_led_off():
    send_command("RAW:LED:OFF")
    return jsonify({"ok": True})


@app.route("/sensors")
def sensors():
    send_command("SENSORS")
    time.sleep(0.2)  # give the Mega a moment to reply before we read the cache
    with state_lock:
        return jsonify(latest_sensors)


# --- Peel-banana easter egg leaderboard (unrelated to the room itself) ---

@app.route("/banana/leaderboard", methods=["GET"])
def banana_leaderboard_get():
    with banana_lock:
        entries = load_banana_leaderboard()
    entries.sort(key=lambda e: e.get("score", 0), reverse=True)
    return jsonify(entries)


@app.route("/banana/leaderboard", methods=["POST"])
def banana_leaderboard_post():
    data = request.get_json(force=True, silent=True) or {}

    name = str(data.get("name", "")).strip()[:24] or "Anonymous Banana"
    try:
        score = int(data.get("score", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid score"}), 400

    brownness = data.get("brownness")
    if not isinstance(brownness, list) or len(brownness) != 3 or not all(
        isinstance(b, (int, float)) for b in brownness
    ):
        return jsonify({"ok": False, "error": "invalid brownness"}), 400

    entry = {
        "name": name,
        "score": score,
        "tierKey": str(data.get("tierKey", "")),
        "tierLabel": str(data.get("tierLabel", "")),
        "tierColor": str(data.get("tierColor", "")),
        "brownness": [float(b) for b in brownness],
    }

    with banana_lock:
        entries = load_banana_leaderboard()
        entries.append(entry)
        entries = write_banana_leaderboard(entries)

    return jsonify({"ok": True, "leaderboard": entries})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
