// Minimal SVG line chart: shared x values, one y scale, crosshair tooltip.
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, value);
  if (parent) parent.appendChild(el);
  return el;
}

function niceTicks(min, max, count) {
  const rough = (max - min) / count;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

/**
 * options: {
 *   series: [{name, color, y: number[]}], x: number[],
 *   xDomain: [min, max], yDomain?: [min, max], yLog?: boolean,
 *   xTitle, yTitle, xFormat, yFormat,
 *   band?: {from, to}, hline?: number, vline?: {x, label}, empty?: string
 * }
 */
function lineChart(container, options) {
  container.replaceChildren();
  const width = Math.max(300, container.clientWidth || 520);
  const height = 270;
  const margin = { top: 12, right: 14, bottom: 38, left: 46 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" }, container);
  svg.setAttribute("aria-label", options.label || "");

  const series = options.series.filter((s) => s.y && s.y.length);
  const [x0, x1] = options.xDomain;
  const inRange = options.x.map((v) => v >= x0 && v <= x1);

  // y domain from the visible data unless given
  let [y0, y1] = options.yDomain || [Infinity, -Infinity];
  if (!options.yDomain) {
    for (const s of series) {
      s.y.forEach((v, i) => {
        if (!inRange[i] || (options.yLog && v <= 0)) return;
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      });
    }
    if (!isFinite(y0)) [y0, y1] = options.yLog ? [0.001, 1] : [0, 1];
    if (options.yLog) {
      y0 = Math.pow(10, Math.floor(Math.log10(y0)));
      y1 = Math.pow(10, Math.ceil(Math.log10(y1)));
    }
  }

  const sx = (v) => margin.left + ((v - x0) / (x1 - x0)) * plotW;
  const ty = options.yLog ? Math.log10 : (v) => v;
  const sy = (v) => margin.top + plotH - ((ty(v) - ty(y0)) / (ty(y1) - ty(y0))) * plotH;

  // Target band sits behind everything.
  if (options.band) {
    const top = sy(Math.min(options.band.to, y1));
    const bottom = sy(Math.max(options.band.from, y0));
    svgEl("rect", {
      x: margin.left, y: top, width: plotW, height: Math.max(0, bottom - top),
      fill: "var(--text-muted)", opacity: 0.16,
    }, svg);
  }

  // Grid and ticks
  let yTicks;
  if (options.yLog) {
    yTicks = [];
    for (let e = Math.round(Math.log10(y0)); e <= Math.round(Math.log10(y1)); e++) {
      yTicks.push(Math.pow(10, e));
    }
  } else {
    yTicks = niceTicks(y0, y1, 5);
  }
  for (const tick of yTicks) {
    const y = sy(tick);
    svgEl("line", { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, stroke: "var(--grid)" }, svg);
    const text = svgEl("text", { x: margin.left - 8, y: y + 4, "text-anchor": "end" }, svg);
    text.textContent = options.yFormat(tick);
  }
  for (const tick of niceTicks(x0, x1, Math.max(3, Math.floor(plotW / 80)))) {
    const text = svgEl("text", {
      x: sx(tick), y: margin.top + plotH + 16, "text-anchor": "middle",
    }, svg);
    text.textContent = options.xFormat(tick);
  }
  svgEl("line", {
    x1: margin.left, x2: margin.left + plotW, y1: margin.top + plotH, y2: margin.top + plotH,
    stroke: "var(--axis)",
  }, svg);
  const xTitle = svgEl("text", {
    x: margin.left + plotW / 2, y: height - 4, "text-anchor": "middle", class: "axis-title",
  }, svg);
  xTitle.textContent = options.xTitle;

  if (options.hline !== undefined) {
    const y = sy(options.hline);
    svgEl("line", { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, stroke: "var(--axis)" }, svg);
  }
  if (options.vline && options.vline.x > x0 && options.vline.x < x1) {
    const x = sx(options.vline.x);
    svgEl("line", { x1: x, x2: x, y1: margin.top, y2: margin.top + plotH, stroke: "var(--axis)" }, svg);
    const label = svgEl("text", { x: x + 5, y: margin.top + 10, class: "annotation" }, svg);
    label.textContent = options.vline.label;
  }

  if (!series.length) {
    const text = svgEl("text", {
      x: margin.left + plotW / 2, y: margin.top + plotH / 2, "text-anchor": "middle", class: "empty",
    }, svg);
    text.textContent = options.empty || "No data";
    return;
  }

  // Lines
  const clipId = `clip-${Math.random().toString(36).slice(2)}`;
  const clip = svgEl("clipPath", { id: clipId }, svg);
  svgEl("rect", { x: margin.left, y: margin.top - 2, width: plotW, height: plotH + 4 }, clip);
  for (const s of series) {
    let d = "";
    let pen = false;
    s.y.forEach((v, i) => {
      if (!inRange[i] || (options.yLog && v <= 0)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${sx(options.x[i]).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    svgEl("path", {
      d, fill: "none", stroke: s.color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round", "clip-path": `url(#${clipId})`,
    }, svg);
  }

  // Hover layer: crosshair snaps to the nearest sample, one tooltip lists every series.
  const visible = options.x.map((_, i) => i).filter((i) => inRange[i]);
  const cross = svgEl("line", {
    y1: margin.top, y2: margin.top + plotH, stroke: "var(--text-muted)", visibility: "hidden",
  }, svg);
  const dots = series.map((s) => svgEl("circle", {
    r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden",
  }, svg));
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.hidden = true;
  container.appendChild(tooltip);

  let current = -1;
  function show(index) {
    current = index;
    const x = sx(options.x[index]);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("visibility", "visible");
    tooltip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tooltip-head";
    head.textContent = options.xFormat(options.x[index], true);
    tooltip.appendChild(head);
    series.forEach((s, k) => {
      const value = s.y[index];
      const drawable = !(options.yLog && value <= 0);
      dots[k].setAttribute("visibility", drawable ? "visible" : "hidden");
      if (drawable) {
        dots[k].setAttribute("cx", x);
        dots[k].setAttribute("cy", Math.max(margin.top, Math.min(margin.top + plotH, sy(value))));
      }
      const row = document.createElement("div");
      row.className = "tooltip-row";
      const key = document.createElement("span");
      key.className = "key";
      key.style.background = s.color;
      const strong = document.createElement("strong");
      strong.textContent = options.yFormat(value, true);
      const name = document.createElement("span");
      name.textContent = s.name;
      row.append(key, strong, name);
      tooltip.appendChild(row);
    });
    tooltip.hidden = false;
    const scale = container.clientWidth / width;
    const left = x * scale;
    const flip = left > container.clientWidth * 0.6;
    tooltip.style.left = flip ? "" : `${left + 12}px`;
    tooltip.style.right = flip ? `${container.clientWidth - left + 12}px` : "";
    tooltip.style.top = `${margin.top * scale}px`;
  }
  function hide() {
    current = -1;
    cross.setAttribute("visibility", "hidden");
    dots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
    tooltip.hidden = true;
  }

  const overlay = svgEl("rect", {
    x: margin.left, y: margin.top, width: plotW, height: plotH, fill: "transparent", tabindex: 0,
  }, svg);
  overlay.style.outline = "none";
  overlay.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const value = x0 + (((event.clientX - box.left) / box.width) * width - margin.left) / plotW * (x1 - x0);
    let best = visible[0];
    for (const i of visible) {
      if (Math.abs(options.x[i] - value) < Math.abs(options.x[best] - value)) best = i;
    }
    show(best);
  });
  overlay.addEventListener("pointerleave", hide);
  overlay.addEventListener("focus", () => show(visible[Math.floor(visible.length / 2)]));
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = Math.max(0, visible.indexOf(current));
    const stride = Math.max(1, Math.round(visible.length / 60)) * (event.key === "ArrowLeft" ? -1 : 1);
    show(visible[Math.max(0, Math.min(visible.length - 1, at + stride))]);
  });
}
