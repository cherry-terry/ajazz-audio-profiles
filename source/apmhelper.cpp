// apmhelper.exe — audio helper for the Audio Profiles plugin (Stream Dock).
// Talks to the plugin in lines over stdin/stdout.
//
// Devices (always on):
//   in:  "list"                      — send state now
//        "set <id>"                  — make the device default (console, multimedia, communications)
//        "mute <1|0|t> [id]"         — mute/unmute/toggle a device (no id = default microphone)
//        "vol <r|c> <n|+n|-n> [id]"  — device volume in percent (no id = default output/microphone)
//   out: {"type":"state",...}        — whenever devices, defaults, volume or mute change
//
// Programs (on request):
//   in:  "apps on|off"               — send the program list whenever it changes
//        "appvol <n|+n|-n> <exe>"    — volume of every audio session of that program
//        "appmute <1|0|t> <exe>"     — mute of every audio session of that program
//        "icon <exe or full path>"   — the program's icon as a 64×64 PNG
//   out: {"type":"apps","apps":[{"exe","name","vol","muted","active"}]}
//        {"type":"icon","exe":...,"png":"<base64>"}  (png is "" when there is no icon)
//
// Microphone level:  "meter on|off"  ->  {"type":"meter","peak":0..1} about 20 times a second
// Running programs:  "watch on|off"  ->  {"type":"procs","list":["game.exe",...]} when the set changes
// Keyboard:          "key <vk> <down|up>"  — press or release a virtual key (push-to-talk, F13 = 124)
//
// Exits when stdin closes (that is, when the plugin closes).
//
// Build (MinGW-w64):
//   x86_64-w64-mingw32-g++ -O2 -std=c++17 apmhelper.cpp -o apmhelper.exe -lole32 -luuid -lgdi32 -luser32 -lversion -static -static-libgcc -static-libstdc++ -s

#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <winver.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>
#include <deque>
#include <map>
#include <set>
#include <algorithm>

// ---------- undocumented IPolicyConfig (Windows 7+), as used by EarTrumpet / SoundSwitch ----------
struct IPolicyConfig : public IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, void **) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, void **) = 0;
    virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, void *, void *) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, void *) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, void *) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, const PROPERTYKEY &, PROPVARIANT *) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, const PROPERTYKEY &, PROPVARIANT *) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR, ERole) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};
static const GUID CLSID_PolicyConfigClient = {0x870af99c, 0x171d, 0x4f9e, {0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9}};
static const GUID IID_IPolicyConfig        = {0xf8679f50, 0x850a, 0x41cf, {0x9c, 0x72, 0x43, 0x0f, 0x29, 0x02, 0x90, 0xc8}};

// ---------- IAudioMeterInformation (MinGW headers only forward-declare it) ----------
struct IMeterInfo : public IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetPeakValue(float *) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetMeteringChannelCount(UINT *) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetChannelsPeakValues(UINT32, float *) = 0;
    virtual HRESULT STDMETHODCALLTYPE QueryHardwareSupport(DWORD *) = 0;
};
static const GUID IID_IMeterInfo = {0xc02216f6, 0x8c67, 0x4b5b, {0x9d, 0x00, 0xd0, 0x08, 0xe7, 0x3e, 0x00, 0x64}};

// ---------- property keys ----------
static const PROPERTYKEY PK_FriendlyName  = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};
static const PROPERTYKEY PK_DeviceDesc    = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 2};
static const PROPERTYKEY PK_InterfaceName = {{0x026e516e, 0xb814, 0x414b, {0x83, 0xcd, 0x85, 0x6d, 0x6f, 0xef, 0x48, 0x22}}, 2};
static const PROPERTYKEY PK_FormFactor    = {{0x1da5d803, 0xd492, 0x4edd, {0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e}}, 0};

static IMMDeviceEnumerator *g_enum = NULL;
static HANDLE g_changeEv, g_cmdEv;
static CRITICAL_SECTION g_cs;
static std::deque<std::string> g_cmds;
static volatile LONG g_quit = 0;

