const statusEl = document.getElementById('status');
let CURRENT = null; // {lat, lon, label}
let map = null;
let lastUpdatedAt = null;

function updateLastUpdatedLabel(){
  const el = document.getElementById('lastUpdated');
  if(!el || !lastUpdatedAt) return;
  const mins = Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 60000));
  el.textContent = mins < 1 ? '· Updated just now' : `· Updated ${mins}m ago`;
}
setInterval(updateLastUpdatedLabel, 30000);

// --- Theme (dark/light/system), persisted on this device ---
function applyTheme(pref){
  const resolved = pref === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : pref;
  if(resolved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  ['themeDark','themeLight','themeSystem'].forEach(id => {
    document.getElementById(id).classList.toggle('theme-active',
      (id === 'themeDark' && pref === 'dark') ||
      (id === 'themeLight' && pref === 'light') ||
      (id === 'themeSystem' && pref === 'system'));
  });
}
function setTheme(pref){
  try{ localStorage.setItem('themePreference', pref); }catch(e){}
  applyTheme(pref);
}
function initTheme(){
  let pref = 'system';
  try{ pref = localStorage.getItem('themePreference') || 'system'; }catch(e){}
  applyTheme(pref);
  if(window.matchMedia){
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      let p = 'system';
      try{ p = localStorage.getItem('themePreference') || 'system'; }catch(e){}
      if(p === 'system') applyTheme('system');
    });
  }
}
initTheme();

// Free, no-key Open-Meteo models. All independently run global/regional forecast models.
const MODELS = [
  {key:'ecmwf_ifs025', name:'ECMWF', color:'#4da3ff'},
  {key:'gfs_seamless', name:'GFS (NOAA)', color:'#f5b942'},
  {key:'icon_seamless', name:'ICON (DWD)', color:'#2ecc71'},
  {key:'meteofrance_seamless', name:'Météo-France', color:'#c07bff'},
  {key:'gem_seamless', name:'GEM (Canada)', color:'#ff9f4d'},
  {key:'jma_seamless', name:'JMA (Japan)', color:'#4dd0e1'},
];
const MODEL_QUERY = MODELS.map(m=>m.key).join(',');

function median(arr){
  const a = arr.filter(v => v !== null && v !== undefined && !isNaN(v)).sort((x,y)=>x-y);
  if(!a.length) return null;
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1]+a[mid])/2;
}
function mean(arr){
  const a = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if(!a.length) return null;
  return a.reduce((s,v)=>s+v,0)/a.length;
}
function stddev(arr){
  const a = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if(a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);
}

// Precipitation "probability" from Open-Meteo isn't meaningfully defined per named
// deterministic model (it's really an ensemble statistic), so instead of trusting that
// field we compute our own honest metric: what % of the 6 models forecast measurable
// rain (>0.1mm) at this hour. This is derived from real forecast amounts, not a
// borrowed number that doesn't apply to single-model runs.
function precipAgreementPct(values){
  const valid = values.filter(v => v !== null && v !== undefined && !isNaN(v));
  if(!valid.length) return null;
  const rainingCount = valid.filter(v => v > 0.1).length;
  return Math.round((rainingCount/valid.length)*100);
}

// Same idea as precipAgreementPct, but also names which specific models forecast rain,
// so the person can see exactly how split (or unanimous) the models actually are.
function computeAgreement(precip, hourIdx){
  if(hourIdx < 0) return {pct:null, count:0, total:0, names:[]};
  const infos = MODELS.map(m => ({name:m.name, val: precip[m.key][hourIdx]}))
    .filter(o => o.val !== null && o.val !== undefined && !isNaN(o.val));
  if(!infos.length) return {pct:null, count:0, total:0, names:[]};
  const raining = infos.filter(o => o.val > 0.1);
  return {
    pct: Math.round((raining.length/infos.length)*100),
    count: raining.length,
    total: infos.length,
    names: raining.map(o=>o.name)
  };
}
function offsetPoints(lat, lon, km=5){
  const dLat = km/111;
  const dLon = km/(111*Math.cos(lat*Math.PI/180));
  return {
    N:{lat: lat+dLat, lon: lon, dir:'North'},
    S:{lat: lat-dLat, lon: lon, dir:'South'},
    E:{lat: lat, lon: lon+dLon, dir:'East'},
    W:{lat: lat, lon: lon-dLon, dir:'West'},
  };
}

async function fetchMultiModel(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,apparent_temperature,relative_humidity_2m,pressure_msl,uv_index` +
    `&daily=sunrise,sunset` +
    `&models=${MODEL_QUERY}&timezone=auto&forecast_days=2`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Weather API error ' + res.status);
  return res.json();
}

// Lightweight 5-day overview from Open-Meteo's default blended model — kept separate
// from the 6-model multi-fetch above so that call doesn't balloon in size/cost.
async function fetchFiveDayOverview(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
    `&timezone=auto&forecast_days=5`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('5-day forecast unavailable');
  return res.json();
}

// Open-Meteo's separate free Air Quality API (no key). Converts PM2.5 to the standard
// US EPA AQI scale using the official breakpoint table — a real, documented formula,
// not an invented number.
async function fetchAirQuality(lat, lon){
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&hourly=pm2_5&timezone=auto`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Air quality unavailable');
  return res.json();
}

function pm25ToAQI(pm){
  // EPA breakpoint table (2024 revision uses similar breakpoints for PM2.5 in µg/m³)
  const bp = [
    [0.0,9.0,0,50],[9.1,35.4,51,100],[35.5,55.4,101,150],
    [55.5,125.4,151,200],[125.5,225.4,201,300],[225.5,500.4,301,500]
  ];
  for(const [cLo,cHi,aLo,aHi] of bp){
    if(pm >= cLo && pm <= cHi){
      return Math.round(((aHi-aLo)/(cHi-cLo)) * (pm-cLo) + aLo);
    }
  }
  return pm > 500 ? 500 : 0;
}
function aqiCategory(aqi){
  if(aqi <= 50) return {label:'Good', color:'var(--good)'};
  if(aqi <= 100) return {label:'Moderate', color:'var(--warn)'};
  if(aqi <= 150) return {label:'Unhealthy (Sensitive)', color:'#ff9f4d'};
  if(aqi <= 200) return {label:'Unhealthy', color:'var(--bad)'};
  if(aqi <= 300) return {label:'Very Unhealthy', color:'#c05ce0'};
  return {label:'Hazardous', color:'#8b1a3d'};
}
async function fetchSimple(lat, lon){
  // Uses Open-Meteo's default blended "best_match" model (no models= param), where
  // precipitation_probability is a genuinely valid ensemble-derived statistic —
  // unlike when it's requested per named deterministic model (see fetchMultiModel).
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation_probability,cloud_cover&timezone=auto&forecast_days=1`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Weather API error ' + res.status);
  return res.json();
}
async function getIpLocation(){
  const res = await fetch('https://ipapi.co/json/');
  if(!res.ok) throw new Error('IP location lookup failed');
  const j = await res.json();
  if(!j.latitude || !j.longitude) throw new Error('IP location returned no coordinates');
  return {lat: j.latitude, lon: j.longitude, label: `${j.city || ''} ${j.region || ''}`.trim() || 'Approximate (IP-based)'};
}
async function geocodeCity(name){
  // Nominatim (OpenStreetMap) has far better coverage of small localities/barangays
  // than the basic Open-Meteo geocoder.
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}&limit=1&addressdetails=1`;
  const res = await fetch(url, {headers:{'Accept':'application/json'}});
  const j = await res.json();
  if(!j || !j.length) throw new Error(`"${name}" not found. Try adding the city/province (e.g. "Libertad, Pasay City"), or just click the map instead — it's always exact.`);
  const r = j[0];
  const parts = r.display_name.split(',').map(s=>s.trim());
  return {lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: parts.slice(0,3).join(', ')};
}
async function reverseGeocode(lat, lon){
  try{
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`;
    const res = await fetch(url, {headers:{'Accept':'application/json'}});
    const j = await res.json();
    return j.address ? (j.address.city || j.address.town || j.address.village || j.address.county || j.display_name) : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }catch(e){
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}

function currentHourIndex(times){
  const now = new Date();
  let best = 0, bestDiff = Infinity;
  times.forEach((t,i)=>{
    const diff = Math.abs(new Date(t) - now);
    if(diff < bestDiff){ bestDiff = diff; best = i; }
  });
  return best;
}

function modelSeries(hourly, field){
  const out = {};
  MODELS.forEach(m => { out[m.key] = hourly[`${field}_${m.key}`]; });
  return out;
}

async function fetchFineResolution(lat, lon){
  // minutely_15 is Open-Meteo's highest-resolution free feed (best-match single blended
  // model, not raw multi-model). We combine it with the hourly multi-model median below
  // so the result reflects several models, not just one.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&minutely_15=temperature_2m,precipitation,cloud_cover&timezone=auto&forecast_days=2`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('High-resolution nowcast unavailable for this location');
  return res.json();
}

// Blends the 15-min high-resolution feed with the multi-model hourly median so the
// near-term chart is both fine-grained AND reflects several independent models.
function buildFineNowcast(fineData, hourlyMultiModel, startIdx){
  const times = hourlyMultiModel.time;
  const temps = modelSeries(hourlyMultiModel, 'temperature_2m');
  const precip = modelSeries(hourlyMultiModel, 'precipitation');
  const clouds = modelSeries(hourlyMultiModel, 'cloud_cover');

  const fTimes = fineData.minutely_15.time;
  const fTemps = fineData.minutely_15.temperature_2m;
  const fPrecip = fineData.minutely_15.precipitation;
  const fClouds = fineData.minutely_15.cloud_cover;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 5*60*60*1000);

  const points = [];
  for(let i=0; i<fTimes.length; i++){
    const t = new Date(fTimes[i]);
    if(t < now || t > windowEnd) continue;

    // find the enclosing hour in the multi-model series to pull its median
    let hourIdx = -1, bestDiff = Infinity;
    for(let j=startIdx; j<times.length; j++){
      const diff = Math.abs(new Date(times[j]) - t);
      if(diff < bestDiff){ bestDiff = diff; hourIdx = j; }
    }
    const hourlyMedianTemp = hourIdx >= 0 ? median(MODELS.map(m => temps[m.key][hourIdx])) : fTemps[i];
    const hourlyMedianCloud = hourIdx >= 0 ? median(MODELS.map(m => clouds[m.key][hourIdx])) : null;
    const agreement = computeAgreement(precip, hourIdx);

    const blendedTemp = fTemps[i] !== null && hourlyMedianTemp !== null
      ? (fTemps[i]*0.6 + hourlyMedianTemp*0.4)
      : (fTemps[i] ?? hourlyMedianTemp);

    // Same idea as temperature: the 15-min feed updates more often and reflects
    // near-term conditions better than a single hourly model consensus that can sit
    // unchanged for hours. Lean on it more heavily for "right now" accuracy.
    const fCloudVal = fClouds ? fClouds[i] : null;
    const blendedCloud = fCloudVal !== null && fCloudVal !== undefined && hourlyMedianCloud !== null
      ? (fCloudVal*0.7 + hourlyMedianCloud*0.3)
      : (fCloudVal ?? hourlyMedianCloud);

    points.push({
      time: fTimes[i],
      temp: blendedTemp,
      cloud: blendedCloud,
      agreement,
      precipMm: fPrecip[i] ?? 0
    });
  }
  return points;
}

