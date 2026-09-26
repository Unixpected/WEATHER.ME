// Escapes text pulled from external APIs (Nominatim place names, GDACS storm names,
// etc.) before it's interpolated into innerHTML. These values aren't typed by the
// user, but they originate outside our control and some of them get persisted to
// localStorage and re-rendered on every load, so treat them as untrusted.
function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

// Only allow http(s) links through to href attributes — blocks javascript: and other
// dangerous schemes sneaking in via an external feed (e.g. GDACS report links).
function safeHref(url){
  if(!url) return null;
  try{
    const u = new URL(url, window.location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  }catch(e){ return null; }
}

const statusEl = document.getElementById('status');
let CURRENT = null; // {lat, lon, label}
let map = null;
let lastUpdatedAt = null;

// --- Plain-language "what to wear" one-liner, built from the same consensus
// numbers already driving the hero and insights — no extra fetch needed. ---
function wearAdvice(temp, rain, wind){
  const parts = [];
  if(rain !== null && rain !== undefined){
    if(rain >= 50) parts.push('bring an umbrella');
    else if(rain >= 20) parts.push('pack a small umbrella just in case');
  }
  if(temp !== null && temp !== undefined){
    if(temp >= 32) parts.push('light, breathable clothing');
    else if(temp >= 26) parts.push('light clothing');
    else if(temp >= 20) parts.push('a light layer');
    else parts.push('a jacket');
  }
  if(wind !== null && wind !== undefined && wind >= 30) parts.push('something windproof');
  if(!parts.length) return 'Dress comfortably — nothing extreme in the forecast.';
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

// --- Offline / last-known-conditions cache. Stores just the small set of
// numbers the hero needs, so a failed fetch can still show something real
// instead of a bare error card. ---
const FORECAST_CACHE_KEY = 'skypulse_lastForecast';
function cacheForecastSnapshot(snap){
  try{ localStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify(snap)); }catch(e){}
}
function loadForecastCache(){
  try{ return JSON.parse(localStorage.getItem(FORECAST_CACHE_KEY) || 'null'); }catch(e){ return null; }
}
function renderStaleForecast(cache, lat, lon, label, err){
  document.getElementById('heroTemp').textContent = `${cache.temp?.toFixed?.(0) ?? '--'}°`;
  document.getElementById('heroCondition').textContent = `${cache.conditionIcon ?? ''} ${cache.conditionText ?? ''}`.trim();
  document.getElementById('heroRain').textContent = `${cache.rain?.toFixed?.(0) ?? '--'}%`;
  document.getElementById('heroWind').textContent = `${cache.wind?.toFixed?.(1) ?? '--'} km/h`;
  document.getElementById('heroFeels').textContent = `${cache.feels?.toFixed?.(0) ?? '--'}°`;
  document.getElementById('heroHumidity').textContent = `${cache.humidity?.toFixed?.(0) ?? '--'}%`;
  document.getElementById('heroCloud').textContent = `${cache.cloud?.toFixed?.(0) ?? '--'}%`;
  document.getElementById('heroPlace').textContent = cache.label || label || '—';
  document.getElementById('wearAdvice').textContent = `👕 ${wearAdvice(cache.temp, cache.rain, cache.wind)}`;

  const mins = Math.max(0, Math.round((Date.now() - (cache.savedAt || Date.now())) / 60000));
  const ageText = mins < 1 ? 'just now' : (mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`);
  const staleBanner = document.getElementById('staleBanner');
  if(staleBanner){
    staleBanner.style.display = 'flex';
    staleBanner.innerHTML = `
      <span>⚠️ Last known conditions from ${ageText} (stale) — couldn't reach the forecast server (${escapeHtml(err?.message || 'network error')}).</span>
      <button type="button" id="staleRetryBtn" class="text-btn">Try again</button>
    `;
    const retryBtn = document.getElementById('staleRetryBtn');
    if(retryBtn) retryBtn.addEventListener('click', () => runForLocation(lat, lon, label));
  }
  statusEl.style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

// --- Auto-refresh: quietly re-fetch the current location every ~12 minutes
// while the tab is actually visible, so "Updated Xm ago" doesn't just sit
// there stale. Only one interval is ever scheduled. ---
let autoRefreshTimer = null;
function scheduleAutoRefresh(){
  if(autoRefreshTimer) return;
  autoRefreshTimer = setInterval(() => {
    if(!CURRENT || document.visibilityState !== 'visible') return;
    runForLocation(CURRENT.lat, CURRENT.lon, CURRENT.label);
  }, 12*60*1000);
}

// --- Rain alert notifications: uses the existing 15-min nowcast (finePoints)
// to warn the user shortly before rain is expected to start, instead of
// making them check the app. Opt-in via the bell button in the topbar. ---
function isRainAlertEnabled(){
  try{ return localStorage.getItem('rainAlertsEnabled') === '1'; }catch(e){ return false; }
}
function updateRainAlertBtn(){
  const btn = document.getElementById('rainAlertBtn');
  if(!btn) return;
  const on = isRainAlertEnabled() && 'Notification' in window && Notification.permission === 'granted';
  btn.classList.toggle('theme-active', on);
  btn.textContent = on ? '🔔' : '🔕';
  btn.title = on ? 'Rain alerts on — tap to turn off' : 'Get notified before it rains';
}
async function toggleRainAlerts(){
  if(!('Notification' in window)){
    alert('Notifications aren\'t supported in this browser.');
    return;
  }
  if(isRainAlertEnabled()){
    try{ localStorage.setItem('rainAlertsEnabled', '0'); }catch(e){}
    updateRainAlertBtn();
    return;
  }
  let perm = Notification.permission;
  if(perm === 'default'){ perm = await Notification.requestPermission(); }
  if(perm !== 'granted'){
    alert('Notifications are blocked for this site — enable them in your browser settings to get rain alerts.');
    updateRainAlertBtn();
    return;
  }
  try{ localStorage.setItem('rainAlertsEnabled', '1'); }catch(e){}
  updateRainAlertBtn();
  try{ new Notification('🔔 Rain alerts on', {body:'We\'ll let you know when rain looks likely soon.'}); }catch(e){}
}
function checkRainAlert(finePoints){
  if(!isRainAlertEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
  if(!finePoints || !finePoints.length || !CURRENT) return;
  const RAIN_MM_THRESHOLD = 0.2;
  const now = new Date();
  if(finePoints[0].precipMm >= RAIN_MM_THRESHOLD) return; // already raining now, nothing to warn about
  const upcoming = finePoints.find(p => p.precipMm >= RAIN_MM_THRESHOLD);
  if(!upcoming) return;
  const minsAway = Math.round((new Date(upcoming.time) - now) / 60000);
  if(minsAway < 5 || minsAway > 90) return; // only near-term, meaningful warnings
  let lastAlerted = null;
  try{ lastAlerted = JSON.parse(localStorage.getItem('rainAlertLast') || 'null'); }catch(e){}
  const alertKey = `${CURRENT.lat.toFixed(2)},${CURRENT.lon.toFixed(2)}`;
  if(lastAlerted && lastAlerted.key === alertKey && lastAlerted.time === upcoming.time) return; // don't repeat the same warning
  try{
    new Notification('🌧️ Rain expected soon', {
      body: `Rain looks likely in about ${minsAway} min near ${CURRENT.label || 'your location'}.`
    });
    localStorage.setItem('rainAlertLast', JSON.stringify({key:alertKey, time:upcoming.time, sentAt:Date.now()}));
  }catch(e){ console.error('Notification failed', e); }
}

// --- PWA install prompt: manifest already exists, just surface the browser's
// native install flow instead of leaving it undiscoverable. ---
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if(btn) btn.style.display = 'inline-flex';
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('installBtn');
  if(btn) btn.style.display = 'none';
});
async function installApp(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  const btn = document.getElementById('installBtn');
  if(btn) btn.style.display = 'none';
}

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

// Two independently run, keyed forecast providers.
const PROVIDERS = [
  {key:'owm', name:'OpenWeatherMap', color:'#4da3ff'},
  {key:'wapi', name:'WeatherAPI.com', color:'#2ecc71'},
  {key:'ms', name:'Meteosource', color:'#f5b942'},
  {key:'vc', name:'Visual Crossing', color:'#c07bff'},
];

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

const RAIN_TRACE_THRESHOLD_MM = 0.2;
// Canonical per-provider rain% — used everywhere a rain number is shown, so the hero
// card, the insights, the hour cards, and both charts' consensus lines always agree
// with each other instead of drifting apart under slightly different formulas.
// Uses that provider's own calibrated probability where it publishes one; otherwise
// falls back to a plain 0%/100% read of whether its own forecast amount is more than
// a light trace (providers routinely show 0.1–0.2mm of numerical noise on dry days).
function providerRainPct(mm, prob){
  if(prob !== null && prob !== undefined && !isNaN(prob)) return prob;
  if(mm === null || mm === undefined || isNaN(mm)) return null;
  return mm > RAIN_TRACE_THRESHOLD_MM ? 100 : 0;
}
function precipAgreementPct(values, probValues){
  const pcts = values.map((mm,i) => providerRainPct(mm, probValues ? probValues[i] : undefined));
  const m = median(pcts);
  return m === null ? null : Math.round(m);
}

// Same canonical per-provider % as above, but also names which providers are actually
// forecasting rain (pct >= 50) for the descriptive "X of Y providers" text.
function computeAgreement(precip, hourIdx, precipProb){
  if(hourIdx < 0) return {pct:null, count:0, total:0, names:[]};
  const infos = PROVIDERS.map(m => ({
    name: m.name,
    pct: providerRainPct(precip[m.key][hourIdx], precipProb ? precipProb[m.key]?.[hourIdx] : undefined)
  })).filter(o => o.pct !== null);
  if(!infos.length) return {pct:null, count:0, total:0, names:[]};
  const raining = infos.filter(o => o.pct >= 50);
  return {
    pct: Math.round(median(infos.map(o => o.pct))),
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

// --- Provider API keys. Defaults are the launch keys; the admin panel (admin.html)
// can override either one later (stored in this browser's localStorage) without
// touching this file. ---
const DEFAULT_API_KEYS = {
  owm: '3f6499c1073e6554d41b995facf9741b',
  weatherapi: '16dbd0fef6d0408885d30629262609',
  meteosource: '4uslnx6d1gyq7brc3nyszx83rnmgsh5a5193m52u',
  visualcrossing: 'TTQGL824XMK5WKTJHLLLJBSBF'
};
function getApiKey(provider){
  try{
    const stored = JSON.parse(localStorage.getItem('skypulse_apiKeys') || 'null');
    if(stored && stored[provider]) return stored[provider];
  }catch(e){}
  return DEFAULT_API_KEYS[provider];
}

async function fetchOWM(lat, lon){
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${getApiKey('owm')}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('OpenWeatherMap error ' + res.status);
  return res.json();
}
async function fetchOWMAirPollution(lat, lon){
  const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${getApiKey('owm')}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Air quality unavailable');
  return res.json();
}
async function fetchWeatherAPI(lat, lon, days=2){
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${getApiKey('weatherapi')}&q=${lat},${lon}&days=${days}&aqi=no&alerts=no`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('WeatherAPI.com error ' + res.status);
  return res.json();
}
async function fetchMeteosource(lat, lon){
  const url = `https://www.meteosource.com/api/v1/free/point?lat=${lat}&lon=${lon}&sections=hourly&language=en&units=metric&key=${getApiKey('meteosource')}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Meteosource error ' + res.status);
  return res.json();
}
async function fetchVisualCrossing(lat, lon){
  const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}?unitGroup=metric&include=hours&key=${getApiKey('visualcrossing')}&contentType=json`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Visual Crossing error ' + res.status);
  return res.json();
}
// Flattens each provider's own hourly shape into a common {date, temp, precip, wind,
// windDir, cloud, humidity, pressure, feels, uv} list so fetchProviders() below can
// look them up the same way regardless of source.
function normalizeMeteosource(json){
  const items = json.hourly?.data || [];
  return items.map(h => ({
    date: new Date(h.date),
    temp: h.temperature ?? null,
    precip: h.precipitation?.total ?? 0,
    wind: h.wind?.speed != null ? h.wind.speed*3.6 : null, // m/s -> km/h
    windDir: h.wind?.angle ?? null,
    cloud: h.cloud_cover?.total ?? null,
    humidity: h.humidity ?? null,
    pressure: h.pressure ?? null,
    feels: h.feels_like ?? h.temperature ?? null,
    uv: h.uv_index ?? null
  }));
}
function normalizeVisualCrossing(json){
  const out = [];
  (json.days || []).forEach(day => {
    (day.hours || []).forEach(h => {
      out.push({
        date: new Date(`${day.datetime}T${h.datetime}`),
        temp: h.temp ?? null,
        precip: h.precip ?? 0,
        precipProb: h.precipprob ?? null,
        wind: h.windspeed ?? null, // already km/h under unitGroup=metric
        windDir: h.winddir ?? null,
        cloud: h.cloudcover ?? null,
        humidity: h.humidity ?? null,
        pressure: h.pressure ?? null,
        feels: h.feelslike ?? h.temp ?? null,
        uv: h.uvindex ?? null
      });
    });
  });
  return out;
}
// Generic "closest timestamp" lookup, used to snap any provider's native time grid
// (3-hourly OWM, or any gaps in the other feeds) onto the shared hourly timeline.
function buildNearestLookup(items, getDate){
  const times = items.map(getDate);
  return function(t){
    let best = null, bestDiff = Infinity;
    items.forEach((it, i) => {
      const diff = Math.abs(times[i] - t);
      if(diff < bestDiff){ bestDiff = diff; best = it; }
    });
    return best;
  };
}

// Astro times come back as e.g. "05:47 AM" — anchor them to the forecast day's
// calendar date and hand back an ISO string so the rest of the app (which expects
// `new Date(...)`-able sunrise/sunset values) doesn't need to know the source format.
function parseAstroTime(dateStr, timeStr){
  const m = /(\d+):(\d+)\s?(AM|PM)/i.exec(timeStr || '');
  if(!m) return null;
  let hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if(/pm/i.test(m[3]) && hh !== 12) hh += 12;
  if(/am/i.test(m[3]) && hh === 12) hh = 0;
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}
function buildDailyFromWapi(wapiJson){
  const days = wapiJson.forecast?.forecastday || [];
  if(!days.length) return null;
  const time = [], sunrise = [], sunset = [];
  days.forEach(d => {
    time.push(d.date);
    sunrise.push(parseAstroTime(d.date, d.astro?.sunrise));
    sunset.push(parseAstroTime(d.date, d.astro?.sunset));
  });
  return {time, sunrise, sunset};
}

// Combines the two providers onto one shared hourly timeline. WeatherAPI.com gives
// true hourly steps, so that's used as the base grid; OpenWeatherMap's 3-hour steps
// are snapped to whichever hour they're closest to (its own docs describe this as
// the intended way to read the 5-day/3-hour feed at finer-than-3-hour resolution).
async function fetchProviders(lat, lon){
  const [owmJson, wapiJson, msJson, vcJson] = await Promise.all([
    fetchOWM(lat, lon), fetchWeatherAPI(lat, lon), fetchMeteosource(lat, lon), fetchVisualCrossing(lat, lon)
  ]);

  const wapiHours = [];
  (wapiJson.forecast?.forecastday || []).forEach(day => wapiHours.push(...(day.hour || [])));
  const now = new Date();
  const windowHours = wapiHours
    .filter(h => new Date(h.time.replace(' ', 'T')) > new Date(now.getTime() - 60*60*1000))
    .slice(0, 48);

  const owmLookup = buildNearestLookup(owmJson.list || [], e => new Date(e.dt*1000));
  const msLookup = buildNearestLookup(normalizeMeteosource(msJson), it => it.date);
  const vcLookup = buildNearestLookup(normalizeVisualCrossing(vcJson), it => it.date);

  const FIELDS = ['temperature_2m','precipitation','precip_probability','wind_speed_10m','wind_direction_10m',
    'cloud_cover','relative_humidity_2m','pressure_msl','apparent_temperature','uv_index'];
  const time = [];
  const series = {};
  PROVIDERS.forEach(p => FIELDS.forEach(f => { series[`${f}_${p.key}`] = []; }));

  windowHours.forEach(h => {
    const t = new Date(h.time.replace(' ', 'T'));
    time.push(t.toISOString());

    const o = owmLookup(t);
    series.temperature_2m_owm.push(o ? o.main.temp : null);
    // OWM's rain['3h'] is accumulated over 3 hours; divide down to an hourly rate
    // so it's comparable to the other providers' per-hour precip figures.
    series.precipitation_owm.push(o ? (o.rain && o.rain['3h'] !== undefined ? o.rain['3h']/3 : 0) : null);
    series.wind_speed_10m_owm.push(o ? o.wind.speed*3.6 : null); // m/s -> km/h
    series.wind_direction_10m_owm.push(o ? o.wind.deg : null);
    series.cloud_cover_owm.push(o ? o.clouds.all : null);
    series.relative_humidity_2m_owm.push(o ? o.main.humidity : null);
    series.pressure_msl_owm.push(o ? o.main.pressure : null);
    series.apparent_temperature_owm.push(o ? o.main.feels_like : null);
    series.uv_index_owm.push(null); // not on this OWM plan
    // OWM's own "probability of precipitation" for this 3-hour block — a real,
    // model-derived confidence figure, not something we're inferring from amount alone.
    series.precip_probability_owm.push(o ? Math.round((o.pop||0)*100) : null);

    series.temperature_2m_wapi.push(h.temp_c);
    series.precipitation_wapi.push(h.precip_mm ?? 0);
    series.wind_speed_10m_wapi.push(h.wind_kph);
    series.wind_direction_10m_wapi.push(h.wind_degree);
    series.cloud_cover_wapi.push(h.cloud);
    series.relative_humidity_2m_wapi.push(h.humidity);
    series.pressure_msl_wapi.push(h.pressure_mb);
    series.apparent_temperature_wapi.push(h.feelslike_c);
    series.uv_index_wapi.push(h.uv ?? null);
    series.precip_probability_wapi.push(h.chance_of_rain ?? null);

    const m = msLookup(t);
    series.temperature_2m_ms.push(m ? m.temp : null);
    series.precipitation_ms.push(m ? m.precip : null);
    series.wind_speed_10m_ms.push(m ? m.wind : null);
    series.wind_direction_10m_ms.push(m ? m.windDir : null);
    series.cloud_cover_ms.push(m ? m.cloud : null);
    series.relative_humidity_2m_ms.push(m ? m.humidity : null);
    series.pressure_msl_ms.push(m ? m.pressure : null);
    series.apparent_temperature_ms.push(m ? m.feels : null);
    series.uv_index_ms.push(m ? m.uv : null);
    series.precip_probability_ms.push(null); // not available on Meteosource's free plan

    const v = vcLookup(t);
    series.temperature_2m_vc.push(v ? v.temp : null);
    series.precipitation_vc.push(v ? v.precip : null);
    series.wind_speed_10m_vc.push(v ? v.wind : null);
    series.wind_direction_10m_vc.push(v ? v.windDir : null);
    series.cloud_cover_vc.push(v ? v.cloud : null);
    series.relative_humidity_2m_vc.push(v ? v.humidity : null);
    series.pressure_msl_vc.push(v ? v.pressure : null);
    series.apparent_temperature_vc.push(v ? v.feels : null);
    series.uv_index_vc.push(v ? v.uv : null);
    series.precip_probability_vc.push(v ? v.precipProb : null);
  });

  return {hourly: {time, ...series}, daily: buildDailyFromWapi(wapiJson)};
}

// 5-day outlook: grouped from OpenWeatherMap's 5-day/3-hour feed (its native use case),
// kept as a separate call so it doesn't bloat the main hourly fetch above.
async function fetchFiveDayOverview(lat, lon){
  const json = await fetchOWM(lat, lon);
  const byDay = {};
  (json.list || []).forEach(entry => {
    const day = entry.dt_txt.slice(0, 10);
    (byDay[day] = byDay[day] || []).push(entry);
  });
  const days = Object.keys(byDay).sort().slice(0, 5);
  const time=[], tmax=[], tmin=[], popMax=[];
  days.forEach(day => {
    const entries = byDay[day];
    time.push(day);
    tmax.push(Math.max(...entries.map(e => e.main.temp)));
    tmin.push(Math.min(...entries.map(e => e.main.temp)));
    popMax.push(Math.max(...entries.map(e => Math.round((e.pop||0)*100))));
  });
  return {daily: {time, temperature_2m_max:tmax, temperature_2m_min:tmin, precipitation_probability_max:popMax}};
}

// Air quality via OpenWeatherMap's Air Pollution API. Still runs PM2.5 through the
// same documented US EPA breakpoint table below, rather than OWM's own coarse 1-5 index.
async function fetchAirQuality(lat, lon){
  const json = await fetchOWMAirPollution(lat, lon);
  const entry = json.list && json.list[0];
  const pm = entry ? entry.main.components.pm2_5 : null;
  const dt = entry ? entry.dt*1000 : Date.now();
  return {hourly: {time:[new Date(dt).toISOString()], pm2_5:[pm]}};
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
// Lightweight single-provider lookup for the trip planner and micro-grid, where full
// multi-provider consensus isn't needed — just a fast, real per-point forecast.
async function fetchSimple(lat, lon){
  const json = await fetchWeatherAPI(lat, lon, 1);
  const hours = [];
  (json.forecast?.forecastday || []).forEach(d => hours.push(...(d.hour || [])));
  return {
    hourly: {
      time: hours.map(h => h.time.replace(' ', 'T')),
      temperature_2m: hours.map(h => h.temp_c),
      precipitation_probability: hours.map(h => h.chance_of_rain),
      cloud_cover: hours.map(h => h.cloud)
    }
  };
}
async function geocodeCity(name){
  // Nominatim (OpenStreetMap) has far better coverage of small localities/barangays
  // than either weather provider's basic geocoder.
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
  PROVIDERS.forEach(m => { out[m.key] = hourly[`${field}_${m.key}`]; });
  return out;
}

// Neither free-tier provider offers a true sub-hourly feed, so instead of pretending
// to have one, this builds honest 15-minute steps by interpolating between consecutive
// hourly consensus values (median across both providers) for the "next hours" view.
function buildFineNowcast(hourlyProviders, startIdx){
  const times = hourlyProviders.time;
  const temps = modelSeries(hourlyProviders, 'temperature_2m');
  const precip = modelSeries(hourlyProviders, 'precipitation');
  const precipProb = modelSeries(hourlyProviders, 'precip_probability');
  const clouds = modelSeries(hourlyProviders, 'cloud_cover');

  const hourlyTemp = times.map((_, i) => median(PROVIDERS.map(m => temps[m.key][i])));
  const hourlyCloud = times.map((_, i) => median(PROVIDERS.map(m => clouds[m.key][i])));
  const hourlyPrecip = times.map((_, i) => median(PROVIDERS.map(m => precip[m.key][i])));

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 5*60*60*1000);
  const points = [];

  for(let i = startIdx; i < times.length - 1; i++){
    const t0 = new Date(times[i]);
    if(t0 > windowEnd) break;
    for(let step = 0; step < 4; step++){
      const t = new Date(t0.getTime() + step*15*60*1000);
      if(t > windowEnd) break;
      const windowFinish = new Date(t.getTime() + 15*60*1000);
      if(windowFinish <= now) continue;
      const frac = step/4;
      const a = hourlyTemp[i], b = hourlyTemp[i+1];
      const temp = (a !== null && b !== null) ? a + (b-a)*frac : a;
      const ca = hourlyCloud[i], cb = hourlyCloud[i+1];
      const cloud = (ca !== null && cb !== null) ? ca + (cb-ca)*frac : ca;
      points.push({
        time: t.toISOString(),
        temp, cloud,
        agreement: computeAgreement(precip, i, precipProb),
        precipMm: (hourlyPrecip[i] ?? 0) / 4
      });
    }
  }
  return points;
}

// Same 15-minute interpolation idea as buildFineNowcast, but kept per-provider instead
// of collapsed to a consensus — this is what feeds the "chance of rain, per provider"
// chart. Each provider's own rain% is its real published probability where it has one,
// else a plain 0/100 read of whether its own forecast amount crosses the trace
// threshold (a lone provider has nothing to "agree" with, so no vote makes sense here).
function buildFineRainByProvider(hourlyProviders, startIdx){
  const times = hourlyProviders.time;
  const precip = modelSeries(hourlyProviders, 'precipitation');
  const precipProb = modelSeries(hourlyProviders, 'precip_probability');

  const hourlyPct = {};
  PROVIDERS.forEach(p => {
    hourlyPct[p.key] = times.map((_, i) => providerRainPct(precip[p.key][i], precipProb[p.key][i]));
  });

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 5*60*60*1000);
  const labels = [];
  const series = {};
  PROVIDERS.forEach(p => { series[p.key] = []; });

  for(let i = startIdx; i < times.length - 1; i++){
    const t0 = new Date(times[i]);
    if(t0 > windowEnd) break;
    for(let step = 0; step < 4; step++){
      const t = new Date(t0.getTime() + step*15*60*1000);
      if(t > windowEnd) break;
      const windowFinish = new Date(t.getTime() + 15*60*1000);
      if(windowFinish <= now) continue;
      const frac = step/4;
      labels.push(t.toISOString());
      PROVIDERS.forEach(p => {
        const a = hourlyPct[p.key][i], b = hourlyPct[p.key][i+1];
        const val = (a !== null && b !== null) ? a + (b-a)*frac : a;
        series[p.key].push(val);
      });
    }
  }
  return {labels, series};
}


// Populated per-location from WeatherAPI's daily astro sunrise/sunset — real astronomical
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

// --- Hero weather icon scenes (SVG) ---
// The hero visual used to show one hardcoded cloud glyph no matter what the sky
// was actually doing, which is why it always looked overcast with the sun stuck
// behind it. These builders draw a real scene (sun/moon/clouds/rain/thunder) that
// matches the classified condition, and heroIconIdFor() below maps our condition
// icons/text onto one of these scenes.
function heroSvgWrap(inner, vb='0 0 240 190'){
  return `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}
function heroSunGlow(cx=120, cy=95, r=46, id='hg1'){
  return `<defs><radialGradient id="${id}" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#ffe28a" stop-opacity="0.95"/>
    <stop offset="40%" stop-color="#f5c451" stop-opacity="0.5"/>
    <stop offset="100%" stop-color="#f5c451" stop-opacity="0"/>
  </radialGradient></defs><circle cx="${cx}" cy="${cy}" r="${r*2.3}" fill="url(#${id})"/>`;
}
function heroSunRays(cx=120, cy=95, r=44, id='hrays1'){
  let rays = '';
  const count = 12;
  for(let i=0;i<count;i++){
    const a = (Math.PI*2/count)*i;
    const inner = r+10, outer = r+(i%2===0?26:18);
    const x1=cx+Math.cos(a)*inner, y1=cy+Math.sin(a)*inner;
    const x2=cx+Math.cos(a)*outer, y2=cy+Math.sin(a)*outer;
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ffd97a" stroke-width="3.5" stroke-linecap="round" opacity="0.85"/>`;
  }
  return `<g id="${id}">${rays}</g>`;
}
function heroSunDisc(cx=120, cy=95, r=44){
  return `<defs><radialGradient id="hsunFace${cx}${cy}" cx="35%" cy="28%" r="75%">
    <stop offset="0%" stop-color="#fffaea"/><stop offset="35%" stop-color="#ffe28a"/>
    <stop offset="70%" stop-color="#ffc247"/><stop offset="100%" stop-color="#f29a1e"/>
  </radialGradient></defs>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#hsunFace${cx}${cy})"/>
  <ellipse cx="${cx-r*0.32}" cy="${cy-r*0.35}" rx="${r*0.38}" ry="${r*0.24}" fill="#fffef2" opacity="0.55"/>`;
}
function heroMoonGlow(cx=120, cy=95, id='hmg1'){
  return `<defs><radialGradient id="${id}" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#cfe3ff" stop-opacity="0.55"/>
    <stop offset="45%" stop-color="#8fb4ff" stop-opacity="0.25"/>
    <stop offset="100%" stop-color="#8fb4ff" stop-opacity="0"/>
  </radialGradient></defs><circle cx="${cx}" cy="${cy}" r="96" fill="url(#${id})"/>`;
}
function heroMoonDisc(cx=120, cy=95, r=42){
  return `<defs><radialGradient id="hmoonFace${cx}${cy}" cx="32%" cy="28%" r="80%">
    <stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="#e3ecfa"/><stop offset="100%" stop-color="#a9bbdc"/>
  </radialGradient>
  <mask id="hmoonMask${cx}${cy}"><rect x="0" y="0" width="240" height="190" fill="white"/>
  <circle cx="${cx+16}" cy="${cy-12}" r="${r-1}" fill="black"/></mask></defs>
  <g mask="url(#hmoonMask${cx}${cy})">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#hmoonFace${cx}${cy})"/>
    <circle cx="${cx-12}" cy="${cy-6}" r="7" fill="#c3d1ec" opacity="0.55"/>
    <circle cx="${cx+2}" cy="${cy+14}" r="4.5" fill="#c3d1ec" opacity="0.5"/>
    <circle cx="${cx-6}" cy="${cy+16}" r="3" fill="#c3d1ec" opacity="0.4"/>
  </g>`;
}
function heroStar(x,y,s){
  return `<path d="M${x} ${y-s} L${x+s*0.28} ${y-s*0.28} L${x+s} ${y} L${x+s*0.28} ${y+s*0.28} L${x} ${y+s} L${x-s*0.28} ${y+s*0.28} L${x-s} ${y} L${x-s*0.28} ${y-s*0.28} Z" fill="#dbe6ff" opacity="0.85"/>`;
}
function heroCloud(x=0,y=0,scale=1,fill='#ffffff',id=''){
  const gid = 'hcloudShade'+(id||Math.random().toString(36).slice(2));
  return `<g transform="translate(${x},${y}) scale(${scale})">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="${fill}"/>
    </linearGradient></defs>
    <path d="M20 55 C4 55 -6 42 3 29 C6 15 24 6 38 12 C46 -2 70 -3 80 11 C97 9 112 20 111 35 C121 38 122 55 106 55 Z" fill="url(#${gid})"/>
  </g>`;
}
function heroCloudShadow(x=0,y=0,scale=1){ return heroCloud(x,y,scale,'#a9b7c9'); }
function heroRaindrop(x,y){
  return `<path d="M${x} ${y} c-4 5 -6 9 -6 12 a6 6 0 0 0 12 0 c0 -3 -2 -7 -6 -12z" fill="#5aa7ff"/>`;
}
function heroBolt(x,y){
  return `<path d="M${x} ${y} L${x-10} ${y+22} L${x} ${y+22} L${x-8} ${y+46} L${x+16} ${y+16} L${x+4} ${y+16} Z" fill="#ffd65c"/>`;
}
function buildHeroScene(id){
  switch(id){
    case 'clear-day': return heroSvgWrap(heroSunGlow()+heroSunRays()+heroSunDisc());
    case 'clear-night': return heroSvgWrap(heroMoonGlow()+heroStar(58,40,4)+heroStar(178,55,3)+heroStar(200,110,4)+heroStar(45,120,3)+heroMoonDisc());
    case 'partly-day': return heroSvgWrap(heroSunGlow(150,70,40)+heroSunRays(150,70,36,'hrays2')+heroSunDisc(150,70,36)+heroCloudShadow(35,86,1.15)+heroCloud(28,80,1.15));
    case 'partly-night': return heroSvgWrap(heroMoonGlow(150,68,'hmg2')+heroMoonDisc(150,68,34)+heroCloudShadow(35,88,1.15)+heroCloud(28,82,1.15));
    case 'rain': return heroSvgWrap(heroCloudShadow(20,42,1.1)+heroCloud(14,34,1.1,'#dfe6ee')+heroCloudShadow(90,66,1.3)+heroCloud(82,58,1.3,'#f4f7fb')+heroRaindrop(70,132)+heroRaindrop(105,142)+heroRaindrop(140,130)+heroRaindrop(160,148));
    case 'thunder': return heroSvgWrap(heroCloudShadow(20,40,1.1)+heroCloud(14,32,1.1,'#c9d2de')+heroCloudShadow(90,64,1.3)+heroCloud(82,56,1.3,'#dde3ec')+heroBolt(118,120));
    case 'cloudy':
    default: return heroSvgWrap(heroCloudShadow(20,52,1.15)+heroCloud(14,44,1.15,'#e9edf3')+heroCloudShadow(90,78,1.35)+heroCloud(82,70,1.35,'#ffffff'));
  }
}
// Maps the emoji+text our existing classifier already produces onto one of the
// scenes above, so the hero art always matches the real forecast instead of a
// fixed glyph.
function heroIconIdFor(icon, isDay, text){
  if(icon === '⛈️') return 'thunder';
  if(icon === '🌧️' || icon === '🌦️') return 'rain';
  if(icon === '☀️') return 'clear-day';
  if(icon === '🌙') return 'clear-night';
  if(icon === '🌤️' || icon === '⛅') return isDay ? 'partly-day' : 'partly-night';
  if(icon === '☁️') return (text || '').includes('Partly') ? (isDay ? 'partly-day' : 'partly-night') : 'cloudy';
  return isDay ? 'partly-day' : 'partly-night';
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
  else if(mmPerHour > 0.15) rainName = 'Light Rain';

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

// Groups the 15-min points into hour buckets — shared by the hour-card row and
// the minute-detail filter below so "6 PM" always means the same set of points
// in both places.
function groupFinePointsByHour(finePoints){
  const hourGroups = [];
  finePoints.forEach((p, idx) => {
    const d = new Date(p.time);
    const hourKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    let grp = hourGroups.find(g => g.key === hourKey);
    if(!grp){ grp = {key:hourKey, points:[], firstIdx:idx}; hourGroups.push(grp); }
    grp.points.push(p);
  });
  return hourGroups;
}

function renderHourCards(finePoints){
  const container = document.getElementById('hourCardsRow');
  if(!finePoints.length){ container.innerHTML = ''; return; }

  const hourGroups = groupFinePointsByHour(finePoints);

  container.innerHTML = hourGroups.map(g => {
    const first = g.points[0];
    const avgTemp = mean(g.points.map(p=>p.temp));
    const maxAgreement = Math.max(...g.points.map(p => p.agreement?.pct ?? 0));
    const avgCloud = mean(g.points.map(p=>p.cloud).filter(c=>c!==null && c!==undefined));
    const mmPerHour = mean(g.points.map(p=>p.precipMm)) * 4;
    const cond = conditionLabel(mmPerHour, avgCloud, maxAgreement, isDaytime(new Date(first.time)));
    return `
      <div class="hour-card" tabindex="0" role="button" aria-label="Show details for ${fmtHour(first.time)}"
        onclick="showHourDetails('${g.key}')" onkeypress="if(event.key==='Enter') showHourDetails('${g.key}')">
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

// The generic "Show 15-minute details" button (as opposed to clicking a specific
// hour card) used to dump every hour in the window at once. Now it opens on
// whichever hour is already selected, or the soonest hour if none is yet.
function toggleMinuteDetailsDefault(){
  const panel = document.getElementById('detailsPanel');
  const willOpen = !panel.classList.contains('open');
  toggleDetailsPanel(willOpen);
  if(willOpen){
    const hourGroups = groupFinePointsByHour(lastFinePoints);
    const key = activeMinuteHourKey || (hourGroups[0] && hourGroups[0].key);
    if(key) selectMinuteHour(key);
  }
}

let lastFinePoints = [];
let activeMinuteHourKey = null;

// Opens the per-minute panel already filtered to just the hour that was clicked,
// instead of dumping every hour in the forecast window into one long list.
function showHourDetails(hourKey){
  toggleDetailsPanel(true);
  selectMinuteHour(hourKey);
  setTimeout(() => {
    document.getElementById('detailsPanel').scrollIntoView({behavior:'smooth', block:'start'});
  }, 50);
}

function selectMinuteHour(hourKey){
  activeMinuteHourKey = hourKey;
  const hourGroups = groupFinePointsByHour(lastFinePoints);
  renderHourPicker(hourGroups, hourKey);
  const group = hourGroups.find(g => g.key === hourKey);
  renderMinuteList(group ? group.points : lastFinePoints, group ? group.firstIdx : 0);
}

// Small row of hour pills inside the details panel so you can jump between
// hours without scrolling back up to the timeline above.
function renderHourPicker(hourGroups, activeKey){
  const picker = document.getElementById('minuteHourPicker');
  if(!picker) return;
  picker.innerHTML = hourGroups.map(g => {
    const first = g.points[0];
    return `<button class="hour-pill ${g.key===activeKey?'active':''}" onclick="selectMinuteHour('${g.key}')">${fmtHour(first.time)}</button>`;
  }).join('');
}

function renderMinuteList(finePoints, baseIdx){
  const container = document.getElementById('minuteList');
  baseIdx = baseIdx || 0;
  if(!finePoints.length){ container.innerHTML = '<div class="minute-row">No high-resolution data available for this location.</div>'; return; }

  container.innerHTML = finePoints.map((p, i) => {
    const idx = baseIdx + i;
    const mmPerHour = p.precipMm * 4;
    const startTime = new Date(p.time);
    const label = conditionLabel(mmPerHour, p.cloud, p.agreement?.pct ?? null, isDaytime(startTime));
    const ag = p.agreement || {pct:null, count:0, total:0, names:[]};

    const endTime = new Date(startTime.getTime() + 15*60*1000);
    const timeLabel = `${fmtHour(startTime)} – ${fmtHour(endTime)}`;
    const confPct = ag.pct !== null ? `${ag.pct}% chance` : '—';
    const blockId = `mb${idx}`;

    const minuteRows = buildMinutesForPoint(lastFinePoints, idx).map(row => {
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
        <div class="chunk-header ${i===0?'open':''}" id="${blockId}-header" onclick="toggleChunk('${blockId}')">
          <span class="m-time" style="width:auto;">${timeLabel}</span>
          <span class="m-icon">${label.icon}</span>
          <span class="m-desc">${label.text}${ag.pct !== null && ag.count > 0 ? ' · '+confPct+' of rain' : ''}</span>
          <span class="m-temp">${p.temp.toFixed(1)}°</span>
          <span class="chev">▾</span>
        </div>
        <div class="chunk-body ${i===0?'open':''}" id="${blockId}-body">
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
  const now = new Date();
  const rows = [];
  for(let m=0; m<15; m++){
    const t = new Date(startTime.getTime() + m*60000);
    // Skip minutes that have already passed within the current in-progress
    // 15-minute window, so "now" doesn't show a list starting in the past.
    if(t.getTime() + 60000 <= now.getTime()) continue;
    const frac = m/15;
    const temp = next ? (p.temp + (next.temp - p.temp)*frac) : p.temp;
    rows.push({time:t, temp, mmPerHour: mmPerMinute*60});
  }
  return rows;
}

// Exclusive accordion: opening one 15-minute block now closes any other block
// that was left open, instead of everything staying open and turning "show
// details" into one very long page that's hard to scroll back out of.
function toggleChunk(id){
  const body = document.getElementById(`${id}-body`);
  const header = document.getElementById(`${id}-header`);
  const wasOpen = body.classList.contains('open');
  document.querySelectorAll('.chunk-body.open').forEach(b => b.classList.remove('open'));
  document.querySelectorAll('.chunk-header.open').forEach(h => h.classList.remove('open'));
  if(!wasOpen){
    body.classList.add('open');
    header.classList.add('open');
  }
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
    statusEl.style.display = 'block';
    statusEl.innerHTML = `<span class="err">Geolocation isn't supported by this browser.</span> Please search for a place or click your spot on the map below instead.`;
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
      console.warn('Browser geolocation (high accuracy) failed:', err.message);
      // High-accuracy GPS often times out on desktops/laptops with no GPS chip
      // (it waits on a hardware fix that never comes), even though the browser
      // can usually resolve a decent Wi-Fi/cell-based position quickly with
      // high accuracy turned off. Retrying that way before giving up entirely
      // means "Use my location" lands on your actual current spot far more
      // often, instead of failing outright on the first timeout.
      if(err.code === err.TIMEOUT){
        statusEl.textContent = 'Precise GPS timed out — trying a quicker, lower-accuracy fix…';
        navigator.geolocation.getCurrentPosition(
          pos => {
            const {latitude:lat, longitude:lon} = pos.coords;
            statusEl.textContent = 'Location found. Fetching forecasts…';
            runForLocation(lat, lon, 'Your location');
          },
          err2 => {
            console.warn('Browser geolocation (low accuracy) failed:', err2.message);
            statusEl.style.display = 'block';
            statusEl.innerHTML = `<span class="err">Could not detect your location.</span> Please search for a place or click your exact spot on the map below instead — that always works regardless of GPS.`;
          },
          {enableHighAccuracy:false, timeout:8000, maximumAge:60000}
        );
        return;
      }
      const isFileProtocol = location.protocol === 'file:';
      let reason;
      if(isFileProtocol) reason = 'GPS is blocked on local files (browser rule)';
      else if(err.code === err.PERMISSION_DENIED) reason = 'location permission was denied';
      else reason = err.message;
      statusEl.style.display = 'block';
      statusEl.innerHTML = `<span class="err">${escapeHtml(reason)}.</span> Please search for a place or click your exact spot on the map below instead.`;
    },
    {enableHighAccuracy:true, timeout:12000, maximumAge:0}
  );
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
        const short = escapeHtml(r.display_name.split(',').map(s=>s.trim()).slice(0,3).join(', '));
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
// Straight lat/lon-degree comparison doesn't account for latitude scaling, and the
// old flat 0.001° threshold (~111m of *latitude*) was wide enough to treat two
// different streets a couple hundred meters apart in a dense city block as "the
// same place" — which is what flagged Pasay Road as a duplicate of Libertad.
// A real distance calculation with a much tighter radius only catches genuine
// re-saves of the same spot (e.g. double-clicking Save), not nearby-but-different
// addresses.
function distanceMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
const DUPLICATE_RADIUS_METERS = 60;
function findDuplicateSaved(arr, lat, lon){
  return arr.find(s => distanceMeters(s.lat, s.lon, lat, lon) < DUPLICATE_RADIUS_METERS) || null;
}
// Explains *why* it's a duplicate (which saved entry it matched) instead of a bare
// "Already saved" — this matters because "Use my location" falls back to coarse,
// network-based positioning when GPS fails/times out, which often lands on the
// same spot as an already-saved place even though the user is somewhere new.
function saveLocationToStorage(lat, lon, label, btnEl){
  const arr = getSavedLocations();
  const dupe = findDuplicateSaved(arr, lat, lon);
  if(dupe){ flashSaveButton(btnEl, `Already saved as "${dupe.label}"`); renderSavedLocations(); return; }
  arr.push({lat, lon, label});
  setSavedLocations(arr);
  renderSavedLocations();
  flashSaveButton(btnEl, 'Saved ✓');
}
// Gives visible confirmation that Save worked, since the saved-locations list can be
// scrolled out of view when the button is clicked — without this the save silently
// succeeds but looks like nothing happened.
function flashSaveButton(btnEl, message){
  if(!btnEl) return;
  const original = btnEl.dataset.originalLabel ?? btnEl.textContent;
  btnEl.dataset.originalLabel = original;
  btnEl.textContent = message;
  btnEl.disabled = true;
  clearTimeout(btnEl.__flashTimer);
  btnEl.__flashTimer = setTimeout(() => {
    btnEl.textContent = btnEl.dataset.originalLabel;
    btnEl.disabled = false;
  }, 2200);
}
function savePickedLocation(btnEl){
  if(!pickedLoc) return;
  saveLocationToStorage(pickedLoc.lat, pickedLoc.lon, pickedLoc.label, btnEl);
}
function saveCurrentLocation(btnEl){
  if(!CURRENT) return;
  saveLocationToStorage(CURRENT.lat, CURRENT.lon, CURRENT.label, btnEl);
}
function deleteSavedLocation(idx){
  const arr = getSavedLocations();
  arr.splice(idx, 1);
  setSavedLocations(arr);
  renderSavedLocations();
}
function renameSavedLocation(idx){
  const arr = getSavedLocations();
  const loc = arr[idx];
  if(!loc) return;
  const next = prompt('Rename this saved location:', loc.label);
  if(next === null) return; // cancelled
  const trimmed = next.trim();
  if(!trimmed) return;
  loc.label = trimmed;
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
  const countEl = document.getElementById('savedLocationsCount');
  const arr = getSavedLocations();
  if(countEl) countEl.textContent = arr.length ? `(${arr.length})` : '';
  if(!arr.length){
    el.innerHTML = '<div class="section-sub" style="margin:0;">No saved locations yet — click "Save" after picking a spot. You can save as many as you like.</div>';
    return;
  }
  el.innerHTML = arr.map((s,i) => `
    <div class="saved-chip">
      <span class="chip-label" onclick="loadSavedLocation(${i})" title="Load this location">📍 ${escapeHtml(s.label)}</span>
      <button class="chip-edit" onclick="renameSavedLocation(${i})" title="Rename">✎</button>
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
let youMarker = null, destMarker = null, gridMarkers = [], pickerMarker = null;

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
}

async function onMapClick(e){
  const {lat, lng:lon} = e.latlng;
  if(mapMode === 'location'){
    updatePickedLocation(lat, lon);
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

// Shared by click-to-place and drag-to-place, so both land in the exact same
// state: a picked spot the person can inspect and Save *without* it touching
// CURRENT or requiring "Use this spot" first — picking a location on the map
// should not require you to first search for it by name.
async function updatePickedLocation(lat, lon){
  if(pickerMarker){
    pickerMarker.setLatLng([lat, lon]);
  } else {
    // A plain L.marker (not circleMarker) so it supports native drag-and-drop.
    pickerMarker = L.marker([lat, lon], {draggable:true, icon: pickerIcon()}).addTo(map);
    pickerMarker.on('dragend', () => {
      const p = pickerMarker.getLatLng();
      updatePickedLocation(p.lat, p.lng);
    });
  }
  const panel = document.getElementById('pickedPanel');
  panel.style.display = 'block';
  document.getElementById('pickedName').textContent = 'Loading address…';
  pickedLoc = {lat, lon, label:null};
  const name = await reverseGeocode(lat, lon);
  pickedLoc.label = name;
  document.getElementById('pickedName').innerHTML = `📍 <b>${escapeHtml(name)}</b> (${lat.toFixed(4)}, ${lon.toFixed(4)}) <small style="opacity:.7">— drag the pin to fine-tune</small>`;
}

// Leaflet's default marker image is hosted on unpkg's dist folder alongside
// leaflet.js, which is already an allowed script host, but the default icon
// PNG path resolution can break depending on how the page bundles assets —
// a small inline SVG pin sidesteps that entirely and matches the app's palette.
function pickerIcon(){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="#4da3ff" stroke="#06111e" stroke-width="1.5"/>
    <circle cx="15" cy="15" r="6" fill="#06111e"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: 'picker-pin',
    iconSize: [30, 42],
    iconAnchor: [15, 42]
  });
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
  document.getElementById('pickedName').textContent = 'Click or drag the pin on the map above.';
  document.getElementById('map').scrollIntoView({behavior:'smooth', block:'center'});
}

// Places "you are here" + the 5km grid on the already-loaded map.
// This used to also flip the map into "pick a trip destination" mode after every
// weather load — but nothing in the Planner tab UI actually lets you click this
// map to set a destination (it's a text search box), so that flip just silently
// broke clicking the map to change your forecast location after your first load.
// The map now always stays in location-picking mode, matching what's exposed.
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
        const short = escapeHtml(r.display_name.split(',').map(s=>s.trim()).slice(0,3).join(', '));
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
          <div class="label">From — ${escapeHtml(fromLoc.label || 'Your location')}</div>
          <div style="font-size:1.1rem; margin-top:4px;">${fCond.icon} ${fCond.text}</div>
          <div style="font-size:1.2rem; font-weight:700;">${fTemp?.toFixed(1) ?? '--'}°</div>
        </div>
        <div class="trip-point">
          <div class="label">To — ${escapeHtml(toLoc.label || toVal)}</div>
          <div style="font-size:1.1rem; margin-top:4px;">${tCond.icon} ${tCond.text}</div>
          <div style="font-size:1.2rem; font-weight:700;">${tTemp?.toFixed(1) ?? '--'}°</div>
        </div>
      </div>
    `;
  }catch(e){
    resultEl.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`;
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
      return `<div class="mini"><div class="dir">${pts[d].dir}</div><div class="mini-icon">${cond.icon}</div><div class="t">${t?.toFixed(1) ?? '--'}°</div><div class="p">${cond.text}</div></div>`;
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
    const data = await fetchProviders(lat, lon);
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
    const precipProb = modelSeries(hourly, 'precip_probability');
    const winds = modelSeries(hourly, 'wind_speed_10m');
    const clouds = modelSeries(hourly, 'cloud_cover');
    const feelsLikeSeries = modelSeries(hourly, 'apparent_temperature');
    const humiditySeries = modelSeries(hourly, 'relative_humidity_2m');
    const windDirSeries = modelSeries(hourly, 'wind_direction_10m');
    const pressureSeries = modelSeries(hourly, 'pressure_msl');
    const uvSeries = modelSeries(hourly, 'uv_index');

    const curTemps = PROVIDERS.map(m => temps[m.key][startIdx]);
    const curPrecip = PROVIDERS.map(m => precip[m.key][startIdx]);
    const curPrecipProb = PROVIDERS.map(m => precipProb[m.key][startIdx]);
    const curWinds = PROVIDERS.map(m => winds[m.key][startIdx]);
    const curClouds = PROVIDERS.map(m => clouds[m.key][startIdx]);
    const curFeels = PROVIDERS.map(m => feelsLikeSeries[m.key][startIdx]);
    const curHumidity = PROVIDERS.map(m => humiditySeries[m.key][startIdx]);
    const curWindDir = PROVIDERS.map(m => windDirSeries[m.key][startIdx]);
    const curPressure = PROVIDERS.map(m => pressureSeries[m.key][startIdx]);
    const curUV = PROVIDERS.map(m => uvSeries[m.key][startIdx]);

    const consensusTemp = median(curTemps);
    const consensusRain = precipAgreementPct(curPrecip, curPrecipProb);
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
    const heroStage = document.getElementById('heroIconStage');
    if(heroStage){
      heroStage.innerHTML = buildHeroScene(heroIconIdFor(nowCondition.icon, isDaytime(new Date(hourly.time[startIdx])), nowCondition.text));
    }
    document.getElementById('heroRain').textContent = `${consensusRain?.toFixed(0) ?? '--'}%`;
    document.getElementById('heroWind').textContent = `${consensusWind?.toFixed(1) ?? '--'} km/h`;
    document.getElementById('heroFeels').textContent = `${consensusFeels?.toFixed(0) ?? '--'}°`;
    document.getElementById('heroHumidity').textContent = `${consensusHumidity?.toFixed(0) ?? '--'}%`;
    document.getElementById('heroCloud').textContent = `${consensusCloud?.toFixed(0) ?? '--'}%`;
    document.getElementById('heroPlace').textContent = `${label}`;
    document.getElementById('wearAdvice').textContent = `👕 ${wearAdvice(consensusTemp, consensusRain, consensusWind)}`;
    const staleBannerEl = document.getElementById('staleBanner');
    if(staleBannerEl) staleBannerEl.style.display = 'none';
    cacheForecastSnapshot({
      lat, lon, label,
      temp: consensusTemp, conditionIcon: nowCondition.icon, conditionText: nowCondition.text,
      rain: consensusRain, wind: consensusWind, feels: consensusFeels,
      humidity: consensusHumidity, cloud: consensusCloud, savedAt: Date.now()
    });
    scheduleAutoRefresh();

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
      `Providers in this forecast: <b>${PROVIDERS.map(m=>m.name).join(', ')}</b> — temperature/wind/cloud consensus is the median across all of them. Rain chance uses each provider's own calibrated probability-of-precipitation where they publish one (OpenWeatherMap, WeatherAPI.com, Visual Crossing), falling back to an amount-based vote only when none is available.`;

    const confBadge = document.getElementById('confBadge');
    if(spread < 1.5){ confBadge.className = 'badge high'; confBadge.textContent = 'High Confidence'; }
    else if(spread > 3.5){ confBadge.className = 'badge low'; confBadge.textContent = 'Provider Divergence'; }
    else { confBadge.className = 'badge mid'; confBadge.textContent = 'Moderate Confidence'; }

    // Model consensus is represented by the redesigned forecast chart and
    // weather-intelligence sections below. Keep the rain-model calculation here
    // for the chart/insight logic, but do not write to legacy UI containers.
    const rainingModels = PROVIDERS.map((m,i) => ({m, raining: curPrecip[i] !== null && curPrecip[i] !== undefined && curPrecip[i] > 0.1}));
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
      insights.push({icon:'⚠️', text:`Forecast confidence is low right now — providers disagree on temperature by ${spread.toFixed(1)}°, so treat details loosely.`});
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
      const laterRain = precipAgreementPct(PROVIDERS.map(m => precip[m.key][laterIdx]), PROVIDERS.map(m => precipProb[m.key][laterIdx]));
      if(laterRain !== null && consensusRain !== null && laterRain - consensusRain >= 25){
        insights.push({icon:'📈', text:`Rain risk increases later — model agreement climbs to ${laterRain}% around ${fmtHour(hourly.time[laterIdx])}.`});
      }
    }
    document.getElementById('insightList').innerHTML = insights.map(i => `
      <div class="insight-item"><span class="ii-icon">${i.icon}</span><span class="ii-text">${i.text}</span></div>
    `).join('');

    const finePoints = buildFineNowcast(hourly, startIdx);
    lastFinePoints = finePoints;
    activeMinuteHourKey = null;
    renderMinuteList(finePoints);
    renderHourPicker(groupFinePointsByHour(finePoints), null);
    renderHourCards(finePoints);
    checkRainAlert(finePoints);

    loadMicroGrid(lat, lon);

    attachWeatherMarkers(lat, lon);
    document.getElementById('tripFrom').placeholder = `Defaults to ${label}`;

    const chartLabels = hourly.time.slice(startIdx, startIdx+24).map(fmtHour);
    const chartDatasets = PROVIDERS.map(m => ({
      label: m.name,
      data: temps[m.key].slice(startIdx, startIdx+24),
      borderColor: m.color,
      tension:.3, pointRadius:0, borderWidth:1.4
    }));
    const consensusData = chartLabels.map((_,i) => median(PROVIDERS.map(m => temps[m.key][startIdx+i])));
    const rainConsensusData = chartLabels.map((_,i) => precipAgreementPct(PROVIDERS.map(m => precip[m.key][startIdx+i]), PROVIDERS.map(m => precipProb[m.key][startIdx+i])));
    const cloudConsensusData = chartLabels.map((_,i) => median(PROVIDERS.map(m => clouds[m.key][startIdx+i])));
    const precipAmtData = chartLabels.map((_,i) => median(PROVIDERS.map(m => precip[m.key][startIdx+i])));
    chartDatasets.push({label:'Consensus', data:consensusData, borderColor:'#ffffff', borderWidth:3, tension:.3, pointRadius:0});

    // Connected-line hourly strip (temperature line, wind speed per hour, sunset marked)
    const windData = chartLabels.map((_,i) => median(PROVIDERS.map(m => winds[m.key][startIdx+i])));
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

    // Second chart: each provider's own rain chance at 15-minute resolution (interpolated
    // from their hourly values — see buildFineRainByProvider), so you can see exactly which
    // source is driving the consensus number instead of only the blended white line.
    const fineRain = buildFineRainByProvider(hourly, startIdx);
    const rainLabels = fineRain.labels.map(t => new Date(t).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}));
    const rainDatasets = PROVIDERS.map(m => ({
      label: m.name,
      data: fineRain.series[m.key],
      borderColor: m.color,
      tension:.3, pointRadius:0, borderWidth:1.4
    }));
    const rainConsensusFine = fineRain.labels.map((_,i) => median(PROVIDERS.map(m => fineRain.series[m.key][i])));
    rainDatasets.push({label:'Consensus', data:rainConsensusFine, borderColor:'#ffffff', borderWidth:3, tension:.3, pointRadius:0});

    if(window.rainChartInstance) window.rainChartInstance.destroy();
    window.rainChartInstance = new Chart(document.getElementById('rainChart'), {
      type: 'line',
      data: { labels: rainLabels, datasets: rainDatasets },
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
            callbacks:{ label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y === null ? '—' : ctx.parsed.y.toFixed(0)+'%'}` }
          }
        },
        scales:{
          x:{ticks:{color:tickColor, maxTicksLimit:8}, grid:{color:gridColor}},
          y:{min:0, max:100, ticks:{color:tickColor, callback:(v)=>v+'%'}, grid:{color:gridColor}}
        }
      }
    });
    document.getElementById('rainChartLegend').innerHTML = rainDatasets.map(d =>
      `<span><span class="dot" style="background:${d.borderColor}"></span>${d.label}</span>`
    ).join('');
    document.getElementById('rainChartNote').innerHTML =
      `Each line is that provider's own rain chance, interpolated to 15-minute steps from its hourly forecast — not a real minutely feed, since none of these providers publish one on their free plans. Providers that don't publish a probability field (Meteosource) show a flat 0%/100% read of whether their own forecast amount crosses ${RAIN_TRACE_THRESHOLD_MM}mm.`;

    statusEl.style.display = 'none';
    document.getElementById('app').style.display = 'block';
    lastUpdatedAt = Date.now();
    updateLastUpdatedLabel();
  }catch(err){
    console.error(err);
    const cache = loadForecastCache();
    if(cache){
      renderStaleForecast(cache, lat, lon, label, err);
      return;
    }
    statusEl.style.display = 'block';
    statusEl.innerHTML = `
      <div class="error-card" role="alert">
        <div class="ec-icon">⚠️</div>
        <div class="ec-title">Unable to load weather data</div>
        <div class="ec-detail">Check your connection and try again. (${escapeHtml(err.message)})</div>
        <button type="button" id="retryFetchBtn" data-lat="${lat}" data-lon="${lon}" data-label="${escapeHtml(label ?? '')}">Retry</button>
      </div>`;
    const retryBtn = document.getElementById('retryFetchBtn');
    if(retryBtn){
      retryBtn.addEventListener('click', () => {
        runForLocation(parseFloat(retryBtn.dataset.lat), parseFloat(retryBtn.dataset.lon), retryBtn.dataset.label);
      });
    }
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
  // Leaflet measures the #map container's size when tiles load. While the forecast
  // tab is hidden (display:none) that size is 0x0, so tiles fetched during that time
  // never render correctly. invalidateSize() forces Leaflet to re-measure and repaint
  // once the container is visible again — must run after the display:block above,
  // and on the next frame so the browser has actually applied the new layout.
  if(tab === 'forecast' && map){
    requestAnimationFrame(() => map.invalidateSize());
  }
  if(tab === 'typhoon' && typhoonLocatorMap){
    requestAnimationFrame(() => typhoonLocatorMap.invalidateSize());
  }
}

function getTyphoonView(){
  try{ return JSON.parse(localStorage.getItem('typhoonView')); }
  catch(e){ return null; }
}
// Returns true/false so callers (and the on-screen note) can tell the difference
// between "saved" and "silently failed" instead of assuming it always worked —
// some browsers (private/incognito modes, storage quota, etc.) can throw here.
function setTyphoonView(v){
  try{ localStorage.setItem('typhoonView', JSON.stringify(v)); return true; }
  catch(e){ console.warn('Could not save typhoon view:', e.message); return false; }
}
// Visible confirmation that the saved map view actually took — the button flash
// alone is easy to miss, and previously there was no way to tell the save had
// worked without reloading the page and watching the map reposition.
// Windy's embed is a cross-origin iframe, so this page can never read back
// where the user actually panned/zoomed to inside it. Instead, a small Leaflet
// "locator" map lets people click a point directly — that click is what gets
// saved and what moves the big radar below, so Save always has something real
// to persist instead of guessing at an unreadable pan position.
let lastTyphoonView = null;
let typhoonLocatorMap = null;
let typhoonLocatorMarker = null;

function loadTyphoonMap(lat, lon, zoom){
  lastTyphoonView = {lat, lon, zoom};
  const iframe = document.getElementById('typhoonFrame');
  iframe.src = `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}` +
    `&width=650&height=480&zoom=${zoom}&level=surface&overlay=wind&product=ecmwf&menu=&message=true` +
    `&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=-1`;
  if(typhoonLocatorMap){
    if(typhoonLocatorMarker) typhoonLocatorMap.removeLayer(typhoonLocatorMarker);
    typhoonLocatorMarker = L.circleMarker([lat, lon], {radius:8, color:'#4da3ff', fillColor:'#4da3ff', fillOpacity:.9}).addTo(typhoonLocatorMap);
    typhoonLocatorMap.setView([lat, lon], typhoonLocatorMap.getZoom());
  }
}

async function onTyphoonLocatorClick(e){
  const {lat, lng:lon} = e.latlng;
  loadTyphoonMap(lat, lon, typhoonLocatorMap.getZoom());
  const note = document.getElementById('typhoonPickedNote');
  if(note) note.textContent = `Picked: ${lat.toFixed(4)}, ${lon.toFixed(4)} — hit Save to remember this spot.`;
  const name = await reverseGeocode(lat, lon).catch(()=>null);
  if(name && note) note.textContent = `Picked: ${name} (${lat.toFixed(4)}, ${lon.toFixed(4)}) — hit Save to remember this spot.`;
}

// Zooming/panning the locator map without clicking a new point should still
// update what Save will persist — otherwise zooming in after picking a spot
// silently gets lost, which is the bug being fixed here.
function onTyphoonLocatorMove(){
  if(!lastTyphoonView) return;
  const c = typhoonLocatorMap.getCenter();
  lastTyphoonView = {lat:c.lat, lon:c.lng, zoom:typhoonLocatorMap.getZoom()};
}

function initTyphoonLocatorMap(startLat, startLon, startZoom){
  typhoonLocatorMap = L.map('typhoonLocatorMap', {zoomControl:true}).setView([startLat, startLon], startZoom);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:16, attribution:'Tiles © Esri — Esri, HERE, Garmin, OpenStreetMap contributors'
  }).addTo(typhoonLocatorMap);
  typhoonLocatorMap.on('click', onTyphoonLocatorClick);
  typhoonLocatorMap.on('zoomend moveend', onTyphoonLocatorMove);
  typhoonLocatorMarker = L.circleMarker([startLat, startLon], {radius:8, color:'#4da3ff', fillColor:'#4da3ff', fillOpacity:.9}).addTo(typhoonLocatorMap);
}

function initTyphoonTab(){
  const saved = getTyphoonView();
  const fallback = CURRENT ? {lat:CURRENT.lat, lon:CURRENT.lon, zoom:7} : {lat:12.8797, lon:130.0, zoom:5};
  const view = saved || fallback;
  loadTyphoonMap(view.lat, view.lon, view.zoom);
  initTyphoonLocatorMap(view.lat, view.lon, view.zoom);
  loadActiveTyphoons();
}

function saveTyphoonView(btnEl){
  if(!lastTyphoonView){
    flashSaveButton(btnEl, 'Nothing to save yet');
    return;
  }
  const ok = setTyphoonView(lastTyphoonView);
  flashSaveButton(btnEl, ok ? 'Saved ✓' : 'Save failed');
}

function centerTyphoonOnMyLocation(){
  if(!CURRENT){
    alert('Load a forecast location on the Forecast tab first.');
    return;
  }
  const zoom = typhoonLocatorMap ? typhoonLocatorMap.getZoom() : 7;
  loadTyphoonMap(CURRENT.lat, CURRENT.lon, zoom);
  const note = document.getElementById('typhoonPickedNote');
  if(note) note.textContent = `Picked: ${CURRENT.label || `${CURRENT.lat.toFixed(4)}, ${CURRENT.lon.toFixed(4)}`} — hit Save to remember this spot.`;
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

    const hLevel = escapeHtml(headline.properties?.alertlevel || 'Green');
    const hName = escapeHtml(headline.properties?.name || headline.properties?.eventname || 'Tropical cyclone tracked');
    const isSevere = (headline.properties?.alertlevel || 'Green').toLowerCase() !== 'green';
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
      const name = escapeHtml(p.name || p.eventname || 'Unnamed system');

      const fromDate = p.fromdate ? new Date(p.fromdate) : null;
      const toDate = p.todate ? new Date(p.todate) : null;
      const dateFmt = (d) => d ? d.toLocaleDateString(undefined, {month:'short', day:'numeric'}) : null;
      let dateRangeText = '';
      if(fromDate && toDate) dateRangeText = `Tracked ${dateFmt(fromDate)} – ${dateFmt(toDate)}`;
      else if(fromDate) dateRangeText = `Tracked since ${dateFmt(fromDate)}`;

      const country = escapeHtml(p.country || p.iso3 || '');
      const reportUrl = safeHref(p.url?.report || p.url?.details || p.url?.geometry || null);
      const distLabel = f.__distanceKm !== null ? `📍 ~${Math.round(f.__distanceKm).toLocaleString()} km from you` : '';

      return `<div style="padding:8px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="dot" style="background:${dotColor};"></span>
          <span style="font-weight:600;">🌀 ${name}</span>
          <span style="color:var(--muted); margin-left:auto; font-size:.78rem;">${escapeHtml(level)} alert</span>
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
updateRainAlertBtn();
// Auto-detect the user's location on first load so they see real weather
// immediately, instead of waiting for a manual "Use my location" click.
useMyLocation();