// ---------- helpers ----------
static std::string utf8(const wchar_t *w) {
    if (!w) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 1) return "";
    std::string s(n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, NULL, NULL);
    return s;
}
static std::wstring wide(const std::string &s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, NULL, 0);
    if (n <= 1) return L"";
    std::wstring w(n - 1, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
    return w;
}
static std::string jstr(const std::string &s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"') o += "\\\"";
        else if (c == '\\') o += "\\\\";
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o + "\"";
}
static std::string lower(std::string s) {
    for (char &c : s) if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
    return s;
}
static std::string baseName(const std::wstring &p) {
    size_t i = p.find_last_of(L"\\/");
    std::wstring b = i == std::wstring::npos ? p : p.substr(i + 1);
    return lower(utf8(b.c_str()));
}
static void writeLine(const std::string &s) {
    std::string l = s + "\n";
    DWORD w;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), l.data(), (DWORD)l.size(), &w, NULL);
}
// "50" sets, "+2" / "-2" changes; returns 0..1
static float applySpec(float cur, const std::string &spec) {
    if (spec.empty()) return cur;
    float v = (float)atof(spec.c_str()) / 100.0f;
    if (spec[0] == '+' || spec[0] == '-') v = cur + v;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
static int pct(float f) { return (int)lroundf(f * 100.0f); }
// splits "a b rest of line" into the first n-1 words and the rest
static std::vector<std::string> words(const std::string &s, size_t n) {
    std::vector<std::string> r;
    size_t p = 0;
    while (p < s.size() && r.size() + 1 < n) {
        size_t sp = s.find(' ', p);
        if (sp == std::string::npos) break;
        r.push_back(s.substr(p, sp - p));
        p = sp + 1;
    }
    r.push_back(s.substr(p));
    return r;
}

static std::string propStr(IPropertyStore *ps, const PROPERTYKEY &k) {
    PROPVARIANT v; PropVariantInit(&v);
    std::string r;
    if (SUCCEEDED(ps->GetValue(k, &v)) && v.vt == VT_LPWSTR) r = utf8(v.pwszVal);
    PropVariantClear(&v);
    return r;
}
static int propU32(IPropertyStore *ps, const PROPERTYKEY &k) {
    PROPVARIANT v; PropVariantInit(&v);
    int r = -1;
    if (SUCCEEDED(ps->GetValue(k, &v)) && v.vt == VT_UI4) r = (int)v.ulVal;
    PropVariantClear(&v);
    return r;
}
static std::string defaultId(EDataFlow flow) {
    IMMDevice *d = NULL; std::string r;
    if (SUCCEEDED(g_enum->GetDefaultAudioEndpoint(flow, eConsole, &d)) && d) {
        LPWSTR id = NULL;
        if (SUCCEEDED(d->GetId(&id))) { r = utf8(id); CoTaskMemFree(id); }
        d->Release();
    }
    return r;
}
static IMMDevice *deviceFor(EDataFlow flow, const std::string &id) {
    IMMDevice *d = NULL;
    if (id.empty()) g_enum->GetDefaultAudioEndpoint(flow, eConsole, &d);
    else { std::wstring w = wide(id); g_enum->GetDevice(w.c_str(), &d); }
    return d;
}
static IAudioEndpointVolume *volumeOf(IMMDevice *d) {
    IAudioEndpointVolume *v = NULL;
    if (FAILED(d->Activate(IID_IAudioEndpointVolume, CLSCTX_ALL, NULL, (void **)&v))) return NULL;
    return v;
}

// ---------- device state ----------
static std::string listFlow(EDataFlow flow) {
    std::string o = "[";
    IMMDeviceCollection *col = NULL;
    if (FAILED(g_enum->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col)) || !col) return "[]";
    UINT n = 0; col->GetCount(&n);
    bool first = true;
    for (UINT i = 0; i < n; i++) {
        IMMDevice *d = NULL;
        if (FAILED(col->Item(i, &d)) || !d) continue;
        LPWSTR id = NULL; d->GetId(&id);
        IPropertyStore *ps = NULL;
        std::string name, desc, iface; int ff = -1;
        if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &ps)) && ps) {
            name = propStr(ps, PK_FriendlyName);
            desc = propStr(ps, PK_DeviceDesc);
            iface = propStr(ps, PK_InterfaceName);
            ff = propU32(ps, PK_FormFactor);
            ps->Release();
        }
        BOOL m = FALSE; float vol = 0;
        IAudioEndpointVolume *v = volumeOf(d);
        if (v) { v->GetMute(&m); v->GetMasterVolumeLevelScalar(&vol); v->Release(); }
        if (!first) o += ",";
        first = false;
        o += "{\"id\":" + jstr(utf8(id)) + ",\"name\":" + jstr(name) + ",\"desc\":" + jstr(desc) +
             ",\"iface\":" + jstr(iface) + ",\"ff\":" + std::to_string(ff) +
             ",\"vol\":" + std::to_string(pct(vol)) + ",\"muted\":" + (m ? "true" : "false") + "}";
        if (id) CoTaskMemFree(id);
        d->Release();
    }
    col->Release();
    return o + "]";
}
static std::string buildState() {
    return "{\"type\":\"state\",\"defRender\":" + jstr(defaultId(eRender)) +
           ",\"defCapture\":" + jstr(defaultId(eCapture)) +
           ",\"render\":" + listFlow(eRender) +
           ",\"capture\":" + listFlow(eCapture) + "}";
}

