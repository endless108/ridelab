'use strict';

/* =====================================================================
   RideLab – lokales Radsport-Analyse-Dashboard
   GPX-Import · Leistung · Herzfrequenz · Zonen · TSS · Power-Kurve
   ===================================================================== */

/* ---------------- Utilities ---------------- */
const $ = s => document.querySelector(s);

function fmtNum(v, d = 0) {
  if (v == null || !isFinite(v)) return '–';
  return v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDate(iso, withTime = true) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  return withTime ? `${date} · ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : date;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function movAvg(arr, w) {
  const n = arr.length, out = new Array(n), half = Math.floor(w / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (arr[j] != null && isFinite(arr[j])) { sum += arr[j]; cnt++; }
    }
    out[i] = cnt ? sum / cnt : null;
  }
  return out;
}
function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ---------------- Einstellungen (Athleten-Profil) ---------------- */
const DEFAULT_SETTINGS = { ftp: 220, hrmax: 185, weight: 75, age: 35, sex: 'm' };
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('ridelab-settings') || '{}')); } catch (e) { /* defaults */ }

function saveSettings() {
  try { localStorage.setItem('ridelab-settings', JSON.stringify(settings)); } catch (e) { /* privater Modus */ }
  $('#settings-summary').textContent = `FTP ${settings.ftp} W`;
}

/* ---------------- Zonen-Definitionen ---------------- */
const POWER_ZONES = [
  { key: 'Z1', name: 'Aktive Erholung', lo: 0,    hi: 0.55, color: '#7d8590' },
  { key: 'Z2', name: 'Grundlage',       lo: 0.55, hi: 0.75, color: '#58a6ff' },
  { key: 'Z3', name: 'Tempo',           lo: 0.75, hi: 0.90, color: '#3fb950' },
  { key: 'Z4', name: 'Schwelle',        lo: 0.90, hi: 1.05, color: '#d29922' },
  { key: 'Z5', name: 'VO2max',          lo: 1.05, hi: 1.20, color: '#f0883e' },
  { key: 'Z6', name: 'Anaerob',         lo: 1.20, hi: 1.50, color: '#f85149' },
  { key: 'Z7', name: 'Sprint',          lo: 1.50, hi: 99,   color: '#bc8cff' },
];
const HR_ZONES = [
  { key: 'Z1', name: 'Regeneration', lo: 0,    hi: 0.60, color: '#7d8590' },
  { key: 'Z2', name: 'Grundlage',    lo: 0.60, hi: 0.70, color: '#58a6ff' },
  { key: 'Z3', name: 'Aerob',        lo: 0.70, hi: 0.80, color: '#3fb950' },
  { key: 'Z4', name: 'Schwelle',     lo: 0.80, hi: 0.90, color: '#d29922' },
  { key: 'Z5', name: 'Maximal',      lo: 0.90, hi: 2.0,  color: '#f85149' },
];
const MMP_DURATIONS = [
  { sec: 1, label: '1 s' }, { sec: 5, label: '5 s' }, { sec: 15, label: '15 s' },
  { sec: 30, label: '30 s' }, { sec: 60, label: '1 min' }, { sec: 120, label: '2 min' },
  { sec: 180, label: '3 min' }, { sec: 300, label: '5 min' }, { sec: 480, label: '8 min' },
  { sec: 600, label: '10 min' }, { sec: 1200, label: '20 min' }, { sec: 1800, label: '30 min' },
  { sec: 3600, label: '1 h' },
];

/* ---------------- Speicher (IndexedDB, Fallback localStorage) ---------------- */
const store = {
  db: null, useLS: false,
  async init() {
    try {
      this.db = await new Promise((res, rej) => {
        const rq = indexedDB.open('ridelab', 1);
        rq.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('rides')) db.createObjectStore('rides', { keyPath: 'id' });
        };
        rq.onsuccess = e => res(e.target.result);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) {
      this.useLS = true;
    }
  },
  async all() {
    if (this.useLS) {
      try { return JSON.parse(localStorage.getItem('ridelab-rides') || '[]'); } catch (e) { return []; }
    }
    return new Promise((res, rej) => {
      const rq = this.db.transaction('rides').objectStore('rides').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  },
  async put(ride) {
    if (this.useLS) {
      const all = await this.all();
      const i = all.findIndex(r => r.id === ride.id);
      if (i >= 0) all[i] = ride; else all.push(ride);
      try {
        localStorage.setItem('ridelab-rides', JSON.stringify(all));
      } catch (e) {
        // Quota erreicht: Rohdaten weglassen, Kernstatistiken behalten
        const slim = all.map(r => { const c = { ...r }; delete c.raw1hz; return c; });
        localStorage.setItem('ridelab-rides', JSON.stringify(slim));
      }
      return;
    }
    return new Promise((res, rej) => {
      const tx = this.db.transaction('rides', 'readwrite');
      tx.objectStore('rides').put(ride);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  async del(id) {
    if (this.useLS) {
      const all = (await this.all()).filter(r => r.id !== id);
      localStorage.setItem('ridelab-rides', JSON.stringify(all));
      return;
    }
    return new Promise((res, rej) => {
      const tx = this.db.transaction('rides', 'readwrite');
      tx.objectStore('rides').delete(id);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
};

/* ---------------- GPX-Parser ---------------- */
function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Ungültige GPX-Datei');
  const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name');
  const name = nameEl ? nameEl.textContent.trim() : null;
  const trkpts = doc.querySelectorAll('trkpt');
  const pts = [];
  trkpts.forEach(pt => {
    const lat = parseFloat(pt.getAttribute('lat')), lon = parseFloat(pt.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;
    const p = { lat, lon, ele: null, t: null, hr: null, cad: null, pw: null };
    for (const child of pt.children) {
      const tag = child.localName.toLowerCase();
      if (tag === 'ele') p.ele = parseFloat(child.textContent);
      else if (tag === 'time') { const ms = Date.parse(child.textContent); if (isFinite(ms)) p.t = ms; }
      else if (tag === 'extensions') {
        (function walk(el) {
          for (const c of el.children) {
            const n = c.localName.toLowerCase();
            if (n === 'hr' || n === 'heartrate') p.hr = parseFloat(c.textContent);
            else if (n === 'cad' || n === 'cadence') p.cad = parseFloat(c.textContent);
            else if (n === 'power' || n === 'watts' || n === 'pwr') p.pw = parseFloat(c.textContent);
            else walk(c);
          }
        })(child);
      }
    }
    pts.push(p);
  });
  return { name, pts };
}

/* ---------------- Fahrt berechnen ---------------- */
function computeRide(pts, name, fileDate) {
  if (!pts || pts.length < 10) throw new Error('Zu wenige Trackpunkte');
  const n = pts.length;

  // Zeitachse (Sekunden ab Start)
  const hasTime = pts[0].t != null && pts[n - 1].t != null && pts[n - 1].t > pts[0].t;
  const t = new Float64Array(n);
  if (hasTime) {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const v = pts[i].t != null ? (pts[i].t - pts[0].t) / 1000 : last;
      t[i] = Math.max(v, last); // monoton
      last = t[i];
    }
  }

  // Distanz
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  const totalDist = dist[n - 1];

  // Höhe (geglättet) + Anstieg
  const eleCount = pts.reduce((c, p) => c + (p.ele != null ? 1 : 0), 0);
  const hasEle = eleCount > n * 0.5;
  let ele = null, elevGain = 0;
  if (hasEle) {
    const raw = pts.map(p => p.ele);
    // Lücken auffüllen
    let lastE = null;
    for (let i = 0; i < n; i++) { if (raw[i] == null) raw[i] = lastE; else lastE = raw[i]; }
    for (let i = n - 1; i >= 0; i--) { if (raw[i] == null) raw[i] = lastE; else lastE = raw[i]; }
    ele = movAvg(raw, 7);
    let ref = ele[0];
    for (let i = 1; i < n; i++) {
      if (ele[i] > ref + 1.5) { elevGain += ele[i] - ref; ref = ele[i]; }
      else if (ele[i] < ref) ref = ele[i];
    }
  }

  // Geschwindigkeit je Punkt (über >=2,5 s Fenster), geglättet
  let spd = null, maxSpeed = null;
  if (hasTime) {
    spd = new Array(n).fill(0);
    let j = 0;
    for (let i = 1; i < n; i++) {
      while (t[i] - t[j] > 4 && j < i - 1) j++;
      const dt = t[i] - t[j];
      spd[i] = dt > 0.5 ? (dist[i] - dist[j]) / dt : 0;
    }
    spd = movAvg(spd, 5);
    maxSpeed = Math.max(...spd) * 3.6;
  }

  const hasPower = pts.reduce((c, p) => c + (p.pw != null ? 1 : 0), 0) > n * 0.1;
  const hasHr = pts.reduce((c, p) => c + (p.hr != null ? 1 : 0), 0) > n * 0.1;
  const hasCad = pts.reduce((c, p) => c + (p.cad != null ? 1 : 0), 0) > n * 0.1;

  /* ---- 1-Hz-Resampling für exakte Leistungs-/HF-Metriken ---- */
  let s1 = null; // {pw, hr, mv, v, e, len}
  if (hasTime) {
    const len = Math.min(Math.round(t[n - 1]) + 1, 12 * 3600);
    const pw1 = new Float32Array(len), hr1 = new Float32Array(len), mv1 = new Uint8Array(len);
    const v1 = new Float32Array(len), e1 = new Float32Array(len);
    let j2 = 0;
    for (let s = 0; s < len; s++) {
      while (j2 < n - 1 && t[j2 + 1] <= s) j2++;
      const gap = s - t[j2];
      pw1[s] = (hasPower && pts[j2].pw != null && gap < 15) ? pts[j2].pw : 0;
      hr1[s] = (hasHr && pts[j2].hr != null && gap < 30) ? pts[j2].hr : 0;
      mv1[s] = (spd && spd[j2] > 0.7 && gap < 15) ? 1 : 0;
      v1[s] = (spd && gap < 15) ? Math.max(0, spd[j2]) : 0;
      e1[s] = ele ? ele[j2] : 0;
    }
    s1 = { pw: pw1, hr: hr1, mv: mv1, v: v1, e: e1, len };
  }

  // Basis-Statistiken
  const stats = {
    distanceKm: totalDist / 1000,
    elapsedSec: hasTime ? t[n - 1] : null,
    movingSec: null, avgSpeed: null, maxSpeed,
    elevGain: hasEle ? Math.round(elevGain) : null,
    avgPw: null, maxPw: null, np: null, workKJ: null,
    avgHr: null, maxHr: null, avgCad: null,
    decoupling: null,
    hasTime, hasEle, hasPower, hasHr, hasCad,
  };

  let powerHist = null, hrHist = null, mmp = null;

  if (s1) {
    let mvCount = 0;
    for (let i = 0; i < s1.len; i++) mvCount += s1.mv[i];
    stats.movingSec = mvCount;
    stats.avgSpeed = mvCount > 30 ? (totalDist / mvCount) * 3.6 : null;

    if (hasPower) {
      let sum = 0, cnt = 0, maxP = 0, work = 0;
      powerHist = new Array(400).fill(0);
      for (let i = 0; i < s1.len; i++) {
        const p = s1.pw[i];
        work += p;
        if (p > maxP) maxP = p;
        if (s1.mv[i]) {
          sum += p; cnt++;
          powerHist[Math.min(Math.floor(p / 5), 399)]++;
        }
      }
      stats.avgPw = cnt ? Math.round(sum / cnt) : null;
      stats.maxPw = Math.round(maxP);
      stats.workKJ = Math.round(work / 1000);

      // Normalized Power (30-s-Rolling, 4. Potenz)
      if (s1.len >= 60) {
        const w = 30;
        let acc = 0, sum4 = 0, n4 = 0;
        for (let i = 0; i < s1.len; i++) {
          acc += s1.pw[i];
          if (i >= w) acc -= s1.pw[i - w];
          if (i >= w - 1) { const a = acc / w; sum4 += a * a * a * a; n4++; }
        }
        stats.np = n4 ? Math.round(Math.pow(sum4 / n4, 0.25)) : null;
      }

      // Power-Kurve (Mean Maximal Power)
      const pre = new Float64Array(s1.len + 1);
      for (let i = 0; i < s1.len; i++) pre[i + 1] = pre[i] + s1.pw[i];
      mmp = { durs: [], watts: [] };
      for (const d of MMP_DURATIONS) {
        if (d.sec > s1.len) break;
        let best = 0;
        for (let i = 0; i + d.sec <= s1.len; i++) {
          const avg = (pre[i + d.sec] - pre[i]) / d.sec;
          if (avg > best) best = avg;
        }
        mmp.durs.push(d.sec);
        mmp.watts.push(Math.round(best));
      }
    }

    if (hasHr) {
      let sum = 0, cnt = 0, maxH = 0;
      hrHist = new Array(231).fill(0);
      for (let i = 0; i < s1.len; i++) {
        const h = s1.hr[i];
        if (h > 30) {
          sum += h; cnt++;
          if (h > maxH) maxH = h;
          hrHist[Math.min(Math.round(h), 230)]++;
        }
      }
      stats.avgHr = cnt ? Math.round(sum / cnt) : null;
      stats.maxHr = Math.round(maxH);
    }

    // Aerobe Entkopplung (Pw:HR, 1. vs. 2. Hälfte der Fahrzeit)
    if (hasPower && hasHr) {
      const idx = [];
      for (let i = 0; i < s1.len; i++) if (s1.mv[i] && s1.hr[i] > 60) idx.push(i);
      if (idx.length > 1200) {
        const half = Math.floor(idx.length / 2);
        let p1 = 0, h1 = 0, p2 = 0, h2 = 0;
        for (let k = 0; k < half; k++) { p1 += s1.pw[idx[k]]; h1 += s1.hr[idx[k]]; }
        for (let k = half; k < idx.length; k++) { p2 += s1.pw[idx[k]]; h2 += s1.hr[idx[k]]; }
        const r1 = (p1 / half) / (h1 / half);
        const r2 = (p2 / (idx.length - half)) / (h2 / (idx.length - half));
        if (r1 > 0) stats.decoupling = ((r1 - r2) / r1) * 100;
      }
    }
  }

  if (hasCad) {
    let sum = 0, cnt = 0;
    for (const p of pts) if (p.cad != null && p.cad > 10) { sum += p.cad; cnt++; }
    stats.avgCad = cnt ? Math.round(sum / cnt) : null;
  }

  /* ---- Abschnitte (Splits) ---- */
  const splitLen = totalDist >= 15000 ? 5000 : 1000;
  const splits = [];
  {
    let startI = 0, nextBound = splitLen;
    const pushSplit = (a, b, len) => {
      let movT = 0, pwSum = 0, pwT = 0, hrSum = 0, hrT = 0, gain = 0;
      for (let i = a + 1; i <= b; i++) {
        const dt = hasTime ? t[i] - t[i - 1] : 0;
        const moving = spd ? spd[i] > 0.7 : true;
        if (moving && dt > 0 && dt < 30) movT += dt;
        if (pts[i].pw != null && dt > 0 && dt < 30) { pwSum += pts[i].pw * dt; pwT += dt; }
        if (pts[i].hr != null && dt > 0 && dt < 30) { hrSum += pts[i].hr * dt; hrT += dt; }
        if (ele && ele[i] > ele[i - 1]) gain += ele[i] - ele[i - 1];
      }
      splits.push({
        fromKm: dist[a] / 1000, toKm: dist[b] / 1000,
        time: movT || null,
        speed: movT > 5 ? (len / movT) * 3.6 : null,
        pw: pwT > 5 ? Math.round(pwSum / pwT) : null,
        hr: hrT > 5 ? Math.round(hrSum / hrT) : null,
        gain: ele ? Math.round(gain) : null,
      });
    };
    for (let i = 1; i < n; i++) {
      if (dist[i] >= nextBound) {
        pushSplit(startI, i, dist[i] - dist[startI]);
        startI = i;
        nextBound += splitLen;
      }
    }
    if (dist[n - 1] - dist[startI] > splitLen * 0.25) pushSplit(startI, n - 1, dist[n - 1] - dist[startI]);
  }

  /* ---- Downsampling für Anzeige (Karte + Diagramme) ---- */
  const N = Math.min(1100, n);
  const bucket = n / N;
  const disp = { km: [], ele: [], pw: [], hr: [], spd: [], cad: [], grade: [], lat: [], lon: [], t: [] };
  for (let b = 0; b < N; b++) {
    const a = Math.floor(b * bucket), z = Math.min(n - 1, Math.floor((b + 1) * bucket) - 1);
    const mid = Math.floor((a + z) / 2);
    let pwS = 0, pwC = 0, hrS = 0, hrC = 0, spS = 0, spC = 0, cdS = 0, cdC = 0, elS = 0, elC = 0;
    for (let i = a; i <= z; i++) {
      if (pts[i].pw != null) { pwS += pts[i].pw; pwC++; }
      if (pts[i].hr != null) { hrS += pts[i].hr; hrC++; }
      if (spd && spd[i] != null) { spS += spd[i]; spC++; }
      if (pts[i].cad != null) { cdS += pts[i].cad; cdC++; }
      if (ele && ele[i] != null) { elS += ele[i]; elC++; }
    }
    disp.km.push(+(dist[mid] / 1000).toFixed(3));
    disp.ele.push(elC ? +(elS / elC).toFixed(1) : null);
    disp.pw.push(pwC ? Math.round(pwS / pwC) : null);
    disp.hr.push(hrC ? Math.round(hrS / hrC) : null);
    disp.spd.push(spC ? +((spS / spC) * 3.6).toFixed(1) : null);
    disp.cad.push(cdC ? Math.round(cdS / cdC) : null);
    disp.lat.push(+pts[mid].lat.toFixed(5));
    disp.lon.push(+pts[mid].lon.toFixed(5));
    disp.t.push(hasTime ? Math.round(t[mid]) : null);
  }
  // Steigung aus Anzeige-Auflösung
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 2), z = Math.min(N - 1, i + 2);
    const dd = (disp.km[z] - disp.km[a]) * 1000;
    const de = (disp.ele[z] != null && disp.ele[a] != null) ? disp.ele[z] - disp.ele[a] : null;
    disp.grade.push(de != null && dd > 15 ? +Math.max(-25, Math.min(25, (de / dd) * 100)).toFixed(1) : null);
  }

  const startISO = hasTime ? new Date(pts[0].t).toISOString() : (fileDate || new Date().toISOString());

  // 1-Hz-Rohdaten für die Pro-Analyse (engine.js) aufheben
  const raw1hz = s1 ? {
    pw: hasPower ? Array.from(s1.pw, x => Math.round(x)) : null,
    hr: hasHr ? Array.from(s1.hr, x => Math.round(x)) : null,
    v: Array.from(s1.v, x => Math.round(x * 100)),   // cm/s
    ele: hasEle ? Array.from(s1.e, x => Math.round(x * 10)) : null, // dm
  } : null;

  return {
    id: `${Date.parse(startISO)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || 'Radfahrt',
    date: startISO,
    stats, powerHist, hrHist, mmp, splits, disp, raw1hz,
  };
}

