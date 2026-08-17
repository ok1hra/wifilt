# WIFILT -- native build (Linux primary, Windows via mingw-w64, macOS in-code).
#
#   make            build for the host
#   make win        cross-compile a static Windows .exe
#   make run        build and run against ./_run as the config directory
#   make clean
#
# The sketch is compiled with ARDUINO defined on purpose. The #else branches in
# icomLanClient.h are prototype scaffolding -- empty audioLock(), empty
# drainAudioRx(), no TX path at all -- while the #ifdef ARDUINO branch is the
# code actually flown against a radio. Defining ARDUINO makes both targets run
# the same path; native/platform/freertos_compat.* supplies the five FreeRTOS
# primitives that needs.

SKETCH_DIR  := ..
TRXNET_DIR  ?= $(HOME)/Arduino/libraries/TrxNet/src
BUILD_DIR   ?= build
TARGET      ?= wifilt

CXX      ?= g++
CC       ?= gcc
CXXSTD   := gnu++17

INCLUDES := -Iarduino -Iplatform -Ifs -Inet -I$(SKETCH_DIR) -I$(TRXNET_DIR)
# WIFILT_NATIVE drives platform_caps.h: no WiFi provisioning, no CI-V wire, no
# GPIO. ARDUINO is defined on purpose -- see the note at the top of this file.
DEFINES  := -DARDUINO=10819 -DWIFILT_NATIVE=1

WARNINGS := -Wall -Wextra -Wno-unused-parameter
OPT      ?= -O2

# -MMD -MP emits a .d file per object listing the headers it used. Without it a
# change to icomLanClient.h or any shim header leaves the stale object in place
# and `make` reports nothing to do -- which is exactly as confusing as it sounds.
DEPFLAGS := -MMD -MP

CXXFLAGS := -std=$(CXXSTD) $(WARNINGS) $(OPT) $(INCLUDES) $(DEFINES) $(DEPFLAGS)
CFLAGS   := -std=gnu11 $(WARNINGS) $(OPT) $(INCLUDES) $(DEFINES) $(DEPFLAGS)

# Static libstdc++/libgcc so the binary does not depend on the build machine's
# GCC version. NOT fully static: WiFi.hostByName -> getaddrinfo needs glibc's
# NSS, which a -static link silently breaks.
LDFLAGS  := -static-libstdc++ -static-libgcc
LDLIBS   := -lpthread

CXX_SOURCES := \
  main.cpp \
  arduino/Arduino.cpp arduino/WString.cpp arduino/Print.cpp \
  arduino/Stream.cpp arduino/IPAddress.cpp \
  platform/paths.cpp platform/process_args.cpp \
  platform/esp_compat.cpp platform/freertos_compat.cpp \
  fs/EEPROM.cpp fs/FS.cpp \
  net/WiFi.cpp net/WiFiUdp.cpp net/WebServer.cpp net/ESPmDNS.cpp \
  net/mbedtls/sha1.cpp \
  $(TRXNET_DIR)/TrxNet.cpp

C_SOURCES := arduino/stdlib_noniso.c arduino/stdlib_extra.c

SKETCH := $(SKETCH_DIR)/wifilt.ino

OBJECTS := \
  $(patsubst %,$(BUILD_DIR)/%.o,$(notdir $(CXX_SOURCES))) \
  $(patsubst %,$(BUILD_DIR)/%.o,$(notdir $(C_SOURCES))) \
  $(BUILD_DIR)/wifilt.ino.o

VPATH := . arduino platform fs net net/mbedtls $(TRXNET_DIR) $(SKETCH_DIR)

.PHONY: all clean run win setcap

all: $(BUILD_DIR)/$(TARGET)

# Ports 80, 82 and 83 are all below 1024, so none of them bind without this --
# and 83 carries the audio, which means no JS8 and no WSPR without it either.
# One capability covers all three, because it belongs to the process rather than
# to a port. It is stored on the inode, so EVERY rebuild drops it: run this again
# after each `make`, or the audio channel fails with a bind error.
setcap: $(BUILD_DIR)/$(TARGET)
	sudo setcap cap_net_bind_service=+ep $(abspath $(BUILD_DIR)/$(TARGET))
	@echo "granted; re-run after every rebuild"

$(BUILD_DIR)/$(TARGET): $(OBJECTS)
	@mkdir -p $(dir $@)
	$(CXX) $(OBJECTS) $(LDFLAGS) $(LDLIBS) -o $@
	@echo "built $@"

