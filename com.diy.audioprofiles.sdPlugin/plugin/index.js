// Audio Profiles — Stream Dock plugin: switch Windows audio devices and profiles
// with live LED indicators that always show the real system state.
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
};
const HOLD_MS = 500;

// ---------- state ----------
let audio = { render: [], capture: [], defRender: '', defCapture: '' };
let helperOk = false;
let profiles = [];
const contexts = new Map();   // context -> { kind, settings, lastSvg, timer, held, multiDone }
const inspectors = new Map(); // context -> action (open settings windows)

// ---------- Stream Dock ----------
const ws = new WebSocket('ws://127.0.0.1:' + port);
const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

ws.on('open', () => {
    send({ event: registerEvent, uuid: pluginUUID });
    send({ event: 'getGlobalSettings', context: pluginUUID });
    log('registered');
});
ws.on('close', () => { stopHelper(); process.exit(0); });
ws.on('error', e => log('ws error', String(e)));
ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    const { event, action, context, payload } = m;
    const kind = action && action.startsWith(PREFIX) ? action.slice(PREFIX.length) : null;
    switch (event) {
        case 'didReceiveGlobalSettings': {
            const p = payload && payload.settings && payload.settings.profiles;
            if (Array.isArray(p) && p.length) profiles = p;
            else if (profiles.length) saveProfiles(profiles); // move the backup copy into Stream Dock
            drawAll(); broadcast();
            break;
        }
        case 'willAppear':
            if (!DEFAULTS[kind]) return;
            contexts.set(context, { kind, settings: Object.assign({}, DEFAULTS[kind], payload && payload.settings), lastSvg: null });
            draw(context, true);
            break;
        case 'willDisappear':
            contexts.delete(context);
            break;
        case 'didReceiveSettings':
            setSettings(context, payload && payload.settings);
            break;
        case 'propertyInspectorDidAppear':
            inspectors.set(context, action);
            sendState(context, action);
            break;
        case 'propertyInspectorDidDisappear':
            inspectors.delete(context);
            break;
        case 'sendToPlugin':
            if (!payload) return;
            if (payload.type === 'hello') { inspectors.set(context, action); sendState(context, action); }
            else if (payload.type === 'settings') setSettings(context, payload.settings);
            else if (payload.type === 'saveProfiles' && Array.isArray(payload.profiles)) { saveProfiles(payload.profiles); drawAll(); broadcast(); }
            else if (payload.type === 'refresh') helperSend('list');
            break;
        case 'keyDown': keyDown(context, payload || {}); break;
        case 'keyUp': keyUp(context, payload || {}); break;
    }
});

function setSettings(context, s) {
    const c = contexts.get(context);
    if (!c || !s) return;
    c.settings = Object.assign({}, DEFAULTS[c.kind], s);
    draw(context, true);
}

// ---------- profiles ----------
const backupFile = path.join(os.homedir(), '.audioprofiles-streamdock.json');
try { const b = JSON.parse(fs.readFileSync(backupFile, 'utf8')); if (Array.isArray(b.profiles)) profiles = b.profiles; } catch (_) {}