/* ---------------- Abgeleitete Metriken (abhängig vom Profil) ---------------- */
function derive(ride) {
  const s = ride.stats, d = {};
  if (s.np && settings.ftp) {
    d.if_ = s.np / settings.ftp;
    d.tss = (s.movingSec * s.np * d.if_) / (settings.ftp * 3600) * 100;
  }
  d.vi = (s.np && s.avgPw) ? s.np / s.avgPw : null;
  d.wkg = (s.avgPw && settings.weight) ? s.avgPw / settings.weight : null;

  if (ride.powerHist) {
    d.zonesPower = POWER_ZONES.map(z => {
      let sec = 0;
      const loW = z.lo * settings.ftp, hiW = z.hi * settings.ftp;
      for (let b = 0; b < ride.powerHist.length; b++) {
        const w = b * 5 + 2.5;
        if (w >= loW && w < hiW) sec += ride.powerHist[b];
      }
      return sec;
    });
  }
  if (ride.hrHist) {
    d.zonesHR = HR_ZONES.map(z => {
      let sec = 0;
      const lo = z.lo * settings.hrmax, hi = z.hi * settings.hrmax;
      for (let h = 31; h < ride.hrHist.length; h++) {
        if (h >= lo && h < hi) sec += ride.hrHist[h];
      }
      return sec;
    });
  }

  // Kalorien: Powermeter (kJ ≈ kcal) > Herzfrequenz (Keytel) > Geschwindigkeit (MET)
  if (s.hasPower && s.workKJ) {
    d.cal = Math.round(s.workKJ);
    d.calSource = 'Powermeter (Arbeit in kJ ≈ kcal)';
  } else if (ride.hrHist && settings.weight && settings.age) {
    let kcal = 0;
    for (let h = 31; h < ride.hrHist.length; h++) {
      const sec = ride.hrHist[h];
      if (!sec) continue;
      const perMin = settings.sex === 'f'
        ? (-20.4022 + 0.4472 * h - 0.1263 * settings.weight + 0.074 * settings.age) / 4.184
        : (-55.0969 + 0.6309 * h + 0.1988 * settings.weight + 0.2017 * settings.age) / 4.184;
      kcal += Math.max(0, perMin) * sec / 60;
    }
    d.cal = Math.round(kcal);
    d.calSource = 'Herzfrequenz-Formel (Keytel)';
  } else if (s.avgSpeed && s.movingSec && settings.weight) {
    const v = s.avgSpeed;
    const met = v < 16 ? 4 : v < 19 ? 6 : v < 22 ? 8 : v < 25 ? 10 : v < 30 ? 12 : 15.8;
    d.cal = Math.round(met * settings.weight * s.movingSec / 3600);
    d.calSource = 'Schätzung über Geschwindigkeit (MET)';
  }

  // FTP-Schätzung aus 20-min-Bestwert
  if (ride.mmp) {
    const i20 = ride.mmp.durs.indexOf(1200);
    if (i20 >= 0) d.ftpEst = Math.round(ride.mmp.watts[i20] * 0.95);
  }
  return d;
}

