// apmhelper.exe — audio helper for the Audio Profiles plugin (Stream Dock).
// Talks to the plugin in lines over stdin/stdout:
//   in:   "list"                 — send state now
//          "set <id>"             — make the device default (all roles: console, multimedia, communications)
//          "mute <1|0|t> [id]"    — mute/unmute/toggle a microphone (no id = default)
//   out:  {"type":"state",...}   — whenever something changes (devices, defaults, mute)
// Exits when stdin closes (that is, when the plugin closes).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <string>
#include <vector>
#include <deque>

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
static void writeLine(const std::string &s) {
    std::string l = s + "\n";
    DWORD w;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), l.data(), (DWORD)l.size(), &w, NULL);
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
static IAudioEndpointVolume *volumeOf(IMMDevice *d) {
    IAudioEndpointVolume *v = NULL;
    if (FAILED(d->Activate(IID_IAudioEndpointVolume, CLSCTX_ALL, NULL, (void **)&v))) return NULL;
    return v;
}

// ---------- state ----------
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
        if (!first) o += ",";
        first = false;
        o += "{\"id\":" + jstr(utf8(id)) + ",\"name\":" + jstr(name) + ",\"desc\":" + jstr(desc) +
             ",\"iface\":" + jstr(iface) + ",\"ff\":" + std::to_string(ff);
        if (flow == eCapture) {
            BOOL m = FALSE;
            IAudioEndpointVolume *v = volumeOf(d);
            if (v) { v->GetMute(&m); v->Release(); }
            o += std::string(",\"muted\":") + (m ? "true" : "false");
        }
        o += "}";
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

// ---------- commands ----------
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
    IMMDevice *d = NULL;
    if (id.empty()) g_enum->GetDefaultAudioEndpoint(eCapture, eConsole, &d);
    else { std::wstring w = wide(id); g_enum->GetDevice(w.c_str(), &d); }
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
    InitializeCriticalSection(&g_cs);
    g_changeEv = CreateEventW(NULL, FALSE, FALSE, NULL);
    g_cmdEv = CreateEventW(NULL, FALSE, FALSE, NULL);
    Notifier *nt = new Notifier();
    g_enum->RegisterEndpointNotificationCallback(nt);
    CreateThread(NULL, 0, reader, NULL, 0, NULL);

    std::string last;
    bool force = true;
    while (!g_quit) {
        HANDLE hs[2] = {g_cmdEv, g_changeEv};
        WaitForMultipleObjects(2, hs, FALSE, 400); // mute has no notifications, so poll as well
        for (;;) {
            std::string c;
            EnterCriticalSection(&g_cs);
            if (!g_cmds.empty()) { c = g_cmds.front(); g_cmds.pop_front(); }
            LeaveCriticalSection(&g_cs);
            if (c.empty()) break;
            if (c == "list") force = true;
            else if (c.rfind("set ", 0) == 0) cmdSet(c.substr(4));
            else if (c.rfind("mute ", 0) == 0) {
                std::string rest = c.substr(5), mode = rest, id;
                size_t sp = rest.find(' ');
                if (sp != std::string::npos) { mode = rest.substr(0, sp); id = rest.substr(sp + 1); }
                cmdMute(mode, id);
            }
            else if (c == "quit") InterlockedExchange(&g_quit, 1);
        }
        if (g_quit) break;
        std::string s = buildState();
        if (force || s != last) { writeLine(s); last = s; force = false; }
    }
    g_enum->UnregisterEndpointNotificationCallback(nt);
    nt->Release();
    g_enum->Release();
    CoUninitialize();
    return 0;
}
