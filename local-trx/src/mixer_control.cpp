#include "mixer_control.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

#if defined(_WIN32)
#include <windows.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#else
#include <dlfcn.h>
#include <fstream>
#endif

namespace LocalTrx {

namespace {

double clampDb(double db, double lo, double hi) { return db < lo ? lo : db > hi ? hi : db; }

}  // namespace

#if defined(_WIN32)

// ---- Windows: the output device's endpoint volume ---------------------------

namespace {

// Spelled out rather than taken from mingw's libuuid, which does not carry
// every one of them.
const CLSID kClsidDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
const IID kIidDeviceEnumerator = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
const IID kIidEndpointVolume = {0x5CDF2C82, 0x841E, 0x4546, {0x97, 0x22, 0x0C, 0xF7, 0x40, 0x78, 0x22, 0x9A}};
const PROPERTYKEY kFriendlyName = {{0xA45C254E, 0xDF1C, 0x4EFD, {0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 14};

struct ComScope {
  HRESULT hr;
  // RPC_E_CHANGED_MODE (this thread already chose apartment threading) still
  // lets the calls below run; only a successful init is ours to undo.
  ComScope() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComScope() { if (SUCCEEDED(hr)) CoUninitialize(); }
};

template <class T>
struct Com {
  T *p = nullptr;
  ~Com() { if (p) p->Release(); }
};

std::string utf8(const wchar_t *w) {
  if (!w) return std::string();
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return std::string();
  std::string out((size_t)n - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &out[0], n, nullptr, nullptr);
  return out;
}

std::string friendlyName(IMMDevice *device) {
  Com<IPropertyStore> store;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &store.p))) return std::string();
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string name;
  if (SUCCEEDED(store.p->GetValue(kFriendlyName, &value)) && value.vt == VT_LPWSTR) name = utf8(value.pwszVal);
  PropVariantClear(&value);
  return name;
}

// The render endpoint miniaudio plays to under this name (its WASAPI device
// names are the endpoints' friendly names); "" / "default" = the default one.
bool findEndpointVolume(const std::string &deviceName, IAudioEndpointVolume **out) {
  Com<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(kClsidDeviceEnumerator, nullptr, CLSCTX_ALL, kIidDeviceEnumerator,
                              (void **)&enumerator.p)))
    return false;
  Com<IMMDevice> device;
  if (deviceName.empty() || deviceName == "default") {
    if (FAILED(enumerator.p->GetDefaultAudioEndpoint(eRender, eConsole, &device.p))) return false;
  } else {
    Com<IMMDeviceCollection> devices;
    if (FAILED(enumerator.p->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices.p))) return false;
    UINT count = 0;
    devices.p->GetCount(&count);
    for (UINT i = 0; i < count && !device.p; i++) {
      IMMDevice *candidate = nullptr;
      if (FAILED(devices.p->Item(i, &candidate))) continue;
      if (friendlyName(candidate) == deviceName) device.p = candidate;
      else candidate->Release();
    }
    if (!device.p) return false;
  }
  return SUCCEEDED(device.p->Activate(kIidEndpointVolume, CLSCTX_ALL, nullptr, (void **)out));
}

class EndpointMixer : public MixerControl {
 public:
  explicit EndpointMixer(std::string deviceName) : deviceName_(std::move(deviceName)) {}

  bool range(double *minDb, double *maxDb) override {
    float lo = 0, hi = 0, step = 0;
    if (!rangeOf(&lo, &hi, &step)) return false;
    *minDb = lo;
    *maxDb = hi;
    return true;
  }

  bool getDb(double *dbOut) override {
    ComScope com;
    Com<IAudioEndpointVolume> volume;
    if (!findEndpointVolume(deviceName_, &volume.p)) return false;
    float db = 0;
    if (FAILED(volume.p->GetMasterVolumeLevel(&db))) return false;
    *dbOut = db;
    return true;
  }