function saveProfiles(list) {
    profiles = list.map(p => ({
        id: String(p.id || ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
        name: String(p.name || 'Profile').slice(0, 40),
        output: p.output || '', outputName: p.outputName || '',
        mic: p.mic || '', micName: p.micName || '',
        icon: p.icon || 'headset', color: p.color || '#a77bff',
    }));
    send({ event: 'setGlobalSettings', context: pluginUUID, payload: { profiles } });
    try { fs.writeFileSync(backupFile, JSON.stringify({ profiles }, null, 2)); } catch (_) {}
}
const profileById = (id) => profiles.find(p => p.id === id) || null;

// ---------- audio helper ----------
let helper = null, helperRestarts = 0;
function startHelper() {
    let cmd = path.join(__dirname, '..', 'bin', 'apmhelper.exe'), args = [];
    if (process.env.APM_HELPER) { const parts = process.env.APM_HELPER.split(' '); cmd = parts[0]; args = parts.slice(1); }
    if (process.platform !== 'win32' && !process.env.APM_HELPER) { log('Windows only'); return; }
    try {
        helper = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { log('helper spawn failed', String(e)); helper = null; return; }
    readline.createInterface({ input: helper.stdout }).on('line', line => {
        let m; try { m = JSON.parse(line); } catch (_) { return; }
        if (m.type === 'state') {
            audio = m; helperOk = true; helperRestarts = 0;
            drawAll(); broadcast();
        } else if (m.type === 'error') log('helper', m);
    });
    helper.stderr.on('data', d => log('helper stderr', d.toString().slice(0, 300)));
    helper.on('error', e => log('helper error', String(e)));
    helper.stdin.on('error', e => log('helper stdin', String(e)));
    helper.on('exit', code => {
        log('helper exit', code);
        helper = null; helperOk = false; drawAll();
        if (helperRestarts++ < 20) setTimeout(startHelper, Math.min(30000, 1000 * helperRestarts));
    });
}
function helperSend(line) {
    if (helper && helper.stdin.writable) helper.stdin.write(line + '\n');
}
function stopHelper() { if (helper) { try { helper.stdin.end(); helper.kill(); } catch (_) {} } }
startHelper();

// ---------- device lookup ----------
// By ID first; if Windows changed the ID (plugged into another port), by name.
function resolve(list, id, name) {
    if (!id && !name) return null;
    return list.find(d => d.id === id) || (name ? list.find(d => d.name === name) : null) || null;
}
const shortName = (d, fallback) => (d && (d.iface || d.desc || d.name)) || fallback || '';

function profileState(p) {
    if (!p) return { active: false, out: null, mic: null };
    const out = resolve(audio.render, p.output, p.outputName);
    const mic = p.mic || p.micName ? resolve(audio.capture, p.mic, p.micName) : null;
    const active = !!out && out.id === audio.defRender && (!(p.mic || p.micName) || (!!mic && mic.id === audio.defCapture));
    return { active, out, mic };
}

function activateProfile(p, context) {
    if (!p) return alert(context);
    const st = profileState(p);
    if (!st.out && (p.output || p.outputName)) { log('profile output missing', p.name); return alert(context); }
    if (st.out) helperSend('set ' + st.out.id);
    if (p.mic || p.micName) {
        if (st.mic) helperSend('set ' + st.mic.id);
        else log('profile mic missing', p.name);
    }
}
const defaultMic = () => audio.capture.find(d => d.id === audio.defCapture) || null;
const alert = (context) => send({ event: 'showAlert', context });

// ---------- presses ----------
function keyDown(context, payload) {
    const c = contexts.get(context);
    if (!c) return;
    if (payload.isInMultiAction) { c.multiDone = true; tap(c, context); return; } // no hold inside a Multi Action
    c.held = false; c.multiDone = false;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.held = true; hold(c, context); }, HOLD_MS);
}
function keyUp(context, payload) {
    const c = contexts.get(context);
    if (!c) return;
    clearTimeout(c.timer);
    if (c.multiDone) { c.multiDone = false; return; }
    if (payload.isInMultiAction || !c.held) tap(c, context);
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
            return audio.defCapture ? helperSend('mute t') : alert(context);
    }
}

function hold(c, context) {
    const s = c.settings;
    if (c.kind === 'mic') {
        const d = resolve(audio.capture, s.device, s.deviceName);
        return d ? helperSend('mute t ' + d.id) : alert(context);
    }
    if (c.kind === 'toggle') return audio.defCapture ? helperSend('mute t') : alert(context);
    // for other actions a hold is a normal press
    tap(c, context);
}

// ---------- drawing ----------
function view(c) {
    const s = c.settings;
    if (!helperOk) return { icon: c.kind === 'mic' || c.kind === 'mute' ? 'mic' : 'speaker', note: process.platform === 'win32' || process.env.APM_HELPER ? '…' : 'WINDOWS', offline: true };
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
            const mic = defaultMic();
            if (!cur) return { icon: 'swap', color: (a || b).color, active: false, micMuted: !!(mic && mic.muted), label: s.showName ? 'Custom' : '' };
            return { icon: cur.icon, color: cur.color, active: true, micMuted: !!(mic && mic.muted), label: s.showName ? cur.name : '' };
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
            const mic = defaultMic();
            if (!mic) return { icon: s.icon || 'mic', color: s.color, offline: true, note: 'NO MIC' };
            return { icon: s.icon || 'mic', color: s.color, active: !mic.muted, muted: mic.muted };
        }
    }
    return { icon: 'speaker' };
}

function draw(context, force) {
    const c = contexts.get(context);
    if (!c) return;
    let svg;
    try { svg = R.key(view(c)); } catch (e) { log('render', String(e && e.stack || e)); return; }
    if (!force && svg === c.lastSvg) return;
    c.lastSvg = svg;
    send({ event: 'setImage', context, payload: { target: 0, image: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64') } });
}
function drawAll() { for (const ctx of contexts.keys()) draw(ctx); }

// ---------- settings window ----------
function sendState(context, action) {
    send({ event: 'sendToPropertyInspector', action, context, payload: {
        type: 'state', helperOk, profiles,
        render: audio.render, capture: audio.capture, defRender: audio.defRender, defCapture: audio.defCapture,
    } });
}
function broadcast() { for (const [ctx, action] of inspectors) sendState(ctx, action); }
