// Audio Profiles — Stream Dock plugin: switch Windows audio devices and profiles,
// control volume from the knobs, mix programs, push-to-talk and focus mode,
// with keys that always show the real system state.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const R = require('./render');

// ---------- log ----------
const logDir = path.join(__dirname, 'log');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
const logFile = path.join(logDir, 'plugin.log');
try { if (fs.statSync(logFile).size > 512 * 1024) fs.unlinkSync(logFile); } catch (_) {}
function log(...a) {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`); } catch (_) {}
}
process.on('uncaughtException', e => log('uncaught', String(e && e.stack || e)));
process.on('unhandledRejection', e => log('unhandled', String(e && e.stack || e)));

// ---------- arguments from Stream Dock ----------
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = arg('-port') || process.argv[3];
const pluginUUID = arg('-pluginUUID') || process.argv[5];
const registerEvent = arg('-registerEvent') || process.argv[7];

const PREFIX = 'com.diy.audioprofiles.';
const DEFAULTS = {
    output: { device: '', deviceName: '', icon: 'auto', color: '#3ddc5a', showName: false, name: '' },
    mic: { device: '', deviceName: '', icon: 'auto', color: '#4ea1ff', showName: false, name: '' },
    toggle: { a: '', b: '', showName: true },
    profile: { profile: '', showName: true },
    mute: { color: '#3ddc5a', icon: 'mic' },
    // 1.1
    volume: { target: 'output', step: 2 },                                   // key + knob
    appvol: { app: '@switcher', appName: '', appPath: '', step: 2, color: '#3ddc5a' }, // key + knob; app '@switcher' = the program chosen on App Switcher
    ptt: { mode: 'key', key: 'F13', label: 'Discord PTT' },                  // mode: key | mute
    appswitch: { apps: '' },                                                  // key + knob: picks the program; apps: "a.exe, b.exe" or empty for all
    autoprofile: {},
    meter: {},
    previous: { showName: true },
    focus: { app: 'discord.exe', appName: 'Discord', mode: 'duck', level: 20 }, // mode: duck | mute
};
const HOLD_MS = 500;
const GLOW_MS = 800;

// Virtual-key codes for push-to-talk. F13–F24 do not exist on most keyboards, so nothing else reacts to them.
const VK = { ScrollLock: 0x91, Pause: 0x13, Insert: 0x2d };
for (let i = 1; i <= 24; i++) VK['F' + i] = 0x6f + i;
const vkOf = (name) => VK[name] || (/^0x[0-9a-f]+$/i.test(name || '') ? parseInt(name, 16) : VK.F13);

// ---------- state ----------
let audio = { render: [], capture: [], defRender: '', defCapture: '' };
let helperOk = false;
let profiles = [];
let autoRules = [];          // [{ exe, name, profile }]
let autoEnabled = true;
let apps = [];               // [{ exe, name, vol, muted, active }] from the helper
let procs = new Set();       // running exe names (while auto profile rules or program keys are on screen)
const iconRetry = new Set(); // programs whose icon was looked up again after they started
const icons = {};            // exe -> base64 PNG ('' = no icon)
const iconAsked = new Set();
const contexts = new Map();  // context -> { kind, knob, settings, lastSvg, timer, held, multiDone, glowUntil }
const inspectors = new Map(); // context -> action (open settings windows)
const pending = {};          // volume set from a knob but not yet reported back: key -> { vol, until }
let switchSel = '';          // app chosen on the App Switcher (shared by its key and knob)
let auto = null;             // { exe, prev: { render, capture } } while a rule is active
let focus = { on: false, app: '', mode: 'duck', level: 20, saved: {} }; // saved: exe -> { vol, muted }
let mic = { level: 0, peak: 0, peakAt: 0, drawn: 0 };
let history = [];            // previous { render, capture } pairs, newest last
let committed = null, stableTimer = null;

// ---------- Stream Dock ----------
const ws = new WebSocket('ws://127.0.0.1:' + port);
const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

ws.on('open', () => {
    send({ event: registerEvent, uuid: pluginUUID });
    send({ event: 'getGlobalSettings', context: pluginUUID });
    log('registered');
});
ws.on('close', () => { releasePtt(); stopHelper(); process.exit(0); });
ws.on('error', e => log('ws error', String(e)));
ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    const { event, action, context, payload } = m;
    const kind = action && action.startsWith(PREFIX) ? action.slice(PREFIX.length) : null;
    switch (event) {
        case 'didReceiveGlobalSettings': {
            const g = (payload && payload.settings) || {};
            let migrate = false;
            if (Array.isArray(g.profiles) && g.profiles.length) profiles = g.profiles; else if (profiles.length) migrate = true;
            if (Array.isArray(g.autoRules)) autoRules = g.autoRules; else if (autoRules.length) migrate = true;
            if (typeof g.autoEnabled === 'boolean') autoEnabled = g.autoEnabled;
            if (migrate) saveGlobal(); // move the backup copy into Stream Dock
            subscriptions(); drawAll(); broadcast();
            break;
        }
        case 'willAppear':
            if (!DEFAULTS[kind]) return;
            contexts.set(context, { kind, knob: !!(payload && payload.controller === 'Knob'),
                settings: Object.assign({}, DEFAULTS[kind], payload && payload.settings), lastSvg: null });
            onSettings(contexts.get(context));
            subscriptions();
            draw(context, true);
            break;
        case 'willDisappear': {
            const c = contexts.get(context);
            if (c && c.kind === 'ptt' && c.talking) pttUp(c);
            contexts.delete(context);
            subscriptions();
            break;
        }
        case 'didReceiveSettings':
            setSettings(context, payload && payload.settings);
            break;
        case 'propertyInspectorDidAppear':
            inspectors.set(context, action);
            subscriptions();
            sendState(context, action);
            break;
        case 'propertyInspectorDidDisappear':
            inspectors.delete(context);
            subscriptions();
            break;
        case 'sendToPlugin':
            if (!payload) return;
            if (payload.type === 'hello') { inspectors.set(context, action); subscriptions(); sendState(context, action); }
            else if (payload.type === 'settings') setSettings(context, payload.settings);
            else if (payload.type === 'saveProfiles' && Array.isArray(payload.profiles)) { setProfiles(payload.profiles); saveGlobal(); drawAll(); broadcast(); }
            else if (payload.type === 'saveAuto') {
                if (Array.isArray(payload.rules)) autoRules = payload.rules.filter(r => r && r.exe).map(r => ({ exe: String(r.exe).toLowerCase(), name: String(r.name || '').slice(0, 30), profile: String(r.profile || '') }));
                if (typeof payload.enabled === 'boolean') autoEnabled = payload.enabled;
                saveGlobal(); subscriptions(); checkAuto(); drawAll(); broadcast();
            }
            else if (payload.type === 'icon' && payload.query) askIcon(String(payload.query), true);
            else if (payload.type === 'refresh') { helperSend('list'); helperSend('apps on'); }
            break;
        case 'keyDown': pressDown(context, payload || {}); break;
        case 'keyUp': pressUp(context, payload || {}); break;
        case 'dialDown': pressDown(context, {}); break;
        case 'dialUp': pressUp(context, {}); break;
        case 'dialPress': (payload && payload.pressed === false ? pressUp : pressDown)(context, {}); break; // older SDKs
        case 'dialRotate': rotate(context, (payload && payload.ticks) || 0); break;
    }
});

function setSettings(context, s) {
    const c = contexts.get(context);
    if (!c || !s) return;
    c.settings = Object.assign({}, DEFAULTS[c.kind], s);
    onSettings(c);
    subscriptions();
    draw(context, true);
}
// side effects of a key's settings
// Older settings windows saved the URL-encoded full path (C%3a%5c...%5capp.exe) as the program name
function cleanExe(v) {
    let x = String(v || '');
    try { x = decodeURIComponent(x); } catch (_) {}
    return { exe: x.split(/[\\/]/).pop().toLowerCase(), path: /[\\/]/.test(x) ? x : '' };
}
function onSettings(c) {
    const s = c.settings;
    if (s.app && s.app !== FOLLOW && /[%\\/]/.test(s.app)) {
        const e = cleanExe(s.app);
        s.app = e.exe; s.appPath = s.appPath || e.path;
        if (!s.appName || /[%\\/]/.test(s.appName)) s.appName = e.exe.replace(/\.exe$/, '').replace(/^./, ch => ch.toUpperCase());
    }
    if (c.kind === 'appvol' && s.app && s.app !== FOLLOW) askIcon(s.appPath || s.app);
    if (c.kind === 'ptt' && s.mode === 'mute' && helperOk && !c.talking) helperSend('mute 1'); // push-to-talk starts muted
}

// ---------- global settings: profiles and auto profile rules ----------
const backupFile = path.join(os.homedir(), '.audioprofiles-streamdock.json');
try {
    const b = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    if (Array.isArray(b.profiles)) profiles = b.profiles;
    if (Array.isArray(b.autoRules)) autoRules = b.autoRules;
    if (typeof b.autoEnabled === 'boolean') autoEnabled = b.autoEnabled;
    if (b.focus && b.focus.on) focus = b.focus; // the plugin was closed in focus mode: keep the volumes to restore
} catch (_) {}
const iconFile = path.join(os.homedir(), '.audioprofiles-icons.json');
try { Object.assign(icons, JSON.parse(fs.readFileSync(iconFile, 'utf8'))); } catch (_) {}

function setProfiles(list) {
    profiles = list.map(p => ({
        id: String(p.id || ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
        name: String(p.name || 'Profile').slice(0, 40),
        output: p.output || '', outputName: p.outputName || '',
        mic: p.mic || '', micName: p.micName || '',
        icon: p.icon || 'headset', color: p.color || '#a77bff',
    }));
}
function saveGlobal() {
    send({ event: 'setGlobalSettings', context: pluginUUID, payload: { profiles, autoRules, autoEnabled } });
    saveBackup();
}
function saveBackup() {
    try { fs.writeFileSync(backupFile, JSON.stringify({ profiles, autoRules, autoEnabled, focus }, null, 2)); } catch (_) {}
}
const profileById = (id) => profiles.find(p => p.id === id) || null;

// ---------- audio helper ----------
let helper = null, helperRestarts = 0, subs = {};
function startHelper() {
    let cmd = path.join(__dirname, '..', 'bin', 'apmhelper.exe'), args = [];
    if (process.env.APM_HELPER) { const parts = process.env.APM_HELPER.split(' '); cmd = parts[0]; args = parts.slice(1); }
    if (process.platform !== 'win32' && !process.env.APM_HELPER) { log('Windows only'); return; }
    try {
        helper = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { log('helper spawn failed', String(e)); helper = null; return; }
    subs = {};
    readline.createInterface({ input: helper.stdout }).on('line', line => {
        let m; try { m = JSON.parse(line); } catch (_) { return; }
        if (m.type === 'state') onState(m);
        else if (m.type === 'apps') onApps(m.apps || []);
        else if (m.type === 'meter') onMeter(+m.peak || 0);
        else if (m.type === 'procs') { procs = new Set(m.list || []); onProcs(); checkAuto(); drawAll(); }
        else if (m.type === 'icon') onIcon(m);
        else if (m.type === 'error') log('helper', m);
    });
    helper.stderr.on('data', d => log('helper stderr', d.toString().slice(0, 300)));
    helper.on('error', e => log('helper error', String(e)));
    helper.stdin.on('error', e => log('helper stdin', String(e)));
    helper.on('exit', code => {
        log('helper exit', code);
        helper = null; helperOk = false; drawAll();
        if (helperRestarts++ < 20) setTimeout(startHelper, Math.min(30000, 1000 * helperRestarts));
    });
    subscriptions();
}
function helperSend(line) {
    if (helper && helper.stdin.writable) helper.stdin.write(line + '\n');
}
function stopHelper() { if (helper) { try { helper.stdin.end(); helper.kill(); } catch (_) {} } }

// Ask the helper only for what the visible keys need: the program list, the mic level, running programs.
function subscriptions() {
    if (!helper) return;
    const kinds = new Set([...contexts.values()].map(c => c.kind));
    const apps = kinds.has('appvol') || kinds.has('appswitch') || kinds.has('focus') || focus.on || inspectors.size > 0;
    const want = {
        apps,
        meter: kinds.has('meter'),
        watch: autoEnabled && autoRules.length > 0, // running programs, for auto profile
    };
    for (const k of Object.keys(want)) {
        if (subs[k] === want[k]) continue;
        subs[k] = want[k];
        helperSend(k + (want[k] ? ' on' : ' off'));
        if (k === 'meter' && !want[k]) mic.level = mic.peak = 0;
        if (k === 'watch' && !want[k]) { procs = new Set(); checkAuto(); }
    }
}

function onState(m) {
    const first = !helperOk;
    audio = m; helperOk = true; helperRestarts = 0;
    trackHistory();
    if (first) for (const c of contexts.values()) onSettings(c);
    drawAll(); broadcast();
}
function onApps(list) {
    apps = list;
    for (const a of apps) askIcon(a.exe);
    if (focus.on) applyFocus();
    drawAll(); broadcast();
}
function onIcon(m) {
    const png = m.png || '';
    for (const k of [m.exe, m.query]) if (k) icons[String(k).toLowerCase()] = png;
    try { fs.writeFileSync(iconFile, JSON.stringify(icons)); } catch (_) {}
    drawAll(); broadcast();
}
// icons come from the exe on this PC, once per program; a full path works even when the program is closed
function askIcon(query, force) {
    const q = String(query || '').toLowerCase();
    if (!q || (!force && (q in icons || iconAsked.has(q)))) return;
    iconAsked.add(q);
    helperSend('icon ' + query);
}
const iconOf = (exe, p) => icons[String(exe || '').toLowerCase()] || (p ? icons[String(p).toLowerCase()] : '') || '';

// ---------- device lookup ----------
// By ID first; if Windows changed the ID (plugged into another port), by name.
function resolve(list, id, name) {
    if (!id && !name) return null;
    return list.find(d => d.id === id) || (name ? list.find(d => d.name === name) : null) || null;
}
const shortName = (d, fallback) => (d && (d.iface || d.desc || d.name)) || fallback || '';
const defaultOut = () => audio.render.find(d => d.id === audio.defRender) || null;
const defaultMic = () => audio.capture.find(d => d.id === audio.defCapture) || null;
const alert = (context) => send({ event: 'showAlert', context });
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

function profileState(p) {
    if (!p) return { active: false, out: null, mic: null };
    const out = resolve(audio.render, p.output, p.outputName);
    const m = p.mic || p.micName ? resolve(audio.capture, p.mic, p.micName) : null;
    const active = !!out && out.id === audio.defRender && (!(p.mic || p.micName) || (!!m && m.id === audio.defCapture));
    return { active, out, mic: m };
}
function activateProfile(p, context) {
    if (!p) return context && alert(context);
    const st = profileState(p);
    if (!st.out && (p.output || p.outputName)) { log('profile output missing', p.name); return context && alert(context); }
    if (st.out) helperSend('set ' + st.out.id);
    if (p.mic || p.micName) {
        if (st.mic) helperSend('set ' + st.mic.id);
        else log('profile mic missing', p.name);
    }
}

// ---------- volume (devices and programs) ----------
function volOf(key, real) {
    const p = pending[key];
    return p && Date.now() < p.until ? p.vol : real;
}
function setPending(key, vol) { pending[key] = { vol, until: Date.now() + 900 }; }
function endpoint(target) { return target === 'mic' ? defaultMic() : defaultOut(); }

function turnDevice(target, ticks, step) {
    const d = endpoint(target);
    if (!d) return false;
    const key = target === 'mic' ? 'c' : 'r';
    const v = clamp(volOf(key, d.vol || 0) + ticks * step);
    setPending(key, v);
    helperSend(`vol ${key} ${v} ${d.id}`);
    if (d.muted && ticks > 0) helperSend('mute 0 ' + d.id); // turning up unmutes, like the Windows volume keys
    return true;
}
function muteDevice(target) {
    const d = endpoint(target);
    if (!d) return false;
    helperSend('mute t ' + d.id);
    return true;
}
const appByExe = (exe) => apps.find(a => a.exe === String(exe || '').toLowerCase()) || null;
function turnApp(exe, ticks, step) {
    const a = appByExe(exe);
    if (!a) return false;
    const key = 'app:' + a.exe;
    const v = clamp(volOf(key, a.vol) + ticks * step);
    setPending(key, v);
    helperSend(`appvol ${v} ${a.exe}`);
    if (a.muted && ticks > 0) helperSend('appmute 0 ' + a.exe);
    return true;
}
function muteApp(exe) {
    const a = appByExe(exe);
    if (!a) return false;
    helperSend('appmute t ' + a.exe);
    return true;
}

// A program shows up in the Windows mixer only while it has sound open (Chrome and Discord close it when quiet),
// so a program that is not in the mixer is shown as SILENT: closed or quiet, it cannot be changed right now.
const isRunning = (exe) => procs.has(String(exe || '').toLowerCase());
const appState = () => 'SILENT';
const titleOf = (exe) => { const t = String(exe || '').replace(/\.exe$/i, ''); return t ? t[0].toUpperCase() + t.slice(1) : ''; };
function wantedExes() {
    const set = new Set();
    for (const c of contexts.values()) {
        if (c.kind === 'appvol' && c.settings.app && c.settings.app !== FOLLOW) set.add(c.settings.app.toLowerCase());
        if (c.kind === 'appswitch') switchList(c.settings).forEach(x => set.add(x.exe));
    }
    return set;
}
// a program chosen before it ever ran has no icon yet: look again once it starts
function onProcs() {
    for (const exe of wantedExes()) {
        if (!isRunning(exe)) { iconRetry.delete(exe); continue; }
        if (!icons[exe] && !iconRetry.has(exe)) { iconRetry.add(exe); askIcon(exe, true); }
    }
}

// ---------- App Switcher ----------
function switchList(s) {
    const wanted = String(s.apps || '').split(/[,;\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!wanted.length) return apps.map(a => ({ exe: a.exe, name: a.name, app: a }));
    return wanted.map(exe => { const a = appByExe(exe); return { exe, name: a ? a.name : titleOf(exe), app: a }; });
}
const FOLLOW = '@switcher';
// The program App Volume works on: its own, or the one chosen on App Switcher.
function appTarget(s) {
    if (s.app !== FOLLOW) return s.app ? { exe: s.app, name: s.appName, path: s.appPath } : null;
    const sw = [...contexts.values()].find(c => c.kind === 'appswitch');
    const { cur } = switchCurrent(sw ? sw.settings : {});
    return cur ? { exe: cur.exe, name: cur.name, path: '' } : null;
}
// App Switcher: turn or tap to move through its programs.
function switchMove(s, step) {
    const { list, i } = switchCurrent(s);
    if (!list.length) return false;
    switchSel = list[((i + step) % list.length + list.length) % list.length].exe;
    for (const [ctx, c] of contexts) if (c.kind === 'appswitch' || (c.kind === 'appvol' && c.settings.app === FOLLOW)) draw(ctx);
    broadcast();
    return true;
}
function switchCurrent(s) {
    const list = switchList(s);
    let i = list.findIndex(x => x.exe === switchSel);
    if (i < 0) i = 0;
    return { list, i, cur: list[i] || null };
}

// ---------- Push to talk ----------
function pttDown(c) {
    c.talking = true;
    if (c.settings.mode === 'mute') helperSend('mute 0');
    else helperSend(`key ${vkOf(c.settings.key)} down`);
}
function pttUp(c) {
    c.talking = false;
    if (c.settings.mode === 'mute') helperSend('mute 1');
    else helperSend(`key ${vkOf(c.settings.key)} up`);
}
function releasePtt() { for (const c of contexts.values()) if (c.kind === 'ptt' && c.talking) pttUp(c); }

// ---------- Auto profile ----------
function checkAuto() {
    const rule = autoEnabled ? autoRules.find(r => procs.has(r.exe) && profileById(r.profile)) : null;
    if (rule) {
        if (!auto) auto = { exe: '', prev: { render: audio.defRender, capture: audio.defCapture } };
        if (auto.exe !== rule.exe) {
            auto.exe = rule.exe;
            log('auto profile on', rule.exe);
            activateProfile(profileById(rule.profile));
        }
    } else if (auto) {
        // the game closed: give back the devices that were default before it started
        log('auto profile off', auto.exe);
        const { render, capture } = auto.prev;
        auto = null;
        if (render && audio.render.some(d => d.id === render) && render !== audio.defRender) helperSend('set ' + render);
        if (capture && audio.capture.some(d => d.id === capture) && capture !== audio.defCapture) helperSend('set ' + capture);
    }
    drawAll();
}

// ---------- Previous profile ----------
// A profile switch changes output and mic one after the other, so a pair counts only after it holds for a moment.
function trackHistory() {
    const now = { render: audio.defRender, capture: audio.defCapture };
    if (!committed) { committed = now; return; }
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
        const cur = { render: audio.defRender, capture: audio.defCapture };
        if (cur.render === committed.render && cur.capture === committed.capture) return;
        history = history.filter(h => !(h.render === committed.render && h.capture === committed.capture));
        history.push(committed);
        if (history.length > 10) history.shift();
        committed = cur;
        drawAll();
    }, 700);
}
function previousPair() {
    for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.render !== audio.defRender || h.capture !== audio.defCapture) return h;
    }
    return null;
}
function goPrevious(context) {
    const h = previousPair();
    if (!h) return alert(context);
    const out = audio.render.find(d => d.id === h.render), m = audio.capture.find(d => d.id === h.capture);
    if (!out && !m) return alert(context);
    if (out && out.id !== audio.defRender) helperSend('set ' + out.id);
    if (m && m.id !== audio.defCapture) helperSend('set ' + m.id);
}

// ---------- Focus mode ("Discord only") ----------
function applyFocus() {
    for (const a of apps) {
        if (a.exe === focus.app || focus.saved[a.exe]) continue;
        focus.saved[a.exe] = { vol: a.vol, muted: a.muted };
        if (focus.mode === 'mute') { if (!a.muted) helperSend('appmute 1 ' + a.exe); }
        else if (a.vol > focus.level) helperSend(`appvol ${focus.level} ${a.exe}`);
    }
    saveBackup();
}
function toggleFocus(s) {
    if (!focus.on) {
        focus = { on: true, app: String(s.app || 'discord.exe').toLowerCase(), mode: s.mode === 'mute' ? 'mute' : 'duck', level: clamp(+s.level || 20), saved: {} };
        subscriptions();
        applyFocus();
    } else {
        for (const [exe, v] of Object.entries(focus.saved)) {
            if (!appByExe(exe)) continue;
            if (focus.mode === 'mute') { if (!v.muted) helperSend('appmute 0 ' + exe); }
            else helperSend(`appvol ${v.vol} ${exe}`);
        }
        focus = { on: false, app: '', mode: 'duck', level: 20, saved: {} };
        saveBackup();
        subscriptions();
    }
    drawAll();
}

// ---------- Mic level ----------
function onMeter(peak) {
    const t = Date.now();
    mic.level = Math.max(peak, mic.level * 0.75);      // fast attack, smooth fall
    if (peak >= mic.peak || t - mic.peakAt > 1000) { mic.peak = peak; mic.peakAt = t; } // peak holds for a second
    if (t - mic.drawn < 90) return;                      // about 10 frames a second
    mic.drawn = t;
    for (const [ctx, c] of contexts) if (c.kind === 'meter') draw(ctx);
}

// ---------- presses ----------
// Keys and knob presses share this: a short press is a tap, 0.5 s is a hold.
function pressDown(context, payload) {
    const c = contexts.get(context);
    if (!c) return;
    if (c.kind === 'ptt') { pttDown(c); return draw(context); }
    if (payload.isInMultiAction) { c.multiDone = true; tap(c, context); return; } // no hold inside a Multi Action
    c.held = false; c.multiDone = false;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.held = true; hold(c, context); }, HOLD_MS);
}
function pressUp(context, payload) {
    const c = contexts.get(context);
    if (!c) return;
    if (c.kind === 'ptt') { if (c.talking) pttUp(c); return draw(context); }
    clearTimeout(c.timer);
    if (c.multiDone) { c.multiDone = false; return; }
    if (payload.isInMultiAction || !c.held) tap(c, context);
}
function rotate(context, ticks) {
    const c = contexts.get(context);
    if (!c || !ticks) return;
    const s = c.settings, step = Math.max(1, Math.min(10, +s.step || 2));
    let ok = true;
    if (c.kind === 'volume') ok = turnDevice(s.target, ticks, step);
    else if (c.kind === 'appvol') { const t = appTarget(s); ok = !!t && turnApp(t.exe, ticks, step); }
    else if (c.kind === 'appswitch') { switchMove(s, ticks > 0 ? 1 : -1); return; }
    else return;
    if (!ok) return;
    glow(null, context);
}
// Keys showing the same thing light up together while a knob turns.
function glow(kind, context) {
    const until = Date.now() + GLOW_MS;
    const src = contexts.get(context);
    for (const [ctx, c] of contexts) {
        const key = (x) => x.kind === 'appvol' ? (appTarget(x.settings) || {}).exe : x.settings.target;
        const same = ctx === context || (kind ? c.kind === kind : (c.kind === src.kind && key(c) === key(src)));
        if (!same) continue;
        c.glowUntil = until;
        draw(ctx);
        clearTimeout(c.glowTimer);
        c.glowTimer = setTimeout(() => draw(ctx), GLOW_MS + 50);
    }
}

function tap(c, context) {
    const s = c.settings;
    switch (c.kind) {
        case 'output': {
            const d = resolve(audio.render, s.device, s.deviceName);
            return d ? helperSend('set ' + d.id) : alert(context);
        }
        case 'mic': {
            const d = resolve(audio.capture, s.device, s.deviceName);
            return d ? helperSend('set ' + d.id) : alert(context);
        }
        case 'toggle': {
            const a = profileById(s.a), b = profileById(s.b);
            if (!a && !b) return alert(context);
            const target = profileState(a).active ? (b || a) : (a || b);
            return activateProfile(target, context);
        }
        case 'profile':
            return activateProfile(profileById(s.profile), context);
        case 'mute':
        case 'meter':
            return audio.defCapture ? helperSend('mute t') : alert(context);
        case 'volume':
            return muteDevice(s.target) || alert(context);
        case 'appvol': {
            const t = appTarget(s);
            return (t && muteApp(t.exe)) || alert(context);
        }
        case 'appswitch':
            // knob press mutes the chosen program; a key has no turn, so a tap moves to the next one
            if (c.knob) { const { cur } = switchCurrent(s); return (cur && muteApp(cur.exe)) || alert(context); }
            return switchMove(s, 1) || alert(context);
        case 'autoprofile':
            if (!autoRules.length) return alert(context);
            autoEnabled = !autoEnabled;
            saveGlobal(); subscriptions(); checkAuto(); broadcast();
            return;
        case 'previous':
            return goPrevious(context);
        case 'focus':
            return toggleFocus(s);
    }
}

function hold(c, context) {
    const s = c.settings;
    if (c.kind === 'mic') {
        const d = resolve(audio.capture, s.device, s.deviceName);
        return d ? helperSend('mute t ' + d.id) : alert(context);
    }
    if (c.kind === 'toggle') return audio.defCapture ? helperSend('mute t') : alert(context);
    if (c.kind === 'appswitch') { const { cur } = switchCurrent(s); return (cur && muteApp(cur.exe)) || alert(context); }
    // for other actions a hold is a normal press
    tap(c, context);
}

// ---------- drawing ----------
const OFFLINE_ICON = { mic: 'mic', mute: 'mic', meter: 'mic', ptt: 'mic', appvol: 'mixer', appswitch: 'mixer', focus: 'chat', autoprofile: 'gamepad', previous: 'back' };

function image(c) {
    const s = c.settings, glowing = (c.glowUntil || 0) > Date.now();
    if (!helperOk) return R.key({ icon: OFFLINE_ICON[c.kind] || 'speaker', note: process.platform === 'win32' || process.env.APM_HELPER ? '…' : 'WINDOWS', offline: true });
    switch (c.kind) {
        case 'volume': {
            const isMic = s.target === 'mic', d = endpoint(s.target);
            const icon = isMic ? 'mic' : 'speakerSound';
            if (!d) return R.metric({ icon, value: 0, caption: isMic ? 'NO MIC' : 'NO OUTPUT', offline: true });
            return R.metric({ icon, value: volOf(isMic ? 'c' : 'r', d.vol || 0), muted: d.muted, glow: glowing,
                caption: d.desc || shortName(d), color: isMic ? '#4ea1ff' : '#3ddc5a' });
        }
        case 'appvol': {
            const t = appTarget(s);
            if (!t) return R.key({ icon: 'mixer', note: s.app === FOLLOW ? 'NO APPS' : 'SET UP', color: s.color, offline: s.app === FOLLOW });
            const a = appByExe(t.exe), name = t.name || (a && a.name) || t.exe.replace(/\.exe$/i, '');
            const icon = iconOf(t.exe, t.path);
            if (!a) return R.app({ name, icon, running: false, status: appState(t.exe) });
            return R.app({ name, icon, color: s.color, value: volOf('app:' + a.exe, a.vol), muted: a.muted, running: true, glow: glowing });
        }
        case 'appswitch': {
            const { list, i, cur } = switchCurrent(s);
            if (!cur) return R.key({ icon: 'mixer', note: 'NO APPS', offline: true });
            const n = Math.min(list.length, 8);
            const dots = list.length > 1 ? { i: Math.min(i, n - 1), n } : null;
            if (!cur.app) return R.app({ name: cur.name, icon: iconOf(cur.exe), running: false, status: appState(cur.exe), dots });
            return R.app({ name: cur.name, icon: iconOf(cur.exe), value: volOf('app:' + cur.exe, cur.app.vol), muted: cur.app.muted, running: true, dots, color: '#3ddc5a' });
        }
        case 'meter': {
            const m = defaultMic();
            return R.meter({ level: mic.level, peak: mic.peak, muted: !!(m && m.muted), offline: !m });
        }
        case 'ptt': {
            if (s.mode === 'mute') {
                const m = defaultMic();
                if (!m) return R.key({ icon: 'mic', note: 'NO MIC', offline: true });
                if (c.talking || !m.muted) return R.key({ icon: 'mic', label: 'Live', color: '#3ddc5a', active: true });
                return R.key({ icon: 'mic', label: 'Push to talk', muted: true });
            }
            if (c.talking) return R.key({ icon: 'chat', label: 'Talking', color: '#3ddc5a', active: true });
            return R.key({ icon: 'chat', label: s.label || 'Push to talk', color: '#a77bff' });
        }
        case 'autoprofile': {
            if (!autoRules.length) return R.key({ icon: 'gamepad', note: 'SET UP', color: '#4ea1ff' });
            if (!autoEnabled) return R.key({ icon: 'gamepad', label: 'Auto', caption: 'off', color: '#4ea1ff' });
            if (auto && auto.exe) {
                const r = autoRules.find(x => x.exe === auto.exe), p = r && profileById(r.profile);
                return R.key({ icon: 'gamepad', label: (r && r.name) || auto.exe.replace(/\.exe$/, ''), caption: p ? '→ ' + p.name : '', color: p ? p.color : '#a77bff', active: true });
            }
            return R.key({ icon: 'gamepad', label: 'Auto', caption: 'waiting', color: '#4ea1ff' });
        }
        case 'previous': {
            const h = previousPair();
            if (!h) return R.key({ icon: 'back', note: 'NO HISTORY', offline: true });
            const p = profiles.find(x => { const o = resolve(audio.render, x.output, x.outputName); const m = x.mic || x.micName ? resolve(audio.capture, x.mic, x.micName) : null; return o && o.id === h.render && (!m || m.id === h.capture); });
            if (p) return R.key({ icon: p.icon, label: s.showName ? p.name : '', color: p.color, badge: 'previous' });
            const out = audio.render.find(d => d.id === h.render) || audio.capture.find(d => d.id === h.capture);
            return R.key({ icon: out ? R.autoIcon(out, audio.render.includes(out) ? 'render' : 'capture') : 'back', label: s.showName ? shortName(out, 'Previous') : '', color: '#3ddc5a', badge: 'previous' });
        }
        case 'focus': {
            const name = s.appName || String(s.app || '').replace(/\.exe$/i, '') || 'Focus';
            if (focus.on) return R.key({ icon: 'chat', label: name + ' only', color: '#a77bff', active: true });
            return R.key({ icon: 'chat', label: 'Focus', color: '#a77bff' });
        }
    }
    return R.key(view(c));
}

// icon/label keys of the 1.0 actions
function view(c) {
    const s = c.settings;
    switch (c.kind) {
        case 'output':
        case 'mic': {
            const flow = c.kind === 'output' ? 'render' : 'capture';
            if (!s.device && !s.deviceName) return { icon: c.kind === 'output' ? 'speaker' : 'mic', color: s.color, note: 'SET UP' };
            const d = resolve(audio[flow], s.device, s.deviceName);
            const icon = s.icon === 'auto' ? R.autoIcon(d || { name: s.deviceName }, flow) : s.icon;
            if (!d) return { icon, color: s.color, offline: true, note: 'OFFLINE' };
            const isDef = d.id === (flow === 'render' ? audio.defRender : audio.defCapture);
            return { icon, color: s.color, active: isDef, muted: flow === 'capture' && d.muted,
                label: s.showName ? (s.name || shortName(d)) : '' };
        }
        case 'toggle': {
            const a = profileById(s.a), b = profileById(s.b);
            if (!a && !b) return { icon: 'swap', color: '#3ddc5a', note: 'SET UP' };
            const cur = profileState(a).active ? a : (profileState(b).active ? b : null);
            const m = defaultMic();
            if (!cur) return { icon: 'swap', color: (a || b).color, active: false, micMuted: !!(m && m.muted), label: s.showName ? 'Custom' : '' };
            return { icon: cur.icon, color: cur.color, active: true, micMuted: !!(m && m.muted), label: s.showName ? cur.name : '' };
        }
        case 'profile': {
            const p = profileById(s.profile);
            if (!p) return { icon: 'headset', color: '#a77bff', note: 'SET UP' };
            const st = profileState(p);
            const missing = !st.out && !!(p.output || p.outputName);
            return { icon: p.icon, color: p.color, active: st.active, offline: missing, note: missing ? 'OFFLINE' : '',
                label: s.showName ? p.name : '' };
        }
        case 'mute': {
            const m = defaultMic();
            if (!m) return { icon: s.icon || 'mic', color: s.color, offline: true, note: 'NO MIC' };
            return { icon: s.icon || 'mic', color: s.color, active: !m.muted, muted: m.muted };
        }
    }
    return { icon: 'speaker' };
}

function draw(context, force) {
    const c = contexts.get(context);
    if (!c) return;
    let svg;
    try { svg = image(c); } catch (e) { log('render', String(e && e.stack || e)); return; }
    if (!force && svg === c.lastSvg) return;
    c.lastSvg = svg;
    send({ event: 'setImage', context, payload: { target: 0, image: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64') } });
}
function drawAll() { for (const ctx of contexts.keys()) draw(ctx); }

// ---------- settings window ----------
function sendState(context, action) {
    const kind = action && action.startsWith(PREFIX) ? action.slice(PREFIX.length) : '';
    const withIcons = ['appvol', 'appswitch', 'focus'].includes(kind);
    send({ event: 'sendToPropertyInspector', action, context, payload: {
        type: 'state', helperOk, profiles, autoRules, autoEnabled,
        render: audio.render, capture: audio.capture, defRender: audio.defRender, defCapture: audio.defCapture,
        apps: apps.map(a => ({ exe: a.exe, name: a.name, vol: a.vol, muted: a.muted })),
        icons: withIcons ? icons : {},
        autoActive: auto ? auto.exe : '',
        focusOn: focus.on,
    } });
}
let broadcastTimer = null;
function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => { broadcastTimer = null; for (const [ctx, action] of inspectors) sendState(ctx, action); }, 100);
}

startHelper();