/* ---------------- Trainer-Analyse (Texte) ---------------- */
function buildInsights(ride, d) {
  const s = ride.stats, out = [];
  const zPow = d.zonesPower, zHr = d.zonesHR;

  if (d.if_ != null) {
    let title, text, cls = 'info';
    if (d.if_ < 0.65) { title = 'Lockere Einheit'; text = `Intensitätsfaktor ${fmtNum(d.if_, 2)} – Regenerations-/Grundlagenbereich. Ideal für aktive Erholung oder lange Grundlagenblöcke.`; cls = 'good'; }
    else if (d.if_ < 0.75) { title = 'Grundlagenausdauer'; text = `Intensitätsfaktor ${fmtNum(d.if_, 2)} – klassische GA-Fahrt. Genau der Bereich, in dem die aerobe Basis wächst.`; cls = 'good'; }
    else if (d.if_ < 0.85) { title = 'Tempo-Einheit'; text = `Intensitätsfaktor ${fmtNum(d.if_, 2)} – zügiges Tempo oberhalb der Grundlage. Fordernd, aber gut verkraftbar, wenn sie nicht zu häufig gefahren wird.`; }
    else if (d.if_ < 0.95) { title = 'Schwellennahe Belastung'; text = `Intensitätsfaktor ${fmtNum(d.if_, 2)} – ein großer Teil der Fahrt lag nahe der Schwelle. Plane 1–2 ruhige Tage zur Erholung ein.`; cls = 'warn'; }
    else { title = 'Sehr intensive Einheit'; text = `Intensitätsfaktor ${fmtNum(d.if_, 2)} – Wettkampfniveau oder härter. Achte auf ausreichend Regeneration.`; cls = 'warn'; }
    out.push({ icon: '🔥', title, text, cls });
  }

  if (d.tss != null) {
    const tss = Math.round(d.tss);
    let text;
    if (tss < 150) text = `${tss} TSS – moderate Belastung, in der Regel bis zum nächsten Tag verarbeitet.`;
    else if (tss < 300) text = `${tss} TSS – solide Trainingsbelastung, Restermüdung bis zum Folgetag möglich.`;
    else if (tss < 450) text = `${tss} TSS – hohe Belastung, rechne mit rund zwei Tagen spürbarer Ermüdung.`;
    else text = `${tss} TSS – sehr hohe Belastung. Plane mehrere ruhige Tage ein, bevor die nächste harte Einheit folgt.`;
    out.push({ icon: '📊', title: 'Trainingsbelastung', text, cls: 'info' });
  }

  if (d.vi != null) {
    let title, text, cls = 'info';
    if (d.vi < 1.05) { title = 'Sehr gleichmäßiges Pacing'; text = `Variabilitätsindex ${fmtNum(d.vi, 2)} – die Leistung wurde konstant abgegeben, wie bei einem gut gefahrenen Zeitfahren oder Berganstieg.`; cls = 'good'; }
    else if (d.vi < 1.15) { title = 'Moderat variable Leistung'; text = `Variabilitätsindex ${fmtNum(d.vi, 2)} – normale Schwankungen durch Terrain und Verkehr.`; }
    else { title = 'Stark wechselnde Leistung'; text = `Variabilitätsindex ${fmtNum(d.vi, 2)} – viele Antritte und Pausen (typisch für Gruppenfahrten oder Kriterien). Für gezieltes Grundlagentraining wäre eine gleichmäßigere Fahrweise effektiver.`; cls = 'warn'; }
    out.push({ icon: '⚡', title, text, cls });
  }

  if (s.decoupling != null) {
    const dec = s.decoupling;
    if (dec < 5) out.push({ icon: '❤️', title: 'Stabile aerobe Leistung', text: `Pw:HR-Entkopplung ${fmtNum(dec, 1)} % – Puls und Leistung blieben im Verhältnis stabil. Zeichen einer guten aeroben Grundlage.`, cls: 'good' });
    else if (dec < 10) out.push({ icon: '❤️', title: 'Leichter kardialer Drift', text: `Pw:HR-Entkopplung ${fmtNum(dec, 1)} % – der Puls stieg im Verlauf bei gleicher Leistung an. Mögliche Ursachen: Hitze, Flüssigkeitsdefizit oder noch ausbaufähige Grundlagenausdauer.`, cls: 'warn' });
    else out.push({ icon: '❤️', title: 'Deutliche Entkopplung', text: `Pw:HR-Entkopplung ${fmtNum(dec, 1)} % – deutlicher Pulsanstieg bei gleicher Leistung. Prüfe Trinken/Essen während langer Fahrten und baue mehr lange, ruhige Einheiten ein.`, cls: 'warn' });
  }

  if (zPow && s.movingSec) {
    const iMax = zPow.indexOf(Math.max(...zPow));
    const z = POWER_ZONES[iMax];
    const pct = Math.round(zPow[iMax] / s.movingSec * 100);
    out.push({ icon: '🎯', title: `Schwerpunkt: ${z.key} ${z.name}`, text: `${pct} % der Fahrzeit in ${z.name} (${fmtDur(zPow[iMax])}). ${iMax <= 1 ? 'Gute Basis-Arbeit für die aerobe Entwicklung.' : iMax <= 3 ? 'Fordernder Trainingsreiz im mittleren Intensitätsbereich.' : 'Hochintensiver Reiz – sparsam dosieren und gut regenerieren.'}`, cls: 'info' });
  } else if (zHr && s.movingSec) {
    const iMax = zHr.indexOf(Math.max(...zHr));
    const z = HR_ZONES[iMax];
    out.push({ icon: '🎯', title: `Schwerpunkt: ${z.key} ${z.name}`, text: `Größter Anteil der Fahrt in HF-Zone ${z.key} (${fmtDur(zHr[iMax])}).`, cls: 'info' });
  }

  if (d.ftpEst && d.ftpEst > settings.ftp * 1.03) {
    out.push({ icon: '🚀', title: 'FTP vermutlich höher', text: `Beste 20-min-Leistung × 0,95 ergibt ${d.ftpEst} W – dein hinterlegtes FTP von ${settings.ftp} W ist wahrscheinlich zu niedrig. Aktualisiere es im Athleten-Profil, damit Zonen und TSS stimmen.`, cls: 'good' });
  }

  if (!s.hasPower && !s.hasHr) {
    out.push({ icon: 'ℹ️', title: 'Nur GPS-Daten', text: 'Diese Datei enthält weder Leistungs- noch Herzfrequenzdaten. Für eine vollständige Analyse exportiere die GPX mit Sensordaten (z. B. aus Garmin Connect oder Wahoo).', cls: 'info' });
  }
  if (out.length === 0) out.push({ icon: 'ℹ️', title: 'Wenig Analysedaten', text: 'Für eine detaillierte Trainer-Analyse werden Zeitstempel sowie Leistungs- oder Herzfrequenzdaten benötigt.', cls: 'info' });
  return out;
}