  bool setDbAtOrAbove(double wantDb, double *gotDb) override {
    float lo = 0, hi = 0, step = 0;
    if (!rangeOf(&lo, &hi, &step)) return false;
    double target = clampDb(wantDb, lo, hi);
    if (step > 0) target = clampDb(lo + std::ceil((target - lo) / step - 1e-4) * step, lo, hi);
    {
      ComScope com;
      Com<IAudioEndpointVolume> volume;
      if (!findEndpointVolume(deviceName_, &volume.p)) return false;
      if (FAILED(volume.p->SetMasterVolumeLevel((float)target, nullptr))) return false;
    }
    return getDb(gotDb);
  }

  std::string describe() const override {
    return "Windows volume of \"" + (deviceName_.empty() ? std::string("default") : deviceName_) + "\"";
  }

 private:
  bool rangeOf(float *lo, float *hi, float *step) {
    ComScope com;
    Com<IAudioEndpointVolume> volume;
    if (!findEndpointVolume(deviceName_, &volume.p)) return false;
    return SUCCEEDED(volume.p->GetVolumeRange(lo, hi, step));
  }

  std::string deviceName_;
};

}  // namespace

std::vector<MixerChoice> listMixerControls(const std::string &outputDevice) {
  std::vector<MixerChoice> out;
  EndpointMixer mixer(outputDevice);
  MixerChoice choice;
  if (!mixer.range(&choice.minDb, &choice.maxDb) || !(choice.maxDb > choice.minDb)) return out;
  if (!mixer.getDb(&choice.nowDb)) return out;
  choice.card = "endpoint";
  choice.cardName = mixer.describe();
  choice.element = "";
  out.push_back(choice);
  return out;
}

std::unique_ptr<MixerControl> openMixerControl(const AudioConfig &audio, std::string *error) {
  if (audio.mixerCard.empty()) return nullptr;
  if (audio.mixerCard != "endpoint") {
    if (error) *error = "mixer \"" + audio.mixerCard + "\" is not a Windows mixer -- pick it again in Step 1";
    return nullptr;
  }
  return std::unique_ptr<MixerControl>(new EndpointMixer(audio.outputDevice));
}

#else

// ---- Linux: ALSA simple mixer, libasound loaded at run time -----------------

