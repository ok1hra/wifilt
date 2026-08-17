#include "paths.h"

#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>

#ifdef _WIN32
  #include <direct.h>
  #include <windows.h>
  #define WIFILT_PATH_SEP '\\'
#else
  #include <limits.h>
  #include <unistd.h>
  #define WIFILT_PATH_SEP '/'
  #ifdef __APPLE__
    #include <mach-o/dyld.h>
  #endif
#endif

namespace {

std::string dataDir;
std::string configDir;

std::string executableDir() {
#ifdef _WIN32
  char buffer[MAX_PATH];
  DWORD length = GetModuleFileNameA(nullptr, buffer, MAX_PATH);
  if (length == 0 || length == MAX_PATH) return ".";
  std::string path(buffer, length);
#elif defined(__APPLE__)
  // Darwin has no /proc. _NSGetExecutablePath may return a path containing
  // symlinks or "..", which is fine here -- it is only used to locate the
  // sibling data/ directory.
  char buffer[PATH_MAX];
  uint32_t size = sizeof(buffer);
  if (_NSGetExecutablePath(buffer, &size) != 0) return ".";
  std::string path(buffer);
#else
  char buffer[PATH_MAX];
  ssize_t length = readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
  if (length <= 0) return ".";
  std::string path(buffer, (size_t)length);
#endif
  size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? std::string(".") : path.substr(0, slash);
}

std::string defaultConfigDir() {
#ifdef _WIN32
  const char *appData = getenv("APPDATA");
  if (appData && *appData) return std::string(appData) + "\\wifilt";
  return executableDir() + "\\config";
#else
  const char *xdg = getenv("XDG_CONFIG_HOME");
  if (xdg && *xdg) return std::string(xdg) + "/wifilt";
  const char *home = getenv("HOME");
  if (home && *home) return std::string(home) + "/.config/wifilt";
  return executableDir() + "/config";
#endif
}

}  // namespace

const std::string &nativeDataDir() {
  if (dataDir.empty()) dataDir = executableDir() + WIFILT_PATH_SEP + "data";
  return dataDir;
}

const std::string &nativeConfigDir() {
  if (configDir.empty()) configDir = defaultConfigDir();
  return configDir;
}

void nativeSetDataDir(const std::string &path) { dataDir = path; }
void nativeSetConfigDir(const std::string &path) { configDir = path; }

bool nativeEnsureDir(const std::string &path) {
  if (path.empty()) return false;

  struct stat info;
  if (stat(path.c_str(), &info) == 0) {
#ifdef _WIN32
    return (info.st_mode & S_IFDIR) != 0;
#else
    return S_ISDIR(info.st_mode);
#endif
  }

  // Create parents first -- the default config path is two levels deep
  // (~/.config/wifilt) and ~/.config may not exist on a bare account.
  size_t slash = path.find_last_of("/\\");
  if (slash != std::string::npos && slash > 0) {
    if (!nativeEnsureDir(path.substr(0, slash))) return false;
  }

#ifdef _WIN32
  return _mkdir(path.c_str()) == 0;
#else
  return mkdir(path.c_str(), 0700) == 0;
#endif
}

std::string nativeJoinPath(const std::string &root, const std::string &child) {
  if (child.empty()) return root;

  // The sketch names its config files with a leading slash ("/log-config",
  // "/bd-config.json") because on LittleFS that is the filesystem root. Here
  // those are relative to the config directory, so the slash is stripped rather
  // than turning the path absolute.
  size_t start = 0;
  while (start < child.size() && (child[start] == '/' || child[start] == '\\')) start++;

  std::string relative = child.substr(start);
#ifdef _WIN32
  for (char &c : relative) {
    if (c == '/') c = '\\';
  }
#endif

  if (root.empty()) return relative;
  if (root.back() == '/' || root.back() == '\\') return root + relative;
  return root + WIFILT_PATH_SEP + relative;
}