/* ---------------- App-Zustand ---------------- */
let rides = [];
let currentRideId = null;
let map = null, routeLayer = null, hoverMarker = null, mapBounds = null, mapUserMoved = false;
let mainChart = null, mmpChart = null, weeklyChart = null, pmcChart = null, wbalChart = null;
let proReqId = 0;
const libsOk = typeof L !== 'undefined' && typeof Chart !== 'undefined';

if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#8b949e';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.animation = false;
}

/* ---------------- Ansichten ---------------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + id).classList.add('active');
  $('#nav-overview').classList.toggle('active', id === 'overview');
  if (id !== 'ride') currentRideId = null;
  renderSidebar();
}

function renderSidebar() {
  const list = $('#ride-list');
  list.innerHTML = '';
  $('#ride-count').textContent = rides.length ? `(${rides.length})` : '';
  const sorted = [...rides].sort((a, b) => new Date(b.date) - new Date(a.date));
  for (const r of sorted) {
    const d = derive(r);
    const el = document.createElement('div');
    el.className = 'ride-item' + (r.id === currentRideId ? ' active' : '');
    const tss = d.tss != null ? Math.round(d.tss) : null;
    const tssCls = tss == null ? '' : tss < 150 ? 'tss-low' : tss < 300 ? 'tss-mid' : tss < 450 ? 'tss-high' : 'tss-max';
    el.innerHTML = `
      <div class="ri-name">${escapeHtml(r.name)}</div>
      <div class="ri-meta">
        <span>${fmtDate(r.date, false)} · ${fmtNum(r.stats.distanceKm, 1)} km</span>
        ${tss != null ? `<span class="tss-chip ${tssCls}">${tss} TSS</span>` : ''}
      </div>`;
    el.onclick = () => { openRide(r.id); scrollToContentOnMobile(); };
    list.appendChild(el);
  }
}

// Auf schmalen Bildschirmen steht die Fahrtenliste über dem Inhalt
function scrollToContentOnMobile() {
  if (window.matchMedia('(max-width: 860px)').matches) $('#main').scrollIntoView({ block: 'start' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Fahrt-Detail ---------------- */
function openRide(id) {
  const ride = rides.find(r => r.id === id);
  if (!ride) return;
  currentRideId = id;
  showView('ride');
  const d = derive(ride);
  const s = ride.stats;

  $('#ride-name').value = ride.name;
  $('#ride-date').textContent = fmtDate(ride.date);

  // Statistik-Karten
  const cards = [];
  const add = (label, value, unit, hl = false) => {
    if (value == null || value === '–') return;
    cards.push(`<div class="stat-card${hl ? ' highlight' : ''}"><div class="sc-label">${label}</div><div class="sc-value">${value}${unit ? `<small>${unit}</small>` : ''}</div></div>`);
  };
  add('Distanz', fmtNum(s.distanceKm, 1), 'km');
  add('Fahrzeit', s.movingSec ? fmtDur(s.movingSec) : null, '');
  add('Gesamtzeit', s.elapsedSec ? fmtDur(s.elapsedSec) : null, '');
  add('Ø Geschwindigkeit', s.avgSpeed ? fmtNum(s.avgSpeed, 1) : null, 'km/h');
  add('Max. Geschwindigkeit', s.maxSpeed ? fmtNum(s.maxSpeed, 1) : null, 'km/h');
  add('Höhenmeter', s.elevGain != null ? fmtNum(s.elevGain) : null, 'm');
  add('Kalorien', d.cal != null ? fmtNum(d.cal) : null, 'kcal', true);
  add('Ø Leistung', s.avgPw, 'W');
  add('Normalized Power', s.np, 'W', true);
  add('Max. Leistung', s.maxPw, 'W');
  add('Intensität (IF)', d.if_ != null ? fmtNum(d.if_, 2) : null, '');
  add('TSS', d.tss != null ? fmtNum(Math.round(d.tss)) : null, '', true);
  add('Variabilität (VI)', d.vi != null ? fmtNum(d.vi, 2) : null, '');
  add('Arbeit', s.workKJ, 'kJ');
  add('Ø W/kg', d.wkg != null ? fmtNum(d.wkg, 2) : null, 'W/kg');
  add('Ø Herzfrequenz', s.avgHr, 'S/min');
  add('Max. Herzfrequenz', s.maxHr, 'S/min');
  add('Ø Trittfrequenz', s.avgCad, 'U/min');
  add('Pw:HR Entkopplung', s.decoupling != null ? fmtNum(s.decoupling, 1) + ' %' : null, '');
  $('#ride-stats').innerHTML = cards.join('');

  // Trainer-Analyse
  $('#insights').innerHTML = buildInsights(ride, d)
    .map(i => `<div class="insight ${i.cls}"><div class="ins-icon">${i.icon}</div><div><div class="ins-title">${i.title}</div><div class="ins-text">${i.text}</div></div></div>`)
    .join('');

  if (libsOk) {
    renderMap(ride);
    renderMainChart(ride);
    renderMmpChart(ride, d);
  }
  renderZones(ride, d);
  renderBestValues(ride, d);
  renderSplits(ride);
  renderProAnalysis(ride);
  renderSidebar();
}

/* ---------------- Pro-Analyse (engine.js) ---------------- */
function aggregateMMP() {
  const agg = {};
  for (const r of rides) {
    if (!r.mmp) continue;
    r.mmp.durs.forEach((dur, i) => { agg[dur] = Math.max(agg[dur] || 0, r.mmp.watts[i]); });
  }
  const durs = Object.keys(agg).map(Number).sort((a, b) => a - b);
  return { durs, watts: durs.map(dur => agg[dur]) };
}

