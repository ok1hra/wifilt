#include "FS.h"

#include "paths.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#ifdef _WIN32
  #include <direct.h>
#else
  #include <dirent.h>
  #include <unistd.h>
#endif

namespace fs {

// The open file itself. Held by shared_ptr so File can be copied and returned
// by value the way the sketch uses it ("File f = cfgFS.open(...)").
class FileHandle {
public:
  FileHandle(FILE *stream, std::string name, std::string path, bool directory)
      : stream(stream), fileName(std::move(name)), filePath(std::move(path)),
        directory(directory) {}

  ~FileHandle() { close(); }

  void close() {
    if (stream) {
      fclose(stream);
      stream = nullptr;
    }
  }

  FILE       *stream;
  std::string fileName;
  std::string filePath;
  bool        directory;
};

File::File() {
  // Matches the ESP32 File constructor (FS.h:51): a zero read timeout, so
  // readString()/readStringUntil() return at EOF instead of stalling for the
  // Stream default of one second on every config read.
  setTimeout(0);
}

File::File(std::shared_ptr<FileHandle> handle) : handle(std::move(handle)) {
  setTimeout(0);
}

File::operator bool() const { return handle && handle->stream != nullptr; }

size_t File::write(uint8_t value) {
  if (!*this) return 0;
  return fputc(value, handle->stream) == EOF ? 0 : 1;
}

size_t File::write(const uint8_t *buffer, size_t length) {
  if (!*this || !buffer) return 0;
  return fwrite(buffer, 1, length, handle->stream);
}

int File::available() {
  if (!*this) return 0;
  long current = ftell(handle->stream);
  if (current < 0) return 0;
  if (fseek(handle->stream, 0, SEEK_END) != 0) return 0;
  long end = ftell(handle->stream);
  fseek(handle->stream, current, SEEK_SET);
  return end > current ? (int)(end - current) : 0;
}

int File::read() {
  if (!*this) return -1;
  int c = fgetc(handle->stream);
  return c == EOF ? -1 : c;
}

int File::peek() {
  if (!*this) return -1;
  int c = fgetc(handle->stream);
  if (c == EOF) return -1;
  ungetc(c, handle->stream);
  return c;
}

void File::flush() {
  if (*this) fflush(handle->stream);
}

size_t File::readBytes(char *buffer, size_t length) {
  return read((uint8_t *)buffer, length);
}

size_t File::read(uint8_t *buffer, size_t length) {
  if (!*this || !buffer) return 0;
  return fread(buffer, 1, length, handle->stream);
}

bool File::seek(uint32_t position) {
  if (!*this) return false;
  return fseek(handle->stream, (long)position, SEEK_SET) == 0;
}

size_t File::position() const {
  if (!handle || !handle->stream) return 0;
  long current = ftell(handle->stream);
  return current < 0 ? 0 : (size_t)current;
}

size_t File::size() const {
  if (!handle || !handle->stream) return 0;
  long current = ftell(handle->stream);
  if (current < 0) return 0;
  if (fseek(handle->stream, 0, SEEK_END) != 0) return 0;
  long end = ftell(handle->stream);
  fseek(handle->stream, current, SEEK_SET);
  return end < 0 ? 0 : (size_t)end;
}

void File::close() {
  if (handle) handle->close();
}

const char *File::name() const { return handle ? handle->fileName.c_str() : ""; }
const char *File::path() const { return handle ? handle->filePath.c_str() : ""; }
bool File::isDirectory() const { return handle && handle->directory; }

// ---------------------------------------------------------------------------
// LittleFSFS
// ---------------------------------------------------------------------------

bool LittleFSFS::begin(bool formatOnFail) {
  if (root.empty()) return false;
  if (!nativeEnsureDir(root)) {
    // formatOnFail on the box reformats the partition; the closest honest
    // equivalent here is "the directory could not be created", which is a hard
    // failure either way.
    (void)formatOnFail;
    return false;
  }
  mounted = true;
  return true;
}

bool LittleFSFS::begin(bool formatOnFail, const char *, uint8_t, const char *) {
  return begin(formatOnFail);
}

void LittleFSFS::end() { mounted = false; }

void LittleFSFS::nativeSetRoot(const std::string &path) { root = path; }

File LittleFSFS::open(const char *path, const char *mode) {
  if (!path || root.empty()) return File();

  const std::string full = nativeJoinPath(root, path);

  struct stat info;
  if (stat(full.c_str(), &info) == 0) {
#ifdef _WIN32
    bool isDir = (info.st_mode & S_IFDIR) != 0;
#else
    bool isDir = S_ISDIR(info.st_mode);
#endif
    if (isDir) {
      return File(std::make_shared<FileHandle>(nullptr, path, full, true));
    }
  }

  // Modes arrive as both the FILE_READ macros and bare "r"/"w" literals; both
  // are already fopen syntax, but binary mode has to be forced or Windows will
  // translate CRLF inside the config files and the served assets.
  std::string binaryMode(mode ? mode : "r");
  if (binaryMode.find('b') == std::string::npos) binaryMode += "b";

  FILE *stream = fopen(full.c_str(), binaryMode.c_str());
  if (!stream) return File();

  return File(std::make_shared<FileHandle>(stream, path, full, false));
}

File LittleFSFS::open(const String &path, const char *mode) {
  return open(path.c_str(), mode);
}

bool LittleFSFS::exists(const char *path) {
  if (!path || root.empty()) return false;
  struct stat info;
  return stat(nativeJoinPath(root, path).c_str(), &info) == 0;
}

bool LittleFSFS::exists(const String &path) { return exists(path.c_str()); }

bool LittleFSFS::remove(const char *path) {
  if (!path || root.empty()) return false;
  return ::remove(nativeJoinPath(root, path).c_str()) == 0;
}

bool LittleFSFS::remove(const String &path) { return remove(path.c_str()); }

bool LittleFSFS::rename(const char *from, const char *to) {
  if (!from || !to || root.empty()) return false;
  const std::string target = nativeJoinPath(root, to);
#ifdef _WIN32
  ::remove(target.c_str());
#endif
  return ::rename(nativeJoinPath(root, from).c_str(), target.c_str()) == 0;
}

bool LittleFSFS::mkdir(const char *path) {
  if (!path || root.empty()) return false;
  return nativeEnsureDir(nativeJoinPath(root, path));
}

// The box reports real partition geometry here and SETUP shows it. A PC has no
// partition, so this reports the directory's actual usage against a nominal
// capacity -- honest numbers rather than a fabricated "plenty of room".
size_t LittleFSFS::totalBytes() {
  return usedBytes() + (64u * 1024u * 1024u);
}

size_t LittleFSFS::usedBytes() {
  if (root.empty()) return 0;

  size_t total = 0;
#ifndef _WIN32
  DIR *dir = opendir(root.c_str());
  if (!dir) return 0;
  while (struct dirent *entry = readdir(dir)) {
    if (entry->d_name[0] == '.') continue;
    struct stat info;
    if (stat(nativeJoinPath(root, entry->d_name).c_str(), &info) == 0)
      total += (size_t)info.st_size;
  }
  closedir(dir);
#endif
  return total;
}

}  // namespace fs

fs::LittleFSFS LittleFS;
