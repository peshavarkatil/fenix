import * as D from "./data.js";
import { lineChart, barChart, dayAreaChart, sparkline, esc, longDate } from "./charts.js";

// ------------------------------------------------------------------ state
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("fd:" + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fd:" + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const state = {
  tab: store.get("tab", "today"), range: store.get("range", 30), units: store.get("units", "mi"),
  theme: store.get("theme", "auto"), typeFilter: "all",
  days: [], acts: [], status: null, loaded: false, error: null,
};
const TABS = [["today", "Today"], ["sleep", "Sleep"], ["recovery", "Recovery"], ["training", "Training"], ["data", "Data"]];
const RANGES = [[7, "7d"], [30, "30d"], [90, "90d"]];
const KIND_LABEL = { daily_summaries: "Daily summary", steps: "Steps", stress: "Stress", hrv: "HRV", sleep: "Sleep", body_battery: "Body Battery", activities: "Activities" };

// ------------------------------------------------------------------ formatting
const n0 = (v) => (v == null ? "–" : Math.round(v).toLocaleString());
const n1 = (v) => (v == null ? "–" : (Math.round(v * 10) / 10).toLocaleString());
const mean = (a) => { const x = a.filter((v) => v != null); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
const hm = (s) => (s == null ? "–" : `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`);
const hmBig = (s) => (s == null ? "–" : `${Math.floor(s / 3600)}<span class="u">h</span> ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}<span class="u">m</span>`);
const hoursFmt = (v) => (v == null ? "–" : `${n1(v)}h`);
const distOf = (m) => (m == null ? null : state.units === "mi" ? m / 1609.344 : m / 1000);
const distFmt = (m) => (m == null || m === 0 ? "–" : n1(distOf(m)));
const unitLabel = () => state.units;
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const lastWith = (arr, key) => [...arr].reverse().find((d) => d[key] != null);
const vals = (arr, key) => arr.map((d) => (d[key] == null ? null : d[key]));
function vsAvg(arr, key, unit = "") {
  const last = lastWith(arr, key); if (!last) return "";
  const prev = arr.filter((d) => d.date < last.date && d[key] != null).slice(-7).map((d) => d[key]);
  if (prev.length < 3) return "";
  const diff = last[key] - mean(prev);
  if (Math.abs(diff) < 0.5) return "About your 7-day average";
  return `${n0(Math.abs(diff))}${unit} ${diff > 0 ? "above" : "below"} your 7-day average`;
}
const inRange = () => state.days.slice(-state.range);
const TYPE_LABEL = { running: "Run", trail_running: "Trail run", treadmill_running: "Treadmill run", cycling: "Ride", indoor_cycling: "Indoor ride", walking: "Walk", hiking: "Hike", strength_training: "Strength", lap_swimming: "Swim", open_water_swimming: "Swim" };
const typeLabel = (t) => TYPE_LABEL[t] || String(t || "Activity").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const ICONS = {
  cycling: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h5l3 8M10 8H8"/>',
  hiking: '<path d="M3 19l6-11 4 7 3-4 5 8z"/>',
  strength: '<path d="M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
};
const iconFor = (t) => (/cycl/.test(t) ? ICONS.cycling : /hik/.test(t) ? ICONS.hiking : /strength/.test(t) ? ICONS.strength : ICONS.pulse);
const icon = (t) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconFor(t)}</svg>`;
function paceOrSpeed(a) {
  const v = a.avg_speed_ms; if (!v) return ["–", ""];
  if (/cycl/.test(a.type)) return state.units === "mi" ? [n1(v * 2.23694), "mph"] : [n1(v * 3.6), "km/h"];
  const secs = (state.units === "mi" ? 1609.344 : 1000) / v;
  return [`${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`, `/${state.units}`];
}
const dateOnly = (iso) => (iso || "").slice(0, 10);
const timeOf = (iso) => { const m = /(\d\d):(\d\d)/.exec((iso || "").split(" ")[1] || iso || ""); if (!m) return ""; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`; };