// Populated per-location from Open-Meteo's daily sunrise/sunset — real astronomical
// times, not a guessed 6am-6pm window. Falls back to the guess only if unavailable.
let SUN_TIMES = [];

// ===== SVG gauge builders for the Pixel-style widget tiles =====

function svgArc(cx, cy, r, startAngle, endAngle){
  const toXY = (a) => [cx + r*Math.cos(a*Math.PI/180), cy + r*Math.sin(a*Math.PI/180)];
  const [x1,y1] = toXY(startAngle), [x2,y2] = toXY(endAngle);
  const largeArc = (endAngle - startAngle) % 360 > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

function uvGaugeSVG(uv){
  const v = uv === null || uv === undefined ? 0 : Math.max(0, Math.min(11, uv));
  const frac = v/11;
  const angle = -210 + frac*240; // -210deg to +30deg sweep (240deg arc)
  const cx=44, cy=44, r=34;
  const needleX = cx + r*0.75*Math.cos(angle*Math.PI/180);
  const needleY = cy + r*0.75*Math.sin(angle*Math.PI/180);
  return `<svg width="88" height="60" viewBox="0 0 88 60">
    <path d="${svgArc(cx,cy,r,-210,30)}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="7" stroke-linecap="round"/>
    <path d="${svgArc(cx,cy,r,-210,30)}" fill="none" stroke="url(#uvGrad)" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${frac*160} 160"/>
    <circle cx="${needleX}" cy="${needleY}" r="4" fill="#fff"/>
    <defs><linearGradient id="uvGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2ecc71"/><stop offset="40%" stop-color="#f5d742"/>
      <stop offset="70%" stop-color="#ff9f4d"/><stop offset="100%" stop-color="#c05ce0"/>
    </linearGradient></defs>
  </svg>`;
}

function humidityGaugeSVG(pct){
  const v = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const r = 30, circ = 2*Math.PI*r;
  return `<svg width="72" height="72" viewBox="0 0 72 72">
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="7"/>
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="#4da3ff" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${circ}" stroke-dashoffset="${circ*(1-v/100)}" transform="rotate(-90 36 36)"/>
    <text x="36" y="41" text-anchor="middle" font-size="14" font-weight="800" fill="currentColor">${Math.round(v)}%</text>
  </svg>`;
}

function realFeelGaugeSVG(temp){
  const v = temp === null || temp === undefined ? 20 : temp;
  const clamped = Math.max(-10, Math.min(45, v));
  const frac = (clamped+10)/55;
  const angle = -210 + frac*240;
  const cx=44, cy=44, r=34;
  const needleX = cx + r*0.75*Math.cos(angle*Math.PI/180);
  const needleY = cy + r*0.75*Math.sin(angle*Math.PI/180);
  return `<svg width="88" height="60" viewBox="0 0 88 60">
    <path d="${svgArc(cx,cy,r,-210,30)}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="7" stroke-linecap="round"/>
    <path d="${svgArc(cx,cy,r,-210,30)}" fill="none" stroke="url(#feelGrad)" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${frac*160} 160"/>
    <circle cx="${needleX}" cy="${needleY}" r="4" fill="#fff"/>
    <defs><linearGradient id="feelGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4da3ff"/><stop offset="50%" stop-color="#2ecc71"/><stop offset="100%" stop-color="#ff5d5d"/>
    </linearGradient></defs>
  </svg>`;
}

function windCompassSVG(speed, dirDeg){
  const angle = (dirDeg === null || dirDeg === undefined) ? 0 : dirDeg;
  return `<svg width="76" height="76" viewBox="0 0 76 76">
    <circle cx="38" cy="38" r="32" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1.5"/>
    <text x="38" y="12" text-anchor="middle" font-size="8" fill="var(--muted)">N</text>
    <text x="66" y="41" text-anchor="middle" font-size="8" fill="var(--muted)">E</text>
    <text x="38" y="71" text-anchor="middle" font-size="8" fill="var(--muted)">S</text>
    <text x="10" y="41" text-anchor="middle" font-size="8" fill="var(--muted)">W</text>
    <g transform="rotate(${angle} 38 38)">
      <path d="M 38 14 L 33 40 L 38 34 L 43 40 Z" fill="#4da3ff"/>
    </g>
    <circle cx="38" cy="38" r="3" fill="#fff"/>
  </svg>`;
}

function sunArcSVG(sunrise, sunset, now){
  let frac = 0.5;
  if(sunrise && sunset){
    const total = sunset - sunrise;
    frac = total > 0 ? Math.max(0, Math.min(1, (now - sunrise)/total)) : 0.5;
  }
  const cx=44, cy=48, r=34;
  const angle = -180 + frac*180;
  const sunX = cx + r*Math.cos(angle*Math.PI/180);
  const sunY = cy + r*Math.sin(angle*Math.PI/180);
  const isUp = now >= sunrise && now <= sunset;
  return `<svg width="88" height="54" viewBox="0 0 88 54">
    <path d="${svgArc(cx,cy,r,-180,0)}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2" stroke-dasharray="2 4"/>
    ${isUp ? `<circle cx="${sunX}" cy="${sunY}" r="5" fill="#ffb74d"/>` : ''}
  </svg>`;
}

function pressureGaugeSVG(hpa){
  const v = hpa === null || hpa === undefined ? 1013 : hpa;
  const clamped = Math.max(970, Math.min(1050, v));
  const frac = (clamped-970)/80;
  const angle = -210 + frac*240;
  const cx=44, cy=44, r=34;
  const needleX = cx + r*0.75*Math.cos(angle*Math.PI/180);
  const needleY = cy + r*0.75*Math.sin(angle*Math.PI/180);
  return `<svg width="88" height="60" viewBox="0 0 88 60">
    <path d="${svgArc(cx,cy,r,-210,30)}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="7" stroke-linecap="round"/>
    <path d="${svgArc(cx,cy,r,-210,30)}" fill="none" stroke="#4da3ff" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${frac*160} 160"/>
    <circle cx="${needleX}" cy="${needleY}" r="4" fill="#fff"/>
  </svg>`;
}

function isDaytime(date){
  const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
  const entry = SUN_TIMES.find(s => {
    const sd = s.sunrise;
    return sd.getFullYear() === y && sd.getMonth() === m && sd.getDate() === d;
  });
  if(!entry) return date.getHours() >= 6 && date.getHours() < 18; // fallback if data missing
  return date >= entry.sunrise && date < entry.sunset;
}

// Full sky-condition classifier: rain intensity (from real forecast amounts) layered
// with confidence wording ("Chance of..."), falling back to cloud-cover-based sky
// conditions (Sunny/Partly Cloudy/Overcast, day- or night-aware) when there's no
// meaningful rain signal. This replaces the old rain-only labeling.
function conditionLabel(mmPerHour, cloudPct, agreementPct, isDay){
  let rainName = null;
  if(mmPerHour > 4) rainName = 'Heavy Rain';
  else if(mmPerHour > 0.5) rainName = 'Moderate Rain';
  else if(mmPerHour > 0.05) rainName = 'Light Rain';

  if(rainName){
    // ⛈️/🌧️ are neutral (no sun drawn in them), safe for day or night.
    // 🌦️/🌤️ literally have a sun in the glyph, so only use those during the day.
    if(rainName === 'Heavy Rain') return {text:rainName, icon:'⛈️'};
    if(rainName === 'Moderate Rain') return {text:rainName, icon:'🌧️'};
    const lightIcon = isDay ? '🌦️' : '🌧️';
    if(agreementPct === null || agreementPct >= 70) return {text:rainName, icon:lightIcon};
    if(agreementPct >= 35) return {text:`Chance of ${rainName}`, icon:lightIcon};
    return {text:`Slight Chance of ${rainName}`, icon: isDay ? '🌤️' : '☁️'};
  }

  // No rain from the primary signal, but if a real chunk of models still disagree
  // and show rain, say so rather than calling it flatly clear.
  if(agreementPct !== null && agreementPct >= 25){
    return {text:'Chance of Rain', icon: isDay ? '🌦️' : '🌧️'};
  }

  if(cloudPct === null || cloudPct === undefined){
    return isDay ? {text:'Clear', icon:'☀️'} : {text:'Clear Night', icon:'🌙'};
  }
  if(cloudPct < 20) return isDay ? {text:'Sunny', icon:'☀️'} : {text:'Clear Night', icon:'🌙'};
  if(cloudPct < 50) return isDay ? {text:'Partly Cloudy', icon:'🌤️'} : {text:'Partly Cloudy Night', icon:'☁️'};
  if(cloudPct < 80) return isDay ? {text:'Mostly Cloudy', icon:'⛅'} : {text:'Mostly Cloudy Night', icon:'☁️'};
  return {text:'Overcast', icon:'☁️'};
}

function confidenceLine(agreement){
  if(agreement.total === 0) return 'Model agreement data unavailable for this window.';
  const {pct, count, total, names} = agreement;
  if(count === 0) return `${total} of ${total} models forecast no measurable rain here.`;
  const who = names.length ? ` (${names.join(', ')})` : '';
  if(pct >= 70) return `${count} of ${total} models agree${who} — fairly confident.`;
  if(pct >= 30) return `Only ${count} of ${total} models show rain${who} — split, low-to-moderate confidence.`;
  return `Just ${count} of ${total} models show any rain${who} — likely won't actually happen.`;
}

// Groups the 15-min finePoints into hourly quick-view cards. Clicking a card opens the
// detailed 15-min panel and scrolls/opens the matching blocks — progressive disclosure
// instead of dumping every 15-min block in the main view.
// Renders the Pixel-style connected 24h strip: an SVG line tracing temperature across
// the hours, with wind speed and condition icon per column, and the real sunset time
// inserted at its correct chronological position (not just appended at the end).
function renderHourStrip(times, temps, winds, rainPcts, clouds, sunTimes){
  const container = document.getElementById('hourStrip');
  if(!container || !times.length){ if(container) container.innerHTML=''; return; }

  const colWidth = 58;
  const cols = times.map((t, i) => ({
    time: new Date(t), temp: temps[i], wind: winds[i], rain: rainPcts[i], cloud: clouds[i], isSunset:false
  }));

  // Insert a sunset marker column at its real chronological slot, if it falls within this window
  if(sunTimes.length){
    const sunset = sunTimes[0].sunset;
    let insertAt = cols.findIndex(c => c.time > sunset);
    if(insertAt === -1 && sunset > cols[0].time && sunset < new Date(cols[cols.length-1].time.getTime()+3600000)) insertAt = cols.length;
    if(insertAt > 0){
      cols.splice(insertAt, 0, {time: sunset, isSunset:true});
    }
  }

  const validTemps = cols.filter(c=>!c.isSunset).map(c=>c.temp).filter(t=>t!==null && t!==undefined);
  const maxT = Math.max(...validTemps), minT = Math.min(...validTemps);
  const range = (maxT - minT) || 1;

  const lineHeight = 30, lineTop = 4;
  let pathD = '';
  let px = 0;
  const points = [];
  cols.forEach((c, i) => {
    const x = i*colWidth + colWidth/2;
    if(!c.isSunset && c.temp !== null && c.temp !== undefined){
      const y = lineTop + lineHeight - ((c.temp - minT)/range)*lineHeight;
      points.push([x,y]);
    }
  });
  pathD = points.map((p,i) => (i===0?'M':'L') + p[0] + ' ' + p[1]).join(' ');

  const svgWidth = cols.length * colWidth;
  const svg = `<svg class="strip-svg" width="${svgWidth}" height="${lineTop+lineHeight+4}" viewBox="0 0 ${svgWidth} ${lineTop+lineHeight+4}">
    <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
  </svg>`;

  const colsHtml = cols.map(c => {
    if(c.isSunset){
      return `<div class="strip-col sc-sunset">
        <div class="sc-time">Sunset</div>
        <div class="sc-icon">🌇</div>
        <div class="sc-val">${fmtHour(c.time)}</div>
      </div>`;
    }
    const cond = conditionLabel((c.rain ?? 0) > 25 ? 0.6 : 0, c.cloud, c.rain, isDaytime(c.time));
    return `<div class="strip-col">
      <div class="sc-time">${fmtHour(c.time)}</div>
      <div class="sc-val">${c.wind !== null && c.wind !== undefined ? c.wind.toFixed(1)+' km/h' : '--'}</div>
      <div class="sc-icon">${cond.icon}</div>
      <div class="sc-temp">${c.temp !== null && c.temp !== undefined ? c.temp.toFixed(0)+'°' : '--'}</div>
    </div>`;
  }).join('');

  container.innerHTML = svg + colsHtml;
  container.style.position = 'relative';
}

function renderHourCards(finePoints){
  const container = document.getElementById('hourCardsRow');
  if(!finePoints.length){ container.innerHTML = ''; return; }

  const hourGroups = [];
  finePoints.forEach((p, idx) => {
    const d = new Date(p.time);
    const hourKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    let grp = hourGroups.find(g => g.key === hourKey);
    if(!grp){ grp = {key:hourKey, points:[], firstIdx:idx}; hourGroups.push(grp); }
    grp.points.push(p);
  });

  container.innerHTML = hourGroups.map(g => {
    const first = g.points[0];
    const avgTemp = mean(g.points.map(p=>p.temp));
    const maxAgreement = Math.max(...g.points.map(p => p.agreement?.pct ?? 0));
    const avgCloud = mean(g.points.map(p=>p.cloud).filter(c=>c!==null && c!==undefined));
    const mmPerHour = mean(g.points.map(p=>p.precipMm)) * 4;
    const cond = conditionLabel(mmPerHour, avgCloud, maxAgreement, isDaytime(new Date(first.time)));
    return `
      <div class="hour-card" tabindex="0" role="button" aria-label="Show details for ${fmtHour(first.time)}"
        onclick="jumpToHourBlock(${g.firstIdx})" onkeypress="if(event.key==='Enter') jumpToHourBlock(${g.firstIdx})">
        <div class="hc-time">${fmtHour(first.time)}</div>
        <div class="hc-icon">${cond.icon}</div>
        <div class="hc-temp">${avgTemp.toFixed(0)}°</div>
        <div class="hc-rain">${maxAgreement}%</div>
      </div>`;
  }).join('');
}

function toggleDetailsPanel(forceOpen){
  const panel = document.getElementById('detailsPanel');
  const btn = document.getElementById('detailsToggleBtn');
  const shouldOpen = forceOpen !== undefined ? forceOpen : !panel.classList.contains('open');
  panel.classList.toggle('open', shouldOpen);
  btn.setAttribute('aria-expanded', String(shouldOpen));
  btn.textContent = shouldOpen ? 'Hide per-minute breakdown ▴' : 'Show per-minute breakdown ▾';
}

function jumpToHourBlock(idx){
  toggleDetailsPanel(true);
  setTimeout(() => {
    const header = document.getElementById(`mb${idx}-header`);
    if(header){
      if(!header.classList.contains('open')) toggleChunk(`mb${idx}`);
      header.scrollIntoView({behavior:'smooth', block:'center'});
    }
  }, 50);
}

let lastFinePoints = [];

function renderMinuteList(finePoints){
  lastFinePoints = finePoints;
  const container = document.getElementById('minuteList');
  if(!finePoints.length){ container.innerHTML = '<div class="minute-row">No high-resolution data available for this location.</div>'; return; }

  container.innerHTML = finePoints.map((p, idx) => {
    const mmPerHour = p.precipMm * 4;
    const startTime = new Date(p.time);
    const label = conditionLabel(mmPerHour, p.cloud, p.agreement?.pct ?? null, isDaytime(startTime));
    const ag = p.agreement || {pct:null, count:0, total:0, names:[]};

    const endTime = new Date(startTime.getTime() + 15*60*1000);
    const timeLabel = `${fmtHour(startTime)} – ${fmtHour(endTime)}`;
    const confPct = ag.pct !== null ? `${ag.pct}% chance` : '—';
    const blockId = `mb${idx}`;

    const minuteRows = buildMinutesForPoint(finePoints, idx).map(row => {
      const rowLabel = conditionLabel(row.mmPerHour, p.cloud, ag.pct, isDaytime(row.time));
      return `
        <div class="minute-row">
          <div class="m-time">${fmtHour(row.time)}</div>
          <div class="m-icon">${rowLabel.icon}</div>
          <div class="m-desc">${rowLabel.text}</div>
          <div class="m-temp">${row.temp.toFixed(1)}°</div>
        </div>`;
    }).join('');

    return `
      <div class="minute-chunk">
        <div class="chunk-header ${idx===0?'open':''}" id="${blockId}-header" onclick="toggleChunk('${blockId}')">
          <span class="m-time" style="width:auto;">${timeLabel}</span>
          <span class="m-icon">${label.icon}</span>
          <span class="m-desc">${label.text}${ag.pct !== null && ag.count > 0 ? ' · '+confPct+' of rain' : ''}</span>
          <span class="m-temp">${p.temp.toFixed(1)}°</span>
          <span class="chev">▾</span>
        </div>
        <div class="chunk-body ${idx===0?'open':''}" id="${blockId}-body">
          <div class="legend-box" style="margin:8px 12px 0; border-radius:8px;">
            ${confidenceLine(ag)} Cloud cover: ${p.cloud !== null && p.cloud !== undefined ? Math.round(p.cloud)+'%' : '—'} · ${p.precipMm.toFixed(2)} mm this 15-min window.
          </div>
          ${minuteRows}
        </div>
      </div>`;
  }).join('');
}

// Interpolates the real 15-min point down to 15 per-minute rows, blending toward the
// next real data point so temperature trends smoothly rather than jumping. Precipitation
// is spread evenly across the window purely for display — it's the same real total,
// just broken into minutes rather than being a new measurement.
function buildMinutesForPoint(finePoints, idx){
  const p = finePoints[idx];
  const next = finePoints[idx+1];
  const startTime = new Date(p.time);
  const mmPerMinute = p.precipMm / 15;
  const rows = [];
  for(let m=0; m<15; m++){
    const t = new Date(startTime.getTime() + m*60000);
    const frac = m/15;
    const temp = next ? (p.temp + (next.temp - p.temp)*frac) : p.temp;
    rows.push({time:t, temp, mmPerHour: mmPerMinute*60});
  }
  return rows;
}

function toggleChunk(id){
  const body = document.getElementById(`${id}-body`);
  const header = document.getElementById(`${id}-header`);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  header.classList.toggle('open', !isOpen);
}

function fmtHour(iso){
  const d = new Date(iso);
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

// For endpoints using a single blended model (grid points, trip checker) where we only
// have a rain probability, not per-model agreement — same sky-condition logic, simpler input.
function simpleCondition(rainProb, cloudPct, isDay){
  if(rainProb !== null && rainProb !== undefined){
    if(rainProb >= 60) return {text:'Rain Likely', icon:'🌧️'};
    if(rainProb >= 30) return {text:'Chance of Rain', icon: isDay ? '🌦️' : '🌧️'};
  }
  if(cloudPct === null || cloudPct === undefined) return isDay ? {text:'Clear', icon:'☀️'} : {text:'Clear Night', icon:'🌙'};
  if(cloudPct < 20) return isDay ? {text:'Sunny', icon:'☀️'} : {text:'Clear Night', icon:'🌙'};
  if(cloudPct < 50) return isDay ? {text:'Partly Cloudy', icon:'🌤️'} : {text:'Partly Cloudy Night', icon:'☁️'};
  if(cloudPct < 80) return isDay ? {text:'Mostly Cloudy', icon:'⛅'} : {text:'Mostly Cloudy Night', icon:'☁️'};
  return {text:'Overcast', icon:'☁️'};
}

function useMyLocation(){
  if(!navigator.geolocation){
    statusEl.innerHTML = 'Geolocation is not supported by this browser — falling back to network-based location…';
    fallbackToIpLocation();
    return;
  }
  statusEl.style.display = 'block';
  statusEl.textContent = 'Requesting precise browser GPS…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const {latitude:lat, longitude:lon} = pos.coords;
      statusEl.textContent = 'Location found. Fetching forecasts…';
      runForLocation(lat, lon, 'Your location');
    },
    err => {
      console.warn('Browser geolocation failed:', err.message);
      const isFileProtocol = location.protocol === 'file:';
      let reason;
      if(isFileProtocol) reason = 'GPS is blocked on local files (browser rule)';
      else if(err.code === err.TIMEOUT) reason = 'GPS timed out — likely blocked by your network/security software, or location services are off';
      else if(err.code === err.PERMISSION_DENIED) reason = 'location permission was denied';
      else reason = err.message;
      statusEl.textContent = `${reason}. Trying network-based location instead…`;
      fallbackToIpLocation();
    },
    {enableHighAccuracy:true, timeout:12000, maximumAge:0}
  );
}

