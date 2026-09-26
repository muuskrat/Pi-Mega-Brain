# Escape Room Controller — Project Notes

This file exists so a future session (human or Claude) can pick this project back up
without re-deriving everything from scratch. Keep it updated whenever the system
changes — new states, new commands, new hardware, new gotchas.

## System overview

Two machines:

- **Arduino Mega 2560** — runs `src/SystemsTest.ino`. Owns the actual game logic
  (state machine, RFID matching, maglocks, LEDs, IR sensor). Talks to the Pi over
  USB serial at 9600 baud.
- **Raspberry Pi** (hostname `pai-guy.local`, user `muuskrat`) — runs `src/app.py`,
  a Flask app that's the only thing that talks to the Mega's serial port. Serves a
  browser control panel for staff running the room.

The Pi is the only serial client. Anything that wants to control the room (a
browser, a script, whatever) goes through the Flask app, which forwards plain-text
line commands to the Mega and parses whatever it prints back.

## Source control

Repo: https://github.com/muuskrat/Pi-Mega-Brain (`main` branch). `.pio/` and
`__pycache__/` are gitignored — don't try to commit those. Git author identity
(`user.name`/`user.email`) is set repo-locally on this machine, not globally.

## Hardware / pin map

| Function | Pin(s) | Notes |
|---|---|---|
| RFID readers (OneWire/iButton) | 53, 51, 49, 47 | `INPUT_PULLUP`, one `OneWire` instance each |
| Maglock relay — Option A | 52 | Active LOW (`LOW` = energized = **unlocked**) |
| Maglock relay — Option B | 44 | Active LOW, same convention |
| IR break-beam (HW-201) | 32 | `INPUT_PULLUP`, `LOW` = triggered |
| LED strips (WS2811, BRG) | 27, 26 | 7 LEDs each, `FastLED`, `UncorrectedColor` |

Target RFID tags (facility code, card ID) are hardcoded in `targetTags[]` in the
sketch — reader 0+1 matching both = Option A, reader 2+3 matching both = Option B.

**Board identity gotcha:** the physical board is a genuine **Arduino Mega 2560 R3**
(confirmed via `lsusb` → `ID 2341:0042 Arduino SA Mega 2560 R3`, and via avrdude's
device signature `0x1e9801`). `platformio.ini` must have `board = megaatmega2560`
(`protocol = wiring`, 115200 baud) — **not** `megaatmega1280` (`protocol = arduino`,
57600 baud), which was the original misconfiguration and causes
`avrdude: stk500_getsync(): not in sync` on every upload attempt.

## State machine (`SystemsTest.ino`)

```
SHUTDOWN → RESET → PREPARE → WAIT_IR → SCANNING → OPTION_A  (terminal, latched)
                                                 ↘ OPTION_B  (terminal, latched)
```

- **SHUTDOWN** — fully off, no sensor polling, LEDs off, maglocks locked.
- **RESET** — "primed" state: maglocks **unlocked** (staff can walk in and reset
  props), dim white LEDs, sensors idle. This was changed on request — RESET used
  to lock everything; now it opens both doors instead.