// ---------- device commands ----------
static void cmdSet(const std::string &id) {
    IPolicyConfig *pc = NULL;
    HRESULT hr = CoCreateInstance(CLSID_PolicyConfigClient, NULL, CLSCTX_ALL, IID_IPolicyConfig, (void **)&pc);
    if (FAILED(hr) || !pc) { writeLine("{\"type\":\"error\",\"msg\":\"PolicyConfig unavailable\"}"); return; }
    std::wstring w = wide(id);
    HRESULT a = pc->SetDefaultEndpoint(w.c_str(), eConsole);
    pc->SetDefaultEndpoint(w.c_str(), eMultimedia);
    pc->SetDefaultEndpoint(w.c_str(), eCommunications);
    pc->Release();
    if (FAILED(a)) writeLine("{\"type\":\"error\",\"msg\":\"set failed\",\"id\":" + jstr(id) + "}");
}
static void cmdMute(const std::string &mode, const std::string &id) {
    IMMDevice *d = deviceFor(eCapture, id);
    if (!d) return;
    IAudioEndpointVolume *v = volumeOf(d);
    if (v) {
        BOOL m = FALSE; v->GetMute(&m);
        BOOL nm = mode == "1" ? TRUE : mode == "0" ? FALSE : !m;
        v->SetMute(nm, NULL);
        v->Release();
    }
    d->Release();
}
static void cmdVol(const std::string &flow, const std::string &spec, const std::string &id) {
    IMMDevice *d = deviceFor(flow == "c" ? eCapture : eRender, id);
    if (!d) return;
    IAudioEndpointVolume *v = volumeOf(d);
    if (v) {
        float cur = 0; v->GetMasterVolumeLevelScalar(&cur);
        v->SetMasterVolumeLevelScalar(applySpec(cur, spec), NULL);
        v->Release();
    }
    d->Release();
}

// ---------- processes ----------
static std::map<DWORD, std::string> snapshot() {
    std::map<DWORD, std::string> r;
    HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h == INVALID_HANDLE_VALUE) return r;
    PROCESSENTRY32W e; e.dwSize = sizeof e;
    if (Process32FirstW(h, &e)) {
        do { r[e.th32ProcessID] = lower(utf8(e.szExeFile)); } while (Process32NextW(h, &e));
    }
    CloseHandle(h);
    return r;
}
static std::wstring procPath(DWORD pid) {
    std::wstring r;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return r;
    wchar_t buf[1024]; DWORD n = 1024;
    if (QueryFullProcessImageNameW(h, 0, buf, &n)) r.assign(buf, n);
    CloseHandle(h);
    return r;
}
static std::string fileDesc(const std::wstring &path) {
    DWORD h = 0, n = GetFileVersionInfoSizeW(path.c_str(), &h);
    if (!n) return "";
    std::vector<BYTE> buf(n);
    if (!GetFileVersionInfoW(path.c_str(), 0, n, buf.data())) return "";
    struct Lang { WORD lang, cp; } *tr = NULL;
    UINT tl = 0;
    wchar_t q[80] = L"\\StringFileInfo\\040904b0\\FileDescription";
    if (VerQueryValueW(buf.data(), L"\\VarFileInfo\\Translation", (LPVOID *)&tr, &tl) && tr && tl >= sizeof(Lang))
        _snwprintf(q, 80, L"\\StringFileInfo\\%04x%04x\\FileDescription", tr[0].lang, tr[0].cp);
    wchar_t *v = NULL; UINT vl = 0;
    if (VerQueryValueW(buf.data(), q, (LPVOID *)&v, &vl) && v && vl > 1) return utf8(v);
    return "";
}
struct ProcInfo { std::string exe, name; std::wstring path; };
static std::map<DWORD, ProcInfo> g_pinfo;
static const ProcInfo &infoOf(DWORD pid) {
    auto it = g_pinfo.find(pid);
    if (it != g_pinfo.end()) return it->second;
    ProcInfo p;
    p.path = procPath(pid);
    if (!p.path.empty()) p.exe = baseName(p.path);
    else {
        auto s = snapshot();
        auto f = s.find(pid);
        p.exe = f != s.end() ? f->second : "pid" + std::to_string(pid);
    }
    std::string stem = p.exe;
    if (stem.size() > 4 && stem.compare(stem.size() - 4, 4, ".exe") == 0) stem.resize(stem.size() - 4);
    std::string d = p.path.empty() ? "" : fileDesc(p.path);
    while (!d.empty() && d.back() == ' ') d.pop_back();
    p.name = (!d.empty() && d.size() <= 24) ? d : stem;
    return g_pinfo[pid] = p;
}

