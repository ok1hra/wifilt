# local-trx -- PC-side ICOM-LAN-radio impersonator for native wifilt builds.
# See docs/local-trx-implementace.md. Own build, never wired into
# native/Makefile's all/dist targets (bod 1/12): deleting local-trx/ leaves
# native/ fully functional, unchanged.
#
#   make            build for the host (Linux x86_64: dev + CI)
#   make test       build and run the doctest unit tests
#   make arm64      cross-build for 64-bit ARM Linux (Raspberry Pi)
#   make win        cross-build for Windows x64
#   make clean
#
# arm64/win need hamlib+libserialport cross-compiled first (bod 13, Dávka 3):
#   third_party/build-cross-libs.sh [arm64|win|all]

NATIVE_DIR  := ../native
TRXNET_DIR  ?= $(HOME)/Arduino/libraries/TrxNet/src
BUILD_DIR   ?= build
TARGET      ?= local-trx

CXX      ?= g++
CC       ?= gcc
CXXSTD   := gnu++17

# Linux x86_64 (default): system -dev packages via pkg-config. arm64:/win:
# below override BOTH of these with explicit -I/-L/-l flags pointing at
# third_party/cross/<lib>-<target>/ instead (built by
# third_party/build-cross-libs.sh) -- kept as their own two variables rather
# than folded into INCLUDES/LDLIBS directly so a cross target only has to
# replace this one pair, not repeat every other -I/-l flag below too.
HAMLIB_SERIALPORT_CFLAGS := $(shell pkg-config --cflags hamlib libserialport)
HAMLIB_SERIALPORT_LIBS   := $(shell pkg-config --libs hamlib libserialport)

# arduino/net: the shimmed Arduino.h/WiFiUDP reused from native/ (bod 12) so
# icom_lan_wire.h and IcomWire::* compile a second time with zero drift from
# the client. miniaudio needs no pkg-config entry at all -- vendored source,
# see bod 5. fs/platform: WebServer.cpp's own dependencies (fs::File/
# LittleFS + nativeEnsureDir/nativeJoinPath), reused the same way for the
# wizard's HTTP server (fáze 6) rather than a hand-rolled HTTP parser.
INCLUDES := -I$(NATIVE_DIR)/arduino -I$(NATIVE_DIR)/net -I$(NATIVE_DIR)/fs \
            -I$(NATIVE_DIR)/platform -I$(TRXNET_DIR) -Isrc \
            -Ithird_party/miniaudio \
            $(HAMLIB_SERIALPORT_CFLAGS)
DEFINES  := -DARDUINO=10819

WARNINGS := -Wall -Wextra -Wno-unused-parameter
OPT      ?= -O2
DEPFLAGS := -MMD -MP

CXXFLAGS := -std=$(CXXSTD) $(WARNINGS) $(OPT) $(INCLUDES) $(DEFINES) $(DEPFLAGS)
CFLAGS   := -std=gnu11 $(WARNINGS) $(OPT) $(INCLUDES) $(DEFINES) $(DEPFLAGS)

LDFLAGS  := -static-libstdc++ -static-libgcc
# -ldl -lm: miniaudio's own Linux requirement (dlopen()s ALSA/PulseAudio/JACK
# at runtime -- no -lasound/-lpulse needed, see bod 5). Windows needs neither
# (miniaudio uses LoadLibraryA there, no POSIX dlopen) -- win: below drops
# both, see its own comment.
LDLIBS   := -lpthread -ldl -lm $(HAMLIB_SERIALPORT_LIBS)