# .ino is C++ that relies on the Arduino builder inserting forward declarations.
# 154 of them are already written by hand (wifilt.ino:786 onward); any the
# compiler still misses get added to the sketch rather than generated, so both
# targets keep compiling from one identical file.
# -include Arduino.h reproduces what the Arduino builder does: the sketch uses
# String and byte at line 91, long before its first #include.
$(BUILD_DIR)/wifilt.ino.o: $(SKETCH)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -x c++ -include Arduino.h -c $< -o $@

$(BUILD_DIR)/%.cpp.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD_DIR)/%.c.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

# Windows: fully static is fine here -- no glibc, so no NSS trap. The result has
# no DLL dependencies at all.
#
# The -posix compiler, explicitly, not the plain name: Debian ships mingw in two
# threading flavours and the default is often win32, which has no std::thread,
# std::mutex or std::condition_variable at all -- and those are exactly what the
# FreeRTOS shim is built from. Naming the variant here means the build does not
# depend on how update-alternatives happens to be set on the machine.
win:
	$(MAKE) \
	  CXX=x86_64-w64-mingw32-g++-posix \
	  CC=x86_64-w64-mingw32-gcc-posix \
	  BUILD_DIR=build-win \
	  TARGET=wifilt.exe \
	  LDFLAGS="-static -static-libstdc++ -static-libgcc" \
	  LDLIBS="-lws2_32 -liphlpapi -lwinmm"

run: all
	@mkdir -p _run
	./$(BUILD_DIR)/$(TARGET) --port 8080 --data-dir $(SKETCH_DIR)/data --config-dir _run

# --- distribution ----------------------------------------------------------
#
# Two archives, both self-contained. Linux ships the binary plus data/ and the
# installer; Windows ships one .exe plus data/, because the .exe is fully static
# and needs nothing else. SHA256 sums go beside them: an unsigned download is
# the norm for ham software, but a published checksum is the least that owes
# the person running it.

VERSION ?= $(shell date +%Y%m%d)
DIST    ?= dist
ASSETS  := $(DIST)/assets

.PHONY: dist dist-assets dist-linux dist-windows

dist: dist-linux dist-windows
	@cd $(DIST) && sha256sum *.tar.gz *.zip > SHA256SUMS 2>/dev/null || true
	@rm -rf $(ASSETS)
	@ls -lh $(DIST)

# Built by the project's own tool rather than by copying data/, and the reason is
# not tidiness: prepare-spiffs-tree.sh re-derives every ?v= from the content it
# points at BEFORE minifying, then compresses, then drops the uncompressed
# duplicates. A plain cp would ship HTML whose script tags still carry the
# previous version -- a stale browser cache entry that outlives the install, and
# a bug this project has already been bitten by. It also means the PC ships
# byte-for-byte what the box flashes.
dist-assets:
	@rm -rf $(ASSETS)
	$(SKETCH_DIR)/tools/prepare-spiffs-tree.sh $(SKETCH_DIR)/data $(abspath $(ASSETS))

dist-linux: all dist-assets
	@rm -rf $(DIST)/wifilt-linux-x86_64 && mkdir -p $(DIST)/wifilt-linux-x86_64
	cp $(BUILD_DIR)/$(TARGET) $(DIST)/wifilt-linux-x86_64/wifilt
	cp install.sh             $(DIST)/wifilt-linux-x86_64/
	cp -r $(ASSETS)           $(DIST)/wifilt-linux-x86_64/data
	@cd $(DIST) && tar czf wifilt-linux-x86_64-$(VERSION).tar.gz wifilt-linux-x86_64
	@rm -rf $(DIST)/wifilt-linux-x86_64

dist-windows: win dist-assets
	@rm -rf $(DIST)/wifilt-windows-x64 && mkdir -p $(DIST)/wifilt-windows-x64
	cp build-win/wifilt.exe $(DIST)/wifilt-windows-x64/
	cp -r $(ASSETS)         $(DIST)/wifilt-windows-x64/data
	@cd $(DIST) && zip -qr wifilt-windows-x64-$(VERSION).zip wifilt-windows-x64
	@rm -rf $(DIST)/wifilt-windows-x64

clean:
	rm -rf $(BUILD_DIR) build-win $(DIST)

-include $(OBJECTS:.o=.d)