function fallbackToIpLocation(){
  getIpLocation().then(loc=>{
    statusEl.textContent = `Using approximate location: ${loc.label} (network-based, not exact GPS). Fetching forecasts…`;
    if(map) map.setView([loc.lat, loc.lon], 12);
    runForLocation(loc.lat, loc.lon, loc.label);
  }).catch(()=>{
    statusEl.innerHTML = `<span class="err">Could not detect your location automatically — your network may be blocking these lookups.</span> Please click your exact spot on the map below instead, that always works regardless of network restrictions.`;
  });
}

function useManualCoords(){
  const errEl = document.getElementById('coordsErr');
  const latEl = document.getElementById('manualLat');
  const lonEl = document.getElementById('manualLon');
  if(!errEl || !latEl || !lonEl){
    statusEl.textContent = 'Manual coordinates are not part of this interface. Click the map or search for a place instead.';
    return;
  }
  errEl.textContent = '';
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  if(isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180){
    errEl.textContent = 'Please enter valid numbers (latitude -90 to 90, longitude -180 to 180).';
    return;
  }
  statusEl.style.display = 'block';
  statusEl.textContent = `Using (${lat}, ${lon}). Fetching forecasts…`;
  if(map) map.setView([lat, lon], 13);
  runForLocation(lat, lon, `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
}

let suggestDebounce = null;
let lastSuggestions = [];

function onCityInput(){
  clearTimeout(suggestDebounce);
  const val = document.getElementById('manualCity').value.trim();
  const box = document.getElementById('citySuggestions');
  if(val.length < 3){ box.style.display = 'none'; box.innerHTML = ''; return; }
  suggestDebounce = setTimeout(async () => {
    try{
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(val)}&limit=6&addressdetails=1`;
      const res = await fetch(url, {headers:{'Accept':'application/json'}});
      const j = await res.json();
      if(!j.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
      lastSuggestions = j;
      box.innerHTML = j.map((r,i) => {
        const short = r.display_name.split(',').map(s=>s.trim()).slice(0,3).join(', ');
        return `<div class="suggestion-item" onmousedown="selectSuggestionByIndex(${i})">${short}</div>`;
      }).join('');
      box.style.display = 'block';
    }catch(e){ box.style.display = 'none'; }
  }, 400);
}

