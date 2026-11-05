'use strict';

/* =====================================================================
   RideLab Pro-Analyse-Engine – läuft komplett im Browser
   Critical Power · W′bal · Intervalle · Ermüdungsresistenz · Wind · Aero
   ===================================================================== */
const RideEngine = (() => {
  const G = 9.81;
  const DRIVETRAIN_EFF = 0.976; // Antriebsverlust ~2,4 %
  const BIKE_KG = 9.0;
  const COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  const round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; };

  function trailingAvg(a, w) {
    const out = new Float64Array(a.length);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      s += a[i];
      if (i >= w) s -= a[i - w];
      out[i] = s / Math.min(i + 1, w);
    }
    return out;
  }

  function prefixSums(a) {
    const pre = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
    return pre;
  }

  // Beste Durchschnittsleistung über `dur` Sekunden im Bereich [lo, hi)
  function bestAvg(pre, dur, lo = 0, hi = pre.length - 1) {
    hi = Math.min(hi, pre.length - 1);
    if (hi - lo < dur) return null;
    let best = 0;
    for (let i = lo; i <= hi - dur; i++) {
      const avg = (pre[i + dur] - pre[i]) / dur;
      if (avg > best) best = avg;
    }
    return best;
  }

  function linreg(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i];
      sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return null;
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    const my = sy / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      ssTot += (ys[i] - my) ** 2;
      ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    }
    return { intercept, slope, r2: 1 - ssRes / (ssTot || 1e-12) };
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const p1 = lat1 * r, p2 = lat2 * r, dl = (lon2 - lon1) * r;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  /* ---- Critical-Power-Modell: Arbeit = CP·t + W′ (Fit auf 2–30-min-Bestwerte) ---- */
  function fitCp(durs, watts) {
    const xs = [], ys = [];
    durs.forEach((d, i) => {
      const w = watts[i];
      if (d >= 120 && d <= 1800 && w > 0) { xs.push(d); ys.push(d * w); }
    });
    if (xs.length < 3) return null;
    const fit = linreg(xs, ys);
    if (!fit) return null;
    const cp = fit.slope, wprime = fit.intercept;
    if (!(cp >= 100 && cp <= 450 && wprime >= 3000 && wprime <= 40000)) return null;
    return { cp: Math.round(cp), wprime: Math.round(wprime), r2: round(fit.r2, 4),
      points: xs.length, source: 'mmp-fit' };
  }

  /* ---- W′bal, differentielles Modell (Froncioni/Skiba) ---- */
  function wbalAnalysis(pw, cp, wp) {
    const n = pw.length, series = new Float64Array(n);
    let bal = wp, mn = wp;
    for (let i = 0; i < n; i++) {
      const p = pw[i];
      if (p > cp) bal -= p - cp;
      else bal += (wp - bal) * (cp - p) / wp;
      if (bal > wp) bal = wp;
      if (bal < mn) mn = bal;
      series[i] = bal;
    }
    // "Match": Abfall unter 75 % W′, wieder scharf ab 90 %
    let matches = 0, armed = true;
    const loThr = 0.75 * wp, hiThr = 0.9 * wp;
    for (const b of series) {
      if (armed && b < loThr) { matches++; armed = false; }
      else if (!armed && b > hiThr) armed = true;
    }
    const step = Math.max(1, Math.floor(n / 600));
    const t = [], kj = [];
    for (let i = 0; i < n; i += step) { t.push(i); kj.push(round(series[i] / 1000, 2)); }
    return { t, kj, minKj: round(mn / 1000, 2), minPct: round(mn / wp * 100, 1), matches };
  }

  /* ---- Intervall-Erkennung: anhaltend über 91 % CP ---- */
  function detectIntervals(pw, hr, v, cp) {
    const sm = trailingAvg(pw, 7);
    const thr = 0.91 * cp;
    const segs = [];
    let start = null;
    for (let i = 0; i < sm.length; i++) {
      if (sm[i] >= thr && start === null) start = i;
      else if (sm[i] < thr && start !== null) { segs.push([start, i]); start = null; }
    }
    if (start !== null) segs.push([start, sm.length]);
    const merged = [];
    for (const seg of segs) {
      const last = merged[merged.length - 1];
      if (last && seg[0] - last[1] <= 20) last[1] = seg[1];
      else merged.push([seg[0], seg[1]]);
    }
    const cum = new Float64Array(v.length + 1);
    for (let i = 0; i < v.length; i++) cum[i + 1] = cum[i] + v[i];
    const kmAt = i => round(cum[Math.min(i, cum.length - 1)] / 1000, 2);
    const out = [];
    for (const [a, b] of merged) {
      const dur = b - a;
      if (dur < 45) continue;
      let sum = 0, max = 0, hs = 0, hc = 0;
      for (let i = a; i < b; i++) {
        sum += pw[i];
        if (pw[i] > max) max = pw[i];
        if (hr && hr[i] > 30) { hs += hr[i]; hc++; }
      }
      const avg = sum / dur;
      out.push({
        startSec: a, dur, fromKm: kmAt(a), toKm: kmAt(b),
        avgW: Math.round(avg), maxW: Math.round(max), pctCp: Math.round(avg / cp * 100),
        avgHr: hc ? Math.round(hs / hc) : null,
      });
    }
    return out.slice(0, 25);
  }

  /* ---- Ermüdungsresistenz: Bestleistung frisch vs. nach 1000/1500/2000 kJ ---- */
  function durability(pw) {
    const n = pw.length;
    const pre = prefixSums(pw);
    const totalKj = pre[n] / 1000;
    const tiers = [];
    for (const kj of [1000, 1500, 2000]) {
      if (totalKj < kj + 150) continue;
      const target = kj * 1000;
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pre[mid] < target) lo = mid + 1; else hi = mid;
      }
      const idx = lo;
      if (idx < 600 || n - idx < 420) continue;
      const tier = { kj };
      for (const [dur, key] of [[60, 'b60'], [300, 'b300']]) {
        const fresh = bestAvg(pre, dur, 0, idx);
        const after = bestAvg(pre, dur, idx, n);
        if (fresh && after && fresh > 50) {
          tier[key] = { fresh: Math.round(fresh), after: Math.round(after),
            dropPct: round((fresh - after) / fresh * 100, 1) };
        }
      }
      if (tier.b60 || tier.b300) tiers.push(tier);
    }
    return { totalKj: Math.round(totalKj), tiers };
  }

  /* ---- Aero-Schätzung: CdA + Crr per Physik-Regression ---- */
  function estimateAero(pw, v, ele, weight) {
    const m = weight + BIKE_KG;
    const xs = [], ys = [];
    const n = v.length;
    for (let i = 6; i < n - 6; i++) {
      const vi = v[i], p = pw[i];
      if (vi < 5.5 || p < 40) continue;
      const acc = (v[i + 3] - v[i - 3]) / 6;
      if (Math.abs(acc) > 0.12) continue;
      const d = vi > 0 ? vi * 10 : 1;
      const grade = (ele[i + 5] - ele[i - 5]) / Math.max(d, 1);
      if (Math.abs(grade) > 0.08) continue;
      const rho = 1.225 * Math.exp(-Math.max(ele[i], 0) / 9000);
      ys.push(p * DRIVETRAIN_EFF / vi - m * G * grade - m * acc);
      xs.push(0.5 * rho * vi * vi);
    }
    if (xs.length < 300) return { ok: false, reason: 'zu wenige verwertbare Messpunkte', samples: xs.length };
    let fit = linreg(xs, ys);
    if (!fit) return { ok: false, reason: 'Regression fehlgeschlagen', samples: xs.length };
    // schlechteste 25 % Residuen verwerfen und neu fitten
    const res = xs.map((x, i) => Math.abs(ys[i] - (fit.intercept + fit.slope * x)));
    const keep = xs.map((_, i) => i).sort((i, j) => res[i] - res[j]).slice(0, Math.floor(xs.length * 0.75));
    fit = linreg(keep.map(i => xs[i]), keep.map(i => ys[i]));
    if (!fit) return { ok: false, reason: 'Regression fehlgeschlagen', samples: xs.length };
    const cda = fit.slope, crr = fit.intercept / (m * G);
    if (!(cda >= 0.12 && cda <= 0.75 && crr >= 0.0005 && crr <= 0.018)) {
      return { ok: false, reason: 'Werte außerhalb plausibler Grenzen (unruhige Daten)', samples: keep.length };
    }
    return { ok: true, cda: round(cda, 3), crr: round(crr, 4), samples: keep.length, r2: round(fit.r2, 3) };
  }

  /* ---- Wetter & Wind (Open-Meteo, kostenlos, ohne API-Key) ---- */
  async function fetchJson(url, timeoutMs = 10000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function weatherAnalysis(route, startIso, durSec) {
    const { lat, lon, t: tarr } = route || {};
    if (!lat || lat.length < 10 || !startIso) return { error: 'keine Routendaten' };
    const start = new Date(startIso);
    const end = new Date(start.getTime() + (durSec || 3600) * 1000);
    const ageDays = Math.floor((Date.now() - start.getTime()) / 86400000);
    const vars = 'temperature_2m,wind_speed_10m,wind_direction_10m';
    const mid = Math.floor(lat.length / 2);
    const la = lat[mid].toFixed(4), lo = lon[mid].toFixed(4);
    const url = ageDays <= 85
      ? `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=${vars}` +
        `&wind_speed_unit=ms&timezone=UTC&past_days=${Math.min(Math.max(ageDays + 2, 1), 92)}&forecast_days=1`
      : `https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}` +
        `&start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}` +
        `&hourly=${vars}&wind_speed_unit=ms&timezone=UTC`;

    const hourly = (await fetchJson(url)).hourly || {};
    const times = hourly.time || [];
    if (!times.length) return { error: 'keine Wetterdaten erhalten' };
    const HOUR = 3600000;
    const byHour = new Map();
    times.forEach((ts, i) => byHour.set(Date.parse(ts + 'Z'),
      [hourly.temperature_2m[i], hourly.wind_speed_10m[i], hourly.wind_direction_10m[i]]));
    const at = ms => {
      let key = Math.floor(ms / HOUR) * HOUR;
      if (new Date(ms).getUTCMinutes() >= 30 && byHour.has(key + HOUR)) key += HOUR;
      return byHour.get(key);
    };

    let headT = 0, tailT = 0, crossT = 0, totT = 0, headSum = 0, tailSum = 0;
    const temps = [], winds = [], wdirs = [];
    for (let k = 0; k < lat.length - 1; k++) {
      if (tarr[k] == null || tarr[k + 1] == null) continue;
      const dt = tarr[k + 1] - tarr[k];
      if (dt <= 0 || dt > 120) continue;
      const wx = at(start.getTime() + tarr[k] * 1000);
      if (!wx || wx[0] == null || wx[1] == null || wx[2] == null) continue;
      const [temp, ws, wd] = wx;
      const brg = bearingDeg(lat[k], lon[k], lat[k + 1], lon[k + 1]);
      const comp = ws * Math.cos((brg - wd) * Math.PI / 180); // > 0 = Gegenwind
      totT += dt;
      temps.push(temp); winds.push(ws); wdirs.push(wd);
      if (comp > 0.8) { headT += dt; headSum += comp * dt; }
      else if (comp < -0.8) { tailT += dt; tailSum += -comp * dt; }
      else crossT += dt;
    }
    if (totT < 60) return { error: 'Zeitachse der Route unvollständig' };
    let sx = 0, cx = 0;
    for (const d of wdirs) { sx += Math.sin(d * Math.PI / 180); cx += Math.cos(d * Math.PI / 180); }
    const dom = (Math.atan2(sx, cx) * 180 / Math.PI + 360) % 360;
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    return {
      tempAvg: round(avg(temps), 1),
      windAvgMs: round(avg(winds), 1),
      windDir: COMPASS[Math.floor((dom + 11.25) / 22.5) % 16],
      headPct: Math.round(headT / totT * 100),
      tailPct: Math.round(tailT / totT * 100),
      crossPct: Math.round(crossT / totT * 100),
      headAvgMs: headT ? round(headSum / headT, 1) : 0,
      tailAvgMs: tailT ? round(tailSum / tailT, 1) : 0,
      source: 'Open-Meteo',
    };
  }

  /* ---- Gesamtanalyse ----
     raw: 1-Hz-Streams wie beim Import gespeichert (pw W, hr S/min, v cm/s, ele dm) */
  async function analyze({ raw = {}, settings = {}, bestMMP = {}, route = {}, startISO = null }) {
    const scale = (arr, f) => (arr ? Float64Array.from(arr, x => x / f) : null);
    const pw = raw.pw || [];
    const hr = raw.hr || null;
    const v = scale(raw.v, 100) || [];
    const ele = scale(raw.ele, 10) || [];
    const ftp = settings.ftp || 220;
    const weight = settings.weight || 75;

    const out = {};
    const cpFit = fitCp(bestMMP.durs || [], bestMMP.watts || []);
    let cp, wp;
    if (cpFit) {
      out.cp = cpFit;
      ({ cp, wprime: wp } = cpFit);
    } else {
      cp = Math.round(ftp);
      wp = 18000;
      out.cp = { cp, wprime: wp, source: 'ftp-fallback' };
    }

    let maxPw = 0;
    for (const p of pw) if (p > maxPw) maxPw = p;
    if (maxPw > 0) {
      out.wbal = wbalAnalysis(pw, cp, wp);
      out.intervals = detectIntervals(pw, hr, v, cp);
      out.durability = durability(pw);
      if (v.length === pw.length && ele.length === pw.length) out.aero = estimateAero(pw, v, ele, weight);
    }

    if (route.lat && startISO) {
      try {
        out.weather = await weatherAnalysis(route, startISO, pw.length || null);
      } catch (e) {
        out.weather = { error: `Wetterdienst nicht erreichbar (${e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message})` };
      }
    }
    return out;
  }

  return { analyze, fitCp, wbalAnalysis, detectIntervals, durability, estimateAero, weatherAnalysis };
})();