namespace {

// Opaque on purpose: only pointers cross this boundary, so no ALSA header is
// needed to build (the arm64 cross toolchain has none).
struct snd_mixer_t;
struct snd_mixer_elem_t;

struct Alsa {
  bool ok = false;
  int (*mixerOpen)(snd_mixer_t **, int) = nullptr;
  int (*mixerAttach)(snd_mixer_t *, const char *) = nullptr;
  int (*selemRegister)(snd_mixer_t *, void *, void **) = nullptr;
  int (*mixerLoad)(snd_mixer_t *) = nullptr;
  int (*mixerClose)(snd_mixer_t *) = nullptr;
  snd_mixer_elem_t *(*firstElem)(snd_mixer_t *) = nullptr;
  snd_mixer_elem_t *(*elemNext)(snd_mixer_elem_t *) = nullptr;
  const char *(*selemName)(snd_mixer_elem_t *) = nullptr;
  unsigned (*selemIndex)(snd_mixer_elem_t *) = nullptr;
  int (*hasPlaybackVolume)(snd_mixer_elem_t *) = nullptr;
  int (*playbackDbRange)(snd_mixer_elem_t *, long *, long *) = nullptr;
  int (*playbackDb)(snd_mixer_elem_t *, int, long *) = nullptr;   // channel 0 = front left / mono
  int (*setPlaybackDbAll)(snd_mixer_elem_t *, long, int) = nullptr;
  int (*cardNext)(int *) = nullptr;
  int (*cardName)(int, char **) = nullptr;
};

template <class F>
bool bind(void *lib, const char *name, F *out) {
  *out = reinterpret_cast<F>(dlsym(lib, name));
  return *out != nullptr;
}

const Alsa &alsa() {
  static const Alsa loaded = [] {
    Alsa a;
    void *lib = dlopen("libasound.so.2", RTLD_NOW);
    if (!lib) lib = dlopen("libasound.so", RTLD_NOW);
    if (!lib) return a;
    a.ok = bind(lib, "snd_mixer_open", &a.mixerOpen) &&
           bind(lib, "snd_mixer_attach", &a.mixerAttach) &&
           bind(lib, "snd_mixer_selem_register", &a.selemRegister) &&
           bind(lib, "snd_mixer_load", &a.mixerLoad) &&
           bind(lib, "snd_mixer_close", &a.mixerClose) &&
           bind(lib, "snd_mixer_first_elem", &a.firstElem) &&
           bind(lib, "snd_mixer_elem_next", &a.elemNext) &&
           bind(lib, "snd_mixer_selem_get_name", &a.selemName) &&
           bind(lib, "snd_mixer_selem_get_index", &a.selemIndex) &&
           bind(lib, "snd_mixer_selem_has_playback_volume", &a.hasPlaybackVolume) &&
           bind(lib, "snd_mixer_selem_get_playback_dB_range", &a.playbackDbRange) &&
           bind(lib, "snd_mixer_selem_get_playback_dB", &a.playbackDb) &&
           bind(lib, "snd_mixer_selem_set_playback_dB_all", &a.setPlaybackDbAll) &&
           bind(lib, "snd_card_next", &a.cardNext) &&
           bind(lib, "snd_card_get_name", &a.cardName);
    return a;   // the library stays loaded for the life of the process
  }();
  return loaded;
}

// One opened, loaded mixer for one card; closed when it goes out of scope.
class MixerSession {
 public:
  explicit MixerSession(const std::string &card) {
    const Alsa &a = alsa();
    if (!a.ok || a.mixerOpen(&mixer_, 0) < 0) { mixer_ = nullptr; return; }
    if (a.mixerAttach(mixer_, card.c_str()) < 0 || a.selemRegister(mixer_, nullptr, nullptr) < 0 ||
        a.mixerLoad(mixer_) < 0) {
      a.mixerClose(mixer_);
      mixer_ = nullptr;
    }
  }
  ~MixerSession() { if (mixer_) alsa().mixerClose(mixer_); }
  MixerSession(const MixerSession &) = delete;
  MixerSession &operator=(const MixerSession &) = delete;

  snd_mixer_elem_t *first() const { return mixer_ ? alsa().firstElem(mixer_) : nullptr; }

  snd_mixer_elem_t *find(const std::string &name, unsigned index) const {
    const Alsa &a = alsa();
    for (snd_mixer_elem_t *e = first(); e; e = a.elemNext(e)) {
      const char *n = a.selemName(e);
      if (n && name == n && a.selemIndex(e) == index && a.hasPlaybackVolume(e)) return e;
    }
    return nullptr;
  }

 private:
  snd_mixer_t *mixer_ = nullptr;
};

bool dbRangeOf(snd_mixer_elem_t *e, double *lo, double *hi) {
  long min = 0, max = 0;
  if (alsa().playbackDbRange(e, &min, &max) < 0 || max <= min) return false;   // no dB scale
  *lo = min / 100.0;
  *hi = max / 100.0;
  return true;
}

// "PCM" or "PCM,1" (amixer's own spelling for index 1).
void splitElement(const std::string &spec, std::string *name, unsigned *index) {
  *name = spec;
  *index = 0;
  const size_t comma = spec.rfind(',');
  if (comma == std::string::npos || comma + 1 >= spec.size()) return;
  char *end = nullptr;
  const unsigned long n = std::strtoul(spec.c_str() + comma + 1, &end, 10);
  if (*end != '\0') return;
  *name = spec.substr(0, comma);
  *index = (unsigned)n;
}

std::string cardId(int card) {
  char path[64];
  std::snprintf(path, sizeof(path), "/proc/asound/card%d/id", card);
  std::ifstream in(path);
  std::string id;
  if (in && std::getline(in, id) && !id.empty()) return "hw:CARD=" + id;   // survives renumbering
  return "hw:" + std::to_string(card);
}

class AlsaMixer : public MixerControl {
 public:
  AlsaMixer(std::string card, std::string element) : card_(std::move(card)), element_(std::move(element)) {
    splitElement(element_, &name_, &index_);
  }