function hideSuggestionsDelayed(){
  // slight delay so a click on a suggestion registers before the dropdown disappears
  setTimeout(() => { document.getElementById('citySuggestions').style.display = 'none'; }, 150);
}

function selectSuggestionByIndex(i){
  const r = lastSuggestions[i];
  if(!r) return;
  const label = r.display_name.split(',').map(s=>s.trim()).slice(0,3).join(', ');
  const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
  document.getElementById('manualCity').value = label;
  document.getElementById('citySuggestions').style.display = 'none';
  document.getElementById('citySuggestions').innerHTML = '';
  document.getElementById('manualBox').style.display = 'none';
  statusEl.style.display = 'block';
  statusEl.textContent = `Using ${label}. Fetching forecasts…`;
  if(map) map.setView([lat, lon], 13);
  runForLocation(lat, lon, label);
}

// --- Saved locations (browser localStorage — this device only) ---
function getSavedLocations(){
  try{ return JSON.parse(localStorage.getItem('savedLocations') || '[]'); }
  catch(e){ return []; }
}
function setSavedLocations(arr){
  try{ localStorage.setItem('savedLocations', JSON.stringify(arr)); }
  catch(e){ console.warn('Could not save location:', e.message); }
}
function isDuplicateSaved(arr, lat, lon){
  return arr.some(s => Math.abs(s.lat - lat) < 0.001 && Math.abs(s.lon - lon) < 0.001);
}
function saveLocationToStorage(lat, lon, label){
  const arr = getSavedLocations();
  if(isDuplicateSaved(arr, lat, lon)){ renderSavedLocations(); return; }
  arr.push({lat, lon, label});
  setSavedLocations(arr);
  renderSavedLocations();
}
function savePickedLocation(){
  if(!pickedLoc) return;
  saveLocationToStorage(pickedLoc.lat, pickedLoc.lon, pickedLoc.label);
}
function saveCurrentLocation(){
  if(!CURRENT) return;
  saveLocationToStorage(CURRENT.lat, CURRENT.lon, CURRENT.label);
}
function deleteSavedLocation(idx){
  const arr = getSavedLocations();
  arr.splice(idx, 1);
  setSavedLocations(arr);
  renderSavedLocations();
}
function loadSavedLocation(idx){
  const arr = getSavedLocations();
  const loc = arr[idx];
  if(!loc) return;
  statusEl.style.display = 'block';
  statusEl.textContent = `Using ${loc.label}. Fetching forecasts…`;
  if(map) map.setView([loc.lat, loc.lon], 13);
  runForLocation(loc.lat, loc.lon, loc.label);
}
function renderSavedLocations(){
  const el = document.getElementById('savedLocations');
  const arr = getSavedLocations();
  if(!arr.length){
    el.innerHTML = '<div class="section-sub" style="margin:0;">No saved locations yet — click "Save this location" after picking a spot.</div>';
    return;
  }
  el.innerHTML = arr.map((s,i) => `
    <div class="saved-chip">
      <span class="chip-label" onclick="loadSavedLocation(${i})">📍 ${s.label}</span>
      <button class="chip-del" onclick="deleteSavedLocation(${i})" title="Remove">✕</button>
    </div>
  `).join('');
}

async function searchCity(){
  const val = document.getElementById('manualCity').value.trim();
  const errEl = document.getElementById('manualErr');
  errEl.textContent = '';
  if(!val){ errEl.textContent = 'Please enter a place name.'; return; }
  try{
    const loc = await geocodeCity(val);
    document.getElementById('manualBox').style.display = 'none';
    statusEl.style.display = 'block';
    statusEl.textContent = `Using ${loc.label}. Fetching forecasts…`;
    if(map) map.setView([loc.lat, loc.lon], 13);
    runForLocation(loc.lat, loc.lon, loc.label);
  }catch(e){
    errEl.textContent = e.message;
  }
}

// The map loads immediately on page load (see bottom of script), before any
// weather data, so there's no lag once the user is ready to click a spot.
let mapMode = 'location'; // 'location' = picking your own spot, 'destination' = picking a trip target
let pickedLoc = null;
let youMarker = null, destMarker = null, gridMarkers = [];

