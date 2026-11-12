// Small dependency-free SVG charts. Every chart: thin marks, recessive grid,
// hover tooltip, and a text equivalent (the Data tab) for screen readers.
const NS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// ---- tooltip (one shared element) ----------------------------------------
let tipEl;
function tip() {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; tipEl.setAttribute("role", "presentation"); document.body.appendChild(tipEl); }
  return tipEl;
}
export function showTip(html, x, y) {
  const t = tip(); t.innerHTML = html; t.classList.add("on");
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  t.style.left = Math.max(8, left) + "px"; t.style.top = top + "px";
}
export function hideTip() { if (tipEl) tipEl.classList.remove("on"); }
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const tipRow = (color, name, value) => `<div class="r"><i style="background:${color}"></i><span>${esc(name)}</span><b>${esc(value)}</b></div>`;

// ---- scale helpers ----------------------------------------------------------
export function niceTicks(min, max, count = 4) {
  if (!isFinite(min) || !isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
  if (min === max) { max = min + 1; }
  const span = max - min, raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = []; for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { ticks, min: lo, max: hi };
}

// Re-render whenever the container's width changes.
function responsive(container, draw) {
  container.innerHTML = "";
  let last = 0;
  const run = () => {
    const w = Math.floor(container.clientWidth);
    if (w < 40 || w === last) return;
    last = w; draw(w);
  };
  run();
  const ro = new ResizeObserver(run); ro.observe(container);
  container._ro?.disconnect(); container._ro = ro;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const color = (token) => `var(${token})`;

function shortDate(d) {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const longDate = (d) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

// ---- line chart over days ---------------------------------------------------
// series: [{name, color, values:[number|null]}], dates: ['YYYY-MM-DD'...]
export function lineChart(container, { dates, series, height = 200, fmt = (v) => String(Math.round(v)), band, yMin, yMax, aria, area = false, unit = "" }) {
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { container.innerHTML = '<div class="nodata">No data in this range yet.</div>'; return; }
  responsive(container, (W) => {
    container.innerHTML = "";
    const m = { l: 40, r: 10, t: 10, b: 24 }, w = W - m.l - m.r, h = height - m.t - m.b;
    let lo = Math.min(...all), hi = Math.max(...all);
    if (band) { lo = Math.min(lo, band.lo); hi = Math.max(hi, band.hi); }
    const pad = (hi - lo) * 0.12 || 1;
    const nt = niceTicks(yMin ?? lo - pad, yMax ?? hi + pad, 4);
    const x = (i) => m.l + (dates.length === 1 ? w / 2 : (i / (dates.length - 1)) * w);
    const y = (v) => m.t + h - ((v - nt.min) / (nt.max - nt.min)) * h;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${height}`, height, role: "img", "aria-label": aria || "Line chart" }, container);
    for (const t of nt.ticks) {
      svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: "var(--grid)", "stroke-width": 1 }, svg);
      svgEl("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = fmt(t);
    }
    if (band) svgEl("rect", { x: m.l, width: w, y: y(band.hi), height: Math.max(0, y(band.lo) - y(band.hi)), fill: "var(--band)", rx: 4 }, svg);
    const every = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor(w / 78))));
    dates.forEach((d, i) => { if (i % every === 0 || i === dates.length - 1 && dates.length < 8) svgEl("text", { x: x(i), y: height - 6, "text-anchor": "middle" }, svg).textContent = shortDate(d); });
    for (const s of series) {
      let d = "", pen = false, firstX = 0, lastX = 0, baseY = y(nt.min);
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; if (!pen) firstX = x(i); lastX = x(i); pen = true;
      });
      if (area && series.length === 1) svgEl("path", { d: `${d}L${lastX},${baseY}L${firstX},${baseY}Z`, fill: s.color, opacity: 0.14 }, svg);
      svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dashed ? "5 4" : null }, svg);
      const li = [...s.values.keys()].reverse().find((i) => s.values[i] != null);
      if (li != null) { svgEl("circle", { cx: x(li), cy: y(s.values[li]), r: 4.5, fill: s.color, stroke: "var(--card)", "stroke-width": 2 }, svg); }
    }
    attachHover(svg, container, { W, height, m, w, dates, x, y, series, fmt, unit });
  });
}

function attachHover(svg, container, { height, m, w, dates, x, y, series, fmt, unit }) {
  const cross = svgEl("line", { y1: m.t, y2: height - m.b, stroke: "var(--ink-3)", "stroke-width": 1, opacity: 0 }, svg);
  const dots = series.map((s) => svgEl("circle", { r: 5, fill: s.color, stroke: "var(--card)", "stroke-width": 2, opacity: 0 }, svg));
  const hit = svgEl("rect", { x: m.l - 6, y: m.t, width: w + 12, height: height - m.t - m.b, fill: "transparent" }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(((px - m.l) / w) * (dates.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", 0.5);
    let html = `<div class="t">${esc(longDate(dates[i]))}</div>`;
    series.forEach((s, k) => {
      const v = s.values[i];
      if (v == null) { dots[k].setAttribute("opacity", 0); return; }
      dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("opacity", 1);
      html += tipRow(s.color, s.name, fmt(v) + (unit ? " " + unit : ""));
    });
    showTip(html, ev.clientX, ev.clientY);
  };
  const leave = () => { cross.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0)); hideTip(); };
  hit.addEventListener("pointermove", move); hit.addEventListener("pointerleave", leave); hit.addEventListener("pointerdown", move);
}

// ---- bars over days (single or stacked) ------------------------------------
// data: [{d, v}] or stacked [{d, parts:[{key,name,color,v}]}]
export function barChart(container, { data, color: col, height = 190, fmt = (v) => String(Math.round(v)), goal, aria, unit = "", stackNames }) {
  if (!data.some((r) => (r.parts ? r.parts.some((p) => p.v) : r.v != null))) { container.innerHTML = '<div class="nodata">No data in this range yet.</div>'; return; }
  responsive(container, (W) => {
    container.innerHTML = "";
    const m = { l: 40, r: 6, t: 10, b: 24 }, w = W - m.l - m.r, h = height - m.t - m.b;
    const totals = data.map((r) => (r.parts ? r.parts.reduce((a, p) => a + (p.v || 0), 0) : r.v || 0));
    const nt = niceTicks(0, Math.max(...totals, goal || 0) * 1.05, 4);
    const y = (v) => m.t + h - (v / nt.max) * h;
    const slot = w / data.length, bw = Math.max(2, Math.min(34, slot - 2));
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${height}`, height, role: "img", "aria-label": aria || "Bar chart" }, container);
    for (const t of nt.ticks) {
      svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: "var(--grid)" }, svg);
      svgEl("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = fmt(t);
    }
    const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(w / 78))));
    const topPath = (x0, y0, wd, ht) => { const r = Math.min(4, wd / 2, ht); return `M${x0},${y0 + ht}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + wd - r}Q${x0 + wd},${y0} ${x0 + wd},${y0 + r}V${y0 + ht}Z`; };
    data.forEach((r, i) => {
      const x0 = m.l + i * slot + (slot - bw) / 2;
      if (i % every === 0) svgEl("text", { x: x0 + bw / 2, y: height - 6, "text-anchor": "middle" }, svg).textContent = shortDate(r.d);
      if (r.parts) {
        let acc = 0; const live = r.parts.filter((p) => p.v > 0);
        live.forEach((p, k) => {
          const yTop = y(acc + p.v), yBot = y(acc) - (k > 0 ? 0 : 0), gap = k > 0 ? 2 : 0;
          const ht = Math.max(1, yBot - yTop - gap);
          const top = k === live.length - 1;
          svgEl(top ? "path" : "rect", top ? { d: topPath(x0, yTop, bw, ht), fill: p.color } : { x: x0, y: yTop, width: bw, height: ht, fill: p.color }, svg);
          acc += p.v;
        });
      } else if (r.v != null && r.v > 0) {
        svgEl("path", { d: topPath(x0, y(r.v), bw, y(0) - y(r.v)), fill: col }, svg);
      }
    });
    if (goal) {
      svgEl("line", { x1: m.l, x2: W - m.r, y1: y(goal), y2: y(goal), stroke: "var(--ink-3)", "stroke-dasharray": "4 4" }, svg);
      svgEl("text", { x: W - m.r, y: y(goal) - 5, "text-anchor": "end", class: "lbl" }, svg).textContent = `Goal ${fmt(goal)}`;
    }
    const hit = svgEl("rect", { x: m.l, y: m.t, width: w, height: h, fill: "transparent" }, svg);
    const hl = svgEl("rect", { y: m.t, height: h, fill: "var(--hover)", opacity: 0, rx: 3 }, svg); svg.insertBefore(hl, svg.children[0]);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(data.length - 1, Math.floor((ev.clientX - r.left - m.l) / slot)));
      hl.setAttribute("x", m.l + i * slot); hl.setAttribute("width", slot); hl.setAttribute("opacity", 0.7);
      const row = data[i];
      let html = `<div class="t">${esc(longDate(row.d))}</div>`;
      if (row.parts) { for (const p of row.parts) html += tipRow(p.color, p.name, fmt(p.v || 0) + (unit ? " " + unit : "")); html += tipRow("var(--ink-3)", "Total", fmt(totals[i]) + (unit ? " " + unit : "")); }
      else html += tipRow(col, aria?.split(",")[0] || "Value", row.v != null ? fmt(row.v) + (unit ? " " + unit : "") : "No data");
      showTip(html, ev.clientX, ev.clientY);
    };
    hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { hl.setAttribute("opacity", 0); hideTip(); });
  });
}