CXX_SOURCES := \
  main.cpp \
  src/config.cpp src/civ_router.cpp src/hamlib_bridge.cpp src/icom_lan_server.cpp \
  src/udp_socket.cpp src/keyer.cpp src/keying_backend.cpp src/key_runner.cpp \
  src/serial_key.cpp src/audio_bridge.cpp \
  src/trxnet_udp.cpp src/trxnet_peer.cpp \
  src/device_enum.cpp src/webui_server.cpp \
  $(NATIVE_DIR)/arduino/Arduino.cpp $(NATIVE_DIR)/arduino/WString.cpp \
  $(NATIVE_DIR)/arduino/Print.cpp $(NATIVE_DIR)/arduino/Stream.cpp \
  $(NATIVE_DIR)/arduino/IPAddress.cpp \
  $(NATIVE_DIR)/net/WiFi.cpp $(NATIVE_DIR)/net/WebServer.cpp \
  $(NATIVE_DIR)/fs/FS.cpp $(NATIVE_DIR)/platform/paths.cpp \
  $(NATIVE_DIR)/platform/process_args.cpp \
  $(TRXNET_DIR)/TrxNet.cpp

C_SOURCES := $(NATIVE_DIR)/arduino/stdlib_noniso.c $(NATIVE_DIR)/arduino/stdlib_extra.c \
             third_party/miniaudio/miniaudio_impl.c

# Same flattening trick as native/Makefile: every source's basename becomes
# one build/*.o, VPATH finds the originals regardless of which directory
# they actually live in.
OBJECTS := \
  $(patsubst %,$(BUILD_DIR)/%.o,$(notdir $(CXX_SOURCES))) \
  $(patsubst %,$(BUILD_DIR)/%.o,$(notdir $(C_SOURCES)))

VPATH := . src $(NATIVE_DIR)/arduino $(NATIVE_DIR)/net $(NATIVE_DIR)/fs $(NATIVE_DIR)/platform \
         $(TRXNET_DIR) third_party/miniaudio

.PHONY: all clean clean-cross test win arm64

all: $(BUILD_DIR)/$(TARGET)

$(BUILD_DIR)/$(TARGET): $(OBJECTS)
	@mkdir -p $(dir $@)
	$(CXX) $(OBJECTS) $(LDFLAGS) $(LDLIBS) -o $@
	@echo "built $@"

$(BUILD_DIR)/%.cpp.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD_DIR)/%.c.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

# --- cross builds (bod 13, Dávka 3) -------------------------------------
# Same shape as native/Makefile's own win:/arm64: targets: a recursive
# $(MAKE) with CXX/CC/BUILD_DIR/TARGET swapped for the cross toolchain, plus
# HAMLIB_SERIALPORT_CFLAGS/_LIBS replaced to point at third_party/cross/
# (built by third_party/build-cross-libs.sh) instead of pkg-config -- that
# override is picked up when the recursive make re-evaluates INCLUDES/LDLIBS
# from scratch, the same mechanism native/Makefile's LDFLAGS/LDLIBS overrides
# already rely on.
CROSS_DIR := third_party/cross

# Windows: fully static, same reasoning as native/Makefile's own win: target
# (no glibc, so no NSS trap; the .exe needs no DLLs at all). Drops -ldl/
# -lpthread from the base LDLIBS (see their own comment above) -- mingw's
# -posix threading variant provides std::thread/mutex without a separate
# -lpthread, and miniaudio's Windows path never calls dlopen(). Adds
# -lsetupapi (libserialport's own Windows requirement, see its .pc's
# Libs.private) and ws2_32/iphlpapi (WiFi.cpp's own Windows requirement,
# same as native/Makefile's win: target already needs for wifilt itself).
win:
	$(MAKE) \
	  CXX=x86_64-w64-mingw32-g++-posix \
	  CC=x86_64-w64-mingw32-gcc-posix \
	  BUILD_DIR=build-win \
	  TARGET=local-trx.exe \
	  HAMLIB_SERIALPORT_CFLAGS="-I$(CROSS_DIR)/hamlib-win/include -I$(CROSS_DIR)/libserialport-win/include" \
	  LDFLAGS="-static -static-libstdc++ -static-libgcc" \
	  LDLIBS="-L$(CROSS_DIR)/hamlib-win/lib -L$(CROSS_DIR)/libserialport-win/lib -lhamlib -lserialport -lsetupapi -lm -lws2_32 -liphlpapi -lshell32"