// Some networks/proxies/antivirus tools block specific map-tile domains while allowing
// others. We try providers in order and automatically switch if one fails to load tiles.
// All watermark-free, no API key required. Ordered by general reliability.
const TILE_PROVIDERS = [
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {maxZoom:19, attribution:'© OpenStreetMap contributors'}
  },
  {
    url: 'https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png',
    options: {maxZoom:18, attribution:'Wikimedia maps | © OpenStreetMap contributors'}
  },
  {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    options: {maxZoom:16, attribution:'Tiles © Esri — Esri, HERE, Garmin, OpenStreetMap contributors'}
  }
];
let currentTileLayer = null;
let tileProviderIdx = 0;
let tileLoadedOnce = false;
let tileErrorCount = 0;

function tryTileProvider(idx){
  if(idx >= TILE_PROVIDERS.length) return; // exhausted automatic attempts — user can still force-cycle manually
  tileProviderIdx = idx;
  tileLoadedOnce = false;
  tileErrorCount = 0;
  const provider = TILE_PROVIDERS[idx];
  if(currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(provider.url, provider.options).addTo(map);

  currentTileLayer.on('tileload', () => { tileLoadedOnce = true; });
  currentTileLayer.on('tileerror', () => {
    if(tileLoadedOnce) return; // at least one tile got through, this provider basically works
    tileErrorCount++;
    // require several failures (not just one slow tile) before giving up on this provider
    if(tileErrorCount < 4) return;
    setTimeout(()=>{
      if(!tileLoadedOnce && tileProviderIdx === idx){
        console.warn('Map provider blocked or failing, switching:', provider.url);
        tryTileProvider(idx+1);
      }
    }, 3000);
  });
}

function cycleTileProvider(){
  tryTileProvider((tileProviderIdx+1) % TILE_PROVIDERS.length);
}

function initFrontMap(){
  map = L.map('map', {zoomControl:true}).setView([12.8797, 121.7740], 6);
  tryTileProvider(0);
  map.on('click', onMapClick);
  // Soft, non-blocking attempt to center the map near the user via IP — no permission needed.
  getIpLocation().then(loc => map.setView([loc.lat, loc.lon], 11)).catch(()=>{});
}

async function onMapClick(e){
  const {lat, lng:lon} = e.latlng;
  if(mapMode === 'location'){
    if(youMarker) map.removeLayer(youMarker);
    youMarker = L.circleMarker([lat, lon], {radius:8, color:'#4da3ff', fillColor:'#4da3ff', fillOpacity:.9}).addTo(map);
    const panel = document.getElementById('pickedPanel');
    panel.style.display = 'block';
    document.getElementById('pickedName').textContent = 'Loading address…';
    pickedLoc = {lat, lon, label:null};
    const name = await reverseGeocode(lat, lon);
    pickedLoc.label = name;
    document.getElementById('pickedName').innerHTML = `📍 <b>${name}</b> (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
  } else {
    if(destMarker) map.removeLayer(destMarker);
    destMarker = L.marker([lat, lon]).addTo(map).bindPopup('Destination').openPopup();
    const toInput = document.getElementById('tripTo');
    toInput.value = 'Loading…';
    const name = await reverseGeocode(lat, lon);
    toInput.value = name;
    toInput.dataset.lat = lat;
    toInput.dataset.lon = lon;
  }
}

function confirmPickedLocation(){
  if(!pickedLoc) return;
  document.getElementById('pickedPanel').style.display = 'none';
  statusEl.style.display = 'block';
  statusEl.textContent = `Using ${pickedLoc.label}. Fetching forecasts…`;
  runForLocation(pickedLoc.lat, pickedLoc.lon, pickedLoc.label);
}

function reopenLocationPicker(){
  mapMode = 'location';
  document.getElementById('pickedPanel').style.display = 'block';
  document.getElementById('pickedName').textContent = 'Click your spot on the map above.';
  document.getElementById('map').scrollIntoView({behavior:'smooth', block:'center'});
}

// Places "you are here" + the 5km grid on the already-loaded map, then
// switches the map into destination-picking mode for the trip checker.
function attachWeatherMarkers(lat, lon){
  if(youMarker) map.removeLayer(youMarker);
  youMarker = L.circleMarker([lat, lon], {radius:8, color:'#4da3ff', fillColor:'#4da3ff', fillOpacity:.9})
    .addTo(map).bindPopup('You are here');

  gridMarkers.forEach(m => map.removeLayer(m));
  gridMarkers = [];
  const pts = offsetPoints(lat, lon, 5);
  Object.values(pts).forEach(p=>{
    const mk = L.circleMarker([p.lat, p.lon], {radius:5, color:'#2ecc71', fillColor:'#2ecc71', fillOpacity:.8})
      .addTo(map).bindPopup(`${p.dir} (5km)`);
    gridMarkers.push(mk);
  });

  map.setView([lat, lon], 13);
  mapMode = 'destination';
}

let tripSuggestDebounce = {};
let tripLastSuggestions = {};

function onTripInput(which){
  const inputId = which === 'from' ? 'tripFrom' : 'tripTo';
  const boxId = which === 'from' ? 'tripFromSuggestions' : 'tripToSuggestions';
  const input = document.getElementById(inputId);
  // typing invalidates any previously selected exact coordinates from a prior suggestion/map click
  delete input.dataset.lat;
  delete input.dataset.lon;
  clearTimeout(tripSuggestDebounce[which]);
  const val = input.value.trim();
  const box = document.getElementById(boxId);
  if(val.length < 3){ box.style.display = 'none'; box.innerHTML = ''; return; }
  tripSuggestDebounce[which] = setTimeout(async () => {
    try{
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(val)}&limit=6&addressdetails=1`;
      const res = await fetch(url, {headers:{'Accept':'application/json'}});
      const j = await res.json();
      if(!j.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
      tripLastSuggestions[which] = j;
      box.innerHTML = j.map((r,i) => {
        const short = r.display_name.split(',').map(s=>s.trim()).slice(0,3).join(', ');
        return `<div class="suggestion-item" onmousedown="selectTripSuggestion('${which}',${i})">${short}</div>`;
      }).join('');
      box.style.display = 'block';
    }catch(e){ box.style.display = 'none'; }
  }, 400);
}

function hideTripSuggestionsDelayed(which){
  const boxId = which === 'from' ? 'tripFromSuggestions' : 'tripToSuggestions';
  setTimeout(() => { const b = document.getElementById(boxId); if(b) b.style.display = 'none'; }, 150);
}

function selectTripSuggestion(which, i){
  const r = (tripLastSuggestions[which] || [])[i];
  if(!r) return;
  const inputId = which === 'from' ? 'tripFrom' : 'tripTo';
  const boxId = which === 'from' ? 'tripFromSuggestions' : 'tripToSuggestions';
  const label = r.display_name.split(',').map(s=>s.trim()).slice(0,3).join(', ');
  const input = document.getElementById(inputId);
  input.value = label;
  input.dataset.lat = r.lat;
  input.dataset.lon = r.lon;
  document.getElementById(boxId).style.display = 'none';
  document.getElementById(boxId).innerHTML = '';
}

async function checkTrip(){
  const resultEl = document.getElementById('tripResult');
  resultEl.innerHTML = 'Checking…';
  try{
    const fromInput = document.getElementById('tripFrom');
    const fromVal = fromInput.value.trim();
    const toInput = document.getElementById('tripTo');
    const toVal = toInput.value.trim();
    if(!toVal){ resultEl.innerHTML = '<span class="err">Please enter a destination or click the map.</span>'; return; }

    let fromLoc = CURRENT;
    if(fromInput.dataset.lat && fromInput.dataset.lon){
      fromLoc = {lat: parseFloat(fromInput.dataset.lat), lon: parseFloat(fromInput.dataset.lon), label: fromVal};
    } else if(fromVal){
      fromLoc = await geocodeCity(fromVal);
    }

    let toLoc;
    if(toInput.dataset.lat && toInput.dataset.lon){
      toLoc = {lat: parseFloat(toInput.dataset.lat), lon: parseFloat(toInput.dataset.lon), label: toVal};
    } else {
      toLoc = await geocodeCity(toVal);
    }

    const whenHours = parseInt(document.getElementById('tripWhen').value, 10);

    const [fromData, toData] = await Promise.all([
      fetchSimple(fromLoc.lat, fromLoc.lon),
      fetchSimple(toLoc.lat, toLoc.lon)
    ]);

    const fIdx = currentHourIndex(fromData.hourly.time) + whenHours;
    const tIdx = currentHourIndex(toData.hourly.time) + whenHours;

    const fRain = fromData.hourly.precipitation_probability[fIdx] ?? 0;
    const fTemp = fromData.hourly.temperature_2m[fIdx];
    const fCloud = fromData.hourly.cloud_cover ? fromData.hourly.cloud_cover[fIdx] : null;
    const tRain = toData.hourly.precipitation_probability[tIdx] ?? 0;
    const tTemp = toData.hourly.temperature_2m[tIdx];
    const tCloud = toData.hourly.cloud_cover ? toData.hourly.cloud_cover[tIdx] : null;

    const fCond = simpleCondition(fRain, fCloud, isDaytime(new Date(fromData.hourly.time[fIdx])));
    const tCond = simpleCondition(tRain, tCloud, isDaytime(new Date(toData.hourly.time[tIdx])));

    const maxRain = Math.max(fRain, tRain);
    const needUmbrella = maxRain >= 40;
    const riskColor = maxRain >= 60 ? 'var(--bad)' : maxRain >= 30 ? 'var(--warn)' : 'var(--good)';
    const explanation = needUmbrella
      ? `Rain chance hits ${maxRain}% along this route — worth carrying protection.`
      : `Rain chance stays under 40% (${maxRain}% peak) — low risk for this trip.`;

    resultEl.innerHTML = `
      <div class="trip-verdict ${needUmbrella ? 'yes' : 'no'}">
        ${needUmbrella ? '☔ Bring an umbrella' : '🌤️ No umbrella needed'}
        <span style="font-weight:400; font-size:.8rem; color:var(--muted); margin-left:auto;">
          highest rain chance: ${maxRain}%
        </span>
      </div>
      <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${maxRain}%; background:${riskColor};"></div></div>
      <div class="section-sub" style="margin:8px 0 0;">${explanation}</div>
      <div class="trip-detail">
        <div class="trip-point">
          <div class="label">From — ${fromLoc.label || 'Your location'}</div>
          <div style="font-size:1.1rem; margin-top:4px;">${fCond.icon} ${fCond.text}</div>
          <div style="font-size:1.2rem; font-weight:700;">${fTemp?.toFixed(1) ?? '--'}°</div>
        </div>
        <div class="trip-point">
          <div class="label">To — ${toLoc.label || toVal}</div>
          <div style="font-size:1.1rem; margin-top:4px;">${tCond.icon} ${tCond.text}</div>
          <div style="font-size:1.2rem; font-weight:700;">${tTemp?.toFixed(1) ?? '--'}°</div>
        </div>
      </div>
    `;
  }catch(e){
    resultEl.innerHTML = `<span class="err">${e.message}</span>`;
  }
}