// ---------- program audio sessions (on every active output) ----------
template <class F> static void forEachSession(F f) {
    IMMDeviceCollection *col = NULL;
    if (FAILED(g_enum->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col)) || !col) return;
    UINT n = 0; col->GetCount(&n);
    for (UINT i = 0; i < n; i++) {
        IMMDevice *d = NULL;
        if (FAILED(col->Item(i, &d)) || !d) continue;
        IAudioSessionManager2 *m = NULL;
        if (SUCCEEDED(d->Activate(IID_IAudioSessionManager2, CLSCTX_ALL, NULL, (void **)&m)) && m) {
            IAudioSessionEnumerator *se = NULL;
            if (SUCCEEDED(m->GetSessionEnumerator(&se)) && se) {
                int c = 0; se->GetCount(&c);
                for (int k = 0; k < c; k++) {
                    IAudioSessionControl *sc = NULL;
                    if (FAILED(se->GetSession(k, &sc)) || !sc) continue;
                    IAudioSessionControl2 *s2 = NULL;
                    if (SUCCEEDED(sc->QueryInterface(IID_IAudioSessionControl2, (void **)&s2)) && s2) {
                        DWORD pid = 0; s2->GetProcessId(&pid);
                        AudioSessionState st = AudioSessionStateInactive; s2->GetState(&st);
                        if (pid && s2->IsSystemSoundsSession() != S_OK && st != AudioSessionStateExpired) {
                            ISimpleAudioVolume *sv = NULL;
                            if (SUCCEEDED(sc->QueryInterface(IID_ISimpleAudioVolume, (void **)&sv)) && sv) {
                                f(pid, st, sv);
                                sv->Release();
                            }
                        }
                        s2->Release();
                    }
                    sc->Release();
                }
                se->Release();
            }
            m->Release();
        }
        d->Release();
    }
    col->Release();
}
struct AppAgg { std::string name; float vol = 0; bool muted = true, active = false; int n = 0; };
static std::string buildApps() {
    std::map<std::string, AppAgg> agg; // sorted by exe, so the list order is stable
    forEachSession([&](DWORD pid, AudioSessionState st, ISimpleAudioVolume *sv) {
        const ProcInfo &p = infoOf(pid);
        AppAgg &a = agg[p.exe];
        float v = 0; BOOL m = FALSE;
        sv->GetMasterVolume(&v); sv->GetMute(&m);
        if (a.n == 0) { a.name = p.name; a.vol = v; a.muted = m != FALSE; }
        else { if (v > a.vol) a.vol = v; a.muted = a.muted && m; }
        if (st == AudioSessionStateActive) a.active = true;
        a.n++;
    });
    std::string o = "{\"type\":\"apps\",\"apps\":[";
    bool first = true;
    for (auto &kv : agg) {
        if (!first) o += ",";
        first = false;
        o += "{\"exe\":" + jstr(kv.first) + ",\"name\":" + jstr(kv.second.name) + ",\"vol\":" + std::to_string(pct(kv.second.vol)) +
             ",\"muted\":" + (kv.second.muted ? "true" : "false") + ",\"active\":" + (kv.second.active ? "true" : "false") + "}";
    }
    return o + "]}";
}
static void cmdAppVol(const std::string &spec, const std::string &exe) {
    std::string e = lower(exe);
    float cur = -1;
    forEachSession([&](DWORD pid, AudioSessionState, ISimpleAudioVolume *sv) {
        if (infoOf(pid).exe != e) return;
        float v = 0; sv->GetMasterVolume(&v);
        if (v > cur) cur = v;
    });
    if (cur < 0) return;
    float nv = applySpec(cur, spec);
    forEachSession([&](DWORD pid, AudioSessionState, ISimpleAudioVolume *sv) {
        if (infoOf(pid).exe == e) sv->SetMasterVolume(nv, NULL);
    });
}
static void cmdAppMute(const std::string &mode, const std::string &exe) {
    std::string e = lower(exe);
    bool found = false, allMuted = true;
    forEachSession([&](DWORD pid, AudioSessionState, ISimpleAudioVolume *sv) {
        if (infoOf(pid).exe != e) return;
        BOOL m = FALSE; sv->GetMute(&m);
        found = true; allMuted = allMuted && m;
    });
    if (!found) return;
    BOOL nm = mode == "1" ? TRUE : mode == "0" ? FALSE : !allMuted;
    forEachSession([&](DWORD pid, AudioSessionState, ISimpleAudioVolume *sv) {
        if (infoOf(pid).exe == e) sv->SetMute(nm, NULL);
    });
}

