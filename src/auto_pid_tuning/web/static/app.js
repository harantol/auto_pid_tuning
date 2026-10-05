"use strict";

const AXES = ["roll", "pitch", "yaw"];
const COLORS = { roll: "var(--series-1)", pitch: "var(--series-2)", yaw: "var(--series-3)" };
const GROUPS = [["pid", "PIDs"], ["filter", "Filters"], ["rates", "Rates"]];
const STEP_WINDOW_MS = 300;

const $ = (id) => document.getElementById(id);
const state = { file: null, data: null, style: "freestyle" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function styleLabel(name) {
  return name.replace("_", " ").replace(/^./, (c) => c.toUpperCase());
}

// ---- Controls -------------------------------------------------------------------------

async function loadStyles() {
  const styles = await (await fetch("/api/styles")).json();
  const group = $("styles");
  for (const style of styles) {
    const label = el("label");
    label.title = style.description;
    const input = el("input");
    input.type = "radio";
    input.name = "style";
    input.value = style.name;
    input.checked = style.name === state.style;
    input.addEventListener("change", () => {
      state.style = style.name;
      if (state.data) render();
    });
    label.append(input, styleLabel(style.name));
    group.appendChild(label);
  }
}

function setStatus(text, kind) {
  const status = $("status");
  status.hidden = !text;
  status.textContent = text || "";
  status.className = `status ${kind || ""}`;
}

async function analyse(logIndex) {
  if (!state.file) return;
  const megabytes = state.file.size / 1e6;
  setStatus(`Decoding ${state.file.name} (${megabytes.toFixed(1)} MB), this can take a few seconds per MB…`, "busy");
  $("results").classList.add("stale");  // keep the previous render in place while loading

  const body = new FormData();
  body.append("file", state.file);
  if (logIndex) body.append("log_index", logIndex);
  try {
    const response = await fetch("/api/analyze", { method: "POST", body });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || `Server error ${response.status}`);
    state.data = payload;
    setStatus("");
    render();
  } catch (error) {
    setStatus(error.message, "error");
    if (!state.data) $("results").hidden = true;
  } finally {
    $("results").classList.remove("stale");
  }
}

function pickFile(file) {
  if (!file) return;
  state.file = file;
  state.data = null;
  $("results").hidden = true;
  $("flight-field").hidden = true;
  $("drop-title").textContent = file.name;
  $("drop-hint").textContent = "Choose or drop another log to replace it";
  analyse(null);
}