// Nearby-direction micro-grid: fetches independently of the main forecast so a failure
// here can't cascade and take down the rest of the page. Shows a shimmer while loading
// and a clear retry state (instead of hanging on "Loading…") if the fetch fails.
async function loadMicroGrid(lat, lon){
  const gridEl = document.getElementById('gridPoints');
  gridEl.innerHTML = Array(4).fill('<div class="mini"><span class="skeleton">Loading direction</span></div>').join('');
  try{
    const pts = offsetPoints(lat, lon, 5);
    const dirs = Object.keys(pts);
    const results = await Promise.all(dirs.map(d => fetchSimple(pts[d].lat, pts[d].lon)));
    gridEl.innerHTML = dirs.map((d,i) => {
      const r = results[i];
      const idx = currentHourIndex(r.hourly.time);
      const t = r.hourly.temperature_2m[idx];
      const p = r.hourly.precipitation_probability[idx];
      const c = r.hourly.cloud_cover ? r.hourly.cloud_cover[idx] : null;
      const cond = simpleCondition(p, c, isDaytime(new Date(r.hourly.time[idx])));
      return `<div class="mini"><div class="dir">${pts[d].dir}</div><div style="font-size:1.1rem; margin:2px 0;">${cond.icon}</div><div class="t">${t?.toFixed(1) ?? '--'}°</div><div class="p" style="font-size:.66rem;">${cond.text}</div></div>`;
    }).join('');
  }catch(e){
    gridEl.innerHTML = `<div class="mini-error"><span>Nearby conditions unavailable right now.</span><button class="text-btn" onclick="loadMicroGrid(${lat}, ${lon})">Retry</button></div>`;
  }
}

// 5-day overview: same independent-fetch pattern as loadMicroGrid above.
function loadFiveDay(lat, lon){
  const el = document.getElementById('fiveDayList');
  el.innerHTML = '<div class="day-row"><span class="skeleton">Loading the 5-day outlook</span></div>';
  fetchFiveDayOverview(lat, lon).then(fd => {
    const days = fd.daily.time;
    const rows = days.map((d, i) => {
      const dt = new Date(d);
      const dayLabel = i === 0 ? 'Today' : dt.toLocaleDateString(undefined, {weekday:'short'});
      const hi = fd.daily.temperature_2m_max[i];
      const lo = fd.daily.temperature_2m_min[i];
      const rain = fd.daily.precipitation_probability_max[i];
      const icon = rain >= 50 ? '🌧️' : rain >= 20 ? '🌦️' : '☀️';
      const allHi = Math.max(...fd.daily.temperature_2m_max);
      const allLo = Math.min(...fd.daily.temperature_2m_min);
      const range = allHi - allLo || 1;
      const leftPct = ((lo - allLo) / range) * 100;
      const widthPct = ((hi - lo) / range) * 100;
      return `<div class="day-row">
        <div class="day-name">${dayLabel}</div>
        <div class="day-icon">${icon}</div>
        <div class="day-rain">${rain ?? 0}%</div>
        <div class="day-bar-wrap">
          <div class="day-lo">${lo?.toFixed(0) ?? '--'}°</div>
          <div class="day-bar-track"><div class="day-bar-fill" style="left:${leftPct}%; width:${widthPct}%;"></div></div>
          <div class="day-hi">${hi?.toFixed(0) ?? '--'}°</div>
        </div>
      </div>`;
    }).join('');
    el.innerHTML = rows;
  }).catch(()=>{
    el.innerHTML = `<div class="mini-error"><span>5-day forecast unavailable right now.</span><button class="text-btn" onclick="loadFiveDay(${lat}, ${lon})">Retry</button></div>`;
  });
}

