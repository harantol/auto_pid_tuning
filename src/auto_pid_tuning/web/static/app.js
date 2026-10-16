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
  // In the Android app (android/), the page is plain HTTP in a WebView: no clipboard API and no
  // downloads there, so the app does both.
  const android = window.AutoPidAndroid;
  $("copy").addEventListener("click", async () => {
    if (android) android.copy($("cli").textContent);
    else await navigator.clipboard.writeText($("cli").textContent);
    $("copy").textContent = "Copied";
    setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
  });
  $("download").addEventListener("click", () => {
    if (android) {
      const saved = android.save(`tune-${state.style}.txt`, $("cli").textContent + "\n");
      $("download").textContent = saved ? "Saved in Downloads" : "Not saved";
      setTimeout(() => { $("download").textContent = "Download"; }, 2000);
      return;
    }
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
  renderExplorer(data);
  renderTiles(data, tune);
  renderCharts(data, tune);
  renderMeasured(data);
  renderChanges(data, tune);
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

// Blackbox Explorer cannot be handed a file from another site: the link opens it, and the
// text names the log (and flight) to open there again.
function renderExplorer(data) {
  const link = el("a", "", "Blackbox Explorer");
  link.href = "https://blackbox.betaflight.com/";
  link.target = "_blank";
  link.rel = "noopener";
  const flight = data.log_count > 1 ? `, flight ${data.log_index}` : "";
  $("explorer").replaceChildren(
    "To see the raw traces, open ", link, ` and choose ${state.file.name}${flight} there.`,
  );
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
    if (!entry.band) key.style.background = entry.color || COLORS[entry.axis];
    if (entry.dash) key.classList.add("dash");
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

function renderChanges(data, tune) {
  const target = $("changes");
  target.replaceChildren();
  if (!tune.changes.length) {
    target.appendChild(el("p", "nothing",
      `Nothing to change: this tune already fits ${styleLabel(tune.style).toLowerCase()} flying.`));
    return;
  }
  // Figures are numbered across groups, in the order their first change appears.
  const figures = [];
  for (const change of tune.changes) {
    if (change.evidence && !figures.includes(change.evidence)) figures.push(change.evidence);
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
      const reason = el("td", "reason", change.reason);
      if (change.evidence) {
        const link = el("a", "figure-link", `Fig. ${figures.indexOf(change.evidence) + 1}`);
        link.href = `#figure-${change.evidence}`;
        reason.append(" ", link);
      }
      row.append(
        el("td", "param", change.param),
        el("td", "num", change.current === null ? "?" : String(change.current)),
        el("td", "arrow", "→"),
        el("td", "num suggested", String(change.suggested)),
        reason,
      );
      row.children[3].style.textAlign = "left";
      body.appendChild(row);
    }
    table.append(thead, body);
    wrap.appendChild(table);
    target.appendChild(wrap);

    const shown = figures.filter((id) => changes.some((change) => change.evidence === id));
    const grid = el("div", "evidence");
    for (const id of shown) {
      const justified = tune.changes.filter((change) => change.evidence === id);
      const figure = evidenceFigure(id, figures.indexOf(id) + 1, justified, data, tune);
      if (figure) grid.appendChild(figure);
    }
    if (grid.children.length) target.appendChild(grid);
  }
}

// ---- Evidence: the part of the log behind each change ------------------------------------

function clock(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function percent(ratio) {
  const value = (ratio - 1) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`;
}

const MS = { xTitle: "Time (ms)", xFormat: (v, full) => (full ? `${v.toFixed(0)} ms` : v.toFixed(0)) };
const DPS = (v, full) => (full ? `${v.toFixed(0)} deg/s` : v.toFixed(0));

// Each builder returns {title, caption, legend, chart} for one evidence id, or null.
const EVIDENCE = {
  move(axis, data, tune) {
    const excerpt = data.excerpts[`move_${axis}`];
    const step = data.axes[axis].step_response;
    const measured = step && step.valid
      ? ` Averaged over the whole flight, ${axis} peaks at ${percent(step.peak)} for a target of `
        + `${percent(tune.peak_min)} to ${percent(tune.peak_max)}.`
      : "";
    return {
      title: `Sharpest ${axis} move, at ${clock(excerpt.start)}`,
      caption: "The dashed line is what the sticks asked for, the solid one what the quad did. "
        + "Going past the dashed line and swinging back is overshoot; trailing behind it is a "
        + `slow response.${measured}`,
      legend: [
        { color: "var(--text-secondary)", dash: true, text: "Setpoint" },
        { axis, text: `${styleLabel(axis)} gyro` },
      ],
      chart: {
        label: `Setpoint and gyro of ${axis} during its sharpest move`,
        x: excerpt.time.map((t) => t * 1000),
        series: [
          { name: "Setpoint", color: "var(--text-secondary)", dash: true, y: excerpt.series.setpoint },
          { name: "Gyro", color: COLORS[axis], y: excerpt.series.gyro },
        ],
        xDomain: [0, excerpt.time[excerpt.time.length - 1] * 1000],
        ...MS,
        yFormat: DPS,
        hline: 0,
      },
    };
  },

  hold(axis, data) {
    const excerpt = data.excerpts[`hold_${axis}`];
    const step = data.axes[axis].step_response;
    const measured = step && step.valid
      ? ` Over the whole flight it settles at ${(step.steady_state * 100).toFixed(0)}% of the setpoint.`
      : "";
    return {
      title: `Longest ${axis} hold, at ${clock(excerpt.start)}`,
      caption: "While the stick is held, the gyro should settle on the setpoint. Staying below it "
        + `means not enough I to hold the rate against drag and wind.${measured}`,
      legend: [
        { color: "var(--text-secondary)", dash: true, text: "Setpoint" },
        { axis, text: `${styleLabel(axis)} gyro` },
      ],
      chart: {
        label: `Setpoint and gyro of ${axis} during its longest held input`,
        x: excerpt.time.map((t) => t * 1000),
        series: [
          { name: "Setpoint", color: "var(--text-secondary)", dash: true, y: excerpt.series.setpoint },
          { name: "Gyro", color: COLORS[axis], y: excerpt.series.gyro },
        ],
        xDomain: [0, excerpt.time[excerpt.time.length - 1] * 1000],
        ...MS,
        yFormat: DPS,
        hline: 0,
      },
    };
  },

  dterm(_, data, tune) {
    const excerpt = data.excerpts.dterm;
    const noise = Math.max(data.axes.roll.noise.dterm_rms, data.axes.pitch.noise.dterm_rms);
    return {
      title: `Typical D-term, at ${clock(excerpt.start)}`,
      caption: "A quarter of a second picked for its typical noise level. The slow swings are the "
        + "quad moving; the fast jitter on top is noise that the filters let through, which heats "
        + `the motors. Its level over the flight is ${noise.toFixed(1)}, and `
        + `${styleLabel(tune.style).toLowerCase()} keeps it between ${tune.noise_low} and ${tune.noise_high}.`,
      legend: ["roll", "pitch"].map((axis) => ({ axis, text: `${styleLabel(axis)} D-term` })),
      chart: {
        label: "D-term of roll and pitch over a typical quarter second",
        x: excerpt.time.map((t) => t * 1000),
        series: ["roll", "pitch"].map((axis) => ({
          name: styleLabel(axis), color: COLORS[axis], y: excerpt.series[axis],
        })),
        xDomain: [0, excerpt.time[excerpt.time.length - 1] * 1000],
        ...MS,
        yFormat: (v) => v.toFixed(0),
        hline: 0,
      },
    };
  },

  notch(_, data, tune) {
    const [low, high] = tune.evidence.notch.range;
    const peaks = ["roll", "pitch"]
      .map((axis) => data.axes[axis].noise.peak_hz)
      .filter((hz) => hz !== null);
    const hz = data.spectrum.hz;
    return {
      title: "Noise peak and dynamic notch range",
      caption: `The dynamic notch only follows noise inside the shaded range (${low}-${high} Hz). `
        + "A peak outside it goes through unfiltered, so the range is widened to reach it.",
      legend: ["roll", "pitch"].map((axis) => ({ axis, text: `${styleLabel(axis)} gyro` })),
      chart: {
        label: "Gyro noise spectrum with the dynamic notch range",
        x: hz,
        series: ["roll", "pitch"].map((axis) => ({
          name: styleLabel(axis), color: COLORS[axis], y: data.spectrum[axis],
        })),
        xDomain: [0, hz.length ? hz[hz.length - 1] : 500],
        yLog: true,
        xBand: { from: low, to: high },
        vlines: peaks.map((peak) => ({ x: peak, label: `${peak.toFixed(0)} Hz` })),
        xTitle: "Frequency (Hz)",
        xFormat: (v, full) => (full ? `${v.toFixed(0)} Hz` : v.toFixed(0)),
        yFormat: (v, full) => (full ? v.toPrecision(2) : String(v)),
      },
    };
  },

  rates(axis, data, tune) {
    const curves = tune.evidence[`rates_${axis}`];
    const sticks = data.axes[axis].sticks;
    const series = [];
    if (curves.current) {
      series.push({ name: "Current", color: "var(--text-secondary)", dash: true, y: curves.current });
    }
    series.push({ name: "Suggested", color: COLORS[axis], y: curves.suggested });
    const top = Math.max(...curves.suggested, ...(curves.current || []), sticks.max_rate);
    return {
      title: `${styleLabel(axis)} rate curve`,
      caption: "Rotation speed asked for at each stick position. The shaded band is where the "
        + `sticks stayed 95% of the flight (up to ${sticks.p95.toFixed(0)} deg/s); the fastest `
        + `command was ${sticks.max_rate.toFixed(0)} deg/s. A gentler centre gives finer control `
        + "there, the end of the curve keeps the flips.",
      legend: [
        ...(curves.current ? [{ color: "var(--text-secondary)", dash: true, text: "Current" }] : []),
        { axis, text: "Suggested" },
        { band: true, text: "95% of the flight" },
      ],
      chart: {
        label: `Current and suggested ${axis} rate curves`,
        x: curves.stick.map((x) => x * 100),
        series,
        xDomain: [0, 100],
        yDomain: [0, Math.ceil(top / 100) * 100],
        band: { from: 0, to: sticks.p95 },
        xTitle: "Stick deflection (%)",
        xFormat: (v, full) => (full ? `${v.toFixed(0)}% stick` : v.toFixed(0)),
        yFormat: DPS,
      },
    };
  },
};

function evidenceFigure(id, number, justified, data, tune) {
  const [kind, axis] = id.split("_");
  const build = EVIDENCE[kind];
  const spec = build ? build(axis, data, tune) : null;
  if (!spec) return null;
  const figure = el("figure", "card evidence-figure");
  figure.id = `figure-${id}`;
  figure.appendChild(el("h4", "", `Fig. ${number} · ${spec.title}`));
  figure.appendChild(el("p", "card-sub", spec.caption));
  const why = el("p", "justifies", "Justifies ");
  justified.forEach((change, k) => {
    if (k) why.append(", ");
    why.appendChild(el("code", "", change.param));
  });
  figure.appendChild(why);
  const keys = el("div", "legend");
  legend(keys, spec.legend);
  const chart = el("div", "chart");
  figure.append(keys, chart);
  // The chart is sized from its container: draw it once the figure is in the page.
  requestAnimationFrame(() => lineChart(chart, spec.chart));
  return figure;
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
  resizeTimer = setTimeout(() => {
    if (!state.data) return;
    const tune = state.data.tunes[state.style];
    renderCharts(state.data, tune);
    renderChanges(state.data, tune);
  }, 150);
});

setupControls();
async function loadVersion() {
  const { version } = await (await fetch("/api/version")).json();
  $("version").textContent = `v${version}`;
}

loadStyles();
loadVersion();
