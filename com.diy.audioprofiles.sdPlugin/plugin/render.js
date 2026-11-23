// Audio Profiles — draws keys as 144×144 SVG, following the "Audio Key" design system (Figma, 2026-11).
// Tokens: Audio/Label Inter Bold 14, Audio/Value 30, Audio/AppValue 26, Audio/Section 18, MeterValue 16; disabled opacity 38%.
// Runs in Node (the plugin) and in the browser (settings window previews).
// Five layouts share one frame and one LED strip: icon, label, metric, app and meter.
(function (root) {
    'use strict';

    const FONT = "Inter, 'Segoe UI Variable Display', 'Segoe UI', 'SF Pro Display', Arial, sans-serif";
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const BG = '#0a0a0a';
    const TEXT = '#d8d8d8', CAPTION = '#9b9b9b', RED = '#ff3b30', DIM = '#555555';

    // ---------- icon library (64×64, filled) ----------
    // parts: [fill, path, fillRule?]; fill "F" = icon colour, "B" = key background (cut-outs).
    const ICONS = {
        back: { name: "Back", parts: [["F", "M51.4 44C51.4 40.45 49.99 37.04 47.48 34.52C44.96 32.01 41.56 30.6 38 30.6H16.28L27.84 42.16C28.86 43.18 28.86 44.82 27.84 45.84C26.82 46.86 25.18 46.86 24.16 45.84L8.16 29.84C7.15 28.82 7.15 27.18 8.16 26.16L24.16 10.16C25.18 9.15 26.82 9.15 27.84 10.16C28.86 11.18 28.86 12.82 27.84 13.84L16.28 25.4H38C42.93 25.4 47.67 27.36 51.15 30.85C54.64 34.34 56.6 39.07 56.6 44C56.6 48.93 54.64 53.67 51.15 57.15C47.67 60.64 42.93 62.6 38 62.6H30C28.56 62.6 27.4 61.44 27.4 60C27.4 58.56 28.56 57.4 30 57.4H38C41.56 57.4 44.96 55.99 47.48 53.48C49.99 50.96 51.4 47.55 51.4 44Z"],["F", "M26 12L10 28L26 44V12Z"]] },
        chat: { name: "Chat", parts: [["F", "M10 10H54C55.33 10 56.6 10.53 57.54 11.46C58.47 12.4 59 13.67 59 15V40C59 41.33 58.47 42.6 57.54 43.54C56.6 44.47 55.33 45 54 45H28L15 56V45H10C8.67 45 7.4 44.47 6.46 43.54C5.53 42.6 5 41.33 5 40V15C5 13.67 5.53 12.4 6.46 11.46C7.4 10.53 8.67 10 10 10Z"],["B", "M24.2 27.5C24.2 29.27 22.77 30.7 21 30.7C19.23 30.7 17.8 29.27 17.8 27.5C17.8 25.73 19.23 24.3 21 24.3C22.77 24.3 24.2 25.73 24.2 27.5Z"],["B", "M35.2 27.5C35.2 29.27 33.77 30.7 32 30.7C30.23 30.7 28.8 29.27 28.8 27.5C28.8 25.73 30.23 24.3 32 24.3C33.77 24.3 35.2 25.73 35.2 27.5Z"],["B", "M46.2 27.5C46.2 29.27 44.77 30.7 43 30.7C41.23 30.7 39.8 29.27 39.8 27.5C39.8 25.73 41.23 24.3 43 24.3C44.77 24.3 46.2 25.73 46.2 27.5Z"]] },
        gamepad: { name: "Gamepad", parts: [["F", "M24 6H40V24H58V40H40V58H24V40H6V24H24V6Z"],["B", "M35.59 25.59C36.37 24.81 37.63 24.81 38.41 25.59C39.2 26.37 39.2 27.63 38.41 28.41L34.83 32L38.41 35.59C39.2 36.37 39.2 37.63 38.41 38.41C37.63 39.19 36.37 39.19 35.59 38.41L32 34.83L28.41 38.41C27.63 39.19 26.37 39.19 25.59 38.41C24.8 37.63 24.8 36.37 25.59 35.59L29.17 32L25.59 28.41C24.8 27.63 24.8 26.37 25.59 25.59C26.37 24.81 27.63 24.81 28.41 25.59L32 29.17L35.59 25.59Z"]] },
        hdmi: { name: "HDMI", parts: [["F", "M5 22H59V35L52 43H12L5 35V22Z"],["B", "M50 27.9C51.16 27.9 52.1 28.84 52.1 30C52.1 31.16 51.16 32.1 50 32.1H14C12.84 32.1 11.9 31.16 11.9 30C11.9 28.84 12.84 27.9 14 27.9H50Z"]] },
        headphones: { name: "Headphones", parts: [["F", "M49.4 42V32C49.4 27.38 47.57 22.96 44.3 19.7C41.04 16.43 36.62 14.6 32 14.6C27.38 14.6 22.96 16.43 19.7 19.7C16.43 22.96 14.6 27.38 14.6 32V42C14.6 43.44 13.44 44.6 12 44.6C10.56 44.6 9.4 43.44 9.4 42V32C9.4 26.01 11.78 20.26 16.02 16.02C20.26 11.78 26.01 9.4 32 9.4C37.99 9.4 43.74 11.78 47.98 16.02C52.22 20.26 54.6 26.01 54.6 32V42C54.6 43.44 53.44 44.6 52 44.6C50.56 44.6 49.4 43.44 49.4 42Z"],["F", "M11.5 38H15.5C17.43 38 19 39.57 19 41.5V51.5C19 53.43 17.43 55 15.5 55H11.5C9.57 55 8 53.43 8 51.5V41.5C8 39.57 9.57 38 11.5 38Z"],["F", "M48.5 38H52.5C54.43 38 56 39.57 56 41.5V51.5C56 53.43 54.43 55 52.5 55H48.5C46.57 55 45 53.43 45 51.5V41.5C45 39.57 46.57 38 48.5 38Z"]] },
        headset: { name: "Headset", parts: [["F", "M49.4 42V32C49.4 27.38 47.57 22.96 44.3 19.7C41.04 16.43 36.62 14.6 32 14.6C27.38 14.6 22.96 16.43 19.7 19.7C16.43 22.96 14.6 27.38 14.6 32V42C14.6 43.44 13.44 44.6 12 44.6C10.56 44.6 9.4 43.44 9.4 42V32C9.4 26.01 11.78 20.26 16.02 16.02C20.26 11.78 26.01 9.4 32 9.4C37.99 9.4 43.74 11.78 47.98 16.02C52.22 20.26 54.6 26.01 54.6 32V42C54.6 43.44 53.44 44.6 52 44.6C50.56 44.6 49.4 43.44 49.4 42Z"],["F", "M11.5 38H15.5C17.43 38 19 39.57 19 41.5V51.5C19 53.43 17.43 55 15.5 55H11.5C9.57 55 8 53.43 8 51.5V41.5C8 39.57 9.57 38 11.5 38Z"],["F", "M48.5 38H52.5C54.43 38 56 39.57 56 41.5V51.5C56 53.43 54.43 55 52.5 55H48.5C46.57 55 45 53.43 45 51.5V41.5C45 39.57 46.57 38 48.5 38Z"],["F", "M47.4 54C47.4 52.56 48.56 51.4 50 51.4C51.44 51.4 52.6 52.56 52.6 54C52.6 57.57 50.72 60.12 48.02 61.64C45.48 63.07 42.22 63.6 39 63.6H36C34.56 63.6 33.4 62.44 33.4 61C33.4 59.56 34.56 58.4 36 58.4H39C41.78 58.4 44.02 57.93 45.48 57.11C46.78 56.38 47.4 55.43 47.4 54Z"],["F", "M30.5 57H34.5C35.88 57 37 58.12 37 59.5V61.5C37 62.88 35.88 64 34.5 64H30.5C29.12 64 28 62.88 28 61.5V59.5C28 58.12 29.12 57 30.5 57Z"]] },
        jack: { name: "Audio jack", parts: [["F", "M32 4L29 10V23H35V10L32 4Z"],["F", "M27 23H37C37.55 23 38 23.45 38 24V30C38 30.55 37.55 31 37 31H27C26.45 31 26 30.55 26 30V24C26 23.45 26.45 23 27 23Z"],["F", "M29 31V46H35V31H29Z"],["F", "M27 46H37C38.11 46 39 46.89 39 48V58C39 59.11 38.11 60 37 60H27C25.89 60 25 59.11 25 58V48C25 46.89 25.89 46 27 46Z"]] },
        mic: { name: "Microphone", parts: [["F", "M32 5C36.42 5 40 8.58 40 13V28C40 32.42 36.42 36 32 36C27.58 36 24 32.42 24 28V13C24 8.58 27.58 5 32 5Z"],["F", "M11.4 29C11.4 27.56 12.56 26.4 14 26.4C15.44 26.4 16.6 27.56 16.6 29C16.6 33.08 18.22 37 21.11 39.89C24 42.78 27.92 44.4 32 44.4C36.08 44.4 40 42.78 42.89 39.89C45.78 37 47.4 33.08 47.4 29C47.4 27.56 48.56 26.4 50 26.4C51.44 26.4 52.6 27.56 52.6 29C52.6 34.46 50.43 39.7 46.57 43.57C43.32 46.81 39.1 48.86 34.6 49.43V55.4H41C42.44 55.4 43.6 56.56 43.6 58C43.6 59.44 42.44 60.6 41 60.6H23C21.56 60.6 20.4 59.44 20.4 58C20.4 56.56 21.56 55.4 23 55.4H29.4V49.43C24.9 48.86 20.68 46.81 17.43 43.57C13.57 39.7 11.4 34.46 11.4 29Z"]] },
        mixer: { name: "Mixer", parts: [["F", "M13.7 58V6C13.7 4.73 14.73 3.7 16 3.7C17.27 3.7 18.3 4.73 18.3 6V58C18.3 59.27 17.27 60.3 16 60.3C14.73 60.3 13.7 59.27 13.7 58ZM29.7 58V6C29.7 4.73 30.73 3.7 32 3.7C33.27 3.7 34.3 4.73 34.3 6V58C34.3 59.27 33.27 60.3 32 60.3C30.73 60.3 29.7 59.27 29.7 58ZM45.7 58V6C45.7 4.73 46.73 3.7 48 3.7C49.27 3.7 50.3 4.73 50.3 6V58C50.3 59.27 49.27 60.3 48 60.3C46.73 60.3 45.7 59.27 45.7 58Z"],["F", "M12 34H20C21.1 34 22 34.89 22 36V41C22 42.11 21.1 43 20 43H12C10.9 43 10 42.11 10 41V36C10 34.89 10.9 34 12 34Z"],["F", "M28 14H36C37.1 14 38 14.89 38 16V21C38 22.11 37.1 23 36 23H28C26.9 23 26 22.11 26 21V16C26 14.89 26.9 14 28 14Z"],["F", "M44 40H52C53.1 40 54 40.89 54 42V47C54 48.11 53.1 49 52 49H44C42.9 49 42 48.11 42 47V42C42 40.89 42.9 40 44 40Z"]] },
        monitor: { name: "Monitor", parts: [["F", "M8 10H56C57.66 10 59 11.34 59 13V42C59 43.66 57.66 45 56 45H8C6.34 45 5 43.66 5 42V13C5 11.34 6.34 10 8 10Z"],["F", "M29.4 45C29.4 43.56 30.56 42.4 32 42.4C33.44 42.4 34.6 43.56 34.6 45V53.4H44C45.44 53.4 46.6 54.56 46.6 56C46.6 57.44 45.44 58.6 44 58.6H20C18.56 58.6 17.4 57.44 17.4 56C17.4 54.56 18.56 53.4 20 53.4H29.4V45Z"]] },
        speaker: { name: "Speaker", parts: [["F", "M22 6H42C44.21 6 46 7.79 46 10V54C46 56.21 44.21 58 42 58H22C19.79 58 18 56.21 18 54V10C18 7.79 19.79 6 22 6Z"],["B", "M36 19C36 21.21 34.21 23 32 23C29.79 23 28 21.21 28 19C28 16.79 29.79 15 32 15C34.21 15 36 16.79 36 19Z"],["B", "M42 40C42 45.52 37.52 50 32 50C26.48 50 22 45.52 22 40C22 34.48 26.48 30 32 30C37.52 30 42 34.48 42 40Z"],["F", "M34.8 40C34.8 41.55 33.55 42.8 32 42.8C30.45 42.8 29.2 41.55 29.2 40C29.2 38.45 30.45 37.2 32 37.2C33.55 37.2 34.8 38.45 34.8 40Z"]] },
        speakers: { name: "Speaker pair", parts: [["F", "M9 6H25C27.21 6 29 7.79 29 10V54C29 56.21 27.21 58 25 58H9C6.79 58 5 56.21 5 54V10C5 7.79 6.79 6 9 6Z"],["B", "M20.43 19C20.43 20.89 18.89 22.43 17 22.43C15.11 22.43 13.57 20.89 13.57 19C13.57 17.11 15.11 15.57 17 15.57C18.89 15.57 20.43 17.11 20.43 19Z"],["B", "M25.57 40C25.57 44.73 21.73 48.57 17 48.57C12.27 48.57 8.43 44.73 8.43 40C8.43 35.27 12.27 31.43 17 31.43C21.73 31.43 25.57 35.27 25.57 40Z"],["F", "M19.4 40C19.4 41.33 18.32 42.4 17 42.4C15.67 42.4 14.6 41.33 14.6 40C14.6 38.68 15.67 37.6 17 37.6C18.32 37.6 19.4 38.68 19.4 40Z"],["F", "M39 6H55C57.21 6 59 7.79 59 10V54C59 56.21 57.21 58 55 58H39C36.79 58 35 56.21 35 54V10C35 7.79 36.79 6 39 6Z"],["B", "M50.43 19C50.43 20.89 48.89 22.43 47 22.43C45.11 22.43 43.57 20.89 43.57 19C43.57 17.11 45.11 15.57 47 15.57C48.89 15.57 50.43 17.11 50.43 19Z"],["B", "M55.57 40C55.57 44.73 51.73 48.57 47 48.57C42.27 48.57 38.43 44.73 38.43 40C38.43 35.27 42.27 31.43 47 31.43C51.73 31.43 55.57 35.27 55.57 40Z"],["F", "M49.4 40C49.4 41.33 48.32 42.4 47 42.4C45.67 42.4 44.6 41.33 44.6 40C44.6 38.68 45.67 37.6 47 37.6C48.32 37.6 49.4 38.68 49.4 40Z"]] },
        speakerSound: { name: "Volume", parts: [["F", "M8 24H18L32 12V52L18 40H8V24Z"],["F", "M53.46 32C53.46 29.18 52.9 26.39 51.82 23.79C50.74 21.19 49.16 18.83 47.17 16.84C46.15 15.83 46.14 14.18 47.16 13.17C48.17 12.15 49.82 12.14 50.83 13.16C53.31 15.63 55.28 18.57 56.62 21.8C57.97 25.03 58.66 28.5 58.66 32C58.66 35.5 57.97 38.97 56.62 42.2C55.28 45.43 53.31 48.37 50.83 50.84C49.82 51.86 48.17 51.85 47.16 50.83C46.14 49.82 46.15 48.17 47.17 47.16C49.16 45.17 50.74 42.81 51.82 40.21C52.9 37.61 53.46 34.82 53.46 32ZM43.6 32C43.6 30.48 43.3 28.98 42.71 27.58C42.12 26.19 41.26 24.92 40.18 23.86C39.15 22.85 39.14 21.21 40.14 20.18C41.15 19.15 42.79 19.14 43.82 20.14C45.4 21.69 46.65 23.53 47.51 25.57C48.36 27.61 48.8 29.79 48.8 32C48.8 34.21 48.36 36.39 47.51 38.43C46.65 40.47 45.4 42.31 43.82 43.86C42.79 44.86 41.15 44.85 40.14 43.82C39.14 42.79 39.15 41.15 40.18 40.14C41.26 39.08 42.12 37.81 42.71 36.42C43.3 35.02 43.6 33.52 43.6 32Z"]] },
        studiomic: { name: "Studio mic", parts: [["F", "M32 4C38.08 4 43 8.93 43 15V27C43 33.07 38.08 38 32 38C25.92 38 21 33.07 21 27V15C21 8.93 25.92 4 32 4Z"],["F", "M11.4 30C11.4 28.56 12.56 27.4 14 27.4C15.44 27.4 16.6 28.56 16.6 30C16.6 34.08 18.22 38 21.11 40.89C24 43.78 27.92 45.4 32 45.4C36.08 45.4 40 43.78 42.89 40.89C45.78 38 47.4 34.08 47.4 30C47.4 28.56 48.56 27.4 50 27.4C51.44 27.4 52.6 28.56 52.6 30C52.6 35.46 50.43 40.7 46.57 44.57C43.32 47.81 39.1 49.86 34.6 50.43V55.4H42C43.44 55.4 44.6 56.56 44.6 58C44.6 59.44 43.44 60.6 42 60.6H22C20.56 60.6 19.4 59.44 19.4 58C19.4 56.56 20.56 55.4 22 55.4H29.4V50.43C24.9 49.86 20.68 47.81 17.43 44.57C13.57 40.7 11.4 35.46 11.4 30ZM28 24.4C29.44 24.4 30.6 25.56 30.6 27C30.6 28.44 29.44 29.6 28 29.6H21C19.56 29.6 18.4 28.44 18.4 27C18.4 25.56 19.56 24.4 21 24.4H28ZM43 24.4C44.44 24.4 45.6 25.56 45.6 27C45.6 28.44 44.44 29.6 43 29.6H36C34.56 29.6 33.4 28.44 33.4 27C33.4 25.56 34.56 24.4 36 24.4H43ZM28 18.4C29.44 18.4 30.6 19.56 30.6 21C30.6 22.44 29.44 23.6 28 23.6H21C19.56 23.6 18.4 22.44 18.4 21C18.4 19.56 19.56 18.4 21 18.4H28ZM43 18.4C44.44 18.4 45.6 19.56 45.6 21C45.6 22.44 44.44 23.6 43 23.6H36C34.56 23.6 33.4 22.44 33.4 21C33.4 19.56 34.56 18.4 36 18.4H43ZM28 12.4C29.44 12.4 30.6 13.56 30.6 15C30.6 16.44 29.44 17.6 28 17.6H21C19.56 17.6 18.4 16.44 18.4 15C18.4 13.56 19.56 12.4 21 12.4H28ZM43 12.4C44.44 12.4 45.6 13.56 45.6 15C45.6 16.44 44.44 17.6 43 17.6H36C34.56 17.6 33.4 16.44 33.4 15C33.4 13.56 34.56 12.4 36 12.4H43Z"],["B", "M40 25.4C40.88 25.4 41.6 26.12 41.6 27C41.6 27.88 40.88 28.6 40 28.6H24C23.12 28.6 22.4 27.88 22.4 27C22.4 26.12 23.12 25.4 24 25.4H40ZM40 19.4C40.88 19.4 41.6 20.12 41.6 21C41.6 21.88 40.88 22.6 40 22.6H24C23.12 22.6 22.4 21.88 22.4 21C22.4 20.12 23.12 19.4 24 19.4H40ZM40 13.4C40.88 13.4 41.6 14.12 41.6 15C41.6 15.88 40.88 16.6 40 16.6H24C23.12 16.6 22.4 15.88 22.4 15C22.4 14.12 23.12 13.4 24 13.4H40Z"]] },
        swap: { name: "Swap", parts: [["F", "M48.4 55V49.28C46.64 51 44.61 52.42 42.37 53.49C38.22 55.48 33.55 56.15 29 55.42C24.45 54.68 20.24 52.57 16.92 49.37C13.61 46.17 11.35 42.03 10.45 37.5C10.17 36.1 11.09 34.73 12.5 34.45C13.9 34.17 15.27 35.08 15.55 36.49C16.24 39.97 17.98 43.16 20.53 45.63C23.08 48.09 26.33 49.71 29.83 50.28C33.34 50.85 36.93 50.33 40.13 48.8C41.84 47.99 43.38 46.9 44.73 45.6H39C37.56 45.6 36.4 44.44 36.4 43C36.4 41.56 37.56 40.4 39 40.4H51C52.44 40.4 53.6 41.56 53.6 43V55C53.6 56.44 52.44 57.6 51 57.6C49.56 57.6 48.4 56.44 48.4 55ZM21.63 10.5C25.78 8.52 30.45 7.85 35 8.58C39.55 9.32 43.76 11.43 47.08 14.63C50.4 17.83 52.65 21.97 53.55 26.49C53.83 27.9 52.91 29.27 51.51 29.55C50.1 29.83 48.73 28.91 48.45 27.5C47.76 24.02 46.02 20.84 43.47 18.37C40.92 15.91 37.67 14.28 34.17 13.72C30.67 13.15 27.07 13.66 23.87 15.2C22.17 16.01 20.62 17.1 19.27 18.4H25C26.44 18.4 27.6 19.56 27.6 21C27.6 22.44 26.44 23.6 25 23.6H13C11.56 23.6 10.4 22.44 10.4 21V9C10.4 7.56 11.56 6.4 13 6.4C14.44 6.4 15.6 7.56 15.6 9V14.72C17.36 13 19.39 11.58 21.63 10.5Z"],["F", "M13 9V21H25L13 9ZM51 55V43H39L51 55Z"]] },
        tv: { name: "TV", parts: [["F", "M9 14H55C57.21 14 59 15.79 59 18V46C59 48.21 57.21 50 55 50H9C6.79 50 5 48.21 5 46V18C5 15.79 6.79 14 9 14Z"],["F", "M46 53.4C47.44 53.4 48.6 54.56 48.6 56C48.6 57.44 47.44 58.6 46 58.6H18C16.56 58.6 15.4 57.44 15.4 56C15.4 54.56 16.56 53.4 18 53.4H46ZM37.97 2.38C38.87 1.25 40.5 1.07 41.62 1.97C42.75 2.87 42.93 4.5 42.03 5.62L34.03 15.62C33.54 16.24 32.79 16.6 32 16.6C31.21 16.6 30.46 16.24 29.97 15.62L21.97 5.62C21.07 4.5 21.25 2.87 22.38 1.97C23.5 1.07 25.13 1.25 26.03 2.38L32 9.84L37.97 2.38Z"]] },
        usb: { name: "USB", parts: [["F", "M29.4 50V41.42L16.59 33.19C15.85 32.71 15.4 31.88 15.4 31V24C15.4 22.56 16.56 21.4 18 21.4C19.44 21.4 20.6 22.56 20.6 24V29.58L29.4 35.24V14.6H27C26.05 14.6 25.18 14.09 24.73 13.26C24.27 12.43 24.29 11.42 24.79 10.62L29.79 2.62C30.27 1.86 31.1 1.4 32 1.4C32.9 1.4 33.73 1.86 34.21 2.62L39.21 10.62C39.71 11.42 39.73 12.43 39.27 13.26C38.82 14.09 37.95 14.6 37 14.6H34.6V28.52L43.4 23.49V19C43.4 17.56 44.56 16.4 46 16.4C47.44 16.4 48.6 17.56 48.6 19V25C48.6 25.93 48.1 26.8 47.29 27.26L34.6 34.51V50C34.6 51.44 33.44 52.6 32 52.6C30.56 52.6 29.4 51.44 29.4 50Z"],["F", "M15 18H21V24H15V18Z"],["F", "M49 16C49 17.66 47.66 19 46 19C44.34 19 43 17.66 43 16C43 14.34 44.34 13 46 13C47.66 13 49 14.34 49 16Z"],["F", "M36.5 55C36.5 57.49 34.49 59.5 32 59.5C29.51 59.5 27.5 57.49 27.5 55C27.5 52.51 29.51 50.5 32 50.5C34.49 50.5 36.5 52.51 36.5 55Z"],["F", "M32 4L27 12H37L32 4Z"]] },
        webcam: { name: "Webcam", parts: [["F", "M50 25C50 34.94 41.94 43 32 43C22.06 43 14 34.94 14 25C14 15.06 22.06 7 32 7C41.94 7 50 15.06 50 25Z"],["B", "M39 25C39 28.87 35.87 32 32 32C28.13 32 25 28.87 25 25C25 21.13 28.13 18 32 18C35.87 18 39 21.13 39 25Z"],["F", "M19 58H45L41 46H23L19 58Z"]] },
        wireless: { name: "Wireless", parts: [["F", "M36 26C36 28.21 34.21 30 32 30C29.79 30 28 28.21 28 26C28 23.79 29.79 22 32 22C34.21 22 36 23.79 36 26Z"],["F", "M29.4 30C29.4 28.56 30.56 27.4 32 27.4C33.44 27.4 34.6 28.56 34.6 30V54.4H40C41.44 54.4 42.6 55.56 42.6 57C42.6 58.44 41.44 59.6 40 59.6H24C22.56 59.6 21.4 58.44 21.4 57C21.4 55.56 22.56 54.4 24 54.4H29.4V30ZM4.34 26C4.34 22.5 5.03 19.03 6.38 15.8C7.72 12.57 9.69 9.63 12.17 7.16C13.18 6.14 14.83 6.15 15.84 7.17C16.86 8.18 16.85 9.83 15.84 10.84C13.84 12.83 12.26 15.19 11.18 17.79C10.1 20.39 9.54 23.18 9.54 26C9.54 28.82 10.1 31.61 11.18 34.21C12.26 36.81 13.84 39.17 15.84 41.16C16.85 42.17 16.86 43.82 15.84 44.83C14.83 45.85 13.18 45.86 12.17 44.84C9.69 42.37 7.72 39.43 6.38 36.2C5.03 32.97 4.34 29.5 4.34 26ZM54.46 26C54.46 23.18 53.9 20.39 52.82 17.79C51.74 15.19 50.16 12.83 48.17 10.84C47.15 9.83 47.14 8.18 48.16 7.17C49.17 6.15 50.82 6.14 51.84 7.16C54.32 9.63 56.28 12.57 57.63 15.8C58.97 19.03 59.66 22.5 59.66 26C59.66 29.5 58.97 32.97 57.63 36.2C56.28 39.43 54.32 42.37 51.84 44.84C50.82 45.86 49.17 45.85 48.16 44.83C47.14 43.82 47.15 42.17 48.17 41.16C50.16 39.17 51.74 36.81 52.82 34.21C53.9 31.61 54.46 28.82 54.46 26ZM15.2 26C15.2 23.79 15.64 21.61 16.49 19.57C17.35 17.53 18.6 15.69 20.18 14.14C21.21 13.14 22.85 13.15 23.86 14.18C24.86 15.21 24.85 16.85 23.82 17.86C22.74 18.92 21.88 20.19 21.29 21.58C20.7 22.98 20.4 24.48 20.4 26C20.4 27.52 20.7 29.02 21.29 30.38C21.88 31.81 22.74 33.08 23.82 34.14C24.85 35.15 24.86 36.79 23.86 37.82C22.85 38.85 21.21 38.86 20.18 37.86C18.6 36.31 17.35 34.47 16.49 32.43C15.64 30.39 15.2 28.21 15.2 26ZM43.6 26C43.6 24.48 43.3 22.98 42.71 21.58C42.12 20.19 41.26 18.92 40.18 17.86C39.15 16.85 39.14 15.21 40.14 14.18C41.15 13.15 42.79 13.14 43.82 14.14C45.4 15.69 46.65 17.53 47.51 19.57C48.36 21.61 48.8 23.79 48.8 26C48.8 28.21 48.36 30.39 47.51 32.43C46.65 34.47 45.4 36.31 43.82 37.86C42.79 38.86 41.15 38.85 40.14 37.82C39.14 36.79 39.15 35.15 40.18 34.14C41.26 33.08 42.12 31.81 42.71 30.38C43.3 29.02 43.6 27.52 43.6 26Z"]] },
        micFilled: { name: "Microphone (filled)", parts: [["F", "M32 5C36.42 5 40 8.58 40 13V28C40 32.42 36.42 36 32 36C27.58 36 24 32.42 24 28V13C24 8.58 27.58 5 32 5Z"],["F", "M11.4 29C11.4 27.56 12.56 26.4 14 26.4C15.44 26.4 16.6 27.56 16.6 29C16.6 33.08 18.22 37 21.11 39.89C24 42.78 27.92 44.4 32 44.4C36.08 44.4 40 42.78 42.89 39.89C45.78 37 47.4 33.08 47.4 29C47.4 27.56 48.56 26.4 50 26.4C51.44 26.4 52.6 27.56 52.6 29C52.6 34.46 50.43 39.7 46.57 43.57C43.32 46.81 39.1 48.86 34.6 49.43V55.4H41C42.44 55.4 43.6 56.56 43.6 58C43.6 59.44 42.44 60.6 41 60.6H23C21.56 60.6 20.4 59.44 20.4 58C20.4 56.56 21.56 55.4 23 55.4H29.4V49.43C24.9 48.86 20.68 46.81 17.43 43.57C13.57 39.7 11.4 34.46 11.4 29Z"]] },
        speakerSoundFilled: { name: "Volume (filled)", parts: [["F", "M8 24H18L32 12V52L18 40H8V24Z"],["F", "M53.46 32C53.46 29.18 52.9 26.39 51.82 23.79C50.74 21.19 49.16 18.83 47.17 16.84C46.15 15.83 46.14 14.18 47.16 13.16C48.17 12.15 49.82 12.14 50.83 13.16C53.31 15.63 55.28 18.57 56.62 21.8C57.97 25.03 58.66 28.5 58.66 32C58.66 35.5 57.97 38.97 56.62 42.2C55.28 45.43 53.31 48.37 50.83 50.84C49.82 51.86 48.17 51.85 47.16 50.84C46.14 49.82 46.15 48.17 47.17 47.16C49.16 45.17 50.74 42.81 51.82 40.21C52.9 37.61 53.46 34.82 53.46 32ZM43.6 32C43.6 30.48 43.3 28.98 42.71 27.58C42.12 26.19 41.26 24.92 40.18 23.86C39.15 22.85 39.14 21.21 40.14 20.18C41.15 19.15 42.79 19.14 43.82 20.14C45.4 21.69 46.65 23.53 47.51 25.57C48.36 27.61 48.8 29.79 48.8 32C48.8 34.21 48.36 36.39 47.51 38.43C46.65 40.47 45.4 42.31 43.82 43.86C42.79 44.86 41.15 44.85 40.14 43.82C39.14 42.79 39.15 41.15 40.18 40.14C41.26 39.08 42.12 37.81 42.71 36.42C43.3 35.02 43.6 33.52 43.6 32Z"]] },
        chatFilled: { name: "Chat (filled)", parts: [["F", "M10 10H54C55.33 10 56.6 10.53 57.54 11.46C58.47 12.4 59 13.67 59 15V40C59 41.33 58.47 42.6 57.54 43.54C56.6 44.47 55.33 45 54 45H28L15 56V45H10C8.67 45 7.4 44.47 6.46 43.54C5.53 42.6 5 41.33 5 40V15C5 13.67 5.53 12.4 6.46 11.46C7.4 10.53 8.67 10 10 10Z"],["B", "M24.2 27.5C24.2 29.27 22.77 30.7 21 30.7C19.23 30.7 17.8 29.27 17.8 27.5C17.8 25.73 19.23 24.3 21 24.3C22.77 24.3 24.2 25.73 24.2 27.5Z"],["B", "M35.2 27.5C35.2 29.27 33.77 30.7 32 30.7C30.23 30.7 28.8 29.27 28.8 27.5C28.8 25.73 30.23 24.3 32 24.3C33.77 24.3 35.2 25.73 35.2 27.5Z"],["B", "M46.2 27.5C46.2 29.27 44.77 30.7 43 30.7C41.23 30.7 39.8 29.27 39.8 27.5C39.8 25.73 41.23 24.3 43 24.3C44.77 24.3 46.2 25.73 46.2 27.5Z"]] },    };
    const ICON_ORDER = ['speaker', 'speakers', 'monitor', 'tv', 'headphones', 'headset', 'wireless', 'mic', 'studiomic', 'webcam', 'hdmi', 'usb', 'jack', 'mixer', 'gamepad', 'swap', 'speakerSound'];

    // Icon from the Windows device type (EndpointFormFactor) and name.
    function autoIcon(dev, flow) {
        const n = ((dev && (dev.name + ' ' + (dev.iface || ''))) || '').toLowerCase();
        if (/cam/.test(n)) return 'webcam';
        if (/headset/.test(n)) return 'headset';
        if (!dev) return flow === 'capture' ? 'mic' : 'speaker';
        if (flow === 'capture') return dev.ff === 5 || dev.ff === 6 ? 'headset' : 'mic';
        switch (dev.ff) {
            case 3: return 'headphones';
            case 5: case 6: return 'headset';
            case 8: return /tv|lg|samsung|sony|philips/.test(n) ? 'tv' : 'monitor';
            case 2: case 7: return 'jack';
            case 0: return 'wireless';
            default: return /headphone|buds|airpods/.test(n) ? 'headphones' : 'speaker';
        }
    }

    // Icon slots per layout: 64-unit icon box drawn at (x, y) with the given size.
    const SLOT = {
        icon: { x: 40, y: 28, size: 64 },
        label: { x: 48, y: 25, size: 48 },
        label2: { x: 48, y: 16, size: 48 },
        metric: { x: 56, y: 14, size: 32 },
        meter: { x: 56, y: 16, size: 32 },
        app: { x: 50, y: 11, size: 44 },
        appOff: { x: 50, y: 16, size: 44 },
    };

    function iconSvg(name, color, slot, opacity) {
        const ic = ICONS[name] || ICONS.speaker;
        const s = slot.size / 64;
        const body = ic.parts.map(([f, d, rule]) =>
            `<path d="${d}" fill="${f === 'F' ? color : f === 'B' ? BG : f}"${rule ? ` fill-rule="${rule}" clip-rule="${rule}"` : ''}/>`).join('');
        return `<g transform="translate(${slot.x} ${slot.y}) scale(${s.toFixed(4)})"${opacity != null && opacity < 1 ? ` opacity="${opacity}"` : ''}>${body}</g>`;
    }

    // Red diagonal over an icon slot: dark outline under a red line, as in the design.
    function strike(slot) {
        const i = slot.size * 0.04, x1 = slot.x + i, y1 = slot.y + i, x2 = slot.x + slot.size - i, y2 = slot.y + slot.size - i;
        const w = 10 * slot.size / 64, d = `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
        return `<path d="${d}" stroke="${BG}" stroke-width="${w.toFixed(2)}" stroke-linecap="round"/><path d="${d}" stroke="${RED}" stroke-width="${(w / 2).toFixed(2)}" stroke-linecap="round"/>`;
    }

    function text(y, s, size, fill) {
        return `<text x="72" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="${fill}" text-anchor="middle" letter-spacing="0">${esc(s)}</text>`;
    }
    // One-line uppercase label, Audio/Label 14 px; cut with … when it would not fit the 128 px content area.
    function labelText(y, s, fill) {
        let t = String(s).toUpperCase();
        if (t.length > 13) t = t.slice(0, 12) + '…';
        return text(y, t, 14, fill);
    }

    // ---------- key frame ----------
    function frame(inner, defs) {
        return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144">` +
            `<defs><linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="0.55" stop-color="#0a0a0a"/><stop offset="0.75" stop-color="#1b1b1b"/><stop offset="1" stop-color="#050505"/></linearGradient>${defs || ''}</defs>` +
            `<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#sheen)"/>` +
            `<rect x="1" y="1" width="142" height="142" rx="21" fill="none" stroke="#2c2c2c" stroke-width="2"/>` +
            inner + `</svg>`;
    }

    // Status LED under the icon: bright with a glow when on, 20% when off.
    function led(color, on) {
        const x = 40, y = 118, w = 64, h = 8;
        if (!on) return { defs: '', body: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${color}" fill-opacity="0.2"/>` };
        // id carries the colour so several keys on one page (settings window) never share a glow
        const id = 'halo' + String(color).replace(/[^0-9a-z]/gi, '');
        return {
            defs: `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${color}" stop-opacity="0.55"/><stop offset="0.6" stop-color="${color}" stop-opacity="0.12"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`,
            body: `<ellipse cx="72" cy="${y + h / 2}" rx="58" ry="20" fill="url(#${id})"/>` +
                `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${color}"/>` +
                `<rect x="${x + 6}" y="${y + 2}" width="${w - 12}" height="2.5" rx="1.25" fill="#ffffff" fill-opacity="0.45"/>`,
        };
    }
    // Progress bar in the LED slot (0–100): 20% track and a solid fill, glowing while it changes.
    function progress(color, value, glow) {
        const x = 40, y = 118, w = 64, h = 8, v = Math.max(0, Math.min(100, value || 0));
        const g = glow ? led(color, true) : { defs: '', body: '' };
        let body = glow ? g.body.split('<rect')[0] : '';
        body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${color}" fill-opacity="0.2"/>`;
        if (v > 0) body += `<rect x="${x}" y="${y}" width="${Math.max(h, w * v / 100).toFixed(1)}" height="${h}" rx="4" fill="${color}"/>`;
        return { defs: g.defs, body };
    }

    // Small round badge in the top-right corner (microphone muted, previous profile).
    function badge(kind) {
        if (kind === 'micMuted') {
            return `<circle cx="116" cy="28" r="15" fill="${RED}"/>` +
                iconSvg('mic', '#ffffff', { x: 106.4, y: 18.5, size: 19.2 }) +
                `<path d="M109 21L123 35" stroke="${RED}" stroke-width="4" stroke-linecap="round"/><path d="M109 21L123 35" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`;
        }
        return `<circle cx="116" cy="28" r="15" fill="#2e2e2e" stroke="#555555" stroke-width="1.5"/>` +
            iconSvg('back', '#ffffff', { x: 106, y: 18, size: 19.9 });
    }

    // ---------- layouts ----------
    // Icon / label key, used by every existing action.
    // o = { icon, color, active, muted, micMuted, offline, label, caption, note, badge }
    //   muted   — red line over the icon and a red LED
    //   offline — device disconnected: dim icon, grey LED
    //   note    — grey caption instead of the name (SET UP, OFFLINE)
    //   caption — optional second line under the label
    function key(o) {
        const main = o.note || o.label || '';
        const slot = !main ? SLOT.icon : (o.caption ? SLOT.label2 : SLOT.label);
        const ledColor = o.offline ? DIM : (o.muted ? RED : (o.color || '#3ddc5a'));
        const l = led(ledColor, !o.offline && (o.active || o.muted));
        let body = l.body + iconSvg(o.icon, '#ffffff', slot, o.offline ? 0.38 : 1);
        if (o.muted) body += strike(slot);
        if (o.micMuted) body += badge('micMuted');
        else if (o.badge) body += badge(o.badge);
        if (main) {
            const fill = o.offline ? CAPTION : TEXT;
            if (o.caption) body += labelText(81, main, fill) + text(100, o.caption, 12, CAPTION);
            else body += labelText(90, main, fill);
        }
        return frame(body, l.defs);
    }

    // Big number with a caption: volume, levels. o = { icon, value, caption, color, muted, offline, glow }
    function metric(o) {
        const off = o.offline, muted = o.muted && !off;
        const p = progress(off ? DIM : muted ? RED : (o.color || '#4ea1ff'), off ? 0 : muted ? 100 : o.value, o.glow && !off);
        let body = p.body + iconSvg(o.icon || 'mic', '#ffffff', SLOT.metric, off ? 0.38 : 1);
        if (muted) body += strike(SLOT.metric) + text(77, 'MUTED', 30, RED);
        else body += text(77, Math.round(o.value) + '%', 30, off ? CAPTION : '#ffffff');
        if (o.caption) body += labelText(101, o.caption, CAPTION);
        return frame(body, p.defs);
    }

    // Program volume. o = { name, letter, color, icon, value, muted, running, status, dots: { i, n }, glow }
    //   icon — the program's own icon as base64 PNG, taken from its exe on the user's PC.
    //          A dark tile with the letter sits under it, so the key still reads if the image is not drawn.
    function appBadge(o, slot, grey) {
        const b = slot.size * 0.6875, x = slot.x + slot.size * 0.15625, y = slot.y + slot.size * 0.15625;
        const tile = o.icon ? '#2c2c2c' : grey ? '#3a3a3a' : o.color || '#3ddc5a';
        let svg = `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${b.toFixed(2)}" height="${b.toFixed(2)}" rx="${(b * 0.26).toFixed(2)}" fill="${tile}"/>` +
            `<text x="${(x + b / 2).toFixed(2)}" y="${(y + b * 0.723).toFixed(2)}" font-family="${FONT}" font-size="${(b * 0.56).toFixed(2)}" font-weight="700" fill="${o.icon ? CAPTION : BG}" text-anchor="middle">${esc((o.letter || o.name || '?')[0].toUpperCase())}</text>`;
        if (o.icon) {
            const s = slot.size * 0.8, ix = slot.x + slot.size * 0.1, iy = slot.y + slot.size * 0.1;
            svg += `<image x="${ix.toFixed(2)}" y="${iy.toFixed(2)}" width="${s.toFixed(2)}" height="${s.toFixed(2)}" href="data:image/png;base64,${o.icon}" xlink:href="data:image/png;base64,${o.icon}"/>`;
        }
        return svg;
    }
    function app(o) {
        if (!o.running) {
            // not in the Windows mixer: closed, or quiet with no sound open, so its volume cannot be changed now
            return frame(`<rect x="40" y="118" width="64" height="8" rx="4" fill="${DIM}" fill-opacity="0.2"/>` +
                `<g opacity="0.38">${appBadge(o, SLOT.appOff, true)}</g>` + labelText(77, o.name || 'APP', CAPTION) + text(100, o.status || 'SILENT', 16, CAPTION));
        }
        let body = '', defs = '';
        if (o.dots) {
            // Audio/Pagination: 8 px active dot, 6 px others, 5 px apart, centred at y 124
            const n = o.dots.n, w = 8 + 6 * (n - 1) + 5 * (n - 1);
            let x = 72 - w / 2;
            for (let i = 0; i < n; i++) {
                const d = i === o.dots.i ? 8 : 6;
                body += `<circle cx="${(x + d / 2).toFixed(1)}" cy="124" r="${d / 2}" fill="${i === o.dots.i ? '#ffffff' : DIM}"/>`;
                x += d + 5;
            }
        } else {
            const p = progress(o.muted ? RED : (o.color || '#3ddc5a'), o.muted ? 100 : o.value, o.glow);
            body += p.body; defs = p.defs;
        }
        body += appBadge(o, SLOT.app) + (o.muted ? strike(SLOT.app) : '');
        body += labelText(72, o.name || 'APP', TEXT);
        body += o.muted ? text(103.5, 'MUTED', 26, RED) : text(103.5, Math.round(o.value) + '%', 26, '#ffffff');
        return frame(body, defs);
    }

    // Microphone level, 12 segments. o = { level 0–1, peak 0–1, muted, offline }
    function meter(o) {
        const off = o.offline, muted = o.muted && !off;
        let body = iconSvg('mic', '#ffffff', SLOT.meter, off ? 0.38 : 1) + (muted ? strike(SLOT.meter) : '');
        // level and peak are linear (0–1); segments follow decibels from −60 to 0 dB, like the Windows meter
        const seg = (v) => v > 0 ? Math.max(0, Math.min(12, Math.round((20 * Math.log10(v) + 60) / 5))) : 0;
        const lit = off || muted ? 0 : seg(o.level || 0), pk = off || muted ? -1 : Math.min(11, seg(o.peak || 0) - 1);
        for (let i = 0; i < 12; i++) {
            const c = off || muted ? DIM : i < 8 ? '#3ddc5a' : i < 10 ? '#ffd21f' : RED;
            const on = i < lit || i === pk;
            body += `<rect x="${19 + i * 9}" y="56" width="7" height="40" rx="2" fill="${c}" fill-opacity="${on ? 1 : off || muted ? 0.2 : 0.16}"/>`;
        }
        const db = (o.level || 0) < 0.001 ? '−∞ dB' : Math.round(20 * Math.log10(o.level)) + ' dB';
        body += off ? text(122.5, 'OFFLINE', 18, CAPTION) : muted ? text(122.5, 'MUTED', 18, RED) : text(122.5, db, 18, '#ffffff');
        return frame(body);
    }

    const LED_COLORS = [
        ['#3ddc5a', 'Green'], ['#4ea1ff', 'Blue'], ['#a77bff', 'Purple'], ['#2ee6d6', 'Teal'],
        ['#ffd21f', 'Yellow'], ['#ff9f1a', 'Orange'], ['#ff3b30', 'Red'], ['#ff5fb8', 'Pink'], ['#ffffff', 'White'],
    ];

    const api = { key, metric, app, meter, autoIcon, ICONS, ICON_ORDER, LED_COLORS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.APMRender = api;
})(this);