async function renderProAnalysis(ride) {
  const statusEl = $('#pro-status'), content = $('#pro-content');
  const req = ++proReqId;
  statusEl.textContent = '';
  statusEl.className = 'badge';
  content.innerHTML = '';
  if (wbalChart) { wbalChart.destroy(); wbalChart = null; }

  if (!ride.raw1hz || !ride.raw1hz.pw) {
    content.innerHTML = `<p class="panel-note">${ride.stats.hasPower
      ? 'Für diese Fahrt liegen keine 1-Hz-Rohdaten vor (älterer Import). Bitte die GPX-Datei erneut importieren, dann erscheint hier die volle Analyse.'
      : 'Die Pro-Analyse benötigt Leistungsdaten (Powermeter). Diese Fahrt enthält keine.'}</p>`;
    return;
  }

  statusEl.textContent = 'rechnet…';
  let res;
  try {
    res = await RideEngine.analyze({
      raw: ride.raw1hz,
      settings: { ftp: settings.ftp, weight: settings.weight, hrmax: settings.hrmax },
      bestMMP: aggregateMMP(),
      route: { lat: ride.disp.lat, lon: ride.disp.lon, t: ride.disp.t },
      startISO: ride.date,
    });
  } catch (e) {
    if (req !== proReqId) return;
    statusEl.textContent = 'Fehler';
    statusEl.className = 'badge off';
    content.innerHTML = `<p class="panel-note">Analyse fehlgeschlagen: ${escapeHtml(e.message)}</p>`;
    return;
  }
  if (req !== proReqId) return;
  statusEl.textContent = 'im Browser berechnet';
  statusEl.className = 'badge on';

  let html = '';
  if (res.cp) {
    const note = res.cp.source === 'mmp-fit'
      ? `aus deiner Power-Kurve gefittet (${res.cp.points} Stützpunkte, R² ${fmtNum(res.cp.r2, 2)}). CP ≈ dauerhaft haltbare Leistung, W′ = anaerober „Akku“.`
      : 'Noch kein Fit möglich – es fehlen harte Bestwerte zwischen 2 und 30 min. Aktuell wird dein Profil-FTP verwendet.';
    html += `<div class="pro-chips">
      <span class="pro-chip"><b>CP ${fmtNum(res.cp.cp)} W</b>Critical Power</span>
      <span class="pro-chip"><b>W′ ${fmtNum(res.cp.wprime / 1000, 1)} kJ</b>anaerobe Kapazität</span>
      <span class="pro-chip-note">${note}</span>
    </div>`;
  }

  html += '<div class="pro-grid">';

  if (res.wbal) {
    html += `<div class="pro-sub pro-full">
      <h3>W′bal – anaerobe Batterie <small>Wie viel „Sprint-Energie“ war zu jedem Zeitpunkt noch übrig?</small></h3>
      <div class="wbal-box"><canvas id="chart-wbal"></canvas></div>
      <div class="pro-stat-row">
        <div class="pro-stat"><b>${fmtNum(res.wbal.minKj, 1)} kJ</b>Tiefster Stand (${fmtNum(res.wbal.minPct, 0)} % Rest)</div>
        <div class="pro-stat"><b>${res.wbal.matches}</b>„Matches“ verbrannt (Tiefentladungen &lt; 75 %)</div>
      </div>
    </div>`;
  }

  if (res.durability) {
    let inner;
    if (res.durability.tiers.length) {
      inner = res.durability.tiers.map(tier => {
        const rows = [];
        if (tier.b300) rows.push(`5 min: <b>${fmtNum(tier.b300.after)} W</b> statt ${fmtNum(tier.b300.fresh)} W frisch (−${fmtNum(tier.b300.dropPct, 1)} %)`);
        if (tier.b60) rows.push(`1 min: <b>${fmtNum(tier.b60.after)} W</b> statt ${fmtNum(tier.b60.fresh)} W frisch (−${fmtNum(tier.b60.dropPct, 1)} %)`);
        return `<div class="pro-stat" style="flex:1"><b>nach ${fmtNum(tier.kj)} kJ</b>${rows.join('<br>')}</div>`;
      }).join('');
      inner = `<div class="pro-stat-row">${inner}</div>
        <p class="panel-note">So analysieren Profi-Teams „Durability“: Wie viel Leistung bleibt übrig, wenn schon viel Arbeit in den Beinen steckt? Weniger als ~5 % Abfall ist stark, über 15 % zeigt Potenzial bei langen Fahrten (Essen! Grundlage!).</p>`;
    } else {
      inner = `<p class="panel-note">Gesamtarbeit dieser Fahrt: ${fmtNum(res.durability.totalKj)} kJ. Die Ermüdungsanalyse startet ab ~1.150 kJ (lange Ausfahrt nötig).</p>`;
    }
    html += `<div class="pro-sub"><h3>Ermüdungsresistenz <small>Bestleistung frisch vs. vorermüdet</small></h3>${inner}</div>`;
  }

  if (res.weather) {
    let inner;
    if (res.weather.error) {
      inner = `<p class="panel-note">${escapeHtml(res.weather.error)}</p>`;
    } else {
      const w = res.weather;
      const bar = (label, pct, color, extra) => `
        <div class="wind-bar-row"><span>${label}</span>
        <div class="zone-track"><div class="zone-fill" style="width:${Math.max(1, pct)}%;background:${color}"></div></div>
        <span>${pct} %${extra || ''}</span></div>`;
      inner = `
        <div class="pro-stat-row" style="margin-top:0">
          <div class="pro-stat"><b>${fmtNum(w.tempAvg, 1)} °C</b>Ø Temperatur</div>
          <div class="pro-stat"><b>${fmtNum(w.windAvgMs * 3.6, 0)} km/h</b>Ø Wind aus ${w.windDir}</div>
        </div>
        ${bar('Gegenwind', w.headPct, '#f85149')}
        ${bar('Seitenwind', w.crossPct, '#d29922')}
        ${bar('Rückenwind', w.tailPct, '#3fb950')}
        <p class="panel-note">Historische Wetterdaten (Open-Meteo) mit deiner Fahrtrichtung verrechnet – erklärt, warum sich „gleiche Watt“ manchmal ganz anders anfühlen.</p>`;
    }
    html += `<div class="pro-sub"><h3>Wetter &amp; Wind <small>zum Zeitpunkt der Fahrt</small></h3>${inner}</div>`;
  }

  if (res.aero) {
    let inner;
    if (res.aero.ok) {
      inner = `
        <div class="pro-stat-row" style="margin-top:0">
          <div class="pro-stat"><b>${fmtNum(res.aero.cda, 3)} m²</b>CdA (Luftwiderstandsfläche)</div>
          <div class="pro-stat"><b>${fmtNum(res.aero.crr, 4)}</b>Crr (Rollwiderstand)</div>
        </div>
        <p class="panel-note">Physik-Regression über ${fmtNum(res.aero.samples)} stabile Messpunkte (experimentell – ohne Windmessung als Trend über mehrere Fahrten lesen). Zur Einordnung: Rennrad-Oberlenker ≈ 0,40, Unterlenker ≈ 0,32, Zeitfahrposition ≈ 0,25 m².</p>`;
    } else {
      inner = `<p class="panel-note">Keine belastbare Schätzung möglich: ${escapeHtml(res.aero.reason || '')}.</p>`;
    }
    html += `<div class="pro-sub"><h3>Aero-Schätzung <small>CdA &amp; Rollwiderstand aus deinen Daten</small></h3>${inner}</div>`;
  }

  if (res.intervals) {
    let inner;
    if (res.intervals.length) {
      inner = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Position</th><th class="num">Dauer</th><th class="num">Ø W</th><th class="num">% CP</th><th class="num">Max W</th><th class="num">Ø HF</th></tr></thead>
        <tbody>${res.intervals.map((iv, i) => `
          <tr><td>${i + 1}</td><td>km ${fmtNum(iv.fromKm, 1)}–${fmtNum(iv.toKm, 1)}</td>
          <td class="num">${fmtDur(iv.dur)}</td><td class="num">${fmtNum(iv.avgW)}</td>
          <td class="num">${fmtNum(iv.pctCp)}</td><td class="num">${fmtNum(iv.maxW)}</td>
          <td class="num">${iv.avgHr != null ? fmtNum(iv.avgHr) : '–'}</td></tr>`).join('')}
        </tbody></table></div>`;
    } else {
      inner = '<p class="panel-note">Keine harten Intervalle (anhaltend > 91 % CP) erkannt – ruhige Fahrt.</p>';
    }
    html += `<div class="pro-sub pro-full"><h3>Automatisch erkannte Intervalle <small>anhaltende Belastungen über 91 % CP</small></h3>${inner}</div>`;
  }

  html += '</div>';
  content.innerHTML = html;

  if (res.wbal && typeof Chart !== 'undefined') {
    const wp = res.cp ? res.cp.wprime / 1000 : null;
    wbalChart = new Chart($('#chart-wbal'), {
      type: 'line',
      data: {
        datasets: [{
          label: 'W′bal',
          data: res.wbal.t.map((sec, i) => ({ x: sec / 60, y: res.wbal.kj[i] })),
          parsing: false,
          borderColor: '#f0883e',
          backgroundColor: 'rgba(240,136,62,0.15)',
          fill: 'origin',
          pointRadius: 0,
          borderWidth: 1.6,
          tension: 0.2,
        }],
      },
      options: {
        maintainAspectRatio: false,
        normalized: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Zeit (min)' }, min: 0 },
          y: { title: { display: true, text: 'kJ' }, suggestedMax: wp || undefined },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => items.length ? `Minute ${fmtNum(items[0].parsed.x, 0)}` : '',
              label: item => ` W′bal: ${fmtNum(item.parsed.y, 1)} kJ${wp ? ` (${fmtNum(item.parsed.y / wp * 100, 0)} %)` : ''}`,
            },
          },
        },
      },
    });
  }
}

/* ---------------- Karte ---------------- */
const COLOR_STOPS = [[59, 130, 246], [34, 197, 94], [234, 179, 8], [239, 68, 68]];
function scaleColor(tt) {
  tt = Math.max(0, Math.min(1, tt));
  const seg = tt * (COLOR_STOPS.length - 1);
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(seg));
  const f = seg - i;
  const c = COLOR_STOPS[i].map((v, k) => Math.round(v + (COLOR_STOPS[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Alle Kartenquellen funktionieren ohne API-Key (auch auf einer öffentlich gehosteten Seite).
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
function buildBasemaps() {
  return {
    'Dunkel': L.layerGroup([
      L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 16, maxZoom: 19, attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, ' + OSM_ATTR,
      }),
      L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19 }),
    ]),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }),
    'Radkarte (CyclOSM)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | ' + OSM_ATTR,
    }),
    'Satellit': L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 18, maxZoom: 19, attribution: 'Tiles &copy; Esri — Maxar, Earthstar Geographics',
    }),
  };
}

function renderMap(ride) {
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: true });
    const basemaps = buildBasemaps();
    let chosen = 'Dunkel';
    try { const saved = localStorage.getItem('ridelab-basemap'); if (basemaps[saved]) chosen = saved; } catch (e) { /* Standard */ }
    basemaps[chosen].addTo(map);
    L.control.layers(basemaps, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', e => { try { localStorage.setItem('ridelab-basemap', e.name); } catch (err) { /* egal */ } });

    // Container-Größe kann sich nach dem Rendern ändern (Hintergrund-Tab, Handy drehen,
    // Schrift lädt nach) – dann neu einpassen, solange der Nutzer die Karte nicht bewegt hat.
    const mapEl = $('#map');
    ['mousedown', 'wheel', 'touchstart', 'keydown'].forEach(ev =>
      mapEl.addEventListener(ev, () => { mapUserMoved = true; }, { passive: true }));
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (!mapEl.clientWidth) return;
        map.invalidateSize();
        if (!mapUserMoved && mapBounds) map.fitBounds(mapBounds, { padding: [24, 24] });
      }).observe(mapEl);
    }
  }
  mapUserMoved = false;
  if (routeLayer) { routeLayer.remove(); routeLayer = null; }
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; }

  const mode = $('#map-color-mode').value;
  const { lat, lon } = ride.disp;
  const latlngs = lat.map((la, i) => [la, lon[i]]);
  routeLayer = L.layerGroup().addTo(map);

  const valArr = mode === 'pw' ? ride.disp.pw : mode === 'hr' ? ride.disp.hr
    : mode === 'spd' ? ride.disp.spd : mode === 'grade' ? ride.disp.grade : null;

  if (!valArr || valArr.every(v => v == null)) {
    L.polyline(latlngs, { color: '#fc5200', weight: 3.5, opacity: 0.9 }).addTo(routeLayer);
  } else {
    const vals = valArr.filter(v => v != null).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.05)], hi = vals[Math.floor(vals.length * 0.95)] || lo + 1;
    const range = Math.max(hi - lo, 1e-6);
    let chunk = [latlngs[0]], chunkBin = -1;
    const flush = bin => {
      if (chunk.length > 1) L.polyline(chunk, { color: scaleColor(bin / 23), weight: 4, opacity: 0.95 }).addTo(routeLayer);
    };
    for (let i = 1; i < latlngs.length; i++) {
      const v = valArr[i] != null ? valArr[i] : lo;
      const bin = Math.max(0, Math.min(23, Math.round(((v - lo) / range) * 23)));
      if (chunkBin === -1) chunkBin = bin;
      if (bin !== chunkBin) {
        chunk.push(latlngs[i]);
        flush(chunkBin);
        chunk = [latlngs[i]];
        chunkBin = bin;
      } else {
        chunk.push(latlngs[i]);
      }
    }
    flush(chunkBin);
  }

  L.circleMarker(latlngs[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#3fb950', fillOpacity: 1 }).bindTooltip('Start').addTo(routeLayer);
  L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#f85149', fillOpacity: 1 }).bindTooltip('Ziel').addTo(routeLayer);

  mapBounds = L.latLngBounds(latlngs);
  setTimeout(() => { map.invalidateSize(); map.fitBounds(mapBounds, { padding: [24, 24] }); }, 50);
}

function setMapMarker(i) {
  const ride = rides.find(r => r.id === currentRideId);
  if (!ride || !map) return;
  const la = ride.disp.lat[i], lo = ride.disp.lon[i];
  if (la == null) return;
  if (!hoverMarker) {
    hoverMarker = L.circleMarker([la, lo], { radius: 7, color: '#fff', weight: 2.5, fillColor: '#fc5200', fillOpacity: 1 }).addTo(map);
  } else {
    hoverMarker.setLatLng([la, lo]);
  }
}

/* ---------------- Haupt-Diagramm ---------------- */
const SERIES = [
  { key: 'ele', label: 'Höhe', color: '#4d5766', axis: 'yEle', unit: 'm', fill: true, on: true },
  { key: 'pw', label: 'Leistung', color: '#fc5200', axis: 'yPw', unit: 'W', on: true },
  { key: 'hr', label: 'Herzfrequenz', color: '#f85149', axis: 'yHr', unit: 'S/min', on: true },
  { key: 'spd', label: 'Geschwindigkeit', color: '#58a6ff', axis: 'ySpd', unit: 'km/h', on: false },
  { key: 'cad', label: 'Trittfrequenz', color: '#bc8cff', axis: 'yCad', unit: 'U/min', on: false },
];
const seriesState = Object.fromEntries(SERIES.map(s => [s.key, s.on]));

const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    const act = chart.tooltip && chart.tooltip.getActiveElements();
    if (act && act.length) {
      const x = act[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    }
  },
};

function renderMainChart(ride) {
  const disp = ride.disp;
  // Umschalt-Chips
  const chipRow = $('#series-toggles');
  chipRow.innerHTML = '';
  for (const sr of SERIES) {
    const has = disp[sr.key].some(v => v != null);
    const btn = document.createElement('button');
    btn.className = 'chip' + (seriesState[sr.key] && has ? ' on' : '');
    btn.style.setProperty('--chip-color', sr.color);
    btn.textContent = sr.label;
    btn.disabled = !has;
    btn.onclick = () => {
      seriesState[sr.key] = !seriesState[sr.key];
      renderMainChart(ride);
    };
    chipRow.appendChild(btn);
  }

  const datasets = [];
  for (const sr of SERIES) {
    const has = disp[sr.key].some(v => v != null);
    if (!has) continue;
    datasets.push({
      label: sr.label,
      data: disp.km.map((x, i) => ({ x, y: disp[sr.key][i] })),
      parsing: false,
      borderColor: sr.color,
      backgroundColor: sr.fill ? 'rgba(77,87,102,0.35)' : sr.color,
      fill: sr.fill ? 'origin' : false,
      borderWidth: sr.fill ? 1 : 1.6,
      pointRadius: 0,
      tension: 0.25,
      yAxisID: sr.axis,
      hidden: !seriesState[sr.key],
      order: sr.fill ? 10 : 1,
      spanGaps: true,
      _unit: sr.unit,
    });
  }

  if (mainChart) mainChart.destroy();
  mainChart = new Chart($('#chart-main'), {
    type: 'line',
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      onHover(e, els) { if (els && els.length) setMapMarker(els[0].index); },
      scales: {
        x: {
          type: 'linear', min: 0, max: disp.km[disp.km.length - 1],
          title: { display: true, text: 'Distanz (km)' },
          ticks: { callback: v => fmtNum(v, 0) },
        },
        yPw: { display: seriesState.pw, position: 'left', title: { display: true, text: 'Watt' }, beginAtZero: true },
        yHr: { display: seriesState.hr, position: 'right', title: { display: true, text: 'S/min' }, grid: { drawOnChartArea: false } },
        yEle: { display: false, beginAtZero: false },
        ySpd: { display: false, beginAtZero: true },
        yCad: { display: false, beginAtZero: true },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const i = items[0].dataIndex;
              const km = disp.km[i], tSec = disp.t[i];
              return `km ${fmtNum(km, 1)}${tSec != null ? ` · ${fmtDur(tSec)}` : ''}${disp.grade[i] != null ? ` · ${fmtNum(disp.grade[i], 1)} %` : ''}`;
            },
            label(item) {
              return ` ${item.dataset.label}: ${fmtNum(item.parsed.y, item.dataset.label === 'Geschwindigkeit' ? 1 : 0)} ${item.dataset._unit}`;
            },
          },
        },
      },
    },
    plugins: [crosshairPlugin],
  });
}

/* ---------------- Power-Kurve ---------------- */
function renderMmpChart(ride, d) {
  const panel = $('#chart-mmp').closest('.panel');
  if (!ride.mmp || ride.mmp.durs.length < 3) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const labels = ride.mmp.durs.map(sec => MMP_DURATIONS.find(x => x.sec === sec).label);
  if (mmpChart) mmpChart.destroy();
  mmpChart = new Chart($('#chart-mmp'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Beste Leistung',
        data: ride.mmp.watts,
        borderColor: '#fc5200',
        backgroundColor: 'rgba(252,82,0,0.15)',
        fill: true,
        pointRadius: 3.5,
        pointBackgroundColor: '#fc5200',
        tension: 0.35,
      }],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        y: { title: { display: true, text: 'Watt' }, beginAtZero: true },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(item) {
              const w = item.parsed.y;
              const wkg = settings.weight ? ` · ${fmtNum(w / settings.weight, 1)} W/kg` : '';
              return ` ${fmtNum(w)} W${wkg}`;
            },
          },
        },
      },
    },
  });
}

/* ---------------- Zonen ---------------- */
function renderZoneBars(container, zones, defs, totalSec, fmtRange) {
  if (!zones || !totalSec) {
    container.innerHTML = '<div class="zone-empty">Keine Daten vorhanden.</div>';
    return;
  }
  const max = Math.max(...zones, 1);
  container.innerHTML = defs.map((z, i) => `
    <div class="zone-row">
      <div class="zone-label" style="color:${z.color}">${z.key} ${z.name}<small>${fmtRange(z)}</small></div>
      <div class="zone-track"><div class="zone-fill" style="width:${Math.max(1, zones[i] / max * 100)}%;background:${z.color}"></div></div>
      <div class="zone-time"><b>${fmtDur(zones[i])}</b><br>${totalSec ? Math.round(zones[i] / totalSec * 100) : 0} %</div>
    </div>`).join('');
}

function renderZones(ride, d) {
  const total = ride.stats.movingSec;
  $('#pz-sub').textContent = `bezogen auf FTP ${settings.ftp} W`;
  $('#hz-sub').textContent = `bezogen auf HFmax ${settings.hrmax} S/min`;
  renderZoneBars($('#power-zones'), d.zonesPower, POWER_ZONES, total,
    z => z.hi > 90 ? `> ${Math.round(z.lo * settings.ftp)} W` : `${Math.round(z.lo * settings.ftp)}–${Math.round(z.hi * settings.ftp)} W`);
  const hrTotal = ride.hrHist ? ride.hrHist.reduce((a, b) => a + b, 0) : 0;
  renderZoneBars($('#hr-zones'), d.zonesHR, HR_ZONES, hrTotal,
    z => z.hi > 1.5 ? `> ${Math.round(z.lo * settings.hrmax)}` : `${Math.round(z.lo * settings.hrmax)}–${Math.round(z.hi * settings.hrmax)}`);
}

/* ---------------- Bestwerte ---------------- */
function renderBestValues(ride, d) {
  const panel = $('#best-values').closest('.panel');
  const el = $('#best-values');
  if (!ride.mmp || !ride.mmp.durs.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const wanted = [5, 60, 300, 1200];
  const items = [];
  for (const sec of wanted) {
    const i = ride.mmp.durs.indexOf(sec);
    if (i < 0) continue;
    const label = MMP_DURATIONS.find(x => x.sec === sec).label;
    const w = ride.mmp.watts[i];
    items.push(`<div class="best-card"><span class="bv-label">Beste ${label}</span><span class="bv-value">${fmtNum(w)} W <small>${settings.weight ? fmtNum(w / settings.weight, 1) + ' W/kg' : ''}</small></span></div>`);
  }
  let html = `<div class="best-grid">${items.join('')}</div>`;
  if (d.ftpEst) {
    html += `<div class="ftp-hint"><b>FTP-Schätzung dieser Fahrt: ${d.ftpEst} W</b> (beste 20 min × 0,95). Hinterlegt: ${settings.ftp} W.</div>`;
  }
  el.innerHTML = html;
}

/* ---------------- Abschnitte ---------------- */
function renderSplits(ride) {
  const tbody = $('#splits-table tbody');
  const splitLen = ride.stats.distanceKm >= 15 ? 5 : 1;
  $('#splits-sub').textContent = `je ${splitLen} km`;
  const maxSpeed = Math.max(...ride.splits.map(s => s.speed || 0), 1);
  tbody.innerHTML = ride.splits.map(s => `
    <tr>
      <td>km ${fmtNum(s.fromKm, 0)}–${fmtNum(s.toKm, s.toKm % 1 > 0.05 ? 1 : 0)}</td>
      <td class="num">${fmtDur(s.time)}</td>
      <td class="num">${s.speed ? fmtNum(s.speed, 1) : '–'}</td>
      <td class="num">${s.pw != null ? fmtNum(s.pw) : '–'}</td>
      <td class="num">${s.hr != null ? fmtNum(s.hr) : '–'}</td>
      <td class="num">${s.gain != null ? fmtNum(s.gain) : '–'}</td>
      <td style="width:130px"><span class="split-bar" style="width:${Math.round((s.speed || 0) / maxSpeed * 120)}px"></span></td>
    </tr>`).join('');
}

/* ---------------- Übersicht ---------------- */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return { year: d.getUTCFullYear(), week: 1 + Math.round((d - firstThu) / 604800000) };
}

function renderOverview() {
  showView('overview');
  const sorted = [...rides].sort((a, b) => new Date(a.date) - new Date(b.date));
  const derived = sorted.map(r => ({ r, d: derive(r) }));

  // Gesamt-Karten
  const totKm = sorted.reduce((a, r) => a + r.stats.distanceKm, 0);
  const totSec = sorted.reduce((a, r) => a + (r.stats.movingSec || 0), 0);
  const totHm = sorted.reduce((a, r) => a + (r.stats.elevGain || 0), 0);
  const totTss = derived.reduce((a, x) => a + (x.d.tss || 0), 0);
  const totCal = derived.reduce((a, x) => a + (x.d.cal || 0), 0);
  $('#ov-subtitle').textContent = rides.length ? `${rides.length} Fahrten · ${fmtDate(sorted[0].date, false)} bis ${fmtDate(sorted[sorted.length - 1].date, false)}` : '';
  $('#ov-totals').innerHTML = [
    ['Fahrten', fmtNum(rides.length), ''],
    ['Distanz gesamt', fmtNum(totKm, 0), 'km'],
    ['Fahrzeit gesamt', fmtDur(totSec), ''],
    ['Höhenmeter gesamt', fmtNum(totHm), 'm'],
    ['Belastung gesamt', fmtNum(Math.round(totTss)), 'TSS'],
    ['Kalorien gesamt', fmtNum(totCal), 'kcal'],
  ].map(([l, v, u]) => `<div class="stat-card"><div class="sc-label">${l}</div><div class="sc-value">${v}${u ? `<small>${u}</small>` : ''}</div></div>`).join('');

  if (libsOk) {
    renderWeeklyChart(derived);
    renderPmcChart(derived);
  }

  // Tabelle
  const tbody = $('#ov-table tbody');
  tbody.innerHTML = [...derived].reverse().map(({ r, d }) => `
    <tr data-id="${r.id}">
      <td>${fmtDate(r.date, false)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${fmtNum(r.stats.distanceKm, 1)}</td>
      <td class="num">${r.stats.elevGain != null ? fmtNum(r.stats.elevGain) : '–'}</td>
      <td class="num">${fmtDur(r.stats.movingSec)}</td>
      <td class="num">${r.stats.avgPw != null ? fmtNum(r.stats.avgPw) : '–'}</td>
      <td class="num">${r.stats.np != null ? fmtNum(r.stats.np) : '–'}</td>
      <td class="num">${r.stats.avgHr != null ? fmtNum(r.stats.avgHr) : '–'}</td>
      <td class="num">${d.tss != null ? fmtNum(Math.round(d.tss)) : '–'}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr').forEach(tr => tr.onclick = () => openRide(tr.dataset.id));
}

function renderWeeklyChart(derived) {
  // Letzte 12 Wochen (Montagsanfang)
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - i * 7);
    weeks.push({ start, km: 0, tss: 0 });
  }
  for (const { r, d } of derived) {
    const rd = new Date(r.date);
    for (const w of weeks) {
      const end = new Date(w.start);
      end.setDate(end.getDate() + 7);
      if (rd >= w.start && rd < end) { w.km += r.stats.distanceKm; w.tss += d.tss || 0; break; }
    }
  }
  const labels = weeks.map(w => `KW ${isoWeek(w.start).week}`);
  if (weeklyChart) weeklyChart.destroy();
  weeklyChart = new Chart($('#chart-weekly'), {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Distanz (km)', data: weeks.map(w => Math.round(w.km * 10) / 10), backgroundColor: 'rgba(88,166,255,0.65)', borderRadius: 4, yAxisID: 'y' },
        { type: 'line', label: 'TSS', data: weeks.map(w => Math.round(w.tss)), borderColor: '#fc5200', backgroundColor: '#fc5200', pointRadius: 3, tension: 0.3, yAxisID: 'y2' },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        y: { position: 'left', title: { display: true, text: 'km' }, beginAtZero: true },
        y2: { position: 'right', title: { display: true, text: 'TSS' }, beginAtZero: true, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderPmcChart(derived) {
  const panel = $('#chart-pmc').closest('.panel');
  if (!derived.length || !derived.some(x => x.d.tss)) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  // Tägliche TSS-Summen vom ersten Tag bis heute
  const first = new Date(derived[0].r.date);
  first.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.max(1, Math.round((today - first) / 86400000) + 1);
  const daily = new Array(days).fill(0);
  for (const { r, d } of derived) {
    const rd = new Date(r.date);
    rd.setHours(0, 0, 0, 0);
    const i = Math.round((rd - first) / 86400000);
    if (i >= 0 && i < days) daily[i] += d.tss || 0;
  }
  let ctl = 0, atl = 0;
  const ctlA = [], atlA = [], tsbA = [], labels = [];
  for (let i = 0; i < days; i++) {
    tsbA.push(Math.round((ctl - atl) * 10) / 10); // Form am Morgen des Tages
    ctl += (daily[i] - ctl) / 42;
    atl += (daily[i] - atl) / 7;
    ctlA.push(Math.round(ctl * 10) / 10);
    atlA.push(Math.round(atl * 10) / 10);
    const d0 = new Date(first);
    d0.setDate(first.getDate() + i);
    labels.push(d0.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }));
  }
  if (pmcChart) pmcChart.destroy();
  pmcChart = new Chart($('#chart-pmc'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Fitness (CTL)', data: ctlA, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.12)', fill: true, pointRadius: 0, tension: 0.3 },
        { label: 'Ermüdung (ATL)', data: atlA, borderColor: '#bc8cff', pointRadius: 0, tension: 0.3 },
        { label: 'Frische (TSB)', data: tsbA, borderColor: '#3fb950', borderDash: [5, 4], pointRadius: 0, tension: 0.3 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 12 } } },
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxHeight: 6 } } },
    },
  });
}

