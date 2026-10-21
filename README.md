# Betaflight auto-tuning

Suggests PIDs, filters and rates for a Betaflight quad from a blackbox log and the way you
want it to fly (`freestyle`, `racing`, `cinematic`, `long_range`). The result is a list of
commands to paste in the Betaflight CLI.

It comes as a web app (drop a log, read the result) and as a command-line tool. The analysis
runs in the browser, so the log never leaves the phone or computer:

- the **Android app**, from the home F-Droid store (see [android/README.md](android/README.md)),
  carries the whole app and works anywhere, without network;
- the page is also served on the local network at http://192.168.1.15:8787 (S13);
- or run it on your own computer, see below.

## Install

The app is plain JavaScript and only needs [Node.js](https://nodejs.org/) 22 or newer, with
nothing else to install. On Windows:

```
winget install OpenJS.NodeJS.LTS
```

Then get the code:

```
git clone https://github.com/harantol/auto_pid_tuning.git
cd auto_pid_tuning
```

## Tutorial

### 1. Record a useful log

The tool can only tune what the flight shows, so the log matters more than anything else.

- In Betaflight Configurator, *Blackbox* tab: log to flash or SD card at 1 kHz or more.
- Fly at least 30 to 60 seconds, with some throttle variation.
- On **each axis** (roll, pitch, yaw), do a few sharp stick snaps with an abrupt stop. Smooth
  cruising does not excite the quad enough to measure how it responds, and the PIDs of that
  axis are then left untouched.
- Fly the way you intend to fly the quad: rates are judged from the flight too.

Download the log from the *Blackbox* tab (`.bbl`) or copy it from the SD card (`.bfl`). A
flash download that holds every flight since the last erase is fine: the longest flight is
picked automatically.

### 2. Launch the web app

Open the Android app, or http://192.168.1.15:8787 at home, or on your computer:

```
npm start
```

A browser tab opens on http://127.0.0.1:8000. Leave the terminal open while you use the app,
and stop it with `Ctrl+C`. Options go after `--`, for example `npm start -- --port 8010`:

| Option | Effect |
|---|---|
| `--port 8010` | use another port, when 8000 is already taken |
| `--host 0.0.0.0` | accept connections from other machines on the local network |
| `--no-browser` | do not open a browser tab |

### 3. Analyse the log

1. Drop the log on the page, or click the box to choose it. Decoding takes about a second
   for a few minutes of flight.
2. Pick a **flight style**. Switching is instant, the log is not decoded again.

   | Style | Aims for |
   |---|---|
   | Freestyle | snappy and locked-in, a slight overshoot is accepted |
   | Racing | fastest stick response, precise at moderate rates |
   | Cinematic | smooth footage: no overshoot, soft sticks, quiet motors |
   | Long range | efficient cruising: cool motors, gentle and stable response |

3. If the file holds several flights, the **Flight** list lets you choose another one. Sizes
   are shown: the few-kilobyte entries are bench arming tests.

### 4. Read the result

- **Step response**: how each axis follows a sudden stick move. 1.0 is the commanded rate.
  The highest point of each curve should land in the shaded band, which is the target of the
  selected style. An axis marked *not measurable* did not get sharp enough stick moves.
- **Gyro noise spectrum**: what is left on the gyro after filtering. Everything right of the
  100 Hz line is noise that ends up heating the motors.
- **Measured**: the same information as numbers, per axis.
- **Suggested changes**: each setting with its current value, the suggested one and the
  reason, grouped as PIDs, filters and rates. Each reason links to a figure (*Fig. 1*, ...) showing the
  part of the log behind it: the sharpest stick move of the axis (setpoint against gyro) for
  P, D and feedforward, the longest held stick for I, a typical stretch of D-term for the
  lowpass filters, the spectrum against the notch range for the dynamic notch, and the
  current and suggested rate curves against the stick range you actually used for rates.
- **Notes**: what could not be measured and what to watch for.

### 5. Apply and iterate

1. Back up first: in the Betaflight *CLI* tab, type `diff all` and save the output.
2. Click **Copy** (or **Download**) under *Betaflight CLI*, paste in the CLI tab and press
   Enter. The last command, `save`, reboots the flight controller.
3. Fly a short hover and check motor temperature, especially after filter changes.
4. Fly the same way again, log, and analyse the new log.

Changes are capped at 15% per pass on purpose. Repeat until the app says there is nothing to
change. To undo, paste your `diff all` backup.

## Command line

The same analysis without a browser:

```
node bin/auto-pid-tuning.js path/to/log.bbl --style cinematic
```

| Option | Effect |
|---|---|
| `-s`, `--style` | `freestyle` (default), `racing`, `cinematic`, `long_range` |
| `-i`, `--log-index N` | flight to analyse when the file holds several (default: the longest) |
| `-o`, `--output tune.txt` | also write the CLI commands to a file |
| `--json` | print the full analysis as JSON, step responses included |

## Troubleshooting

- **The page shows another site, or "Port 8000 is already used"**: port 8000 is used by
  another program. Start with `npm start -- --port 8010` and open that address.
- **"node" or "npm" is not recognised**: open a new terminal after installing Node.js, so that
  it is on the `PATH`.
- **An axis is "not measurable"**: its stick moves were too gentle. Add sharp snaps on that
  axis in the next flight.
- **"holds too few frames to analyse"**: the selected flight is an arming test or a truncated
  log. Choose another flight in the list.
- **"is missing the ... fields"**: gyro and setpoint logging are disabled in the blackbox
  settings of the quad.

## How it works

Everything is in `app/`, a static page with no build step: plain JavaScript modules and SVG.
The analysis is `app/core/`, independent of the page:

1. `decoder.js` decodes the blackbox format. It follows the parser of Betaflight's
   [Blackbox Explorer](https://github.com/betaflight/blackbox-log-viewer) (same encodings,
   predictors and recovery from corrupt frames).
2. `blackbox.js` splits a file into flights and turns one into arrays.
3. `analysis.js` measures the flight (`numeric.js` holds the FFT and filters it needs):
   - closed-loop **step response** of each axis from the setpoint-to-gyro cross-spectrum,
     limited to the band where the sticks actually excited the quad (overshoot, rise time,
     steady state);
   - **noise** above 100 Hz on the filtered gyro and on the D-term, and any standing peak;
   - **motor saturation** and **stick usage**.
4. `styles.js` defines the targets of each flight style.
5. `tuner.js` compares the measurements to the targets and emits setting changes.
6. `report.js` renders the result as JSON (for the page) and text (command line).

The page (`app.js`) runs the analysis in a worker (`worker.js`) so it stays responsive while
a log decodes. `bin/` holds the command line and the local server.

### The Python version

`src/auto_pid_tuning/` is the first version of the same analysis, in Python. It stays for now
as a reference: `tests/test_js_parity.py` runs both on simulated flights and checks that they
give the same measurements and the same changes. On real logs the JavaScript version reads the
first frames correctly where the Python decoder (`orangebox`) gets them wrong, so both differ
slightly there. The Python version will be removed once the JavaScript one has proven itself
on real flights.

## Limits

- The targets and noise thresholds in `styles.py` are heuristics, not measured on a fleet of
  quads. Treat suggestions as a starting point and check motor temperature after each change.
- Step responses need real stick inputs: a hover-only log leaves the PIDs untouched.
- Supports Betaflight 4.2+ logs; Actual and Betaflight rate types are modelled.

## Development

```
npm test                 # the app's tests (tests/js/)
uv run pytest            # the Python reference, and the comparison of both versions
uv run ruff check
```

The Python side is managed with [uv](https://docs.astral.sh/uv/) (`uv sync` once). Sample logs
go in `samples/` (git-ignored); tests that need them are skipped when absent. The JavaScript
tests write their own logs (`tests/js/writer.js`), from simulated flights.

## Versions and deployment

The version is `MAJOR.MINOR`, shown at the bottom of the web page (from `version.json`, written
when the image or the Android app is built).

- `MAJOR` is the number in the `VERSION` file. Edit it in a PR to start a new major version.
- `MINOR` counts the merges into `master` since `VERSION` last changed, so each merged PR adds
  one and bumping `MAJOR` resets it to 0. `python src/auto_pid_tuning/version.py` prints it.

Changes go through pull requests on GitHub. Each PR runs the tests (`.github/workflows/ci.yml`).
Each merge into `master` (`.github/workflows/release.yml`) then:

1. runs the tests again and computes the version;
2. builds the Docker image (nginx serving `app/`) and pushes it to
   `ghcr.io/harantol/auto_pid_tuning` as `:X.Y` and `:latest`, and tags the commit `vX.Y`;
3. builds the Android app and attaches it to the GitHub release `vX.Y`, where the home F-Droid
   store picks it up.

S13 (the Debian server at 192.168.1.15) runs `deploy/s13/compose.yaml`: the app on port 8787 plus Watchtower, which picks up a new
`:latest` image within 5 minutes.

### One-time setup

- **GHCR:** after the first release, make the package public (GitHub > Packages >
  auto_pid_tuning > Package settings > Change visibility), so S13 can pull it
  without credentials.
- **S13:** copy `deploy/s13/compose.yaml` to `~/auto_pid_tuning/` on the server and start
  it once there with `docker compose up -d`.

To build and run the image locally: `docker build -t auto-pid-tuning .` then
`docker run -p 7860:7860 auto-pid-tuning`. Each PR also builds it in CI (`image` job).