// ---------- program icon -> PNG (no extra libraries: stored deflate) ----------
static uint32_t g_crc[256];
static void crcInit() {
    for (uint32_t n = 0; n < 256; n++) {
        uint32_t c = n;
        for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        g_crc[n] = c;
    }
}
static uint32_t crc32(const std::string &s) {
    uint32_t c = 0xffffffffu;
    for (unsigned char b : s) c = g_crc[(c ^ b) & 0xff] ^ (c >> 8);
    return c ^ 0xffffffffu;
}
static void put32(std::string &o, uint32_t v) {
    o += (char)(v >> 24); o += (char)(v >> 16); o += (char)(v >> 8); o += (char)v;
}
static void pngChunk(std::string &o, const char *type, const std::string &data) {
    put32(o, (uint32_t)data.size());
    std::string td = std::string(type, 4) + data;
    o += td;
    put32(o, crc32(td));
}
static std::string pngRGBA(const std::vector<unsigned char> &rgba, int w, int h) {
    std::string raw;
    for (int y = 0; y < h; y++) { raw += '\0'; raw.append((const char *)&rgba[(size_t)y * w * 4], (size_t)w * 4); }
    std::string z = "\x78\x01";
    size_t pos = 0;
    for (;;) {
        size_t len = std::min<size_t>(65535, raw.size() - pos);
        bool last = pos + len == raw.size();
        z += (char)(last ? 1 : 0);
        z += (char)(len & 0xff); z += (char)(len >> 8);
        z += (char)(~len & 0xff); z += (char)((~len >> 8) & 0xff);
        z.append(raw, pos, len);
        pos += len;
        if (last) break;
    }
    uint32_t a = 1, b = 0;
    for (unsigned char c : raw) { a = (a + c) % 65521; b = (b + a) % 65521; }
    put32(z, (b << 16) | a);
    std::string ihdr;
    put32(ihdr, (uint32_t)w); put32(ihdr, (uint32_t)h);
    ihdr += (char)8; ihdr += (char)6; ihdr += (char)0; ihdr += (char)0; ihdr += (char)0;
    std::string o = "\x89PNG\r\n\x1a\n";
    pngChunk(o, "IHDR", ihdr);
    pngChunk(o, "IDAT", z);
    pngChunk(o, "IEND", "");
    return o;
}
static std::string base64(const std::string &s) {
    static const char *t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string o;
    size_t i = 0;
    for (; i + 2 < s.size(); i += 3) {
        uint32_t v = ((unsigned char)s[i] << 16) | ((unsigned char)s[i + 1] << 8) | (unsigned char)s[i + 2];
        o += t[v >> 18]; o += t[(v >> 12) & 63]; o += t[(v >> 6) & 63]; o += t[v & 63];
    }
    if (i + 1 == s.size()) {
        uint32_t v = (unsigned char)s[i] << 16;
        o += t[v >> 18]; o += t[(v >> 12) & 63]; o += "==";
    } else if (i + 2 == s.size()) {
        uint32_t v = ((unsigned char)s[i] << 16) | ((unsigned char)s[i + 1] << 8);
        o += t[v >> 18]; o += t[(v >> 12) & 63]; o += t[(v >> 6) & 63]; o += '=';
    }
    return o;
}
// Draws the icon on black and on white; the difference gives the alpha of every pixel,
// so old icons with a 1-bit mask and new 32-bit icons both come out right.
static std::string iconPng(const std::wstring &path) {
    const int S = 64;
    HICON hi = NULL; UINT iid = 0;
    UINT got = PrivateExtractIconsW(path.c_str(), 0, S, S, &hi, &iid, 1, 0);
    if (got == 0 || got == 0xFFFFFFFFu || !hi) return "";
    BITMAPINFO bi; ZeroMemory(&bi, sizeof bi);
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = S; bi.bmiHeader.biHeight = -S;
    bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
    HDC dc = CreateCompatibleDC(NULL);
    std::vector<unsigned char> px[2];
    for (int pass = 0; pass < 2; pass++) {
        void *bits = NULL;
        HBITMAP bm = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
        if (!bm || !bits) { if (bm) DeleteObject(bm); continue; }
        HGDIOBJ old = SelectObject(dc, bm);
        memset(bits, pass ? 255 : 0, (size_t)S * S * 4);
        DrawIconEx(dc, 0, 0, hi, S, S, 0, NULL, DI_NORMAL);
        GdiFlush();
        px[pass].assign((unsigned char *)bits, (unsigned char *)bits + (size_t)S * S * 4);
        SelectObject(dc, old);
        DeleteObject(bm);
    }
    DeleteDC(dc);
    DestroyIcon(hi);
    if (px[0].empty() || px[1].empty()) return "";
    std::vector<unsigned char> rgba((size_t)S * S * 4);
    bool any = false;
    for (size_t i = 0; i < (size_t)S * S; i++) {
        const unsigned char *k = &px[0][i * 4], *w = &px[1][i * 4];
        int diff = ((w[0] - k[0]) + (w[1] - k[1]) + (w[2] - k[2])) / 3;
        int a = 255 - std::max(0, std::min(255, diff));
        unsigned char *o = &rgba[i * 4];
        if (a > 0) {
            o[0] = (unsigned char)std::min(255, k[2] * 255 / a);
            o[1] = (unsigned char)std::min(255, k[1] * 255 / a);
            o[2] = (unsigned char)std::min(255, k[0] * 255 / a);
            any = true;
        } else o[0] = o[1] = o[2] = 0;
        o[3] = (unsigned char)a;
    }
    return any ? base64(pngRGBA(rgba, S, S)) : "";
}
static void cmdIcon(const std::string &arg) {
    std::wstring path;
    if (arg.find('\\') != std::string::npos || arg.find('/') != std::string::npos) path = wide(arg);
    else {
        std::string e = lower(arg);
        for (auto &kv : g_pinfo) if (kv.second.exe == e && !kv.second.path.empty()) { path = kv.second.path; break; }
        if (path.empty()) {
            for (auto &kv : snapshot()) {
                if (kv.second != e) continue;
                path = procPath(kv.first);
                if (!path.empty()) break;
            }
        }
    }
    std::string exe = path.empty() ? lower(arg) : baseName(path);
    std::string png = path.empty() ? "" : iconPng(path);
    writeLine("{\"type\":\"icon\",\"exe\":" + jstr(exe) + ",\"query\":" + jstr(arg) + ",\"png\":\"" + png + "\"}");
}

