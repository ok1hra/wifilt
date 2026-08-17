// Native stand-in for the ESP32 FS / LittleFS API, backed by a real directory.
//
// Two instances exist, mirroring the box's two partitions:
//   LittleFS -> the shipped web assets (nativeDataDir())
//   cfgFS    -> the operator's configuration (nativeConfigDir())
// The split is deliberate on the box so a firmware flash cannot wipe
// calibrations; here it means reinstalling the binary never touches config.
#pragma once

#include <stdint.h>
#include <stddef.h>

#include <memory>
#include <string>

#include "Arduino.h"

#define FILE_READ   "r"
#define FILE_WRITE  "w"
#define FILE_APPEND "a"

namespace fs {

class FileHandle;

class File : public Stream {
public:
  File();
  explicit File(std::shared_ptr<FileHandle> handle);

  explicit operator bool() const;

  // Print / Stream
  size_t write(uint8_t value) override;
  size_t write(const uint8_t *buffer, size_t length) override;
  using Print::write;

  int  available() override;
  int  read() override;
  int  peek() override;
  void flush() override;

  // Overridden rather than inherited so a bulk read goes straight to fread(),
  // matching the ESP32 File which does the same (FS.h:61).
  size_t readBytes(char *buffer, size_t length);
  size_t read(uint8_t *buffer, size_t length);

  bool     seek(uint32_t position);
  size_t   position() const;
  size_t   size() const;
  void     close();
  const char *name() const;
  const char *path() const;
  bool     isDirectory() const;

private:
  std::shared_ptr<FileHandle> handle;
};

class LittleFSFS {
public:
  // The box's signatures. basePath, maxOpenFiles and the partition label are
  // accepted and ignored -- the host directory is set by main() before setup()
  // runs, from --data-dir / --config-dir.
  bool begin(bool formatOnFail = false);
  bool begin(bool formatOnFail, const char *basePath, uint8_t maxOpenFiles,
             const char *partitionLabel);
  void end();

  File open(const char *path, const char *mode = FILE_READ);
  File open(const String &path, const char *mode = FILE_READ);

  bool exists(const char *path);
  bool exists(const String &path);
  bool remove(const char *path);
  bool remove(const String &path);
  bool rename(const char *from, const char *to);
  bool mkdir(const char *path);

  size_t totalBytes();
  size_t usedBytes();

  // Native-only: assigns the host directory this instance maps onto.
  void nativeSetRoot(const std::string &path);
  const std::string &nativeRoot() const { return root; }

private:
  std::string root;
  bool        mounted = false;
};

}  // namespace fs

using fs::File;

// The web assets. cfgFS is declared by the sketch itself (wifilt.ino:444).
extern fs::LittleFSFS LittleFS;