  bool range(double *minDb, double *maxDb) override {
    MixerSession session(card_);
    snd_mixer_elem_t *e = session.find(name_, index_);
    return e && dbRangeOf(e, minDb, maxDb);
  }

  bool getDb(double *dbOut) override {
    MixerSession session(card_);
    snd_mixer_elem_t *e = session.find(name_, index_);
    long db = 0;
    if (!e || alsa().playbackDb(e, 0, &db) < 0) return false;
    *dbOut = db / 100.0;
    return true;
  }

  bool setDbAtOrAbove(double wantDb, double *gotDb) override {
    MixerSession session(card_);
    snd_mixer_elem_t *e = session.find(name_, index_);
    double lo = 0, hi = 0;
    if (!e || !dbRangeOf(e, &lo, &hi)) return false;
    // dir +1: the step at or above. ceil() keeps the 1/100 dB units from
    // rounding the request itself down past a step boundary.
    const long want = (long)std::ceil(clampDb(wantDb, lo, hi) * 100.0 - 1e-6);
    if (alsa().setPlaybackDbAll(e, want, 1) < 0) return false;
    long db = 0;
    if (alsa().playbackDb(e, 0, &db) < 0) return false;
    *gotDb = db / 100.0;
    return true;
  }

  std::string describe() const override { return "ALSA mixer " + card_ + " \"" + element_ + "\""; }

 private:
  std::string card_, element_, name_;
  unsigned index_ = 0;
};

}  // namespace

std::vector<MixerChoice> listMixerControls(const std::string &) {
  std::vector<MixerChoice> out;
  const Alsa &a = alsa();
  if (!a.ok) return out;
  int card = -1;
  while (a.cardNext(&card) >= 0 && card >= 0) {
    char *name = nullptr;
    std::string cardName = a.cardName(card, &name) >= 0 && name ? name : "card " + std::to_string(card);
    std::free(name);
    MixerSession session("hw:" + std::to_string(card));
    for (snd_mixer_elem_t *e = session.first(); e; e = a.elemNext(e)) {
      MixerChoice choice;
      if (!a.hasPlaybackVolume(e) || !dbRangeOf(e, &choice.minDb, &choice.maxDb)) continue;
      // HDA codecs give their mic boosts and inputs a "playback" volume too
      // (the monitor path); none of them is the level going out to the radio.
      const std::string name = a.selemName(e);
      if (name.find("Boost") != std::string::npos || name.find("Capture") != std::string::npos ||
          name.compare(0, 3, "Mic") == 0)
        continue;
      long now = 0;
      if (a.playbackDb(e, 0, &now) < 0) continue;
      choice.nowDb = now / 100.0;
      const unsigned index = a.selemIndex(e);
      choice.card = cardId(card);
      choice.cardName = cardName;
      choice.element = name + (index ? "," + std::to_string(index) : "");
      out.push_back(choice);
    }
  }
  return out;
}

std::unique_ptr<MixerControl> openMixerControl(const AudioConfig &audio, std::string *error) {
  if (audio.mixerCard.empty()) return nullptr;
  if (!alsa().ok) {
    if (error) *error = "libasound.so.2 not found -- no ALSA mixer on this machine";
    return nullptr;
  }
  if (audio.mixerElement.empty()) {
    if (error) *error = "mixer " + audio.mixerCard + " has no element chosen -- pick one in Step 1";
    return nullptr;
  }
  return std::unique_ptr<MixerControl>(new AlsaMixer(audio.mixerCard, audio.mixerElement));
}

#endif

}  // namespace LocalTrx