/* ---------------- Import / Export ---------------- */
const EXPORT_FORMAT = 'ridelab-export';

function isValidRide(r) {
  return r && typeof r.id === 'string' && r.stats && r.disp && Array.isArray(r.disp.lat) && r.disp.lat.length > 1;
}

async function importFiles(fileList) {
  const files = [...fileList].filter(f => /\.(gpx|json)$/i.test(f.name));
  if (!files.length) {
    toast('Keine GPX- oder RideLab-Dateien gefunden.', true);
    return;
  }
  let ok = 0, skipped = 0, lastId = null, settingsRestored = false;
  for (const f of files) {
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name)) {
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('Datei ist kein gültiges JSON'); }
        if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.rides)) {
          throw new Error('keine RideLab-Exportdatei');
        }
        for (const r of data.rides) {
          if (!isValidRide(r)) continue;
          if (rides.some(x => x.id === r.id)) { skipped++; continue; }
          await store.put(r);
          rides.push(r);
          lastId = r.id;
          ok++;
        }
        if (data.settings && typeof data.settings.ftp === 'number') {
          settings = { ...DEFAULT_SETTINGS, ...data.settings };
          saveSettings();
          settingsRestored = true;
        }
      } else {
        const { name, pts } = parseGPX(text);
        const ride = computeRide(pts, name || f.name.replace(/\.gpx$/i, ''), new Date(f.lastModified).toISOString());
        await store.put(ride);
        rides.push(ride);
        lastId = ride.id;
        ok++;
      }
    } catch (e) {
      toast(`${f.name}: ${e.message}`, true);
    }
  }
  if (skipped) toast(`${skipped} ${skipped === 1 ? 'Fahrt war' : 'Fahrten waren'} schon vorhanden und ${skipped === 1 ? 'wurde' : 'wurden'} übersprungen`);
  if (settingsRestored) toast('Athleten-Profil aus dem Backup übernommen');
  if (ok) {
    toast(ok === 1 ? '1 Fahrt importiert' : `${ok} Fahrten importiert`);
    renderSidebar();
    if (ok === 1 && lastId) openRide(lastId);
    else renderOverview();
  }
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(s) {
  return String(s).replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'fahrt';
}