// ---------- microphone level ----------
// A capture endpoint reports a level only while some program records from it,
// so the helper opens its own shared stream (like the Windows Sound panel does).
static IMeterInfo *g_meter = NULL;
static IAudioClient *g_mclient = NULL;
static IAudioCaptureClient *g_mcap = NULL;
static std::string g_meterDev;
static void meterStop() {
    if (g_mclient) g_mclient->Stop();
    if (g_mcap) { g_mcap->Release(); g_mcap = NULL; }
    if (g_mclient) { g_mclient->Release(); g_mclient = NULL; }
    if (g_meter) { g_meter->Release(); g_meter = NULL; }
    g_meterDev.clear();
}
static void meterStart() {
    meterStop();
    IMMDevice *d = deviceFor(eCapture, "");
    if (!d) return;
    LPWSTR id = NULL;
    if (SUCCEEDED(d->GetId(&id))) { g_meterDev = utf8(id); CoTaskMemFree(id); }
    d->Activate(IID_IMeterInfo, CLSCTX_ALL, NULL, (void **)&g_meter);
    if (SUCCEEDED(d->Activate(IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&g_mclient)) && g_mclient) {
        WAVEFORMATEX *fmt = NULL;
        if (SUCCEEDED(g_mclient->GetMixFormat(&fmt)) && fmt) {
            if (SUCCEEDED(g_mclient->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2000000, 0, fmt, NULL)) &&
                SUCCEEDED(g_mclient->GetService(IID_IAudioCaptureClient, (void **)&g_mcap)) && g_mcap)
                g_mclient->Start();
            CoTaskMemFree(fmt);
        }
    }
    d->Release();
}
static void meterDrain() {
    if (!g_mcap) return;
    UINT32 n = 0;
    for (int guard = 0; guard < 64 && SUCCEEDED(g_mcap->GetNextPacketSize(&n)) && n; guard++) {
        BYTE *data = NULL; UINT32 frames = 0; DWORD flags = 0;
        if (FAILED(g_mcap->GetBuffer(&data, &frames, &flags, NULL, NULL))) break;
        g_mcap->ReleaseBuffer(frames);
    }
}