async function runForLocation(lat, lon, label){
  CURRENT = {lat, lon, label};
  showLoadingSkeleton();
  try{
    const data = await fetchMultiModel(lat, lon);
    const hourly = data.hourly;
    if(data.daily && data.daily.sunrise && data.daily.sunset){
      SUN_TIMES = data.daily.time.map((t, i) => ({
        sunrise: new Date(data.daily.sunrise[i]),
        sunset: new Date(data.daily.sunset[i])
      }));
    } else {
      SUN_TIMES = [];
    }
    const startIdx = currentHourIndex(hourly.time);

    const temps = modelSeries(hourly, 'temperature_2m');
    const precip = modelSeries(hourly, 'precipitation');
    const winds = modelSeries(hourly, 'wind_speed_10m');
    const clouds = modelSeries(hourly, 'cloud_cover');
    const feelsLikeSeries = modelSeries(hourly, 'apparent_temperature');
    const humiditySeries = modelSeries(hourly, 'relative_humidity_2m');
    const windDirSeries = modelSeries(hourly, 'wind_direction_10m');
    const pressureSeries = modelSeries(hourly, 'pressure_msl');
    const uvSeries = modelSeries(hourly, 'uv_index');

    const curTemps = MODELS.map(m => temps[m.key][startIdx]);
    const curPrecip = MODELS.map(m => precip[m.key][startIdx]);
    const curWinds = MODELS.map(m => winds[m.key][startIdx]);
    const curClouds = MODELS.map(m => clouds[m.key][startIdx]);
    const curFeels = MODELS.map(m => feelsLikeSeries[m.key][startIdx]);
    const curHumidity = MODELS.map(m => humiditySeries[m.key][startIdx]);
    const curWindDir = MODELS.map(m => windDirSeries[m.key][startIdx]);
    const curPressure = MODELS.map(m => pressureSeries[m.key][startIdx]);
    const curUV = MODELS.map(m => uvSeries[m.key][startIdx]);

    const consensusTemp = median(curTemps);
    const consensusRain = precipAgreementPct(curPrecip);
    const consensusWind = median(curWinds);
    const consensusCloud = median(curClouds);
    const consensusPrecipAmt = median(curPrecip);
    const consensusFeels = median(curFeels);
    const consensusHumidity = median(curHumidity);
    const consensusWindDir = median(curWindDir);
    const consensusPressure = median(curPressure);
    const consensusUV = median(curUV);
    const spread = stddev(curTemps);

    const nowCondition = conditionLabel(consensusPrecipAmt ?? 0, consensusCloud, consensusRain, isDaytime(new Date(hourly.time[startIdx])));

    document.getElementById('heroTemp').textContent = `${consensusTemp?.toFixed(0) ?? '--'}°`;
    document.getElementById('heroCondition').textContent = `${nowCondition.icon} ${nowCondition.text}`;
    document.getElementById('heroRain').textContent = `${consensusRain?.toFixed(0) ?? '--'}%`;
    document.getElementById('heroWind').textContent = `${consensusWind?.toFixed(1) ?? '--'} km/h`;
    document.getElementById('heroFeels').textContent = `${consensusFeels?.toFixed(0) ?? '--'}°`;
    document.getElementById('heroHumidity').textContent = `${consensusHumidity?.toFixed(0) ?? '--'}%`;
    document.getElementById('heroCloud').textContent = `${consensusCloud?.toFixed(0) ?? '--'}%`;
    document.getElementById('heroPlace').textContent = `${label}`;
    document.getElementById('weatherIconOrbit').textContent = nowCondition.icon;

    // Update widgets that exist in the SkyPulse redesign.
    // The older UI had separate humidity/feels-like/wind/sun gauge containers;
    // the redesigned hero presents those values directly, so do not reference
    // elements that are no longer part of the page.
    document.getElementById('uvValue').textContent = consensusUV !== null ? consensusUV.toFixed(1) : '--';
    document.getElementById('uvGauge').innerHTML = uvGaugeSVG(consensusUV);
    document.getElementById('pressureValue').textContent = consensusPressure !== null ? `${consensusPressure.toFixed(0)} mb` : '-- mb';
    document.getElementById('pressureGauge').innerHTML = pressureGaugeSVG(consensusPressure);

    // Weather-reactive background
    document.body.className = nowCondition.text.includes('Rain') || nowCondition.text.includes('Chance')
      ? 'wx-rain'
      : (consensusCloud !== null && consensusCloud >= 50 ? 'wx-cloudy' : (isDaytime(new Date(hourly.time[startIdx])) ? 'wx-clear-day' : 'wx-clear-night'));

    if(SUN_TIMES.length){
      document.getElementById('heroSun').innerHTML = `🌅 Sunrise ${fmtHour(SUN_TIMES[0].sunrise)} &nbsp;·&nbsp; 🌇 Sunset ${fmtHour(SUN_TIMES[0].sunset)}`;
    } else {
      document.getElementById('heroSun').textContent = 'Sunrise/sunset unavailable for this location';
    }

    // Air quality (separate free API) — best effort, degrades quietly if unreachable
    fetchAirQuality(lat, lon).then(aq => {
      const idx = currentHourIndex(aq.hourly.time);
      const pm = aq.hourly.pm2_5[idx];
      if(pm === null || pm === undefined) return;
      const aqi = pm25ToAQI(pm);
      const cat = aqiCategory(aqi);
      document.getElementById('aqiChip').innerHTML = `🍃 AQI ${aqi} · <span style="color:${cat.color};">${cat.label}</span>`;
    }).catch(()=>{ document.getElementById('aqiChip').textContent = '🍃 AQI unavailable'; });

    // 5-day forecast — separate lightweight fetch, isolated so a failure here can't
    // cascade and take down the rest of the page (see loadFiveDay above)
    loadFiveDay(lat, lon);

    document.getElementById('modelLegend').innerHTML =
      `Models in this forecast: <b>${MODELS.map(m=>m.name).join(', ')}</b> — temperature/wind/cloud consensus is the median across all of them. Rain chance = % of these models forecasting measurable rain (not a borrowed probability field, since that's not reliably defined per individual model).`;

    const confBadge = document.getElementById('confBadge');
    if(spread < 1.5){ confBadge.className = 'badge high'; confBadge.textContent = 'High Confidence'; }
    else if(spread > 3.5){ confBadge.className = 'badge low'; confBadge.textContent = 'Model Divergence'; }
    else { confBadge.className = 'badge mid'; confBadge.textContent = 'Moderate Confidence'; }

    // Model consensus is represented by the redesigned forecast chart and
    // weather-intelligence sections below. Keep the rain-model calculation here
    // for the chart/insight logic, but do not write to legacy UI containers.
    const rainingModels = MODELS.map((m,i) => ({m, raining: curPrecip[i] !== null && curPrecip[i] !== undefined && curPrecip[i] > 0.1}));
    const rainCount = rainingModels.filter(r=>r.raining).length;

    // Weather Intelligence — plain-language takeaways from the real data above
    const insights = [];
    if(consensusRain !== null && consensusRain >= 50){
      insights.push({icon:'☔', text:`Umbrella recommended — ${consensusRain}% of models agree it'll rain soon.`});
    } else if(consensusRain !== null && consensusRain >= 20){
      insights.push({icon:'🌂', text:`Maybe bring an umbrella — only ${consensusRain}% of models show rain, so it's a coin flip.`});
    } else {
      insights.push({icon:'🌤️', text:'Low rain signal right now — good conditions for being outdoors.'});
    }
    if(spread >= 3.5){
      insights.push({icon:'⚠️', text:`Forecast confidence is low right now — the 6 models disagree on temperature by ${spread.toFixed(1)}°, so treat details loosely.`});
    } else if(spread < 1.5){
      insights.push({icon:'✅', text:'Models are in close agreement right now — this forecast is fairly reliable.'});
    }
    if(consensusWind !== null && consensusWind >= 30){
      insights.push({icon:'💨', text:`Winds are running ${consensusWind.toFixed(0)} km/h — secure loose items and expect rougher conditions if travelling.`});
    } else if(consensusWind !== null){
      insights.push({icon:'🚗', text:'Wind conditions look mild — fine for travel or outdoor plans.'});
    }
    // Check if rain risk climbs later in the day (next 6 hours) for a "rain risk increases after X" style note
    const laterIdx = Math.min(startIdx + 6, hourly.time.length - 1);
    if(laterIdx > startIdx){
      const laterRain = precipAgreementPct(MODELS.map(m => precip[m.key][laterIdx]));
      if(laterRain !== null && consensusRain !== null && laterRain - consensusRain >= 25){
        insights.push({icon:'📈', text:`Rain risk increases later — model agreement climbs to ${laterRain}% around ${fmtHour(hourly.time[laterIdx])}.`});
      }
    }
    document.getElementById('insightList').innerHTML = insights.map(i => `
      <div class="insight-item"><span class="ii-icon">${i.icon}</span><span class="ii-text">${i.text}</span></div>
    `).join('');

    const fineData = await fetchFineResolution(lat, lon);
    const finePoints = buildFineNowcast(fineData, hourly, startIdx);
    renderMinuteList(finePoints);
    renderHourCards(finePoints);

    loadMicroGrid(lat, lon);

    attachWeatherMarkers(lat, lon);
    document.getElementById('tripFrom').placeholder = `Defaults to ${label}`;

    const chartLabels = hourly.time.slice(startIdx, startIdx+24).map(fmtHour);
    const chartDatasets = MODELS.map(m => ({
      label: m.name,
      data: temps[m.key].slice(startIdx, startIdx+24),
      borderColor: m.color,
      tension:.3, pointRadius:0, borderWidth:1.4
    }));
    const consensusData = chartLabels.map((_,i) => median(MODELS.map(m => temps[m.key][startIdx+i])));
    const rainConsensusData = chartLabels.map((_,i) => precipAgreementPct(MODELS.map(m => precip[m.key][startIdx+i])));
    const cloudConsensusData = chartLabels.map((_,i) => median(MODELS.map(m => clouds[m.key][startIdx+i])));
    const precipAmtData = chartLabels.map((_,i) => median(MODELS.map(m => precip[m.key][startIdx+i])));
    chartDatasets.push({label:'Consensus', data:consensusData, borderColor:'#ffffff', borderWidth:3, tension:.3, pointRadius:0});

    // Connected-line hourly strip (temperature line, wind speed per hour, sunset marked)
    const windData = chartLabels.map((_,i) => median(MODELS.map(m => winds[m.key][startIdx+i])));
    renderHourStrip(hourly.time.slice(startIdx, startIdx+24), consensusData, windData, rainConsensusData, cloudConsensusData, SUN_TIMES);

    if(window.mainChartInstance) window.mainChartInstance.destroy();
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? '#dbe3f0' : '#22304d';
    const tickColor = isLight ? '#5b6b8c' : '#8fa0c2';
    window.mainChartInstance = new Chart(document.getElementById('chart'), {
      type: 'line',
      data: { labels: chartLabels, datasets: chartDatasets },
      options: {
        animation:false,
        interaction:{mode:'index', intersect:false},
        plugins:{
          legend:{display:false},
          tooltip:{
            backgroundColor: isLight ? '#ffffff' : '#131d33',
            titleColor: isLight ? '#101828' : '#eef2fb',
            bodyColor: isLight ? '#101828' : '#eef2fb',
            borderColor: gridColor, borderWidth:1, padding:10, cornerRadius:8,
            callbacks:{ label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}°C` }
          }
        },
        scales:{
          x:{ticks:{color:tickColor, maxTicksLimit:10}, grid:{color:gridColor}},
          y:{ticks:{color:tickColor, callback:(v)=>v+'°'}, grid:{color:gridColor}}
        }
      }
    });
    document.getElementById('chartLegend').innerHTML = chartDatasets.map(d =>
      `<span><span class="dot" style="background:${d.borderColor}"></span>${d.label}</span>`
    ).join('');

    statusEl.style.display = 'none';
    document.getElementById('app').style.display = 'block';
    lastUpdatedAt = Date.now();
    updateLastUpdatedLabel();
  }catch(err){
    console.error(err);
    statusEl.style.display = 'block';
    statusEl.innerHTML = `
      <div class="error-card" role="alert">
        <div class="ec-icon">⚠️</div>
        <div class="ec-title">Unable to load weather data</div>
        <div class="ec-detail">Check your connection and try again. (${err.message})</div>
        <button onclick="runForLocation(${lat}, ${lon}, ${JSON.stringify(label)})">Retry</button>
      </div>`;
  }
}

// Shows shimmering skeleton placeholders in the hero while a fetch is in flight, so the
// page never just sits on static "--" placeholders.
function showLoadingSkeleton(){
  document.getElementById('app').style.display = 'block';
  document.getElementById('heroTemp').innerHTML = '<span class="skeleton">--°</span>';
  document.getElementById('heroCondition').innerHTML = '<span class="skeleton">Loading condition</span>';
  document.getElementById('heroPlace').innerHTML = '<span class="skeleton">Loading location details</span>';
  document.getElementById('heroRain').innerHTML = '<span class="skeleton">--%</span>';
  document.getElementById('heroHumidity').innerHTML = '<span class="skeleton">--%</span>';
  document.getElementById('heroWind').innerHTML = '<span class="skeleton">-- km/h</span>';
  document.getElementById('heroCloud').innerHTML = '<span class="skeleton">--%</span>';
  document.getElementById('uvValue').innerHTML = '<span class="skeleton">--</span>';
  document.getElementById('pressureValue').innerHTML = '<span class="skeleton">-- mb</span>';
  document.getElementById('uvGauge').innerHTML = '<div class="skeleton-gauge"></div>';
  document.getElementById('pressureGauge').innerHTML = '<div class="skeleton-gauge"></div>';
  const lastUpdatedEl = document.getElementById('lastUpdated');
  if(lastUpdatedEl) lastUpdatedEl.textContent = '';
  document.getElementById('hourCardsRow').innerHTML = Array(5).fill(0).map(()=>`
    <div class="hour-card"><div class="hc-time skeleton">--</div><div class="hc-icon skeleton">--</div><div class="hc-temp skeleton">--°</div></div>
  `).join('');
}

// Load the map right away so it's ready with no lag by the time the user wants to click.
// --- Typhoon Tracker tab ---
let typhoonInitialized = false;

function switchTab(tab){
  document.getElementById('forecastTab').style.display = tab === 'forecast' ? 'block' : 'none';
  document.getElementById('toolsTab').style.display = tab === 'tools' ? 'block' : 'none';
  document.getElementById('typhoonTab').style.display = tab === 'typhoon' ? 'block' : 'none';
  document.getElementById('tabForecastBtn').classList.toggle('tab-active', tab === 'forecast');
  document.getElementById('tabToolsBtn').classList.toggle('tab-active', tab === 'tools');
  document.getElementById('tabTyphoonBtn').classList.toggle('tab-active', tab === 'typhoon');
  if(tab === 'typhoon' && !typhoonInitialized){
    typhoonInitialized = true;
    initTyphoonTab();
  }
}

function getTyphoonView(){
  try{ return JSON.parse(localStorage.getItem('typhoonView')); }
  catch(e){ return null; }
}
function setTyphoonView(v){
  try{ localStorage.setItem('typhoonView', JSON.stringify(v)); }
  catch(e){ console.warn('Could not save typhoon view:', e.message); }
}

function loadTyphoonMap(lat, lon, zoom){
  const iframe = document.getElementById('typhoonFrame');
  iframe.src = `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}` +
    `&width=650&height=480&zoom=${zoom}&level=surface&overlay=wind&product=ecmwf&menu=&message=true` +
    `&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=-1`;
}

function initTyphoonTab(){
  const saved = getTyphoonView();
  const fallback = CURRENT ? {lat:CURRENT.lat, lon:CURRENT.lon, zoom:7} : {lat:12.8797, lon:130.0, zoom:5};
  const view = saved || fallback;
  document.getElementById('typhoonLat').value = view.lat;
  document.getElementById('typhoonLon').value = view.lon;
  document.getElementById('typhoonZoom').value = view.zoom;
  loadTyphoonMap(view.lat, view.lon, view.zoom);
  loadActiveTyphoons();
}

function saveTyphoonView(){
  const lat = parseFloat(document.getElementById('typhoonLat').value);
  const lon = parseFloat(document.getElementById('typhoonLon').value);
  const zoom = parseInt(document.getElementById('typhoonZoom').value, 10) || 6;
  if(isNaN(lat) || isNaN(lon)) return;
  setTyphoonView({lat, lon, zoom});
  loadTyphoonMap(lat, lon, zoom);
}

function centerTyphoonOnMyLocation(){
  if(!CURRENT){
    alert('Load a forecast location on the Forecast tab first.');
    return;
  }
  document.getElementById('typhoonLat').value = CURRENT.lat;
  document.getElementById('typhoonLon').value = CURRENT.lon;
  document.getElementById('typhoonZoom').value = 7;
  saveTyphoonView();
}

// Best-effort: GDACS publishes a free global disaster feed including active tropical
// cyclones. If it's unreachable (network/CORS on a given host) this fails gracefully —
// the Windy map above still shows any active storm visually either way.
function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Best-effort extraction of a cyclone's current position from whatever shape GDACS
// gives us — a Point geometry, a LineString/Polygon track (first coordinate as an
// approximation), or explicit lat/lon properties.
function extractStormLatLon(f){
  const p = f.properties || {};
  if(p.latitude !== undefined && p.longitude !== undefined) return {lat: p.latitude, lon: p.longitude};
  const g = f.geometry;
  if(!g || !g.coordinates) return null;
  if(g.type === 'Point') return {lat: g.coordinates[1], lon: g.coordinates[0]};
  // LineString/Polygon: coordinates are [lon,lat] pairs, possibly nested — dig to the first pair
  let c = g.coordinates;
  while(Array.isArray(c) && Array.isArray(c[0]) && typeof c[0][0] !== 'number') c = c[0];
  if(Array.isArray(c) && typeof c[0]?.[0] === 'number') return {lat: c[0][1], lon: c[0][0]};
  return null;
}

async function loadActiveTyphoons(){
  const el = document.getElementById('typhoonList');
  const statusCard = document.getElementById('typhoonStatusCard');
  el.innerHTML = 'Checking for active tropical cyclones…';
  try{
    const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventtypes=TC';
    const res = await fetch(url);
    if(!res.ok) throw new Error('feed unavailable');
    const j = await res.json();
    const allFeats = j.features || [];
    // The API's own eventtypes= query param isn't reliably restrictive on its own
    // (it was letting other disaster types like floods through) — filter client-side
    // to be certain only actual tropical cyclones show up here.
    let feats = allFeats.filter(f => (f.properties?.eventtype || '').toUpperCase() === 'TC');

    if(!feats.length){
      el.innerHTML = 'No active tropical cyclone alerts from GDACS right now.';
      statusCard.className = 'status-card';
      statusCard.innerHTML = `<div class="status-dot" style="background:var(--good);"></div>
        <div><div style="font-weight:800;">🟢 No active tropical cyclone reported</div>
        <div style="color:var(--muted); font-size:.8rem;">Based on GDACS's global feed — always confirm with PAGASA for local warnings.</div></div>`;
      return;
    }

    // Attach distance-from-you to every storm when we know your location, so "is this
    // even near me?" has a real answer instead of just a global severity ranking.
    const refLoc = CURRENT; // the location loaded on the Forecast tab
    feats = feats.map(f => {
      const pos = extractStormLatLon(f);
      const distanceKm = (pos && refLoc) ? haversineKm(refLoc.lat, refLoc.lon, pos.lat, pos.lon) : null;
      return {...f, __pos: pos, __distanceKm: distanceKm};
    });

    if(refLoc){
      feats.sort((a,b) => (a.__distanceKm ?? Infinity) - (b.__distanceKm ?? Infinity));
    }

    const headline = refLoc ? feats[0] : feats.reduce((w,f) => {
      const lvl = (f.properties?.alertlevel || 'Green').toLowerCase();
      const rank = {red:3, orange:2, green:1};
      return (rank[lvl]||0) > (rank[(w.properties?.alertlevel||'Green').toLowerCase()]||0) ? f : w;
    }, feats[0]);

    const hLevel = (headline.properties?.alertlevel || 'Green');
    const hName = headline.properties?.name || headline.properties?.eventname || 'Tropical cyclone tracked';
    const isSevere = hLevel.toLowerCase() !== 'green';
    const distText = headline.__distanceKm !== null
      ? `~${Math.round(headline.__distanceKm).toLocaleString()} km from your location`
      : (refLoc ? 'Distance unavailable for this system' : 'Load a location on the Forecast tab to see distance');

    statusCard.className = isSevere ? 'status-card alert' : 'status-card';
    statusCard.innerHTML = `<div class="status-dot" style="background:${isSevere?'var(--bad)':'var(--good)'};"></div>
      <div><div style="font-weight:800;">${isSevere?'🔴':'🟢'} ${hName}${refLoc ? ' — Nearest to you' : ''}</div>
      <div style="color:var(--muted); font-size:.8rem;">${hLevel} alert level · ${distText} · ${feats.length} tropical cyclone${feats.length>1?'s':''} tracked globally</div></div>`;

    // Best-effort date range and track/report link — GDACS's field names vary by
    // event, so everything here is read defensively and simply omitted if absent
    // rather than guessed or fabricated.
    el.innerHTML = feats.slice(0, 6).map(f => {
      const p = f.properties || {};
      const level = (p.alertlevel || 'Green');
      const dotColor = level.toLowerCase() === 'red' ? 'var(--bad)' : level.toLowerCase() === 'orange' ? 'var(--warn)' : 'var(--good)';
      const name = p.name || p.eventname || 'Unnamed system';

      const fromDate = p.fromdate ? new Date(p.fromdate) : null;
      const toDate = p.todate ? new Date(p.todate) : null;
      const dateFmt = (d) => d ? d.toLocaleDateString(undefined, {month:'short', day:'numeric'}) : null;
      let dateRangeText = '';
      if(fromDate && toDate) dateRangeText = `Tracked ${dateFmt(fromDate)} – ${dateFmt(toDate)}`;
      else if(fromDate) dateRangeText = `Tracked since ${dateFmt(fromDate)}`;

      const country = p.country || p.iso3 || '';
      const reportUrl = p.url?.report || p.url?.details || p.url?.geometry || null;
      const distLabel = f.__distanceKm !== null ? `📍 ~${Math.round(f.__distanceKm).toLocaleString()} km from you` : '';

      return `<div style="padding:8px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="dot" style="background:${dotColor};"></span>
          <span style="font-weight:600;">🌀 ${name}</span>
          <span style="color:var(--muted); margin-left:auto; font-size:.78rem;">${level} alert</span>
        </div>
        <div style="color:var(--muted); font-size:.75rem; margin-top:3px; margin-left:17px;">
          ${distLabel}${dateRangeText ? (distLabel?' · ':'')+dateRangeText : ''}${country ? ' · Affecting: ' + country : ''}
          ${reportUrl ? `<br><a href="${reportUrl}" target="_blank" rel="noopener" style="color:var(--accent);">View full track &amp; forecast on GDACS →</a>` : ''}
        </div>
      </div>`;
    }).join('');
  }catch(e){
    el.innerHTML = 'Live typhoon list unavailable right now (network restrictions vary by device) — the map above still shows any active storm directly, or check PAGASA below.';
    statusCard.className = 'status-card';
    statusCard.innerHTML = `<div class="status-dot" style="background:var(--muted);"></div>
      <div><div style="font-weight:800;">Status unavailable</div>
      <div style="color:var(--muted); font-size:.8rem;">Live feed unreachable on this network — check the map above or PAGASA directly.</div></div>`;
  }
}

initFrontMap();
renderSavedLocations();