# Raspberry Pi (64-bit ARM Linux), cross-compiled from an x86_64 host -- same
# shape as native/Makefile's own arm64: target, same aarch64-linux-gnu-g++
# major version as the host gcc. NOT fully static: still links glibc (same
# NSS trap as the plain Linux target).
arm64:
	$(MAKE) \
	  CXX=aarch64-linux-gnu-g++ \
	  CC=aarch64-linux-gnu-gcc \
	  BUILD_DIR=build-arm64 \
	  TARGET=local-trx \
	  HAMLIB_SERIALPORT_CFLAGS="-I$(CROSS_DIR)/hamlib-arm64/include -I$(CROSS_DIR)/libserialport-arm64/include" \
	  LDFLAGS="-static-libstdc++ -static-libgcc" \
	  LDLIBS="-L$(CROSS_DIR)/hamlib-arm64/lib -L$(CROSS_DIR)/libserialport-arm64/lib -lhamlib -lserialport -lpthread -ldl -lm"

# --- tests -------------------------------------------------------------
# doctest (vendored, third_party/doctest/) links straight against the same
# civ_router.cpp/hamlib_bridge.cpp translation units the real binary uses --
# one copy of the wire-format logic, not a reimplementation for tests.
TEST_BUILD_DIR := build-test
TEST_BIN       := $(TEST_BUILD_DIR)/local-trx-tests
TEST_SOURCES   := tests/test_civ_router.cpp tests/test_config.cpp tests/test_hamlib_bridge.cpp \
                  tests/test_keyer.cpp tests/test_keying_backend.cpp tests/test_key_runner.cpp \
                  tests/test_serial_key.cpp tests/test_audio_bridge.cpp tests/test_device_enum.cpp \
                  src/config.cpp src/civ_router.cpp src/hamlib_bridge.cpp src/keyer.cpp \
                  src/keying_backend.cpp src/key_runner.cpp src/serial_key.cpp src/audio_bridge.cpp \
                  src/device_enum.cpp $(NATIVE_DIR)/platform/paths.cpp
TEST_C_SOURCES := third_party/miniaudio/miniaudio_impl.c
TEST_OBJECTS   := $(patsubst %,$(TEST_BUILD_DIR)/%.o,$(notdir $(TEST_SOURCES))) \
                  $(patsubst %,$(TEST_BUILD_DIR)/%.o,$(notdir $(TEST_C_SOURCES)))

test: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): $(TEST_OBJECTS)
	@mkdir -p $(dir $@)
	$(CXX) $(TEST_OBJECTS) $(LDFLAGS) $(LDLIBS) -o $@

$(TEST_BUILD_DIR)/%.cpp.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -Itests -Ithird_party/doctest -c $< -o $@

$(TEST_BUILD_DIR)/%.c.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

VPATH += tests

clean:
	rm -rf $(BUILD_DIR) $(TEST_BUILD_DIR) build-win build-arm64

# third_party/cross/ (the actual cross-compiled libs) is NOT part of plain
# `clean` -- it takes third_party/build-cross-libs.sh several minutes to
# rebuild (hamlib alone is ~200 backend files), so wiping it needs asking
# for explicitly.
clean-cross:
	rm -rf third_party/cross third_party/.cross-build-work

# Without this, -MMD's own .d files (bod: DEPFLAGS above) are generated but
# never actually consulted, so `make`/`make test` only notice a CHANGED .cpp
# file, never a changed HEADER -- a stale .o from before a shared header edit
# gets silently relinked instead of rebuilt. Found live 2026-09-01 editing
# rig_backend.h during fáze 7: `make test` re-ran clean/green using a
# test_civ_router.cpp.o built against the OLD interface, not the one it was
# just compiled to check. native/Makefile already has this line; local-trx's
# own copy had silently dropped it since bod 12's "mirrors native/Makefile
# shape" was never re-diffed this deep after the initial scaffold.
-include $(OBJECTS:.o=.d)
-include $(TEST_OBJECTS:.o=.d)