// ---------- running programs ----------
static std::string buildProcs() {
    std::set<std::string> names;
    for (auto &kv : snapshot()) names.insert(kv.second);
    std::string o = "{\"type\":\"procs\",\"list\":[";
    bool first = true;
    for (auto &n : names) { if (!first) o += ","; first = false; o += jstr(n); }
    return o + "]}";
}

// ---------- keyboard ----------
static void cmdKey(const std::string &vkS, const std::string &dir) {
    WORD vk = (WORD)strtoul(vkS.c_str(), NULL, 0);
    if (!vk) return;
    INPUT in; ZeroMemory(&in, sizeof in);
    in.type = INPUT_KEYBOARD;
    in.ki.wVk = vk;
    in.ki.wScan = (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
    in.ki.dwFlags = dir == "up" ? KEYEVENTF_KEYUP : 0;
    SendInput(1, &in, sizeof in);
}

// ---------- Windows device change notifications ----------
class Notifier : public IMMNotificationClient {
    LONG ref = 1;
public:
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref); }
    ULONG STDMETHODCALLTYPE Release() override { ULONG r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
        if (riid == IID_IUnknown || riid == IID_IMMNotificationClient) { *pp = this; AddRef(); return S_OK; }
        *pp = NULL; return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { SetEvent(g_changeEv); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { SetEvent(g_changeEv); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { SetEvent(g_changeEv); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { SetEvent(g_changeEv); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};

// ---------- stdin reader thread ----------
static DWORD WINAPI reader(LPVOID) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    std::string buf;
    char tmp[1024];
    DWORD n;
    while (ReadFile(in, tmp, sizeof tmp, &n, NULL) && n > 0) {
        buf.append(tmp, n);
        size_t p;
        while ((p = buf.find('\n')) != std::string::npos) {
            std::string line = buf.substr(0, p);
            buf.erase(0, p + 1);
            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
            if (line.empty()) continue;
            EnterCriticalSection(&g_cs); g_cmds.push_back(line); LeaveCriticalSection(&g_cs);
            SetEvent(g_cmdEv);
        }
    }
    InterlockedExchange(&g_quit, 1);
    SetEvent(g_cmdEv);
    return 0;
}

int main() {
    if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) return 1;
    if (FAILED(CoCreateInstance(CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, IID_IMMDeviceEnumerator, (void **)&g_enum)) || !g_enum) {
        writeLine("{\"type\":\"error\",\"msg\":\"no audio enumerator\"}");
        return 2;
    }
    crcInit();
    InitializeCriticalSection(&g_cs);
    g_changeEv = CreateEventW(NULL, FALSE, FALSE, NULL);
    g_cmdEv = CreateEventW(NULL, FALSE, FALSE, NULL);
    Notifier *nt = new Notifier();
    g_enum->RegisterEndpointNotificationCallback(nt);
    CreateThread(NULL, 0, reader, NULL, 0, NULL);

    std::string last, lastApps, lastProcs;
    bool force = true, appsOn = false, watchOn = false, meterOn = false, forceApps = false, forceProcs = false;
    ULONGLONG tState = 0, tApps = 0, tProcs = 0;
    while (!g_quit) {
        HANDLE hs[2] = {g_cmdEv, g_changeEv};
        // mute, volume and programs have no cheap notifications here, so poll as well
        DWORD r = WaitForMultipleObjects(2, hs, FALSE, meterOn ? 50 : 150);
        if (r == WAIT_OBJECT_0 + 1) force = true;
        for (;;) {
            std::string c;
            EnterCriticalSection(&g_cs);
            if (!g_cmds.empty()) { c = g_cmds.front(); g_cmds.pop_front(); }
            LeaveCriticalSection(&g_cs);
            if (c.empty()) break;
            std::vector<std::string> w = words(c, 2);
            const std::string &cmd = w[0], rest = w.size() > 1 ? w[1] : "";
            if (cmd == "list") force = true;
            else if (cmd == "set") { cmdSet(rest); force = true; }
            else if (cmd == "mute") {
                std::vector<std::string> a = words(rest, 2);
                cmdMute(a[0], a.size() > 1 ? a[1] : "");
                force = true;
            } else if (cmd == "vol") {
                std::vector<std::string> a = words(rest, 3);
                if (a.size() >= 2) cmdVol(a[0], a[1], a.size() > 2 ? a[2] : "");
                force = true;
            } else if (cmd == "apps") {
                appsOn = rest != "off";
                forceApps = true; lastApps.clear();
            } else if (cmd == "appvol" || cmd == "appmute") {
                std::vector<std::string> a = words(rest, 2);
                if (a.size() == 2) { if (cmd == "appvol") cmdAppVol(a[0], a[1]); else cmdAppMute(a[0], a[1]); }
                forceApps = true;
            } else if (cmd == "icon") cmdIcon(rest);
            else if (cmd == "meter") {
                bool on = rest != "off";
                if (on && !meterOn) meterStart();
                if (!on && meterOn) meterStop();
                meterOn = on;
            } else if (cmd == "watch") {
                watchOn = rest != "off";
                forceProcs = true; lastProcs.clear();
            } else if (cmd == "key") {
                std::vector<std::string> a = words(rest, 2);
                if (a.size() == 2) cmdKey(a[0], a[1]);
            } else if (cmd == "quit") InterlockedExchange(&g_quit, 1);
        }
        if (g_quit) break;
        ULONGLONG now = GetTickCount64();
        if (force || now - tState >= 400) {
            std::string s = buildState();
            if (force || s != last) { writeLine(s); last = s; }
            force = false; tState = now;
            if (meterOn && defaultId(eCapture) != g_meterDev) meterStart();
        }
        if (appsOn && (forceApps || now - tApps >= 500)) {
            std::string s = buildApps();
            if (s != lastApps) { writeLine(s); lastApps = s; }
            forceApps = false; tApps = now;
            if (g_pinfo.size() > 512) g_pinfo.clear();
        }
        if (watchOn && (forceProcs || now - tProcs >= 1500)) {
            std::string s = buildProcs();
            if (s != lastProcs) { writeLine(s); lastProcs = s; }
            forceProcs = false; tProcs = now;
        }
        if (meterOn) {
            meterDrain();
            float pk = 0;
            if (g_meter) g_meter->GetPeakValue(&pk);
            char b[64]; snprintf(b, sizeof b, "{\"type\":\"meter\",\"peak\":%.4f}", pk);
            writeLine(b);
        }
    }
    meterStop();
    g_enum->UnregisterEndpointNotificationCallback(nt);
    nt->Release();
    g_enum->Release();
    CoUninitialize();
    return 0;
}