- **PREPARE** — precursor to starting: guests are in, maglocks **locked** again,
  lights dimmed further than RESET (brightness 10 vs. 30), sensors still idle
  (no puzzles active). There's a `// TODO` at the top of this case in
  `enterState()` for where ambiance/music would kick in once audio hardware
  exists — nothing plays yet, this Mega has no audio output. `START` moves on
  from here (or from RESET directly — PREPARE isn't enforced as mandatory).
- **WAIT_IR** — game running, maglocks locked, waiting for the IR beam to break.
- **SCANNING** — IR tripped, RFID readers polled every loop, checked against
  `targetTags[]`.
- **OPTION_A / OPTION_B** — terminal, latched. Whichever pair of tags matched
  first wins; the corresponding relay stays energized (loop() re-asserts both
  relay pins every ~50ms while latched, so a raw manual lock poke during this
  state gets overwritten almost immediately — see Commands page notes below).

**Stage order / sequence guard:** `WAIT_IR`=0, `SCANNING`=1, `OPTION_A`=`OPTION_B`=2
(they're alternate endings of the same puzzle, not sequential stages). `FORCE:` and
`THROUGH:` commands are rejected on the Mega itself if the target stage's order is
behind the current state's order — i.e. you can skip forward but never back into an
already-passed stage. Only `RESET` (which resets order to -1) undoes that. This
same order value is mirrored in `app.py`'s `STAGES` list and used client-side in
`index.html` to grey out buttons for passed stages — but the Mega is the
authoritative enforcement point, not the browser.

## Serial protocol (Pi → Mega, one command per line, case-insensitive)

| Command | Effect |
|---|---|
| `POWER_ON` | Confirms Mega is alive (`MEGA_ONLINE`), enters RESET |
| `RESET` | Re-prime: unlock both maglocks, dim lights, stop polling, wait for START |
| `RELOAD` | Re-lock both maglocks, no state change |
| `PREPARE` | Precursor to START: lock both maglocks, dim lights further, no puzzles active |
| `START` | Enter WAIT_IR (begin the game) |
| `SHUTDOWN` | Lights off, locked, no polling |
| `STATUS` | Ask for a `STATE:` line right now |
| `FORCE:WAIT_IR` / `FORCE:SCANNING` / `FORCE:OPTION_A` / `FORCE:OPTION_B` | Jump straight into that state (arms it / triggers its side effects). Rejected if behind current stage order. |
| `THROUGH:WAIT_IR` | Simulate the IR beam actually tripping → advances to SCANNING via the normal transition code |
| `THROUGH:SCANNING` | Simulate all 4 tags correctly scanned → advances to whichever Option the real matching logic picks |
| `RAW:LOCK:52:UNLOCK` / `RAW:LOCK:52:LOCK` | Poke relay 52 directly. **No state change.** |
| `RAW:LOCK:44:UNLOCK` / `RAW:LOCK:44:LOCK` | Poke relay 44 directly. **No state change.** |
| `RAW:LED:<RRGGBB>:<brightness>` | Set LED strips to an arbitrary color/brightness. **No state change.** |
| `RAW:LED:OFF` | LEDs off. **No state change.** |
| `SENSORS` | One-shot snapshot, replies `SENSORS:IR=...;LOCK52=...;LOCK44=...;P53=...;P51=...;P49=...;P47=...` |

Unsolicited output the Mega also prints: `STATE:<name>` (after every state
transition — the Pi's log parser keys off this exact prefix), `[STATE] ...`,
`[EVENT] ...`, `[STATUS] ...`, `[CMD] ...`, `[RAW] ...`.

## Web app (`app.py` + `templates/`)

Three pages, shared nav in `templates/_nav.html`:

- **`/`** — Control Panel. Power/reset/reload/prepare/start/shutdown buttons,
  live state badge + serial log (polling `/state` every second), and a
  collapsible dropdown per stage:
  - Each stage row auto-expands the moment it becomes the active stage
    (badge: "active") and auto-collapses the moment the room moves past it
    (badge: "finished", `F`/`>>` inside disabled) — but only at the instant of
    a real state transition, not every poll tick, so it never fights a manual
    toggle in between.
  - Click a row's label to toggle it open/closed by hand at any time.
  - Toolbar above the list: **open all**, **close all**, **only current**
    (collapses every row except whichever matches the live state).
  - `F` (force) and `>>` (force-through) sit inside each row's dropdown,
    right-aligned.
- **`/commands`** — raw hardware control, explicitly **decoupled from game
  state**: maglock lock/unlock buttons, an LED color picker + brightness slider +
  off button, and a live sensor table (IR, all 4 RFID readers, both lock states)
  polling `/sensors` every second.
- **`/settings`** — placeholder, intentionally left blank for now.

Routes: `/state` (GET), `/command/<cmd>` (POST), `/force/<stage_id>` (POST),
`/through/<stage_id>` (POST, only `WAIT_IR`/`SCANNING`), `/raw/lock/<52|44>/<lock|unlock>`
(POST), `/raw/led` (POST, JSON `{color, brightness}`), `/raw/led/off` (POST),
`/sensors` (GET — sends `SENSORS` over serial, sleeps ~0.2s, returns the cached
parse).

## Deploying / flashing workflow

1. Edit locally under `src/`, rebuild to check it compiles:
   `pio run` from the project root (Windows PlatformIO install at
   `%USERPROFILE%\.platformio\penv\Scripts\pio.exe`).
2. Sync to the Pi's `~/escape/` (mirrors the local layout: `platformio.ini` at
   root, everything else under `src/`). Use **rsync, not plain `scp -r`** —
   `.pio/` is ~100MB of Windows-only build artifacts and `scp -r .` doesn't
   respect `.gitignore`:
   ```
   rsync -av --exclude='.pio' --exclude='.vscode' . muuskrat@pai-guy.local:~/escape/
   ```
3. **Before flashing, confirm nothing holds `/dev/ttyACM0`** — if `app.py` is
   running, `avrdude` will time out (`stk500v2_getsync(): timeout communicating
   with programmer`) because the Flask app's `pyserial` connection is holding the
   port open. Check with `ps aux | grep app.py` on the Pi; stop it first.
4. Flash from the Pi (PlatformIO lives in a venv there, not system Python —
   Debian 13/trixie blocks bare `pip install` via PEP 668):
   ```
   cd ~/escape && ~/.platformio-venv/bin/pio run -t upload --upload-port /dev/ttyACM0
   ```
5. Restart the Flask app on the Pi to pick up any `app.py`/template changes —
   it doesn't hot-reload (`debug=False`).

### Gotchas hit so far

- **mDNS flakiness**: `pai-guy.local` sometimes fails to resolve from Python
  (`socket.getaddrinfo` → `[Errno 11001] getaddrinfo failed`) even when Windows'
  own resolver (`Resolve-DnsName`) answers instantly. Connecting by the Pi's
  current LAN IP instead of the `.local` hostname sidesteps it reliably (check
  `Resolve-DnsName pai-guy.local` for the current IP if it's DHCP and may change).
- **USB host controller glitch**: this Pi's `dwc_otg` USB controller has thrown
  `WARN::dwc_otg_hcd_urb_dequeue:639: Timed out waiting for FSM NP transfer to
  complete` during a flash, which can leave `avrdude`/`pio`/`scons` genuinely
  hung (not just failed) — check `ps aux | grep -Ei 'pio|avrdude|scons'` if an
  upload seems stuck far longer than the normal ~90 seconds. Kill the hung
  processes and retry; if it recurs, physically replug the Mega's USB cable.
- **Serial port is exclusive** — see step 3 above. This is the most common
  cause of a failed/hung flash in practice.
- **Backgrounding a test process over SSH needs full fd redirection**:
  `nohup cmd > log 2>&1 &` alone isn't enough on a non-interactive `exec`
  channel (like paramiko's `exec_command`, no pty) — the child still inherits
  **stdin** from the channel, which keeps the channel from ever reporting EOF
  even after the visible commands finish. Add `< /dev/null` too, or just don't
  wait on that channel's output — open a fresh connection to check results
  instead.

## Known open items (raised, not yet addressed — ask before changing)

- **No authentication** on any Flask control endpoint. Anyone on the same
  network can hit `/command/shutdown`, `/raw/lock/...`, etc. Fine for a closed
  venue network, worth reconsidering if the Pi is ever exposed more broadly.
- **Pi SSH password is `1`** — trivially guessable. Should be changed once the
  current round of work settles.
- `PREPARE`'s ambiance/music hook is a `// TODO` only — there's no audio
  hardware on this Mega yet, so nothing actually plays. Lights dimming and
  maglocks locking do work.
- Manual `RAW:LOCK` pokes while latched in OPTION_A/OPTION_B only hold for
  ~50ms before `loop()`'s continuous re-assertion overwrites them (see state
  machine section above) — a known interaction, not a bug, but worth knowing
  before assuming a Commands-page lock toggle "didn't work" during those states.

## File layout

```
platformio.ini              env: megaatmega2560, lib_deps: OneWire, FastLED
src/
  SystemsTest.ino           Mega firmware — state machine + serial protocol
  app.py                    Flask app — serial bridge + web routes
  requirements.txt          flask, pyserial
  templates/
    _nav.html                shared nav bar (Control panel | Commands | Settings)
    index.html                Control Panel
    commands.html             raw hardware control + live sensors
    settings.html             placeholder
```

Mirrored on the Pi at `~/escape/` in the same shape.