// ------------------------------------------------------------------ data
const STALE_HOURS = 14;
function applySnapshot(snap, offline) {
  state.days = snap.days || []; state.acts = snap.activities || [];
  state.status = { mode: snap.mode, today: snap.today, kinds: snap.status || {}, last_sync: Date.parse(snap.generated) / 1000, offline,
    mode_note: snap.mode === "demo" ? "These are made-up numbers so you can try the app." : "" };
  state.error = null; state.locked = false; state.loaded = true;
}
// Returns true when the app is showing data. False means we need the passphrase.
async function load({ manual = false } = {}) {
  let buf = null, offline = false;
  try { buf = await D.fetchBlob(); }
  catch (e) {
    buf = await D.saved.get("blob"); offline = !!buf;
    if (!buf) { state.loaded = true; state.error = String(e.message) === "no-data" ? "no-data" : "Can't reach the data and nothing is saved on this phone yet. Check your internet connection."; render(); return false; }
  }
  const key = await D.saved.get("key"), keySalt = await D.saved.get("salt");
  let sh; try { sh = D.saltHex(buf); } catch { state.loaded = true; state.error = "The data file isn't readable. Re-run the refresh in GitHub."; render(); return false; }
  if (key && keySalt === sh) {
    try { const snap = await D.decrypt(buf, key); await D.saved.set("blob", buf); applySnapshot(snap, offline); render(); return true; }
    catch { await D.saved.del("key"); }
  }
  pending = buf; state.locked = true; state.loaded = true; state.lockMsg = manual ? "" : (key ? "Your passphrase changed. Enter the new one." : ""); render(); return false;
}
let pending = null;
async function unlock(pass) {
  if (!pending) return;
  const err = $("#uerr"), btn = $("#ubtn"); btn.disabled = true; btn.textContent = "Unlocking…"; err.hidden = true;
  try {
    const salt = D.parse(pending).salt, key = await D.deriveKey(pass, salt), snap = await D.decrypt(pending, key);
    await D.saved.set("key", key); await D.saved.set("salt", D.saltHex(pending)); await D.saved.set("blob", pending);
    applySnapshot(snap, false); pending = null; render();
  } catch (e) { err.textContent = e instanceof D.WrongPassphrase ? "That passphrase isn't right. Check for typos and try again." : "Something went wrong: " + e.message; err.hidden = false; btn.disabled = false; btn.textContent = "Unlock"; }
}
async function lockNow() { await D.saved.del("key"); await D.saved.del("salt"); await D.saved.del("blob"); state.days = []; state.acts = []; state.status = null; await load({ manual: true }); }
async function refresh() { const b = $("#sync"); b.disabled = true; b.innerHTML = '<span class="spin"></span>Checking'; await load({ manual: true }); }