function setupControls() {
  const drop = $("drop");
  $("file").addEventListener("change", (event) => pickFile(event.target.files[0]));
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("file").click(); }
  });
  for (const name of ["dragenter", "dragover"]) {
    drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("over"); });
  }
  for (const name of ["dragleave", "drop"]) {
    drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (event) => pickFile(event.dataTransfer.files[0]));
  // A file dropped beside the drop zone must not navigate away from the page.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  $("flight").addEventListener("change", (event) => analyse(event.target.value));
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("cli").textContent);
    $("copy").textContent = "Copied";
    setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
  });
  $("download").addEventListener("click", () => {
    const blob = new Blob([$("cli").textContent + "\n"], { type: "text/plain" });
    const link = el("a");
    link.href = URL.createObjectURL(blob);
    link.download = `tune-${state.style}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

// ---- Rendering ------------------------------------------------------------------------

function render() {
  const data = state.data;
  const tune = data.tunes[state.style];
  $("results").hidden = false;
  $("style-note").textContent = `${styleLabel(tune.style)}: ${tune.description}`;

  renderFlightPicker(data);
  renderTiles(data, tune);
  renderCharts(data, tune);
  renderMeasured(data);
  renderChanges(tune);
  renderNotes(tune);
  renderCli(tune);
}

function renderFlightPicker(data) {
  const select = $("flight");
  $("flight-field").hidden = data.log_count < 2;
  select.replaceChildren();
  // A flash dump holds one log per arming, mostly tiny bench tests: show sizes to tell them apart.
  for (let i = 1; i <= data.log_count; i++) {
    const bytes = data.flight_bytes[i - 1];
    const size = bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
    const option = el("option", "", `${i} of ${data.log_count} (${size})`);
    option.value = i;
    option.selected = i === data.log_index;
    select.appendChild(option);
  }
}

function tile(label, value, note, small) {
  const node = el("div", "tile");
  node.append(el("div", "tile-label", label), el("div", `tile-value${small ? " small" : ""}`, value));
  if (note) node.appendChild(el("div", "tile-note", note));
  return node;
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

function renderTiles(data, tune) {
  const firmware = (data.firmware || "Unknown").replace(/\s*\(.*$/, "");
  const board = (data.firmware || "").split(") ")[1] || "";
  const count = tune.changes.length;
  $("tiles").replaceChildren(
    tile("Firmware", firmware, board, true),
    tile("Flight time", formatDuration(data.duration)),
    tile("Log rate", `${Math.round(data.sample_rate)} Hz`),
    tile("Motors at limit", `${(data.motor_saturation * 100).toFixed(1)}%`, "of flight time"),
    tile("Suggested changes", String(count), count ? `for ${styleLabel(tune.style).toLowerCase()}` : "tune already fits"),
  );
}

function legend(target, entries) {
  target.replaceChildren();
  for (const entry of entries) {
    const item = el("span", `legend-item${entry.off ? " off" : ""}`);
    const key = el("span", entry.band ? "key band" : "key");
    if (!entry.band) key.style.background = COLORS[entry.axis];
    item.append(key, el("span", "", entry.text));
    target.appendChild(item);
  }
}

function renderCharts(data, tune) {
  // Step response: only axes the log could actually measure are drawn.
  const measured = AXES.filter((axis) => data.axes[axis].step_response && data.axes[axis].step_response.valid);
  legend($("step-legend"), [
    ...AXES.map((axis) => ({
      axis,
      off: !measured.includes(axis),
      text: measured.includes(axis) ? styleLabel(axis) : `${styleLabel(axis)} (not measurable)`,
    })),
    { band: true, text: `${styleLabel(tune.style)} peak target` },
  ]);
  const first = measured.length ? data.axes[measured[0]].step_response : null;
  const top = Math.max(1.3, tune.peak_max + 0.1, ...measured.map((axis) => data.axes[axis].step_response.peak + 0.05));
  lineChart($("step-chart"), {
    label: "Step response of each axis",
    x: first ? first.time.map((t) => t * 1000) : [],
    series: measured.map((axis) => ({
      name: styleLabel(axis), color: COLORS[axis], y: data.axes[axis].step_response.response,
    })),
    xDomain: [0, STEP_WINDOW_MS],
    yDomain: [0, Math.ceil(top * 10) / 10],
    xTitle: "Time after the stick move (ms)",
    xFormat: (v, full) => (full ? `${v.toFixed(0)} ms` : v.toFixed(0)),
    yFormat: (v) => v.toFixed(2),
    band: { from: tune.peak_min, to: tune.peak_max },
    hline: 1,
    empty: "Stick moves too gentle to measure",
  });

  legend($("noise-legend"), AXES.map((axis) => ({ axis, text: styleLabel(axis) })));
  const hz = data.spectrum.hz;
  lineChart($("noise-chart"), {
    label: "Gyro noise spectrum of each axis",
    x: hz,
    series: AXES.map((axis) => ({ name: styleLabel(axis), color: COLORS[axis], y: data.spectrum[axis] })),
    xDomain: [0, hz.length ? hz[hz.length - 1] : 500],
    yLog: true,
    xTitle: "Frequency (Hz)",
    xFormat: (v, full) => (full ? `${v.toFixed(0)} Hz` : v.toFixed(0)),
    yFormat: (v, full) => (full ? v.toPrecision(2) : String(v)),
    vline: { x: 100, label: "100 Hz" },
  });
}

function renderMeasured(data) {
  const body = $("measured").querySelector("tbody");
  body.replaceChildren();
  for (const axis of AXES) {
    const info = data.axes[axis];
    const step = info.step_response && info.step_response.valid ? info.step_response : null;
    const row = el("tr");
    const head = el("th");
    head.scope = "row";
    const cell = el("span", "axis-cell");
    const key = el("span", "key");
    key.style.background = COLORS[axis];
    cell.append(key, axis);
    head.appendChild(cell);
    row.appendChild(head);

    const values = [
      step ? `${step.peak >= 1 ? "+" : ""}${((step.peak - 1) * 100).toFixed(0)}%` : null,
      step && step.rise_time !== null ? `${(step.rise_time * 1000).toFixed(0)} ms` : null,
      step ? `${(step.steady_state * 100).toFixed(0)}%` : null,
      `${info.noise.gyro_rms.toFixed(1)} deg/s`,
      info.noise.dterm_rms > 0 ? info.noise.dterm_rms.toFixed(1) : null,
      info.noise.peak_hz !== null ? `${info.noise.peak_hz.toFixed(0)} Hz` : null,
      `${info.sticks.max_rate.toFixed(0)} deg/s`,
    ];
    for (const value of values) {
      row.appendChild(el("td", `num${value === null ? " muted" : ""}`, value === null ? "n/a" : value));
    }
    body.appendChild(row);
  }
}

function renderChanges(tune) {
  const target = $("changes");
  target.replaceChildren();
  if (!tune.changes.length) {
    target.appendChild(el("p", "nothing",
      `Nothing to change: this tune already fits ${styleLabel(tune.style).toLowerCase()} flying.`));
    return;
  }
  for (const [group, title] of GROUPS) {
    const changes = tune.changes.filter((change) => change.group === group);
    if (!changes.length) continue;
    target.appendChild(el("h3", "", title));
    const wrap = el("div", "table-wrap");
    const table = el("table", "changes");
    const head = el("tr");
    for (const [text, className] of [["Setting", ""], ["Current", "num"], ["", ""], ["Suggested", ""], ["Why", ""]]) {
      const th = el("th", className, text);
      th.scope = "col";
      head.appendChild(th);
    }
    const thead = el("thead");
    thead.appendChild(head);
    const body = el("tbody");
    for (const change of changes) {
      const row = el("tr");
      row.append(
        el("td", "param", change.param),
        el("td", "num", change.current === null ? "?" : String(change.current)),
        el("td", "arrow", "→"),
        el("td", "num suggested", String(change.suggested)),
        el("td", "reason", change.reason),
      );
      row.children[3].style.textAlign = "left";
      body.appendChild(row);
    }
    table.append(thead, body);
    wrap.appendChild(table);
    target.appendChild(wrap);
  }
}

function renderNotes(tune) {
  $("notes-card").hidden = !tune.notes.length;
  $("notes").replaceChildren(...tune.notes.map((note) => el("li", "", note)));
}

function renderCli(tune) {
  $("cli-card").hidden = !tune.cli.length;
  $("cli").textContent = tune.cli.join("\n");
}

// Charts are drawn at the container's pixel width: redraw when it changes.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.data) renderCharts(state.data, state.data.tunes[state.style]); }, 150);
});

setupControls();
loadStyles();