// ---- body battery: one day, 00:00 to 24:00 ---------------------------------
export function dayAreaChart(container, { points, col, height = 230, aria }) {
  if (!points?.length) { container.innerHTML = '<div class="nodata">No Body Battery readings for this day yet.</div>'; return; }
  responsive(container, (W) => {
    container.innerHTML = "";
    const m = { l: 34, r: 12, t: 12, b: 24 }, w = W - m.l - m.r, h = height - m.t - m.b;
    const d0 = new Date(points[0][0]); d0.setHours(0, 0, 0, 0);
    const t0 = d0.getTime(), DAY = 86400000;
    const x = (t) => m.l + ((t - t0) / DAY) * w, y = (v) => m.t + h - (v / 100) * h;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${height}`, height, role: "img", "aria-label": aria || "Body Battery over the day" }, container);
    for (const t of [0, 25, 50, 75, 100]) {
      svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: "var(--grid)" }, svg);
      svgEl("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = t;
    }
    [[0, "12a"], [6, "6a"], [12, "12p"], [18, "6p"], [24, "12a"]].forEach(([hr, label], i, a) => svgEl("text", { x: x(t0 + hr * 3600000), y: height - 6, "text-anchor": i === 0 ? "start" : i === a.length - 1 ? "end" : "middle" }, svg).textContent = label);
    const pts = points.map(([t, v]) => [x(t), y(v)]);
    const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    svgEl("path", { d: `${line}L${pts.at(-1)[0]},${y(0)}L${pts[0][0]},${y(0)}Z`, fill: col, opacity: 0.16 }, svg);
    svgEl("path", { d: line, fill: "none", stroke: col, "stroke-width": 2.5, "stroke-linejoin": "round" }, svg);
    const last = points.at(-1);
    svgEl("circle", { cx: x(last[0]), cy: y(last[1]), r: 5.5, fill: col, stroke: "var(--card)", "stroke-width": 2 }, svg);
    const cross = svgEl("line", { y1: m.t, y2: m.t + h, stroke: "var(--ink-3)", opacity: 0 }, svg);
    const dot = svgEl("circle", { r: 5, fill: col, stroke: "var(--card)", "stroke-width": 2, opacity: 0 }, svg);
    const hit = svgEl("rect", { x: m.l, y: m.t, width: w, height: h, fill: "transparent" }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), t = t0 + ((ev.clientX - r.left - m.l) / w) * DAY;
      let best = points[0]; for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      cross.setAttribute("x1", x(best[0])); cross.setAttribute("x2", x(best[0])); cross.setAttribute("opacity", 0.5);
      dot.setAttribute("cx", x(best[0])); dot.setAttribute("cy", y(best[1])); dot.setAttribute("opacity", 1);
      const time = new Date(best[0]).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      showTip(`<div class="t">${esc(time)}</div>${tipRow(col, "Body Battery", String(Math.round(best[1])))}`, ev.clientX, ev.clientY);
    };
    hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip(); });
  });
}

// ---- sparkline --------------------------------------------------------------
export function sparkline(container, values, col, height = 40) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) { container.innerHTML = ""; return; }
  responsive(container, (W) => {
    container.innerHTML = "";
    const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    const x = (i) => 4 + (i / (values.length - 1)) * (W - 8), y = (v) => 5 + (height - 10) - ((v - lo) / (hi - lo || 1)) * (height - 10);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${height}`, height, "aria-hidden": "true" }, container);
    let d = ""; let pen = false;
    values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    svgEl("path", { d, fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    const [li, lv] = pts.at(-1);
    svgEl("circle", { cx: x(li), cy: y(lv), r: 4, fill: col, stroke: "var(--card)", "stroke-width": 2 }, svg);
  });
}