// ------------------------------------------------------------------ chrome
const $ = (s) => document.querySelector(s);
function renderChrome() {
  $("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${state.tab === k}" data-tab="${k}">${l}</button>`).join("");
  $("#range").innerHTML = RANGES.map(([v, l]) => `<button type="button" aria-pressed="${state.range === v}" data-range="${v}">${l}</button>`).join("");
  $("#range").style.display = state.tab === "today" ? "none" : "";
  $("#units").innerHTML = ["mi", "km"].map((u) => `<button type="button" aria-pressed="${state.units === u}" data-units="${u}">${u}</button>`).join("");
  const s = state.status, locked = state.locked || !s;
  const b = $("#sync"); b.disabled = false; b.hidden = locked;
  b.innerHTML = `Updated ${esc(ago(s?.last_sync))}`;
  b.title = "Check for newer data";
  $("#mode-tag").textContent = s?.mode === "demo" ? "demo data" : "";
  $("#signout").hidden = locked; $("#signout").textContent = "Lock";
  document.querySelector(".tabs").style.visibility = locked ? "hidden" : "";
  $("#theme").textContent = state.theme === "auto" ? "Auto" : state.theme === "light" ? "Light" : "Dark";
  if (state.theme === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", state.theme);
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab],[data-range],[data-units],[data-filter],#sync,#theme,#signout,[data-act='retry'],[data-act='csv']");
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; store.set("tab", state.tab); }
  else if (t.dataset.range) { state.range = +t.dataset.range; store.set("range", state.range); }
  else if (t.dataset.units) { state.units = t.dataset.units; store.set("units", state.units); }
  else if (t.dataset.filter) { state.typeFilter = t.dataset.filter; }
  else if (t.id === "theme") { state.theme = { auto: "light", light: "dark", dark: "auto" }[state.theme]; store.set("theme", state.theme); }
  else if (t.id === "signout") { lockNow(); return; }
  else if (t.id === "sync" || t.dataset.act === "retry") { refresh(); return; }
  else if (t.dataset.act === "csv") { downloadCsv(); return; }
  render();
});

// ------------------------------------------------------------------ render
function banners() {
  const s = state.status, out = [];
  const info = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  if (state.error) out.push(`<div class="banner warn" role="alert">${info}<div><b>${esc(state.error)}</b></div></div>`);
  if (s?.offline) out.push(`<div class="banner">${info}<div><b>You're offline.</b> Showing the last data saved on this phone.</div></div>`);
  if (s && s.mode !== "demo" && Date.now() / 1000 - s.last_sync > STALE_HOURS * 3600) out.push(`<div class="banner warn" role="alert">${info}<div><b>The data hasn't refreshed for ${esc(ago(s.last_sync).replace(" ago", ""))}.</b> Open GitHub, go to Actions, and check the latest "Refresh Garmin data" run for a red cross. SETUP.md part 7 explains the fixes.</div></div>`);
  if (s?.mode === "demo") out.push(`<div class="banner">${info}<div><b>You're looking at sample data.</b> ${esc(s.mode_note || "")} Follow the setup guide to see your own numbers.</div></div>`);
  const bad = Object.entries(s?.kinds || {}).filter(([, v]) => v.error);
  if (bad.length) {
    out.push(`<div class="banner warn" role="alert">${info}<div><b>Garmin didn't return ${bad.map(([k]) => KIND_LABEL[k] || k).join(", ")} at the last refresh.</b> You're seeing the last data we saved. ${esc(bad[0][1].error)}</div></div>`);
  }
  return out.join("");
}

function unlockScreen() {
  const nodata = state.error === "no-data";
  if (nodata) return `<div class="card unlock"><h2>No data published yet</h2><p class="sub">The app is installed, but GitHub hasn't built your data file yet. In GitHub, open <b>Actions</b>, pick <b>Refresh Garmin data</b>, and press <b>Run workflow</b>. Come back here in about 3 minutes.</p><button class="btn" data-act="retry" type="button">Check again</button></div>`;
  return `<form class="card unlock" id="uform" autocomplete="off"><h2>Unlock your data</h2>
    <p class="sub">Your numbers are stored scrambled. Type your passphrase to read them. It stays on this phone.</p>
    ${state.lockMsg ? `<p class="note">${esc(state.lockMsg)}</p>` : ""}
    <label for="pass">Passphrase</label>
    <input id="pass" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required>
    <p class="err" id="uerr" role="alert" hidden></p>
    <button id="ubtn" class="go" type="submit">Unlock</button></form>`;
}
function render() {
  renderChrome();
  const main = $("#main");
  if (!state.loaded) { main.innerHTML = '<div class="empty"><p>Loading…</p></div>'; return; }
  if (state.locked || (state.error && !state.days.length)) {
    main.innerHTML = (state.error && state.error !== "no-data" ? banners() : "") + unlockScreen(); return;
  }
  let body;
  if (!state.days.length && !state.acts.length) {
    body = '<div class="empty"><h2>No data yet</h2><p>The file unlocked but has no days in it. Garmin may not have returned anything yet. Check the refresh log in GitHub.</p></div>';
  } else {
    body = { today: viewToday, sleep: viewSleep, recovery: viewRecovery, training: viewTraining, data: viewData }[state.tab]();
  }
  main.innerHTML = banners() + body;
  mountCharts();
}
document.addEventListener("submit", (e) => { if (e.target.id === "uform") { e.preventDefault(); unlock($("#pass").value); } });

const charts = [];
const chart = (html, fn) => { const id = "c" + charts.length; charts.push([id, fn]); return html.replace("%ID%", id); };
function mountCharts() { for (const [id, fn] of charts.splice(0)) { const el = document.getElementById(id); if (el) fn(el); } }
const slot = (id, label) => `<div class="chart" id="${id}" role="img" aria-label="${esc(label)}"></div>`;

function head(title, when = "") { return `<div class="h"><h2>${esc(title)}</h2>${when ? `<span class="when">${esc(when)}</span>` : ""}</div>`; }
function statCard({ title, when, n, u, note, id, span = "s3", extra = "" }) {
  return `<section class="card ${span}">${head(title, when)}<div class="big"><span class="n">${n}</span>${u ? `<span class="u">${u}</span>` : ""}</div><p class="sub">${note || "&nbsp;"}</p>${extra}${id ? slot(id, `${title} trend`) : ""}</section>`;
}

// ---- Today
function viewToday() {
  const days = state.days, today = state.status?.today;
  const sleepDay = lastWith(days, "sleep_total_s"), bbDay = [...days].reverse().find((d) => d.bb_series?.length);
  const out = [];
  // Body Battery hero
  if (bbDay) {
    const pts = bbDay.bb_series, cur = pts.at(-1)[1], isToday = bbDay.date === today;
    out.push(`<section class="card hero s8">${head("Body Battery", isToday ? "Today" : longDate(bbDay.date))}
      <div class="big"><span class="n">${n0(cur)}</span><span class="u">${isToday ? "now" : "at last reading"}</span></div>
      <div class="row"><div class="kv"><span class="k">Charged</span><span class="v">+${n0(bbDay.bb_charged)}</span></div>
      <div class="kv"><span class="k">Drained</span><span class="v">−${n0(bbDay.bb_drained)}</span></div>
      <div class="kv"><span class="k">High</span><span class="v">${n0(bbDay.bb_high)}</span></div>
      <div class="kv"><span class="k">Low</span><span class="v">${n0(bbDay.bb_low)}</span></div></div>
      ${chart(slot("%ID%", "Body Battery across the day"), (el) => dayAreaChart(el, { points: pts, col: "var(--c-battery)", aria: "Body Battery across the day" }))}
    </section>`);
  } else out.push(`<section class="card hero s8">${head("Body Battery")}<p class="nodata">No Body Battery readings yet.</p></section>`);
  // Sleep
  if (sleepDay) {
    const parts = [["Deep", "sleep_deep_s", "--st-deep"], ["Light", "sleep_light_s", "--st-light"], ["REM", "sleep_rem_s", "--st-rem"], ["Awake", "sleep_awake_s", "--st-awake"]];
    const total = parts.reduce((a, [, k]) => a + (sleepDay[k] || 0), 0);
    out.push(`<section class="card s4">${head("Last night", longDate(sleepDay.date))}
      <div class="big"><span class="n">${hmBig(sleepDay.sleep_total_s)}</span></div>
      <p class="sub">${sleepDay.sleep_score != null ? `Sleep score <b>${n0(sleepDay.sleep_score)}</b>` : "No sleep score"}${vsAvg(days, "sleep_total_s") ? "" : ""}</p>
      <div class="stack" role="img" aria-label="Sleep stages">${parts.map(([n, k, c]) => (sleepDay[k] ? `<div title="${n}" style="flex:${sleepDay[k]};background:var(${c})"></div>` : "")).join("")}</div>
      <ul class="stages">${parts.map(([n, k, c]) => `<li><i style="background:var(${c})"></i><span>${n}</span><b>${hm(sleepDay[k])}</b></li>`).join("")}</ul>
      ${total ? "" : '<p class="note">Stage breakdown isn\'t available for this night.</p>'}
    </section>`);
  } else out.push(`<section class="card s4">${head("Last night")}<p class="nodata">No sleep recorded yet.</p></section>`);

  const last14 = days.slice(-14);
  const hrv = lastWith(days, "hrv_last"), rhr = lastWith(days, "rhr"), st = lastWith(days, "stress_avg"), sp = lastWith(days, "steps");
  out.push(chart(statCard({ title: "Overnight HRV", when: hrv ? longDate(hrv.date) : "", n: hrv ? n0(hrv.hrv_last) : "–", u: "ms", id: "%ID%",
    note: hrv ? `${esc(hrv.hrv_status || "")}${hrv.hrv_status ? ". " : ""}${vsAvg(days, "hrv_last", " ms")}` : "No HRV data yet" }), (el) => sparkline(el, vals(last14, "hrv_last"), "var(--c-hrv)")));
  out.push(chart(statCard({ title: "Resting heart rate", when: rhr ? longDate(rhr.date) : "", n: rhr ? n0(rhr.rhr) : "–", u: "bpm", id: "%ID%",
    note: rhr ? vsAvg(days, "rhr", " bpm") : "No heart rate data yet" }), (el) => sparkline(el, vals(last14, "rhr"), "var(--c-rhr)")));
  out.push(chart(statCard({ title: "Stress", when: st ? longDate(st.date) : "", n: st ? n0(st.stress_avg) : "–", u: "avg", id: "%ID%",
    note: st ? (st.stress_high_s != null ? `${hm(st.stress_high_s)} in high stress` : vsAvg(days, "stress_avg")) : "No stress data yet" }), (el) => sparkline(el, vals(last14, "stress_avg"), "var(--c-stress)")));
  const goal = sp?.step_goal;
  out.push(chart(statCard({ title: "Steps", when: sp ? longDate(sp.date) : "", n: sp ? n0(sp.steps) : "–", u: goal ? `of ${n0(goal)}` : "", id: "%ID%",
    note: sp ? `${n1(distOf(sp.distance_m))} ${unitLabel()}` : "No step data yet",
    extra: goal && sp ? `<div class="bar" role="img" aria-label="Step goal progress"><div style="width:${Math.min(100, (sp.steps / goal) * 100)}%"></div></div>` : "" }), (el) => sparkline(el, vals(last14, "steps"), "var(--c-steps)")));

  const recent = state.acts.slice(0, 3);
  out.push(`<section class="card s12">${head("Recent activities", recent.length ? "" : "")}${recent.length ? recent.map(actRow).join("") : '<p class="nodata">No activities yet. Record one on your watch, then sync.</p>'}</section>`);
  return `<div class="grid">${out.join("")}</div>`;
}

function actRow(a) {
  const [p, pu] = paceOrSpeed(a);
  return `<div class="act"><div class="ic">${icon(a.type)}</div>
    <div><div class="nm">${esc(a.name)}</div><div class="dt">${esc(typeLabel(a.type))} · ${esc(longDate(dateOnly(a.start)))} ${esc(timeOf(a.start))}</div></div>
    <div class="m">${distFmt(a.distance_m)}<small>${a.distance_m ? unitLabel() : "&nbsp;"}</small></div>
    <div class="m">${hm(a.duration_s)}<small>time</small></div>
    <div class="m">${n0(a.avg_hr)}<small>avg bpm</small></div>
    <div class="m">${p}<small>${pu || "&nbsp;"}</small></div></div>`;
}

// ---- Sleep
const STAGES = [["sleep_deep_s", "Deep", "--st-deep"], ["sleep_light_s", "Light", "--st-light"], ["sleep_rem_s", "REM", "--st-rem"], ["sleep_awake_s", "Awake", "--st-awake"]];
function viewSleep() {
  const days = inRange(), withSleep = days.filter((d) => d.sleep_total_s != null);
  if (!withSleep.length) return '<div class="grid"><section class="card s12"><p class="nodata">No sleep data in this range yet.</p></section></div>';
  const avgDur = mean(withSleep.map((d) => d.sleep_total_s)), avgScore = mean(withSleep.map((d) => d.sleep_score));
  const deepPct = mean(withSleep.map((d) => (d.sleep_deep_s != null && d.sleep_total_s ? (d.sleep_deep_s / d.sleep_total_s) * 100 : null)));
  const bed = withSleep.map((d) => (d.sleep_start != null ? bedMinutes(d.sleep_start) : null)).filter((v) => v != null);
  const spread = bed.length > 2 ? Math.round(Math.sqrt(mean(bed.map((v) => (v - mean(bed)) ** 2)))) : null;
  const dates = days.map((d) => d.date);
  const stat = (t, n, u, s) => `<section class="card s3">${head(t)}<div class="big"><span class="n">${n}</span><span class="u">${u}</span></div><p class="sub">${s}</p></section>`;
  return `<div class="grid">
    ${stat("Average sleep", hmBig(avgDur), "", `Across ${withSleep.length} nights`)}
    ${stat("Average score", n0(avgScore), "", avgScore == null ? "No scores in this range" : "Garmin's sleep score")}
    ${stat("Deep sleep", n0(deepPct), "%", "Share of time asleep")}
    ${stat("Bedtime spread", spread == null ? "–" : n0(spread), "min", spread == null ? "Needs 3+ nights" : "Typical swing from your usual bedtime")}
    <section class="card s12">${head("Time asleep by stage", "hours per night")}
      ${chart(slot("%ID%", "Hours asleep per night, split by stage"), (el) => barChart(el, {
        data: days.map((d) => ({ d: d.date, parts: STAGES.map(([k, name, c]) => ({ key: k, name, color: `var(${c})`, v: d[k] != null ? d[k] / 3600 : 0 })) })),
        fmt: (v) => hoursFmt(v), height: 240, aria: "Hours asleep per night, split by stage", unit: "" }))}
      <div class="legend">${[...STAGES].reverse().map(([, n, c]) => `<span><i style="background:var(${c})"></i>${n}</span>`).join("")}</div></section>
    <section class="card s12">${head("Sleep score")}
      ${chart(slot("%ID%", "Sleep score by night"), (el) => lineChart(el, { dates, series: [{ name: "Sleep score", color: "var(--ink)", values: vals(days, "sleep_score") }], yMin: 0, yMax: 100, height: 200, aria: "Sleep score by night" }))}</section>
  </div>`;
}
function bedMinutes(ms) { const d = new Date(ms); let m = d.getUTCHours() * 60 + d.getUTCMinutes(); if (m < 12 * 60) m += 24 * 60; return m; }

// ---- Recovery
function viewRecovery() {
  const days = inRange(), dates = days.map((d) => d.date);
  if (!days.length) return '<div class="grid"><section class="card s12"><p class="nodata">No data in this range yet.</p></section></div>';
  const hrvAvg = mean(vals(days, "hrv_last")), last = lastWith(days, "hrv_last");
  const base = days.find((d) => d.hrv_base_low != null && d.hrv_base_high != null);
  const hrvNote = last && hrvAvg != null ? `Last night was ${n0(Math.abs(last.hrv_last - hrvAvg))} ms ${last.hrv_last >= hrvAvg ? "above" : "below"} your ${state.range}-day average of ${n0(hrvAvg)} ms.` : "";
  const rhrAvg = mean(vals(days, "rhr")), rl = lastWith(days, "rhr");
  const rhrNote = rl && rhrAvg != null ? `Resting heart rate is ${n0(rl.rhr)} bpm against a ${state.range}-day average of ${n0(rhrAvg)}.` : "";
  const hrvSeries = [{ name: "Overnight HRV", color: "var(--c-hrv)", values: vals(days, "hrv_last") }];
  if (days.some((d) => d.hrv_weekly != null)) hrvSeries.push({ name: "7-day average", color: "var(--ink-3)", values: vals(days, "hrv_weekly"), dashed: true });
  return `<div class="grid">
    <section class="card s12">${head("Heart rate variability", "ms")}<p class="sub">${esc(hrvNote)}</p>
      ${chart(slot("%ID%", "Overnight HRV over time"), (el) => lineChart(el, { dates, series: hrvSeries, band: base ? { lo: base.hrv_base_low, hi: base.hrv_base_high } : undefined, height: 220, unit: "ms", aria: "Overnight HRV over time" }))}
      <div class="legend">${hrvSeries.map((s) => `<span><i class="ln" style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}${base ? '<span><i style="background:var(--band);border:1px solid var(--line)"></i>Your balanced range</span>' : ""}</div></section>
    <section class="card s6">${head("Resting heart rate", "bpm")}<p class="sub">${esc(rhrNote)}</p>
      ${chart(slot("%ID%", "Resting heart rate over time"), (el) => lineChart(el, { dates, series: [{ name: "Resting heart rate", color: "var(--c-rhr)", values: vals(days, "rhr") }], unit: "bpm", height: 210, aria: "Resting heart rate over time" }))}</section>
    <section class="card s6">${head("Stress", "daily average")}<p class="sub">Lower is calmer. Garmin scores stress from 0 to 100.</p>
      ${chart(slot("%ID%", "Average stress over time"), (el) => lineChart(el, { dates, series: [{ name: "Average stress", color: "var(--c-stress)", values: vals(days, "stress_avg") }], yMin: 0, yMax: 100, height: 210, aria: "Average stress over time" }))}</section>
    <section class="card s12">${head("Body Battery range", "daily high and low")}
      ${chart(slot("%ID%", "Body Battery daily high and low"), (el) => lineChart(el, { dates, series: [{ name: "High", color: "var(--c-battery)", values: vals(days, "bb_high") }, { name: "Low", color: "var(--ink-3)", values: vals(days, "bb_low"), dashed: true }], yMin: 0, yMax: 100, height: 210, aria: "Body Battery daily high and low" }))}
      <div class="legend"><span><i class="ln" style="background:var(--c-battery)"></i>High</span><span><i class="ln" style="background:var(--ink-3)"></i>Low</span></div></section>
  </div>`;
}

// ---- Training
function weekStart(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); const dt = new Date(y, m - 1, d); const back = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - back); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`; }
function viewTraining() {
  const cutoff = (inRange()[0]?.date) || "0000";
  const acts = state.acts.filter((a) => dateOnly(a.start) >= cutoff);
  if (!acts.length) return '<div class="grid"><section class="card s12"><p class="nodata">No activities in this range yet.</p></section></div>';
  const types = [...new Set(acts.map((a) => a.type))];
  const shown = state.typeFilter === "all" ? acts : acts.filter((a) => a.type === state.typeFilter);
  const byWeek = new Map();
  for (const a of acts) { const w = weekStart(dateOnly(a.start)); byWeek.set(w, (byWeek.get(w) || 0) + (a.duration_s || 0)); }
  const weeks = [...byWeek.keys()].sort();
  const totalTime = acts.reduce((s, a) => s + (a.duration_s || 0), 0), totalDist = acts.reduce((s, a) => s + (a.distance_m || 0), 0), totalKcal = acts.reduce((s, a) => s + (a.calories || 0), 0);
  const stat = (t, n, u, s) => `<section class="card s3">${head(t)}<div class="big"><span class="n">${n}</span><span class="u">${u}</span></div><p class="sub">${s}</p></section>`;
  return `<div class="grid">
    ${stat("Activities", n0(acts.length), "", `In the last ${state.range} days`)}
    ${stat("Time", hmBig(totalTime), "", "Moving and rest time")}
    ${stat("Distance", n1(distOf(totalDist)), unitLabel(), "All activity types")}
    ${stat("Calories", n0(totalKcal), "kcal", "Reported by your watch")}
    <section class="card s12">${head("Training time per week", "hours, weeks start Monday")}
      ${chart(slot("%ID%", "Training hours per week"), (el) => barChart(el, { data: weeks.map((w) => ({ d: w, v: byWeek.get(w) / 3600 })), color: "var(--c-train)", fmt: hoursFmt, height: 200, aria: "Training hours per week" }))}</section>
    <section class="card s12">${head("Activities")}
      <div class="chips" role="group" aria-label="Filter by type"><button class="chip" data-filter="all" aria-pressed="${state.typeFilter === "all"}" type="button">All</button>${types.map((t) => `<button class="chip" data-filter="${esc(t)}" aria-pressed="${state.typeFilter === t}" type="button">${esc(typeLabel(t))}</button>`).join("")}</div>
      ${shown.slice(0, 60).map(actRow).join("") || '<p class="nodata">No activities of this type.</p>'}
      ${shown.length > 60 ? `<p class="note">Showing the 60 most recent of ${shown.length}.</p>` : ""}</section></div>`;
}