// Einzelne Fahrt zum Weitergeben (ohne Athleten-Profil)
function exportRide(ride) {
  downloadJson({ format: EXPORT_FORMAT, version: 1, exported: new Date().toISOString(), rides: [ride] },
    `${ride.date.slice(0, 10)}-${safeFilename(ride.name)}.ridelab.json`);
  toast('Fahrt exportiert – die Datei kann in jedem RideLab importiert werden');
}

// Komplettes Backup inkl. Athleten-Profil
function exportAll() {
  if (!rides.length) { toast('Noch keine Fahrten zum Sichern vorhanden.', true); return; }
  downloadJson({ format: EXPORT_FORMAT, version: 1, exported: new Date().toISOString(), settings, rides },
    `ridelab-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast(`Backup mit ${rides.length} ${rides.length === 1 ? 'Fahrt' : 'Fahrten'} gespeichert`);
}

/* ---------------- Demo-Fahrten ---------------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function solveSpeed(power, gradePct, rnd) {
  // P = 0,5·rho·CdA·v³ + m·g·(Steigung + Crr)·v  →  Bisektion
  const a = 0.5 * 1.226 * 0.34;
  const b = 82 * 9.81 * (gradePct / 100 + 0.0045);
  const f = v => a * v * v * v + b * v - Math.max(power, 5);
  let lo = 0.5, hi = 26;
  if (f(hi) < 0) return hi;
  for (let k = 0; k < 45; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid; else lo = mid;
  }
  return Math.max(0.8, Math.min(25, (lo + hi) / 2 + (rnd() - 0.5) * 0.3));
}

function generateDemoRide(cfg) {
  const rnd = mulberry32(cfg.seed);
  const pts = [];
  let lat = cfg.startLat, lon = cfg.startLon, ele = cfg.startEle, hr = 82, heading = rnd() * Math.PI * 2;
  let tSec = 0, coastLeft = 0;
  const startMs = cfg.start.getTime();
  const totalSec = cfg.plan.reduce((a, seg) => a + seg.dur, 0);

  for (const seg of cfg.plan) {
    for (let s = 0; s < seg.dur; s++, tSec++) {
      const grade = seg.grade + Math.sin(tSec / 95) * (seg.gradeVar || 0.6) + (rnd() - 0.5) * 0.4;
      let pw = seg.pw + Math.sin(tSec / 40) * seg.pw * 0.06 + (rnd() - 0.5) * 26;
      if (coastLeft > 0) { pw = 0; coastLeft--; }
      else if (rnd() < (grade < -2 ? 0.05 : 0.006)) coastLeft = 2 + Math.floor(rnd() * 6);
      pw = Math.max(0, pw);

      const v = solveSpeed(pw, grade, rnd);
      const hrTarget = Math.min(cfg.hrmax || 184, 88 + pw * 0.33 + 9 * (tSec / totalSec));
      hr += (hrTarget - hr) / 45 + (rnd() - 0.5) * 0.8;
      const cad = pw < 25 ? 0 : Math.round((grade > 3 ? 74 : 89) + (rnd() - 0.5) * 8);

      heading += 0.0006 + 0.0025 * Math.sin(tSec / 130) + (rnd() - 0.5) * 0.004;
      lat += (v * Math.cos(heading)) / 111320;
      lon += (v * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
      ele = Math.max(50, ele + v * grade / 100);

      pts.push({
        lat, lon, ele: +ele.toFixed(1), t: startMs + tSec * 1000,
        hr: Math.round(hr), cad, pw: Math.round(pw),
      });
    }
  }
  return computeRide(pts, cfg.name, null);
}

function daysAgoAt(days, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function loadDemoRides() {
  const configs = [
    {
      name: 'Schwarzwald-Runde (Demo)', seed: 42,
      start: daysAgoAt(3, 9, 12),
      startLat: 47.995, startLon: 7.842, startEle: 265,
      plan: [
        { dur: 900, pw: 148, grade: 0.3, gradeVar: 1.2 },
        { dur: 2520, pw: 232, grade: 6.3, gradeVar: 1.4 },
        { dur: 1200, pw: 176, grade: 0, gradeVar: 2.2 },
        { dur: 840, pw: 70, grade: -6.4, gradeVar: 1.2 },
        { dur: 300, pw: 288, grade: 0.2 }, { dur: 300, pw: 132, grade: 0 },
        { dur: 300, pw: 291, grade: 0.2 }, { dur: 300, pw: 130, grade: 0 },
        { dur: 300, pw: 285, grade: 0.2 }, { dur: 300, pw: 128, grade: 0 },
        { dur: 300, pw: 282, grade: 0.2 }, { dur: 300, pw: 126, grade: 0 },
        { dur: 1200, pw: 193, grade: -0.3, gradeVar: 0.8 },
        { dur: 840, pw: 128, grade: -0.4, gradeVar: 0.6 },
      ],
    },
    {
      name: 'Intervalle nach Feierabend (Demo)', seed: 7,
      start: daysAgoAt(1, 17, 45),
      startLat: 48.012, startLon: 7.79, startEle: 230,
      plan: [
        { dur: 720, pw: 142, grade: 0.2, gradeVar: 0.8 },
        { dur: 180, pw: 302, grade: 0.3 }, { dur: 180, pw: 118, grade: 0 },
        { dur: 180, pw: 305, grade: 0.3 }, { dur: 180, pw: 116, grade: 0 },
        { dur: 180, pw: 298, grade: 0.3 }, { dur: 180, pw: 118, grade: 0 },
        { dur: 180, pw: 300, grade: 0.3 }, { dur: 180, pw: 115, grade: 0 },
        { dur: 180, pw: 295, grade: 0.3 }, { dur: 180, pw: 117, grade: 0 },
        { dur: 180, pw: 290, grade: 0.3 }, { dur: 180, pw: 116, grade: 0 },
        { dur: 600, pw: 182, grade: -0.2 },
        { dur: 720, pw: 122, grade: 0, gradeVar: 0.5 },
      ],
    },
    {
      name: 'Lockere Grundlagenfahrt (Demo)', seed: 99,
      start: daysAgoAt(6, 10, 5),
      startLat: 47.988, startLon: 7.865, startEle: 250,
      plan: [
        { dur: 1500, pw: 149, grade: 0.4, gradeVar: 1.5 },
        { dur: 1800, pw: 156, grade: 1.1, gradeVar: 1.8 },
        { dur: 1500, pw: 151, grade: -0.8, gradeVar: 1.5 },
        { dur: 1200, pw: 143, grade: -0.3, gradeVar: 1.0 },
      ],
    },
  ];
  let lastId = null;
  for (const cfg of configs) {
    const ride = generateDemoRide(cfg);
    await store.put(ride);
    rides.push(ride);
    lastId = ride.id;
  }
  toast('3 Demo-Fahrten geladen');
  renderSidebar();
  const big = rides.find(r => r.name.startsWith('Schwarzwald'));
  openRide(big ? big.id : lastId);
}

/* ---------------- Events ---------------- */
function wireEvents() {
  $('#btn-import').onclick = () => $('#file-input').click();
  $('#file-input').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  $('#btn-demo').onclick = loadDemoRides;
  $('#nav-overview').onclick = () => { renderOverview(); scrollToContentOnMobile(); };
  $('#btn-backup').onclick = exportAll;
  $('#btn-restore').onclick = () => $('#file-input').click();
  $('#btn-export').onclick = () => {
    const ride = rides.find(r => r.id === currentRideId);
    if (ride) exportRide(ride);
  };

  // Drag & Drop
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  // Fahrt umbenennen
  $('#ride-name').addEventListener('change', async e => {
    const ride = rides.find(r => r.id === currentRideId);
    if (!ride) return;
    ride.name = e.target.value.trim() || 'Radfahrt';
    await store.put(ride);
    renderSidebar();
  });

  // Fahrt löschen
  $('#btn-delete').onclick = async () => {
    const ride = rides.find(r => r.id === currentRideId);
    if (!ride) return;
    if (!confirm(`„${ride.name}“ wirklich löschen?`)) return;
    await store.del(ride.id);
    rides = rides.filter(r => r.id !== ride.id);
    toast('Fahrt gelöscht');
    if (rides.length) renderOverview(); else showView('empty');
  };

  // Karten-Färbung
  $('#map-color-mode').onchange = () => {
    const ride = rides.find(r => r.id === currentRideId);
    if (ride && libsOk) renderMap(ride);
  };

  // Einstellungen
  const modal = $('#settings-modal');
  $('#btn-settings').onclick = () => {
    const f = $('#settings-form');
    f.ftp.value = settings.ftp;
    f.hrmax.value = settings.hrmax;
    f.weight.value = settings.weight;
    f.age.value = settings.age;
    f.sex.value = settings.sex;
    modal.hidden = false;
  };
  $('#btn-settings-cancel').onclick = () => { modal.hidden = true; };
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  $('#settings-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    settings = {
      ftp: +f.ftp.value, hrmax: +f.hrmax.value,
      weight: +f.weight.value, age: +f.age.value, sex: f.sex.value,
    };
    saveSettings();
    modal.hidden = true;
    toast('Profil gespeichert – Zonen und TSS neu berechnet');
    if (currentRideId) openRide(currentRideId);
    else if ($('#view-overview').classList.contains('active')) renderOverview();
    renderSidebar();
  });
}

/* ---------------- Start ---------------- */
(async function init() {
  saveSettings();
  wireEvents();
  if (!libsOk) {
    toast('Karte/Diagramme konnten nicht geladen werden – bitte Internetverbindung prüfen und neu laden.', true);
  }
  await store.init();
  try {
    rides = await store.all();
  } catch (e) {
    rides = [];
  }
  renderSidebar();
  if (rides.length) {
    const newest = [...rides].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    openRide(newest.id);
  } else {
    showView('empty');
  }
})();
