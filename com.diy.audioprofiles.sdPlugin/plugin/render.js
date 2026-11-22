// Audio Profiles — draws keys as 144×144 SVG, in the Metrics style.
// Runs in Node (the plugin) and in the browser (settings window previews).
(function (root) {
    'use strict';

    const FONT = "'Segoe UI Variable Display', 'Segoe UI', 'SF Pro Display', Arial, sans-serif";
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const BG = '#0a0a0a';

    // ---------- icon library (64×64, outline) ----------
    const SPEAKER = (x, w) => `<rect x="${x}" y="6" width="${w}" height="52" rx="4"/><circle cx="${x + w / 2}" cy="19" r="${w / 7}"/><circle cx="${x + w / 2}" cy="40" r="${w / 2.8}"/><circle cx="${x + w / 2}" cy="40" r="${w / 10}"/>`;
    const PHONES = `<path d="M12 42V32a20 20 0 0 1 40 0v10"/><rect x="8" y="38" width="11" height="17" rx="3.5"/><rect x="45" y="38" width="11" height="17" rx="3.5"/>`;
    const MIC = `<rect x="24" y="5" width="16" height="31" rx="8"/><path d="M14 29a18 18 0 0 0 36 0M32 47v11M23 58h18"/>`;
    const ICONS = {
        speaker: { name: 'Speaker', svg: SPEAKER(18, 28) },
        speakers: { name: 'Speaker pair', svg: SPEAKER(5, 24) + SPEAKER(35, 24) },
        monitor: { name: 'Monitor', svg: `<rect x="5" y="10" width="54" height="35" rx="3"/><path d="M32 45v10M20 56h24"/>` },
        headphones: { name: 'Headphones', svg: PHONES },
        headset: { name: 'Headset', svg: PHONES + `<path d="M50 54c0 5-5 7-11 7h-3"/><rect x="28" y="57" width="9" height="7" rx="2.5"/>` },
        wireless: { name: 'Wireless', svg: `<circle cx="32" cy="26" r="4"/><path d="M32 30v26M24 57h16M22 16a14 14 0 0 0 0 20M42 16a14 14 0 0 1 0 20M14 9a24 24 0 0 0 0 34M50 9a24 24 0 0 1 0 34"/>` },
        mic: { name: 'Microphone', svg: MIC },
        studiomic: { name: 'Studio mic', svg: `<rect x="21" y="4" width="22" height="34" rx="11"/><path d="M21 15h7M21 21h7M21 27h7M36 15h7M36 21h7M36 27h7M14 30a18 18 0 0 0 36 0M32 48v10M22 58h20"/>` },
        webcam: { name: 'Webcam', svg: `<circle cx="32" cy="25" r="18"/><circle cx="32" cy="25" r="7"/><path d="M19 58h26l-4-12H23z"/>` },
        hdmi: { name: 'HDMI', svg: `<path d="M5 22h54v13l-7 8H12l-7-8z"/><path d="M14 30h36"/>` },
        usb: { name: 'USB', svg: `<path d="M32 8v42M32 4l-5 8h10zM32 40L18 31v-7M32 33l14-8v-6"/><rect x="15" y="18" width="6" height="6"/><circle cx="46" cy="16" r="3"/><circle cx="32" cy="55" r="4.5"/>` },
        jack: { name: 'Audio jack', svg: `<path d="M32 4l-3 6v13h6V10z"/><rect x="26" y="23" width="12" height="8" rx="1"/><path d="M29 31v15h6V31"/><rect x="25" y="46" width="14" height="14" rx="2"/>` },
        mixer: { name: 'Mixer', svg: `<path d="M16 6v52M32 6v52M48 6v52"/><rect x="10" y="34" width="12" height="9" rx="2" fill="${BG}"/><rect x="26" y="14" width="12" height="9" rx="2" fill="${BG}"/><rect x="42" y="40" width="12" height="9" rx="2" fill="${BG}"/>` },
        gamepad: { name: 'Gamepad', svg: `<path d="M24 6h16v18h18v16H40v18H24V40H6V24h18z"/><path d="M27 27l10 10M37 27L27 37"/>` },
        swap: { name: 'Swap', svg: `<path d="M51 27a20 20 0 0 0-37-6M13 37a20 20 0 0 0 37 6M13 9v12h12M51 55V43H39"/>` },
        tv: { name: 'TV', svg: `<rect x="5" y="14" width="54" height="36" rx="4"/><path d="M24 4l8 10 8-10M18 56h28"/>` },
        speakerSound: { name: 'Volume', svg: `<path d="M8 24h10l14-12v40L18 40H8z"/><path d="M42 22a14 14 0 0 1 0 20M49 15a24 24 0 0 1 0 34"/>` },
    };
    const ICON_ORDER = ['speaker', 'speakers', 'monitor', 'tv', 'headphones', 'headset', 'wireless', 'mic', 'studiomic', 'webcam', 'hdmi', 'usb', 'jack', 'mixer', 'gamepad', 'swap', 'speakerSound'];

    // Icon from the Windows device type (EndpointFormFactor) and name.
    function autoIcon(dev, flow) {
        const n = ((dev && (dev.name + ' ' + (dev.iface || ''))) || '').toLowerCase();
        if (/cam|\u043a\u0430\u043c\u0435\u0440/.test(n)) return 'webcam';
        if (/headset|\u0433\u0430\u0440\u043d\u0456\u0442\u0443\u0440/.test(n)) return 'headset';
        if (!dev) return flow === 'capture' ? 'mic' : 'speaker';
        if (flow === 'capture') return dev.ff === 5 || dev.ff === 6 ? 'headset' : 'mic';
        switch (dev.ff) {
            case 3: return 'headphones';
            case 5: case 6: return 'headset';
            case 8: return /tv|lg|samsung|sony|philips/.test(n) ? 'tv' : 'monitor';
            case 2: case 7: return 'jack';
            case 0: return 'wireless';
            default: return /headphone|\u043d\u0430\u0432\u0443\u0448\u043d\u0438\u043a|buds|airpods/.test(n) ? 'headphones' : 'speaker';
        }
    }

    function iconSvg(name, color, x, y, size, opacity) {
        const ic = ICONS[name] || ICONS.speaker;
        const s = size / 64;
        return `<g transform="translate(${x} ${y}) scale(${s.toFixed(4)})" fill="none" stroke="${color}" stroke-width="${(3.2 / s * (size / 64)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}">${ic.svg}</g>`;
    }

    // ---------- key frame (as in Metrics) ----------
    function frame(inner, defs) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
            `<defs><linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="0.55" stop-color="#0a0a0a"/><stop offset="0.75" stop-color="#1b1b1b"/><stop offset="1" stop-color="#050505"/></linearGradient>${defs || ''}</defs>` +
            `<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#sheen)"/>` +
            `<rect x="1" y="1" width="142" height="142" rx="21" fill="none" stroke="#2c2c2c" stroke-width="2"/>` +
            inner + `</svg>`;
    }

    // LED strip under the icon: bright with a glow when active, faint when not.
    function led(color, on, y) {
        const x = 40, w = 64, h = 8;
        if (!on) {
            return { defs: '', body: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${color}" fill-opacity="0.2"/>` };
        }
        return {
            defs: `<radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${color}" stop-opacity="0.55"/><stop offset="0.6" stop-color="${color}" stop-opacity="0.12"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`,
            body: `<ellipse cx="72" cy="${y + h / 2}" rx="58" ry="20" fill="url(#halo)"/>` +
                `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${color}"/>` +
                `<rect x="${x + 6}" y="${y + 2}" width="${w - 12}" height="2.5" rx="1.25" fill="#ffffff" fill-opacity="0.45"/>`,
        };
    }

    // ---------- key ----------
    // o = { icon, color, active, muted, micMuted, offline, label, note }
    //   muted   — cross out the icon and light the LED red
    //   offline — device disconnected: dim icon, grey LED
    //   note    — small caption instead of the name (SET UP, OFFLINE)
    function key(o) {
        const text = o.note || o.label || '';
        const iconSize = text ? 58 : 70;
        const iconY = text ? 18 : 22;
        const ledY = 118;
        const dim = o.offline || o.note === 'SET UP';
        const iconColor = dim ? '#8a8a8a' : '#ffffff';
        const ledColor = o.offline ? '#555555' : (o.muted ? '#ff3b30' : (o.color || '#3ddc5a'));
        const l = led(ledColor, !o.offline && (o.active || o.muted), ledY);
        let body = l.body + iconSvg(o.icon, iconColor, 72 - iconSize / 2, iconY, iconSize, dim ? 0.45 : 1);
        if (o.muted) {
            const cx = 72, cy = iconY + iconSize / 2, r = iconSize * 0.42;
            body += `<path d="M${cx - r} ${cy - r}L${cx + r} ${cy + r}" stroke="${BG}" stroke-width="10" stroke-linecap="round"/>` +
                `<path d="M${cx - r} ${cy - r}L${cx + r} ${cy + r}" stroke="#ff3b30" stroke-width="5" stroke-linecap="round"/>`;
        }
        if (o.micMuted) { // small "mic muted" badge in the corner, the profile icon stays clean
            body += `<circle cx="116" cy="28" r="15" fill="#ff3b30"/>` +
                `<g transform="translate(106.5 18.5) scale(0.297)" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${ICONS.mic.svg}<path d="M8 8L56 56"/></g>`;
        }
        if (text) {
            let t = String(text);
            if (t.length > 13) t = t.slice(0, 12) + '…';
            const sz = t.length > 10 ? 14 : 16;
            body += `<text x="72" y="${iconY + iconSize + 22}" font-family="${FONT}" font-size="${sz}" font-weight="600" fill="${o.note ? '#9b9b9b' : '#d8d8d8'}" text-anchor="middle" letter-spacing="0.5">${esc(t)}</text>`;
        }
        return frame(body, l.defs);
    }

    const LED_COLORS = [
        ['#3ddc5a', 'Green'], ['#4ea1ff', 'Blue'], ['#a77bff', 'Purple'], ['#2ee6d6', 'Teal'],
        ['#ffd21f', 'Yellow'], ['#ff9f1a', 'Orange'], ['#ff3b30', 'Red'], ['#ff5fb8', 'Pink'], ['#ffffff', 'White'],
    ];

    const api = { key, autoIcon, ICONS, ICON_ORDER, LED_COLORS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.APMRender = api;
})(this);