// ---- Data (a plain table: the accessible view of every chart, and CSV for Excel or Tableau)
const COLS = [["date", "Date"], ["steps", "Steps"], ["rhr", "Resting HR"], ["sleep_h", "Sleep (h)"], ["sleep_score", "Sleep score"], ["hrv_last", "HRV (ms)"], ["bb_high", "BB high"], ["bb_low", "BB low"], ["stress_avg", "Stress"], ["active_kcal", "Active kcal"], ["intensity_min", "Intensity min"]];
const rowOf = (d) => ({ ...d, sleep_h: d.sleep_total_s != null ? +(d.sleep_total_s / 3600).toFixed(2) : null });
function viewData() {
  const rows = inRange().map(rowOf).reverse();
  return `<div class="grid"><section class="card s12">${head("Daily data", `last ${state.range} days`)}
    <p class="sub"><button class="btn" data-act="csv" type="button">Download CSV</button></p>
    <p class="note">A card shows "–" when Garmin didn't send that number. To see exactly what Garmin sent (field names only, never your values), run the refresh with "Only check the connection" ticked. SETUP.md part 7 shows how.</p>
    <div class="tbl-wrap"><table><thead><tr>${COLS.map(([, l]) => `<th scope="col">${l}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${COLS.map(([k]) => `<td>${k === "date" ? esc(longDate(r.date)) : r[k] == null ? "–" : n1(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section></div>`;
}
function downloadCsv() {
  const rows = inRange().map(rowOf);
  const csv = [COLS.map(([, l]) => l).join(","), ...rows.map((r) => COLS.map(([k]) => (r[k] == null ? "" : r[k])).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `garmin-daily-${rows.at(-1)?.date || "data"}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ boot
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => { /* app still works without it */ });
renderChrome();
load();
const recheck = () => { if (document.visibilityState === "visible" && !state.locked) load(); };
document.addEventListener("visibilitychange", recheck);
setInterval(recheck, 10 * 60 * 1000);
