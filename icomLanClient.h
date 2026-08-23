// icomLanClient.h — ICOM LAN (RS-BA1) CI-V client for ESP32.
//
// Step-3 minimal client: control + CI-V UDP channels, no audio, reads the
// operating frequency and prints it. Protocol verified against a real IC-705
// with tools/icom-lan-login-test.py — see docs/icom-lan-implementace.md §2 for
// the six IC-705 deviations from the wfview flow that this code follows.
//
// The passcode substitution and Icom LAN packet layout were adapted in 2026
// from wfview. Copyright 2017-2026 Elliott H. Liggett (W6EL) and Phil Taylor
// (M0VSE). wfview and this modified port are licensed under GNU GPL v3.
// Source: https://gitlab.com/eliggett/wfview/
// Notices for all modem/runtime dependencies: data/THIRD-PARTY-NOTICES.txt
//
// Non-blocking: call begin() once, then loop() often. Drives itself through a
// state machine. Designed to grow into the real transport (BT vs LAN) module.
#pragma once
#include <WiFi.h>
#include <WiFiUdp.h>
#include <new>
#include "icom_lan_wire.h"
#include "icom_lan_audio_tx.h"
#include "icom_lan_tx_history.h"

#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <lwip/sockets.h>
#include <fcntl.h>
#include <errno.h>
#endif

// Implemented in the .ino — routes a received CI-V frame (FE FE..FD) through the
// shared parser so LAN gets the same full CAT state (freq, mode, meters, TX...).
extern void lanCivFrameHandler(const uint8_t *frame, size_t len);

// Secondary LAN sessions use the same protocol client, but their CI-V frames
// feed TRX2/TRX3 state instead of the primary radio's full CAT state.
extern void lanSecondaryCivFrameHandler(uint8_t slot, const uint8_t *frame, size_t len);

// Single entry point for a decoded frame: the .ino decides what a slot's state
// means (TRX1 owns the shared CAT globals, a LAN radio in another slot keeps its
// own snapshot for the JS8 page). Keeping the decision there is what lets the
// LAN radio live in any slot without this client knowing about slots at all.
extern void lanCivFrameRoute(uint8_t slot, const uint8_t *frame, size_t len);

// Implemented in the .ino — receives a chunk of raw RX audio (payload of one audio
// UDP datagram, codec = AUDIO_RX_CODEC below). Used by the DATA-page waterfall.
extern void lanAudioHandler(const uint8_t *data, size_t len, uint16_t sequence);

// Verbose LAN load-noise logging (CAT reopen churn etc.), toggled by the CLI 'D'
// command. Off by default; host smoke tests link a quiet constant instead.
#ifdef ARDUINO
extern bool Debug;
#else
static const bool Debug = false;
#endif

// Link health since boot, device-wide and deliberately outside the class: the
// client object is destroyed and rebuilt on every reconnect, and how often that
// happens is exactly what these count. Watching a permanently open audio stream
// otherwise means watching the serial console all night.
//
//   lanHealthDrops  — sessions lost to six seconds of control-channel silence
//   lanHealthStalls — loop stalls long enough to log (>= LAN_STALL_LOG_MS)
//   lanHealthFilled — retransmits answered with filler because the packet was
//                     already gone; during TX this is a hole in the emitted tone
static uint16_t lanHealthDrops = 0, lanHealthStalls = 0, lanHealthFilled = 0;

class IcomLanClient {
public:
  enum State {
    LAN_IDLE, LAN_AYT, LAN_LOGIN, LAN_AUTH, LAN_STREAM,   // control channel
    LAN_CIV_AYT, LAN_CIV_OPEN, LAN_CONNECTED, LAN_FAILED
  };
  enum CivPriority : uint8_t {
    CIV_USER = 1,
    CIV_CONTROL = 2,
    CIV_SAFETY = 3
  };

  // civAddr = radio CI-V address (IC-705 = 0xA4). name is filled from caps.
  void begin(IPAddress radioIp, uint16_t controlPort,
             const char* user, const char* pass, uint8_t civAddr,
             uint8_t slot = 0, uint16_t localControlPort = 50001,
             bool enableAudio = true) {
    stop();
#ifdef ARDUINO
    // stopRxAudio() is bounded. If the previous owner did not actually leave,
    // never start a second owner over its storage/socket; a later reconnect can
    // retry once the old task has reached its exit path.
    if (audioRuntime && audioRuntime->task) {
      state = LAN_FAILED;
      Serial.println("LAN | audio task still stopping, reconnect deferred");
      return;
    }
    if (audioRuntime) audioRuntime->detached = false;
#endif
    radioIP = radioIp;
    ctrlPort = controlPort ? controlPort : 50001;
    radioSlot = slot;
    ctrlLocalPort = localControlPort;
    civLocalPort = localControlPort + 1;
    audioLocalPort = localControlPort + 2;
    audioAllowed = enableAudio;   // caller decides; the LAN radio may be any slot
    strlcpy(username, user, sizeof(username));
    strlcpy(password, pass, sizeof(password));
    radioCivAddr = civAddr;

    localIP = WiFi.localIP();
    ctrlUdp.begin(ctrlLocalPort);
    ctrlMyId = mkId(ctrlLocalPort);
    ctrlRemoteId = 0;
    ctrlSendSeq = 1;
    ctrlTxHistory.clear();
    clearCivCommands();
    authInnerSeq = 0x30;
    tokRequest = (uint16_t)esp_random();
    token = 0;
    haveCaps = false; authOk = false; authAnnounced = false; streamReqSent = false; streamOpened = false;
    loginRejected = false;
    civPort = 0;
    audioPort = 0; audioOpened = false; audioGotHere = false; audioGotReady = false;
    civTxTrafficActive = false;
    if (audioRuntime) {
      audioLock();
      audioRuntime->txEpoch++;
      audioRuntime->tx.reset();
      audioRuntime->rxRead = audioRuntime->rxWrite = audioRuntime->rxCount = 0;
      audioUnlock();
    }

    state = LAN_AYT;
    stateSince = millis();
    lastCtrlRxMs = millis();
    lastServiceMs = 0;   // no baseline until the first serviced loop() of this session
    lastAyt = 0; lastPing = 0; lastIdle = 0;
    Serial.print("LAN | begin -> "); Serial.print(radioIP);
    Serial.print(":"); Serial.println(ctrlPort);
  }

  void stop() {
    bool sessionWasActive = state != LAN_IDLE;
    stopRxAudio();
    if (!sessionWasActive) return;
    if (streamOpened) sendCivOpenClose(true);
#if defined(WIFILT_NATIVE)
    // The radio keeps per-endpoint CI-V conversation state keyed by our fixed
    // local ports, and a polite control-channel logout alone PARKS it: the
    // radio stops pinging, nothing ever expires the conversation, and the next
    // session from the same ports gets its control packets answered but never
    // any CI-V data ("civ: ready" then "timeout in state", verified against an
    // IC-705 2026-08-18). A disconnect on the civ channel itself is what
    // releases it -- wfview sends one on every teardown. The box escapes this
    // only because its reboot leaves the ports closed long enough for the
    // radio's keepalives to fail and tear the whole session down; the native
    // build restarts in under a second, so it must say goodbye properly.
    if (civGotHere) sendCtrl(civUdp, civMyId, civRemoteId, 0x05, 0);
#endif
    if (token) sendToken(0x01);        // release
    sendCtrl(ctrlUdp, ctrlMyId, ctrlRemoteId, 0x05, 0);  // disconnect
    civUdp.stop();
    ctrlUdp.stop();
    state = LAN_IDLE;
    lastServiceMs = 0;
    clearCivCommands();
  }

  // connected() = authenticated session is up. It deliberately stays true while
  // a CI-V sub-stream recovers or audio is quiet, so PWR and TX (which own the
  // radio) do not flap on sub-stream hiccups. The two finer signals below let
  // the UI report CAT/audio health separately instead of overloading this one.
  bool connected() const { return state == LAN_CONNECTED; }
  bool failed() const    { return state == LAN_FAILED; }
  State status() const   { return state; }
  // Distinguishes "radio said no" from "radio never answered". Only the SETUP
  // credential test cares; the reconnect logic retries either way.
  bool credentialsRejected() const { return loginRejected; }
  // CI-V stream is actually delivering data and not mid-recovery.
  bool catHealthy() const { return state == LAN_CONNECTED && civGotData && !civRecovering; }
  // Audio sub-stream linked and delivering fresh payload (firmware-side RX-live).
  bool audioReady() const {
    return audioOpened && audioGotHere && (millis() - audioLastDataMs) < LAN_AUDIO_FRESH_MS;
  }
  // TX readiness is deliberately distinct from RX freshness. A quiet/squelched
  // radio may have no recent payload while its audio command channel is fully
  // handshaken and safe to transmit on.
  bool audioTxReady() const {
    return audioOpened && audioGotHere && audioGotReady && audioRuntime != nullptr;
  }

  // Model name the radio reports in its capabilities packet, and the CI-V
  // address that came with it. Both are parsed already (see the caps branch in
  // handleControl) and were only printed to Serial.
  //
  // Worth exposing because the LAN transport is configured as "IC-705-LAN" but
  // the same protocol serves IC-7610 and IC-9700, which are 100 W radios. A
  // WSPR beacon converting a dBm setting into a percentage of full power gets a
  // factor of ten wrong if it trusts the profile name instead of this.
  // Empty until the capabilities packet has arrived.
  const char* radioModelName() const { return haveCaps ? radioName : ""; }
  uint8_t radioCivAddress() const { return radioCivAddr; }

  // Send a CI-V command body (cmd + payload, WITHOUT the FE FE <to><from> .. FD
  // wrapper — sendCiv adds it with the LAN controller address 0xE1). Used by
  // catWriteFrame so CW/tune/set-freq/set-mode all work over LAN.
  bool sendCommand(const uint8_t* body, size_t len) {
    if (state != LAN_CONNECTED || civPort == 0) return false;
    bool accepted = enqueueCivCommand(body, len, CIV_USER);
    serviceCivCommands(millis());
    return accepted;
  }

  bool sendPriorityCommand(const uint8_t* body, size_t len, CivPriority priority) {
    // CONTROL/SAFETY callers use the return value to decide whether PTT really
    // crossed the CI-V Seam. Never leave a latent PTT ON in a recovering stream.
    if (state != LAN_CONNECTED || civPort == 0 || !civGotReady ||
        !civOpenSent || !civGotData) return false;
    bool accepted = enqueueCivCommand(body, len, priority);
    if (accepted && priority >= CIV_CONTROL) {
      // A stale meter/frequency request must never hold PTT ON/OFF for 500 ms.
      civRequestPending = false;
    }
    return accepted && serviceCivCommands(millis());
  }

  // RX audio channel (DATA-page waterfall). The stream request already advertised
  // rxenable=1 (see sendStreamRequest), so the radio streams once we complete the
  // audio-channel handshake. Called on WebSocket connect/disconnect so the audio
  // UDP traffic only exists while the page is open.
  void startRxAudio() {
    if (state != LAN_CONNECTED || audioOpened || audioPort == 0) return;
    openAudioChannel();
  }
  void stopRxAudio() {
    if (!audioOpened) return;
#ifdef ARDUINO
    if (audioRuntime && audioRuntime->task) {
      audioRuntime->stopRequested = true;
      xTaskNotifyGive(audioRuntime->task);
      uint32_t until = millis() + AUDIO_TASK_STOP_TIMEOUT_MS;
      while (audioRuntime->task && (int32_t)(millis() - until) < 0) delay(1);
    }
    // A wedged socket task must never be reused by a reconnect. The task owns
    // and closes its fd; if it missed the bounded stop window, mark the channel
    // unusable and let the session reconnect rather than sharing the socket.
    if (audioRuntime && audioRuntime->task) {
      audioRuntime->tx.fail(IcomLanAudioTx::FAULT_LINK);
      audioRuntime->detached = true;
    }
#else
    sendCtrl(audioUdp, audioMyId, audioRemoteId, 0x05, 0);
    audioUdp.stop();
#endif
    audioOpened = false; audioGotHere = false; audioGotReady = false;
    Serial.println("LAN | audio channel closed");
  }
  bool rxAudioActive() const { return audioOpened; }

  bool prepareAudioTx() {
    if (!audioTxReady() || !audioRuntime) return false;
    audioLock();
    audioRuntime->txEpoch++;
    audioRuntime->tx.clearTx();
    audioUnlock();
    return true;
  }

  bool queueAudioTx(const uint8_t* payload, size_t length) {
    if (!audioRuntime || !audioOpened) return false;
    audioLock();
    bool ok = audioRuntime->tx.enqueue(payload, length);
    audioUnlock();
#ifdef ARDUINO
    if (ok && audioRuntime->task) xTaskNotifyGive(audioRuntime->task);
#endif
    return ok;
  }

  bool startAudioTx(uint64_t totalBytes, uint32_t startMs) {
    if (!audioTxReady() || !audioRuntime) return false;
    audioLock();
    audioRuntime->txEpoch++;
    bool ok = audioRuntime->tx.arm(totalBytes, startMs);
    audioUnlock();
#ifdef ARDUINO
    if (ok && audioRuntime->task) xTaskNotifyGive(audioRuntime->task);
#endif
    return ok;
  }

  void cancelAudioTx(IcomLanAudioTx::Fault fault = IcomLanAudioTx::FAULT_NONE) {
    if (!audioRuntime) return;
    audioLock();
    audioRuntime->txEpoch++;
    if (fault == IcomLanAudioTx::FAULT_NONE) audioRuntime->tx.clearTx();
    else audioRuntime->tx.fail(fault);
    audioUnlock();
#ifdef ARDUINO
    if (audioRuntime->task) xTaskNotifyGive(audioRuntime->task);
#endif
  }

  IcomLanAudioTx::Snapshot audioTxSnapshot() const {
    IcomLanAudioTx::Snapshot result = {};
    result.capacity = IcomLanAudioTx::QUEUE_CAPACITY;
    if (!audioRuntime) {
      result.fault = IcomLanAudioTx::FAULT_NOT_READY;
      return result;
    }
    const_cast<IcomLanClient*>(this)->audioLock();
    result = audioRuntime->tx.snapshot();
    const_cast<IcomLanClient*>(this)->audioUnlock();
    return result;
  }

  uint32_t audioRxDropped() const {
    return audioRuntime ? audioRuntime->rxDropped : 0;
  }
  uint32_t audioMaxSendUs() const {
    return audioRuntime ? audioRuntime->maxSendUs : 0;
  }
  // Retransmit-chase health, cumulative per audio channel open. asked >> got
  // means the radio ignores audio retransmit requests (the chase then only adds
  // its bounded hold and should be reconsidered); got tracking asked with
  // gaveup near zero means WiFi holes are being healed.
  uint32_t audioRtxRequested() const {
    return audioRuntime ? audioRuntime->rtxRequested : 0;
  }
  uint32_t audioRtxRecovered() const {
    return audioRuntime ? audioRuntime->rtxRecovered : 0;
  }
  uint32_t audioRtxAbandoned() const {
    return audioRuntime ? audioRuntime->rtxAbandoned : 0;
  }
  // Round-trip time of the already-flowing 0x07 ping/pong on each UDP channel
  // (500ms cadence, zero added traffic) and of the stop-and-wait CI-V request on
  // the LAN CAT channel -- last sample plus max-since-boot, per icomLanClient.h
  // link-latency comment above.
  uint32_t pingRttCtrlMs() const { return ctrlPingRtt; }
  uint32_t pingRttCtrlMaxMs() const { return ctrlPingRttMax; }
  uint32_t pingRttCivMs() const { return civPingRtt; }
  uint32_t pingRttCivMaxMs() const { return civPingRttMax; }
  uint32_t pingRttAudioMs() const { return audioPingRtt; }
  uint32_t pingRttAudioMaxMs() const { return audioPingRttMax; }
  uint32_t civReqRttMs() const { return civReqRtt; }
  uint32_t civReqRttMaxMs() const { return civReqRttMax; }
  bool txTrafficActive() const { return civTxTrafficActive; }
  void setTxTrafficActive(bool active) {
    civTxTrafficActive = active;
    // Ending TX traffic always ends the fast-ALC rotation. Every path that
    // stops a transmission -- drained, abort, link loss -- comes through here,
    // so the calibration metering cannot be left latched on by a run that died
    // between arming it and finishing.
    if (!active) setAlcFast(false);
  }

  // Gain calibration asks for ALC at twice the normal rate. Phase is reset with
  // the mode so a run always starts on an ALC slot rather than wherever the
  // previous transmission happened to leave the counter.
  bool alcFast() const { return civAlcFast; }
  void setAlcFast(bool fast) {
    if (civAlcFast == fast) return;
    civAlcFast = fast;
    txAuxRot = 0;
  }

  static const char* audioTxFaultName(IcomLanAudioTx::Fault fault) {
    switch (fault) {
      case IcomLanAudioTx::FAULT_NONE: return "";
      case IcomLanAudioTx::FAULT_NOT_READY: return "audio channel not ready";
      case IcomLanAudioTx::FAULT_OVERFLOW: return "TX buffer overflow";
      case IcomLanAudioTx::FAULT_UNDERRUN: return "TX buffer underrun";
      case IcomLanAudioTx::FAULT_DEADLINE: return "TX audio deadline missed";
      case IcomLanAudioTx::FAULT_SEND: return "TX UDP send failed";
      case IcomLanAudioTx::FAULT_LINK: return "LAN audio link lost";
    }
    return "TX audio fault";
  }

  void loop() {
    if (state == LAN_IDLE || state == LAN_FAILED) return;
    uint32_t now = millis();

    // Loop-stall compensation, applied before any health check runs. Health
    // decisions below measure RX silence in wall-clock, but this client is
    // serviced cooperatively — a single unserviced gap of 1-4 s is normal under
    // page-load/audio load and is NOT link silence (the socket simply was not
    // read). Credit each tick with at most LAN_STALL_CREDIT_MS of observed
    // silence and forgive the excess: a transient multi-second stall therefore
    // advances the health windows by only ~one credit, so it cannot false-fire
    // civSilent (false CAT reopen) or the 6 s control-loss drop. Sustained
    // slowness still credits a full LAN_STALL_CREDIT_MS every tick, so a
    // genuinely dead link keeps accruing silence and is always eventually caught
    // — the compensation delays honest failure, it never masks it. Real RX that
    // arrives during the gap refreshes these clocks in the pumps below (which
    // run after this), so a live link is unaffected.
    if (lastServiceMs) {
      uint32_t gap = now - lastServiceMs;
      if (gap > LAN_STALL_CREDIT_MS) {
        uint32_t forgive = gap - LAN_STALL_CREDIT_MS;
        forgiveClock(lastCtrlRxMs, now, forgive);
        forgiveClock(lastCivDataMs, now, forgive);
        forgiveClock(stateSince, now, forgive);
        if (civHealthProbePending) forgiveClock(civHealthProbeSentMs, now, forgive);
        if (civRecovering)         forgiveClock(civRecoveryStartedMs, now, forgive);
        if (audioOpened)           forgiveClock(audioLastDataMs, now, forgive);
        if (gap >= LAN_STALL_LOG_MS) {
          if (lanHealthStalls < 0xffff) lanHealthStalls++;
          Serial.print("LAN | loop stall "); Serial.print(gap);
          Serial.println("ms, health timers forgiven");
        }
      }
    }
    lastServiceMs = now;

    retransmitBudget = LAN_RETRANSMIT_BUDGET;
    rtxResent = rtxFilled = rtxDeferred = 0;

    pumpControl();
    if (state == LAN_FAILED) return;
    if (civPort) pumpCiv();
    serviceCivCommands(now);
#ifdef ARDUINO
    drainAudioRx();
#else
    if (audioOpened) pumpAudio();
#endif

    if (rtxResent || rtxFilled || rtxDeferred) {
      Serial.print("LAN | retransmit resent="); Serial.print(rtxResent);
      Serial.print(" filled="); Serial.print(rtxFilled);
      if (rtxDeferred) { Serial.print(" deferred="); Serial.print(rtxDeferred); }
      Serial.println();
    }

    // control-channel periodic sends
    if (state == LAN_AYT) {
      if (now - lastAyt >= 500) { sendCtrl(ctrlUdp, ctrlMyId, ctrlRemoteId, 0x03, 0); lastAyt = now; }
    } else {
      if (now - lastPing >= 500) { sendPing(ctrlUdp, ctrlMyId, ctrlRemoteId, ctrlPingSeq++); lastPing = now; }
      if (now - lastIdle >= 100) { sendTracked(ctrlUdp, ctrlPkt(0x10, 0x00), 0x10); lastIdle = now; }
      reauthMaybe(now);
    }

    // CI-V channel periodic sends
    if (civPort) {
      if (!civGotHere) {
        if (now - civLastAyt >= 500) { sendCtrl(civUdp, civMyId, civRemoteId, 0x03, 0); civLastAyt = now; }
      } else {
        if (now - civLastPing >= 500) { sendPing(civUdp, civMyId, civRemoteId, civPingSeq++); civLastPing = now; }
        // IC-705 can stream radio->client data before this exchange completes,
        // but it drops client->radio CI-V commands. Never confuse that
        // half-connection with an open command channel: retry Ready until the
        // radio acknowledges it, then (and only then) send CI-V open.
        if (!civGotReady && now - civLastReady >= 500) {
          sendCtrl(civUdp, civMyId, civRemoteId, 0x06, 1);
          civLastReady = now;
          if (!civReadyWaitAnnounced) {
            Serial.println("LAN | civ: waiting for ready");
            civReadyWaitAnnounced = true;
          }
        }
        // A received frame only proves that CI-V worked at that instant. The
        // stream can later wedge while control/audio pings remain healthy.
        // Several unsupported telemetry reads can also legitimately produce a
        // >2 s reply gap, so first probe frequency on the existing stream. Only
        // reopen CI-V if this known-supported liveness command also times out.
        bool civSilent = civGotData && now - lastCivDataMs >= 2000;
        if (civSilent && !civRecovering && !civHealthProbePending) {
          // Preempt a timed-out auxiliary request; normal polling stays gated
          // until this probe either receives its 03 reply or enters recovery.
          civRequestPending = false;
          uint8_t b[]={0x03}; sendCiv(b,1);
          civHealthProbePending = true;
          civHealthProbeSentMs = now;
          lastFreqPoll = now;
        } else if (civHealthProbePending && now - civHealthProbeSentMs >= 1000) {
          civHealthProbePending = false;
          civRecovering = true;
          civRecoveryStartedMs = now;
          civGotData = false;
          civRequestPending = false;
          civNextOpen = now;
          if (Debug) Serial.println("LAN | CAT probe timeout, reopening CI-V stream");
        }
        if (civRecovering && now - civRecoveryStartedMs >= 6000) {
          Serial.println("LAN | CAT recovery failed, reconnecting session");
          state = LAN_FAILED;
          return;
        }
        if (civGotReady && civOpenSent && !civGotData
            && (int32_t)(now - civNextOpen) >= 0) {
          sendCivOpenClose(false); civNextOpen = now + 500;
        }
        // Establish request/reply health with one conservative command before
        // starting the telemetry rotation. Transceive broadcasts remain useful
        // UI input, but do not satisfy this addressed E1 probe.
        if (civGotReady && civOpenSent && !civGotData && !civHealthProbePending
            && now - lastFreqPoll >= 500
            && civCanSendRequest(now)) {
          uint8_t b[]={0x03}; sendCiv(b,1);
          lastFreqPoll = now;
        }
        if (civGotReady && civOpenSent && civGotData && !civHealthProbePending && !scopeOff
            && civCanSendRequest(now)) {
          sendCivFrame3(0x27, 0x11, 0x00);       // disable unsolicited scope stream
          scopeOff = true;
          lastFreqPoll = now;
        }
        // CI-V remains a serial command stream even when transported over UDP.
        // Pace one request per tick; sending freq+mode+telemetry as a burst made
        // the IC-705 commonly answer the first (frequency) and drop read-mode.
        uint32_t pollPeriod = civTxTrafficActive ? 250 : 100;
        if (civGotReady && civOpenSent && civGotData && !civHealthProbePending
            && scopeOff && now - lastFreqPoll >= pollPeriod
            && civCanSendRequest(now)) {
          if (civTxTrafficActive && civAlcFast) {
            // Gain calibration. ALC lands in every other slot -- 2 Hz at this
            // 250 ms pace -- because the search spends one step per reading and
            // the carrier it runs on is capped. SWR keeps a slot of its own
            // (worst case 1.5 s) precisely because this is the one mode that
            // deliberately drives the level up; Po stays in as the independent
            // confirmation that the ALC knee is where the power stops rising.
            switch (txAuxRot++ % 6) {
              case 1: { uint8_t b[]={0x1C,0x00}; sendCiv(b,2); break; } // PTT
              case 3: { uint8_t b[]={0x15,0x12}; sendCiv(b,2); break; } // SWR
              case 5: { uint8_t b[]={0x15,0x11}; sendCiv(b,2); break; } // power
              default:{ uint8_t b[]={0x15,0x13}; sendCiv(b,2); break; } // ALC
            }
          } else if (civTxTrafficActive) {
            // During browser TX retain only state/safety metering. Frequency,
            // mode and slow station telemetry cannot change without ending the
            // protected TX session, so they do not compete with audio/WiFi.
            switch (txAuxRot++ % 4) {
              case 0: { uint8_t b[]={0x1C,0x00}; sendCiv(b,2); break; } // PTT
              case 1: { uint8_t b[]={0x15,0x11}; sendCiv(b,2); break; } // power
              case 2: { uint8_t b[]={0x15,0x12}; sendCiv(b,2); break; } // SWR
              default:{ uint8_t b[]={0x15,0x13}; sendCiv(b,2); break; } // ALC
            }
          } else {
            switch (auxRot) {
              case 0: { uint8_t b[]={0x03};       sendCiv(b,1); break; } // frequency
              case 1: { uint8_t b[]={0x26,0x00};  sendCiv(b,2); break; } // selected mode+data+filter
              case 2: {
                // Legacy fallback for radios/configurations that do not answer
                // 26 00. Once selected-mode works, avoid overwriting USB-D with
                // the data-mode-blind 04 response.
                if (!civSelectedModeSeen) { uint8_t b[]={0x04}; sendCiv(b,1); }
                break;
              }
              case 3: { uint8_t b[]={0x15,0x02};  sendCiv(b,2); break; } // S-meter
              case 4: { uint8_t b[]={0x15,0x11};  sendCiv(b,2); break; } // power meter
              default: sendAuxRot(auxRot - 5); break;
            }
            auxRot = (auxRot + 1) % 16;  // 5 direct cases + sendAuxRot's 0..10 (11 cases)
          }
          lastFreqPoll = now;
        }
        // sendTracked() resets civLastIdle. Put the idle check after open/data
        // so a useful packet due on this tick suppresses a redundant idle.
        if (now - civLastIdle >= 100) { sendTracked(civUdp, civPkt0(0x00), 0x10); }
      }
    }

    // On ESP32 the dedicated audio task owns this whole channel. The native
    // harness keeps the synchronous implementation so protocol state can be
    // fault-injected without FreeRTOS.
#ifndef ARDUINO
    // audio channel periodic sends (same handshake/keepalive as CI-V; no open/data)
    if (audioOpened) {
      if (!audioGotHere) {
        if (now - audioLastAyt >= 500) { sendCtrl(audioUdp, audioMyId, audioRemoteId, 0x03, 0); audioLastAyt = now; }
      } else {
        if (now - audioLastPing >= 500) { sendPing(audioUdp, audioMyId, audioRemoteId, audioPingSeq++); audioLastPing = now; }
        if (!audioGotReady && now - audioLastReady >= 500) {
          sendCtrl(audioUdp, audioMyId, audioRemoteId, 0x06, 1);
          audioLastReady = now;
        }
        if (now - audioLastIdle >= 100) { sendTracked(audioUdp, audioPkt0(0x00), 0x10); audioLastIdle = now; }
        // No automatic reopen on payload silence: the radio legitimately streams
        // nothing on a quiet/squelched channel, and reopening the sub-stream stops
        // it resuming. audioLastDataMs only feeds audioReady()/the RX-live status.
      }
    }
#endif

    if (state != LAN_CONNECTED && millis() - stateSince > 12000) {
      Serial.println("LAN | timeout in state, giving up");
      state = LAN_FAILED;
    }
    // Whole-session health belongs to the authenticated control channel.
    // CI-V retransmit requests or an open browser audio socket must not keep a
    // dead radio login reported as CONNECTED.
    if (state == LAN_CONNECTED && millis() - lastCtrlRxMs > 6000) {
      if (lanHealthDrops < 0xffff) lanHealthDrops++;
      Serial.println("LAN | no control packets 6s, link lost");
      state = LAN_FAILED;
    }
  }

private:
  // ---- config / session state ----
  IPAddress radioIP, localIP;
  uint16_t ctrlPort = 50001;
  uint16_t ctrlLocalPort = 50001;
  uint16_t civLocalPort = 50002;
  uint16_t audioLocalPort = 50003;
  char username[24] = {0}, password[24] = {0};
  uint8_t radioCivAddr = 0xA4;
  uint8_t radioSlot = 0;
  bool audioAllowed = true;
  bool loginRejected = false;   // radio answered the login and refused it

  WiFiUDP ctrlUdp, civUdp, audioUdp;  // audioUdp is native-harness only on ESP32
  uint32_t ctrlMyId = 0, ctrlRemoteId = 0;
  uint32_t civMyId = 0, civRemoteId = 0;
  uint16_t ctrlSendSeq = 1, civSendSeq = 1;
  // CI-V channel needs TWO counters: civSendSeq = tracked seq (bytes 6-7, bumped
  // by every packet incl. idles); civDataSeq = CI-V sendseq (field 0x13, starts 0,
  // bumped only by open/close+data). Sharing them makes 0x13 non-contiguous and
  // the radio then ignores civ-open (verified: symptom = civ opens, no CI-V data).
  uint16_t civDataSeq = 0;
  uint16_t authInnerSeq = 0x30;
  uint16_t tokRequest = 0;
  uint32_t token = 0;
  uint16_t ctrlPingSeq = 0, civPingSeq = 0;

  // radio identity from capabilities
  uint8_t radioMac[6] = {0};
  uint16_t commonCap = 0x8010;
  char radioName[16] = "IC-705";
  bool haveCaps = false, authOk = false, authAnnounced = false, streamReqSent = false, streamOpened = false;
  uint16_t civPort = 0, audioPort = 0;

  // CI-V channel progress
  bool civGotHere = false, civGotReady = false, civOpenSent = false, civGotData = false, scopeOff = false;
  bool civRecovering = false, civReadyWaitAnnounced = false, civRequestPending = false;
  bool civHealthProbePending = false;
  bool civSelectedModeSeen = false;
  uint32_t civNextOpen = 0, lastFreqPoll = 0, lastCivDataMs = 0, lastCtrlRxMs = 0;
  uint32_t civLastAyt = 0, civLastReady = 0, civLastPing = 0, civLastIdle = 0;
  uint32_t civRequestSentMs = 0, civHealthProbeSentMs = 0, civRecoveryStartedMs = 0;
  // Link-latency samples: last + max-since-boot only (no ring buffer/EWMA), same
  // shape as lanHealthDrops/Stalls/Filled below -- cheap, and immune to multiple
  // independent /state readers racing a reset-on-read scheme.
  uint32_t civPingRtt = 0, civPingRttMax = 0;
  uint32_t civReqRtt = 0, civReqRttMax = 0;
  uint8_t auxRot = 0;
  uint8_t txAuxRot = 0;
  bool civTxTrafficActive = false;
  bool civAlcFast = false;

  static const size_t CIV_COMMAND_MAX_BYTES = 32;
  static const size_t CIV_COMMAND_QUEUE_SIZE = 12;
  struct CivCommand {
    uint8_t body[CIV_COMMAND_MAX_BYTES];
    uint8_t length;
    CivPriority priority;
    uint32_t order;
    bool valid;
  };
  CivCommand civCommands[CIV_COMMAND_QUEUE_SIZE] = {};
  uint32_t civCommandOrder = 0;

  // ---- RX audio channel ----
  // Codec byte per RS-BA1: 0x01 = uLaw 8-bit 1ch (PCMU, lightest — ~8 kB/s @ 8 kHz,
  // ~6 packets/s so the single-threaded loop tolerates it), 0x04 = LPCM 16-bit 1ch.
  // If the radio refuses to stream, try LPCM16 (0x04 @ 16000/48000) — see
  // docs/icom-lan-implementace.md and the bench note (LPCM16/48k verified working).
  static const uint8_t  AUDIO_RX_CODEC   = 0x01;
  static const uint32_t AUDIO_RX_SAMPLE  = 8000;    // Hz
  static const uint8_t  AUDIO_TX_CODEC   = 0x01;    // uLaw 8-bit 1ch (M3 TX)
  static const uint32_t AUDIO_TX_SAMPLE  = 8000;    // Hz
  // Freshness window for audioReady(): the radio only streams audio while there
  // is AF (nothing on a quiet/squelched channel), so this is a "recently flowing"
  // threshold for the RX-live status, NOT a wedge/reopen trigger.
  static const uint32_t LAN_AUDIO_FRESH_MS = 5000;
  volatile bool audioOpened = false, audioGotHere = false, audioGotReady = false;
  uint32_t audioMyId = 0, audioRemoteId = 0;
  uint16_t audioSendSeq = 1, audioPingSeq = 0, audioTxSeq = 0;
  volatile uint32_t audioHereTime = 0, audioLastPing = 0, audioLastIdle = 0, audioLastAyt = 0;
  volatile uint32_t audioLastReady = 0;
  volatile uint32_t audioLastDataMs = 0;
  // Written from the ESP32 audio task, read from the main loop for /state --
  // volatile matches every other cross-task field in this group, no mutex.
  volatile uint32_t audioPingRtt = 0, audioPingRttMax = 0;

  static const size_t AUDIO_RX_PACKET_BYTES = 160;
  static const size_t AUDIO_RX_QUEUE_PACKETS = 64;
  static const uint32_t AUDIO_TASK_STOP_TIMEOUT_MS = 750;

  // RX retransmit (radio -> us). The radio keeps a replay history exactly like
  // ours (it already asks US to replay lost TX audio); a lost RX datagram used
  // to become a permanent 20 ms hole the decoder had to eat. Chase it instead:
  // ask, hold the head of the queue briefly so the replay can land back in its
  // hole, and give up on a wall-clock/occupancy bound so an ignored request
  // costs one bounded delay, never a stall. 240 ms of hold spends 12 of the 64
  // ring slots and stays far under the browser's ~1 s jitter tolerance.
  static const uint32_t AUDIO_RTX_HOLD_MS   = 240;  // max head-of-line wait
  static const uint32_t AUDIO_RTX_RESEND_MS = 80;   // re-ask cadence while open
  static const uint8_t  AUDIO_RTX_ATTEMPTS  = 3;
  static const uint16_t AUDIO_RTX_MAX_CHASE = 8;    // wider holes are not worth the storm
  static const size_t   AUDIO_RX_HOLD_HIGH  = 48;   // occupancy bound for the hold

  struct AudioRxPacket {
    uint16_t sequence;
    uint16_t length;
    uint8_t payload[AUDIO_RX_PACKET_BYTES];
  };

  // Allocated only for the unique LAN slot that owns audio. Embedding this in
  // all three IcomLanClient instances would waste ~30 kB per secondary radio.
  struct AudioRuntime {
    IcomLanAudioTx tx;
    AudioRxPacket rx[AUDIO_RX_QUEUE_PACKETS];
    size_t rxRead = 0, rxWrite = 0, rxCount = 0;
    volatile uint32_t rxDropped = 0;
    volatile uint32_t maxSendUs = 0;
    volatile uint32_t txEpoch = 1;
    // RX reorder + retransmit-chase state, guarded by audioMux like rx[].
    // Inner = the data-only counter (BE @0x12) lanAudioHandler accounts with;
    // outer = the control-layer counter (LE @0x06) the replay history is keyed
    // by. Idle control packets consume outer but never inner, so holes are
    // detected on inner and only translated to an outer window for the ask.
    bool     rxSeqValid = false;
    uint16_t rxLastInner = 0;
    uint16_t rxLastOuter = 0;
    bool     rxReleaseValid = false;   // rxNextRelease holds a real expectation
    uint16_t rxNextRelease = 0;        // inner seq the drain releases next
    uint32_t rxGapWaitStartMs = 0;     // head-of-line hold start; 0 = not holding
    uint16_t rtxFirstOuter = 0;        // open ask toward the radio (one hole at a time)
    uint16_t rtxChase = 0;             // outer seqs still being asked; 0 = idle
    uint8_t  rtxAttempts = 0;
    uint32_t rtxLastSendMs = 0;
    volatile uint32_t rtxRequested = 0;  // outer seqs asked back from the radio
    volatile uint32_t rtxRecovered = 0;  // holes a late/replayed packet filled
    volatile uint32_t rtxAbandoned = 0;  // head-of-line holds given up (hole stayed)
#ifdef ARDUINO
    TaskHandle_t task = nullptr;
    volatile bool stopRequested = false;
    volatile bool detached = false;
    int socketFd = -1;
#endif
  };

  AudioRuntime* audioRuntime = nullptr;
#ifdef ARDUINO
  portMUX_TYPE audioMux = portMUX_INITIALIZER_UNLOCKED;
#endif

  State state = LAN_IDLE;
  uint32_t stateSince = 0, lastAyt = 0, lastPing = 0, lastIdle = 0, lastReauth = 0;
  uint32_t ctrlPingRtt = 0, ctrlPingRttMax = 0;

  // Loop-stall compensation. This client is serviced cooperatively from the
  // Arduino loop and from long HTTP/audio-WS sends; a single unserviced gap of
  // 1-4 s is normal under page-load/audio load. RX "silence" measured across
  // such a gap is not evidence of a dead link (the socket simply was not read),
  // so health timers must not count it. lastServiceMs is the millis() of the
  // previous loop() body; 0 means "no baseline yet" (fresh session).
  uint32_t lastServiceMs = 0;
  static const uint32_t LAN_STALL_CREDIT_MS = 300;   // max silence credited per tick; excess forgiven
  static const uint32_t LAN_STALL_LOG_MS    = 800;   // only log substantial stalls

  // Retransmit rate limit. Each reply is a blocking UDP send; cap how many run
  // per loop() iteration so a storm (or the stale full-history request after a
  // reconnect) cannot monopolise the cooperative loop. Counters summarise the
  // iteration instead of one Serial line per sequence.
  static const int LAN_RETRANSMIT_BUDGET = 16;
  int retransmitBudget = 0;
  uint16_t rtxResent = 0, rtxFilled = 0, rtxDeferred = 0;

  uint8_t buf[1500];

  // Match the protocol's roughly ten-second replay horizon. Eight/sixteen
  // entries covered less than two seconds at the 100 ms channel cadence, so a
  // blocked cooperative loop evicted exactly the packets the radio later
  // requested and the radio then stopped accepting subsequent CAT commands.
  IcomLanTxHistory<0x90, 128> ctrlTxHistory;
  IcomLanTxHistory<64, 128> civTxHistory;

  // ---- little/big-endian writers ----
  // Thin forwarders; the implementations live in icom_lan_wire.h so the LAN
  // discovery scanner shares one definition of the wire format with us.
  static void putLE16(uint8_t*p,uint16_t v){ IcomWire::putLE16(p,v); }
  static void putLE32(uint8_t*p,uint32_t v){ IcomWire::putLE32(p,v); }
  static void putBE16(uint8_t*p,uint16_t v){ IcomWire::putBE16(p,v); }
  static void putBE32(uint8_t*p,uint32_t v){ IcomWire::putBE32(p,v); }
  static uint16_t getLE16(const uint8_t*p){ return IcomWire::getLE16(p); }
  static uint32_t getLE32(const uint8_t*p){ return IcomWire::getLE32(p); }
  static uint16_t getBE16(const uint8_t*p){ return IcomWire::getBE16(p); }

  uint32_t mkId(uint16_t localPort) { return IcomWire::mkId(localIP, localPort); }

  // ---- passcode substitution (icomudpbase.h) ----
  static uint8_t pcSeq(uint8_t i) {
    static const uint8_t s[] = {
      0x47,0x5d,0x4c,0x42,0x66,0x20,0x23,0x46,0x4e,0x57,0x45,0x3d,0x67,0x76,0x60,0x41,
      0x62,0x39,0x59,0x2d,0x68,0x7e,0x7c,0x65,0x7d,0x49,0x29,0x72,0x73,0x78,0x21,0x6e,
      0x5a,0x5e,0x4a,0x3e,0x71,0x2c,0x2a,0x54,0x3c,0x3a,0x63,0x4f,0x43,0x75,0x27,0x79,
      0x5b,0x35,0x70,0x48,0x6b,0x56,0x6f,0x34,0x32,0x6c,0x30,0x61,0x6d,0x7b,0x2f,0x4b,
      0x64,0x38,0x2b,0x2e,0x50,0x40,0x3f,0x55,0x33,0x37,0x25,0x77,0x24,0x26,0x74,0x6a,
      0x28,0x53,0x4d,0x69,0x22,0x5c,0x44,0x31,0x36,0x58,0x3b,0x7a,0x51,0x5f,0x52};
    return (i >= 32 && i < 32 + sizeof(s)) ? s[i - 32] : 0;
  }
  static void passcode(const char* in, uint8_t* out16) {
    memset(out16, 0, 16);
    for (int i = 0; in[i] && i < 16; i++) {
      int p = (uint8_t)in[i] + i;
      if (p > 126) p = 32 + p % 127;
      out16[i] = pcSeq(p);
    }
  }

  // ---- packet primitives ----
  // Build a 0x10 control packet into buf; returns length.
  size_t hdr16(uint32_t myId, uint32_t rid, uint16_t type, uint16_t seq) {
    return IcomWire::hdr16(buf, myId, rid, type, seq);
  }
  size_t ctrlPkt(uint16_t /*len*/, uint16_t type) { return hdr16(ctrlMyId, ctrlRemoteId, type, 0); }
  size_t civPkt0(uint16_t type) { return hdr16(civMyId, civRemoteId, type, 0); }
  size_t audioPkt0(uint16_t type) { return hdr16(audioMyId, audioRemoteId, type, 0); }

  // remote port depends on channel
  uint16_t currentRemote(WiFiUDP& u) {
    if (&u == &ctrlUdp) return ctrlPort;
    if (&u == &civUdp)  return civPort;
    return audioPort;
  }

  void sendCtrl(WiFiUDP& u, uint32_t myId, uint32_t rid, uint16_t type, uint16_t seq) {
    hdr16(myId, rid, type, seq);
    u.beginPacket(radioIP, currentRemote(u)); u.write(buf, 0x10); u.endPacket();
  }

  // Tracked packet: stamp seq into bytes 6-7 and retain the exact wire image.
  // A missing tracked sequence blocks later client->radio commands until the
  // radio receives the requested replay.
  void sendTracked(WiFiUDP& u, size_t len, uint16_t /*hint*/) {
    uint16_t& seq = (&u == &ctrlUdp) ? ctrlSendSeq : (&u == &civUdp ? civSendSeq : audioSendSeq);
    uint16_t packetSeq = seq++;
    putLE16(buf+6, packetSeq);
    if (&u == &ctrlUdp) ctrlTxHistory.remember(packetSeq, buf, len);
    else if (&u == &civUdp) civTxHistory.remember(packetSeq, buf, len);
    u.beginPacket(radioIP, currentRemote(u)); u.write(buf, len); u.endPacket();
    if (&u == &ctrlUdp) lastIdle = millis();
    else if (&u == &civUdp) civLastIdle = millis();
    else audioLastIdle = millis();
  }

  bool resendTracked(WiFiUDP& u, uint16_t sequence) {
    size_t len = 0;
    const uint8_t* packet = nullptr;
    if (&u == &ctrlUdp) packet = ctrlTxHistory.find(sequence, len);
    else if (&u == &civUdp) packet = civTxHistory.find(sequence, len);
    if (!packet || len == 0) return false;
    u.beginPacket(radioIP, currentRemote(u)); u.write(packet, len); u.endPacket();
    return true;
  }

  void fillMissingTracked(WiFiUDP& u, uint16_t sequence) {
    uint32_t myId = (&u == &ctrlUdp) ? ctrlMyId : civMyId;
    uint32_t remoteId = (&u == &ctrlUdp) ? ctrlRemoteId : civRemoteId;
    sendCtrl(u, myId, remoteId, 0x00, sequence);
  }

  // Answer one requested sequence, but only while this loop() iteration still
  // has retransmit budget. Every reply is a blocking UDP send; on a congested
  // WiFi link a single send can take tens of ms, so an unbounded range (or the
  // stale full-history request the radio fires right after reconnect) used to
  // freeze the whole firmware for seconds. Deferred sequences are simply left
  // for the radio to re-request on the next tick, spreading the work out.
  void respondRetransmit(WiFiUDP& u, uint16_t sequence) {
    if (retransmitBudget <= 0) { rtxDeferred++; return; }
    retransmitBudget--;
    if (resendTracked(u, sequence)) rtxResent++;
    else {
      fillMissingTracked(u, sequence); rtxFilled++;
      if (lanHealthFilled < 0xffff) lanHealthFilled++;
    }
  }

  bool handleRetransmitRequest(WiFiUDP& u, const uint8_t* packet, int length) {
    if (length < 0x10 || getLE16(packet+4) != 0x01) return false;
    if (length == 0x10) {
      respondRetransmit(u, getLE16(packet+6));
      return true;
    }
    // A variable-length request carries inclusive little-endian start/end
    // ranges, not a flat sequence list. IC-705 also commonly duplicates each
    // range in the same datagram. Treating the endpoints as individual packets
    // produced the live BE,C5 -> BF,C4 -> C0,C3 retry pattern and stalled CAT.
    static const uint16_t MAX_RETRANSMIT_RANGE = 50;
    for (int at = 0x10; at + 3 < length; at += 4) {
      uint16_t first = getLE16(packet+at);
      uint16_t last = getLE16(packet+at+2);
      uint16_t count = (uint16_t)(last - first) + 1;
      if (count == 0 || count > MAX_RETRANSMIT_RANGE) {
        Serial.println("LAN | retransmit range rejected");
        continue;
      }
      for (uint16_t offset = 0; offset < count; ++offset)
        respondRetransmit(u, (uint16_t)(first + offset));
    }
    return true;
  }

  void sendPing(WiFiUDP& u, uint32_t myId, uint32_t rid, uint16_t seq) {
    memset(buf, 0, 0x15);
    putLE32(buf+0, 0x15); putLE16(buf+4, 0x07); putLE16(buf+6, seq);
    putLE32(buf+8, myId); putLE32(buf+12, rid);
    buf[0x10] = 0x00;                       // request
    putLE32(buf+0x11, millis());            // our uptime ms
    u.beginPacket(radioIP, currentRemote(u)); u.write(buf, 0x15); u.endPacket();
  }
  void sendPingReply(WiFiUDP& u, uint32_t myId, uint32_t rid, uint16_t seq, uint32_t t) {
    memset(buf, 0, 0x15);
    putLE32(buf+0, 0x15); putLE16(buf+4, 0x07); putLE16(buf+6, seq);
    putLE32(buf+8, myId); putLE32(buf+12, rid);
    buf[0x10] = 0x01; putLE32(buf+0x11, t);
    u.beginPacket(radioIP, currentRemote(u)); u.write(buf, 0x15); u.endPacket();
  }

  void sendLogin() {
    memset(buf, 0, 0x80);
    putLE32(buf+0, 0x80);
    putLE32(buf+8, ctrlMyId); putLE32(buf+12, ctrlRemoteId);
    putBE32(buf+0x10, 0x70);
    buf[0x14] = 0x01; buf[0x15] = 0x00;
    putBE16(buf+0x16, authInnerSeq++);
    putLE16(buf+0x1a, tokRequest);
    uint8_t u[16], w[16];
    passcode(username, u); passcode(password, w);
    memcpy(buf+0x40, u, 16); memcpy(buf+0x50, w, 16);
    const char* nm = "esp705if";
    memcpy(buf+0x60, nm, strlen(nm));
    sendTracked(ctrlUdp, 0x80, 0x80);
    Serial.println("LAN | login sent");
  }

  // magic: 0x02 confirm, 0x05 auth/renew, 0x01 release. No resetcap (IC-705).
  void sendToken(uint8_t magic) {
    memset(buf, 0, 0x40);
    putLE32(buf+0, 0x40);
    putLE32(buf+8, ctrlMyId); putLE32(buf+12, ctrlRemoteId);
    putBE32(buf+0x10, 0x30);
    buf[0x14] = 0x01; buf[0x15] = magic;
    putBE16(buf+0x16, authInnerSeq++);
    putLE16(buf+0x1a, tokRequest);
    putLE32(buf+0x1c, token);
    sendTracked(ctrlUdp, 0x40, 0x40);
  }

  void sendStreamRequest() {
    memset(buf, 0, 0x90);
    putLE32(buf+0, 0x90);
    putLE32(buf+8, ctrlMyId); putLE32(buf+12, ctrlRemoteId);
    putBE32(buf+0x10, 0x80);
    buf[0x14] = 0x01; buf[0x15] = 0x03;
    putBE16(buf+0x16, authInnerSeq++);
    putLE16(buf+0x1a, tokRequest);
    putLE32(buf+0x1c, token);
    putLE16(buf+0x27, commonCap);          // 0x8010 + mac identity
    memcpy(buf+0x2a, radioMac, 6);
    memcpy(buf+0x40, radioName, strnlen(radioName, 15));
    uint8_t u[16]; passcode(username, u); memcpy(buf+0x60, u, 16);
    // RX audio enabled (TX off). Field offsets verified in tools/icom-lan-login-test.py.
    // The radio only actually streams once we complete the audio-channel handshake
    // (openAudioChannel), so advertising it here costs nothing until the page opens.
    buf[0x70] = audioAllowed ? 1 : 0;      // rxenable
    buf[0x71] = audioAllowed ? 1 : 0;      // txenable (M3: TX audio)
    buf[0x72] = AUDIO_RX_CODEC;            // rxcodec
    buf[0x73] = AUDIO_TX_CODEC;            // txcodec
    putBE32(buf+0x74, AUDIO_RX_SAMPLE);    // rxsample rate
    putBE32(buf+0x78, AUDIO_TX_SAMPLE);    // txsample rate
    putBE32(buf+0x7c, civLocalPort);        // civ local port
    putBE32(buf+0x80, audioAllowed ? audioLocalPort : 0);
    putBE32(buf+0x84, 150);                // txbuffer
    buf[0x88] = 1;                         // convert
    sendTracked(ctrlUdp, 0x90, 0x90);
    Serial.println(audioAllowed
      ? "LAN | stream request sent (rx+tx audio uLaw/8k)"
      : "LAN | stream request sent (CI-V only)");
  }

  void sendCivOpenClose(bool close) {
    memset(buf, 0, 0x16);
    putLE32(buf+0, 0x16);
    putLE32(buf+8, civMyId); putLE32(buf+12, civRemoteId);
    putLE16(buf+0x10, 0x01c0);
    putBE16(buf+0x13, civDataSeq++);       // CI-V sendseq (BE), separate counter
    buf[0x15] = close ? 0x00 : 0x05;       // IC-705 open magic is 0x05
    sendTracked(civUdp, 0x16, 0x16);
  }

  void clearCivCommands() {
    for (size_t i = 0; i < CIV_COMMAND_QUEUE_SIZE; ++i) civCommands[i].valid = false;
    civCommandOrder = 0;
  }

  bool enqueueCivCommand(const uint8_t* body, size_t length, CivPriority priority) {
    if (!body || length == 0 || length > CIV_COMMAND_MAX_BYTES) return false;
    // PTT is level state, not an event stream. Keeping an older queued PTT body
    // can key the radio after a newer abort/un-key, so coalesce it before adding
    // the current desired level.
    if (length >= 3 && body[0] == 0x1C && body[1] == 0x00) {
      for (size_t i = 0; i < CIV_COMMAND_QUEUE_SIZE; ++i)
        if (civCommands[i].valid && civCommands[i].length >= 3 &&
            civCommands[i].body[0] == 0x1C && civCommands[i].body[1] == 0x00)
          civCommands[i].valid = false;
    }
    int target = -1;
    for (size_t i = 0; i < CIV_COMMAND_QUEUE_SIZE; ++i) {
      if (!civCommands[i].valid) { target = int(i); break; }
    }
    if (target < 0 && priority >= CIV_CONTROL) {
      // Preserve safety/control by evicting the oldest strictly lower-priority
      // command. Never evict an equally urgent PTT OFF with a later command.
      for (size_t i = 0; i < CIV_COMMAND_QUEUE_SIZE; ++i) {
        if (civCommands[i].priority >= priority) continue;
        if (target < 0 || civCommands[i].order < civCommands[target].order)
          target = int(i);
      }
    }
    if (target < 0) return false;
    CivCommand& command = civCommands[target];
    memcpy(command.body, body, length);
    command.length = uint8_t(length);
    command.priority = priority;
    command.order = ++civCommandOrder;
    command.valid = true;
    return true;
  }

  bool serviceCivCommands(uint32_t now) {
    if (state != LAN_CONNECTED || civPort == 0 || !civGotReady || !civOpenSent ||
        !civGotData) return false;
    int selected = -1;
    for (size_t i = 0; i < CIV_COMMAND_QUEUE_SIZE; ++i) {
      if (!civCommands[i].valid) continue;
      if (selected < 0 || civCommands[i].priority > civCommands[selected].priority ||
          (civCommands[i].priority == civCommands[selected].priority &&
           civCommands[i].order < civCommands[selected].order))
        selected = int(i);
    }
    if (selected < 0) return false;
    CivCommand command = civCommands[selected];
    if (civRequestPending) {
      if (command.priority < CIV_CONTROL || now - civRequestSentMs < 20) return false;
      civRequestPending = false;
      civHealthProbePending = false;
    }
    civCommands[selected].valid = false;
    sendCiv(command.body, command.length);
    return true;
  }

  // send a CI-V frame (payload only, without FE FE .. FD wrapper) to the radio
  void sendCiv(const uint8_t* civBody, size_t bodyLen) {
    // full CI-V frame: FE FE <radio> E1 <body...> FD
    uint8_t fr[32];
    size_t fl = 0;
    fr[fl++] = 0xFE; fr[fl++] = 0xFE; fr[fl++] = radioCivAddr; fr[fl++] = 0xE1;
    for (size_t i = 0; i < bodyLen && fl < sizeof(fr)-1; i++) fr[fl++] = civBody[i];
    fr[fl++] = 0xFD;
    // wrap in data packet
    memset(buf, 0, 0x15);
    putLE32(buf+0, 0x15 + fl);
    putLE32(buf+8, civMyId); putLE32(buf+12, civRemoteId);
    buf[0x10] = 0xC1;
    putLE16(buf+0x11, fl);
    putBE16(buf+0x13, civDataSeq++);       // CI-V sendseq (BE), separate counter
    memcpy(buf+0x15, fr, fl);
    sendTracked(civUdp, 0x15 + fl, 0x15);
    civRequestPending = true;
    civRequestSentMs = millis();
  }
  void sendCivFrame3(uint8_t a, uint8_t b, uint8_t c) { uint8_t f[]={a,b,c}; sendCiv(f,3); }

  // rotating aux telemetry poll (mirrors the BT pollRadio aux set, minus the
  // S-meter/power that are polled every tick). Feeds the same state globals.
  void sendAuxRot(uint8_t i) {
    switch (i) {
      case 0: { uint8_t b[]={0x15,0x12}; sendCiv(b,2); break; } // SWR
      case 1: { uint8_t b[]={0x15,0x15}; sendCiv(b,2); break; } // supply voltage
      case 2: { uint8_t b[]={0x14,0x01}; sendCiv(b,2); break; } // AF gain
      case 3: { uint8_t b[]={0x14,0x0C}; sendCiv(b,2); break; } // key speed
      case 4: { uint8_t b[]={0x14,0x0A}; sendCiv(b,2); break; } // RF power
      case 5: { uint8_t b[]={0x1C,0x00}; sendCiv(b,2); break; } // TX state (PTT)
      case 6: { uint8_t b[]={0x21,0x00}; sendCiv(b,2); break; } // RIT offset
      case 7: { uint8_t b[]={0x11};      sendCiv(b,1); break; } // ATT
      case 8: { uint8_t b[]={0x16,0x02}; sendCiv(b,2); break; } // preamp
      case 9: { uint8_t b[]={0x16,0x47}; sendCiv(b,2); break; } // VOX
      // Mercury (docs/mercury-implementace.md §7): idle ALC readback, so
      // alcRaw/alcSeq (already parsed at civ 15 13 -- see the TX-time slots
      // above, which have exercised that parser for months) stay current
      // between transmissions too, not just during one.
      case 10: { uint8_t b[]={0x15,0x13}; sendCiv(b,2); break; } // ALC
    }
  }

  // CI-V remains a serial request/reply stream inside UDP. A new command may
  // follow an addressed radio response immediately, or an unanswered command
  // after a bounded timeout so one unsupported query cannot stop the rotation.
  bool civCanSendRequest(uint32_t now) {
    if (!civRequestPending) return true;
    if (now - civRequestSentMs < 500) return false;
    civRequestPending = false;
    return true;
  }

  // send the stream request once, only after BOTH auth 0x05 ack and caps arrived
  void maybeRequestStream() {
    if (authOk && haveCaps && !streamReqSent) {
      streamReqSent = true;
      sendStreamRequest();
      setState(LAN_STREAM);
    }
  }

  void reauthMaybe(uint32_t now) {
    // Match the reference client renewal cadence. Renewing twice as often adds
    // tracked control traffic without improving session liveness.
    if (authOk && now - lastReauth >= 60000) { sendToken(0x05); lastReauth = now; }
  }

  // Advance a past timestamp toward `now` by up to `amount` ms, never past
  // `now`. Clamping to the timestamp's own age keeps unsigned subtraction from
  // wrapping when a clock was refreshed slightly after the previous service point.
  static inline void forgiveClock(uint32_t& ts, uint32_t now, uint32_t amount) {
    uint32_t age = now - ts;
    ts += (age > amount) ? amount : age;
  }
  static inline void forgiveClock(volatile uint32_t& ts, uint32_t now, uint32_t amount) {
    uint32_t value = ts;
    uint32_t age = now - value;
    ts = value + ((age > amount) ? amount : age);
  }

  // ---- receive ----
  // Only the configured radio may drive session state. A datagram that lands on
  // one of our local ports from any other source is drained and ignored, so
  // stray or spoofed traffic cannot refresh session health or inject CAT/audio.
  bool fromRadio(WiFiUDP& u) { return u.remoteIP() == radioIP; }

  void pumpControl() {
    int n;
    while ((n = ctrlUdp.parsePacket()) > 0) {
      int r = ctrlUdp.read(buf, sizeof(buf));
      if (r < 0x10 || !fromRadio(ctrlUdp)) continue;
      lastCtrlRxMs = millis();      // authenticated session health is control-channel health
      handleControl(buf, r);
    }
  }
  void pumpCiv() {
    int n;
    while ((n = civUdp.parsePacket()) > 0) {
      int r = civUdp.read(buf, sizeof(buf));
      if (r < 0x10 || !fromRadio(civUdp)) continue;
      handleCiv(buf, r);
    }
  }

  void handleControl(uint8_t* r, int n) {
    uint16_t type = getLE16(r+4);
    uint32_t sentid = getLE32(r+8);

    // ping request -> reply
    if (n == 0x15 && type == 0x07 && r[0x10] == 0x00) {
      sendPingReply(ctrlUdp, ctrlMyId, ctrlRemoteId, getLE16(r+6), getLE32(r+0x11));
      return;
    }
    // reply to OUR ping -- timestamp is our own earlier millis(), so the RTT is
    // just now-minus-that. Previously received and silently dropped here.
    if (n == 0x15 && type == 0x07 && r[0x10] == 0x01) {
      ctrlPingRtt = millis() - getLE32(r+0x11);
      if (ctrlPingRtt > ctrlPingRttMax) ctrlPingRttMax = ctrlPingRtt;
      return;
    }
    if (handleRetransmitRequest(ctrlUdp, r, n)) return;
    if (n == 0x10) {
      if (type == 0x04 && state == LAN_AYT) {          // IAmHere
        ctrlRemoteId = sentid;
        Serial.println("LAN | ctrl: I am here");
        sendCtrl(ctrlUdp, ctrlMyId, ctrlRemoteId, 0x06, 1);  // AreYouReady
        setState(LAN_LOGIN);
      } else if (type == 0x06 && state == LAN_LOGIN) {  // Ready
        sendLogin();
      }
      return;
    }
    if (n == 0x60) {                                   // login response
      uint32_t err = getLE32(r+0x30);
      uint16_t tr = getLE16(r+0x1a);
      Serial.print("LAN | login response err=0x"); Serial.println(err, HEX);
      if (err == 0xFEFFFFFF) { Serial.println("LAN | BAD USERNAME/PASSWORD"); loginRejected = true; state = LAN_FAILED; return; }
      if (err != 0) { Serial.println("LAN | login rejected"); loginRejected = true; state = LAN_FAILED; return; }
      if (tr == tokRequest) {
        token = getLE32(r+0x1c);
        sendToken(0x02); sendToken(0x05);              // confirm + auth
        setState(LAN_AUTH);
      }
      return;
    }
    if (n == 0x40) {                                   // auth response
      if (r[0x14] == 0x02 && r[0x15] == 0x05) {
        uint32_t err = getLE32(r+0x30);
        if (err != 0) {
          authOk = false;
          Serial.print("LAN | token auth rejected err=0x"); Serial.println(err, HEX);
          state = LAN_FAILED;
          return;
        }
        authOk = true; lastReauth = millis();
        if (!authAnnounced) { Serial.println("LAN | auth OK"); authAnnounced = true; }
        maybeRequestStream();
      }
      return;
    }
    if (n == 0x50) {                                   // status (stream ports)
      uint32_t err = getLE32(r+0x30);
      if (r[0x40] == 0x01) {
        Serial.println("LAN | radio disconnected session");
        state = LAN_FAILED;
        return;
      }
      if (err != 0) {
        Serial.print("LAN | stream refused err=0x"); Serial.println(err, HEX);
        state = LAN_FAILED;
        return;
      }
      uint16_t cp = getBE16(r+0x42);
      if (cp == 0) {
        // radio still holding a prior session — fast-fail so we back off and retry
        Serial.println("LAN | stream civ port=0 (stale session), retrying");
        state = LAN_FAILED;
        return;
      }
      civPort = cp;
      audioPort = getBE16(r+0x46);
      Serial.print("LAN | stream ok, civ port="); Serial.println(civPort);
      openCivChannel();
      return;
    }
    if (n >= 0x42 && (n - 0x42) % 0x66 == 0) {         // capabilities
      // one radio: identity at first entry
      int base = 0x42;
      commonCap = getLE16(r+base+0x07);
      memcpy(radioMac, r+base+0x0a, 6);
      memcpy(radioName, r+base+0x10, 15); radioName[15] = 0;
      radioCivAddr = r[base+0x52];
      haveCaps = true;
      Serial.print("LAN | caps: "); Serial.print(radioName);
      Serial.print(" civ=0x"); Serial.println(radioCivAddr, HEX);
      maybeRequestStream();
      return;
    }
    // n==0x90 conninfo: ignored in minimal client
  }

  void openCivChannel() {
    if (streamOpened) return;
    streamOpened = true;
    civUdp.begin(civLocalPort);
    civMyId = mkId(civLocalPort);
    civRemoteId = 0;
    civGotHere = civGotReady = civOpenSent = civGotData = scopeOff = false;
    civRecovering = civReadyWaitAnnounced = civRequestPending = civSelectedModeSeen = false;
    civHealthProbePending = false;
    civRecoveryStartedMs = 0;
    civSendSeq = 1;
    civTxHistory.clear();
    civDataSeq = 0;
    lastCivDataMs = millis();
    lastFreqPoll = 0;
    auxRot = 0;
    civLastAyt = civLastReady = civLastPing = civLastIdle = 0;
    setState(LAN_CIV_AYT);
  }

  void openAudioChannel() {
    if (!audioAllowed) return;
#ifdef ARDUINO
    if (!audioRuntime) {
      audioRuntime = new (std::nothrow) AudioRuntime();
      if (!audioRuntime) {
        Serial.println("LAN | audio allocation failed");
        return;
      }
    }
    if (audioRuntime->task || audioRuntime->detached) return;
    audioLock();
    audioRuntime->txEpoch++;
    audioRuntime->tx.reset();
    audioRuntime->rxRead = audioRuntime->rxWrite = audioRuntime->rxCount = 0;
    audioRuntime->rxSeqValid = audioRuntime->rxReleaseValid = false;
    audioRuntime->rxGapWaitStartMs = 0;
    audioRuntime->rtxChase = 0;
    audioRuntime->rtxRequested = audioRuntime->rtxRecovered = 0;
    audioRuntime->rtxAbandoned = 0;
    audioRuntime->stopRequested = false;
    audioRuntime->socketFd = -1;
    audioUnlock();
    audioMyId = mkId(audioLocalPort);
    audioRemoteId = 0;
    audioGotHere = audioGotReady = false;
    audioHereTime = audioLastPing = audioLastIdle = audioLastAyt = audioLastReady = 0;
    audioLastDataMs = millis();
    audioOpened = true;  // includes the bounded opening/handshake state
    BaseType_t made = xTaskCreatePinnedToCore(
        audioTaskEntry, "icom-audio", 6144, this, 3, &audioRuntime->task,
        ARDUINO_RUNNING_CORE);
    if (made != pdPASS) {
      audioRuntime->task = nullptr;
      audioOpened = false;
      audioLock();
      audioRuntime->tx.fail(IcomLanAudioTx::FAULT_NOT_READY);
      audioUnlock();
      Serial.println("LAN | audio task allocation failed");
      return;
    }
#else
    if (!audioRuntime) audioRuntime = new (std::nothrow) AudioRuntime();
    if (!audioRuntime) return;
    audioUdp.begin(audioLocalPort);
    audioMyId = mkId(audioLocalPort);
    audioRemoteId = 0;
    audioGotHere = audioGotReady = false;
    audioSendSeq = 1; audioPingSeq = 0; audioTxSeq = 0;
    audioHereTime = 0; audioLastPing = audioLastIdle = audioLastAyt = audioLastReady = 0;
    audioLastDataMs = millis();   // start the no-data watchdog from channel open
    audioRuntime->tx.reset();
    audioOpened = true;
#endif
    Serial.print("LAN | audio channel open, remote port="); Serial.println(audioPort);
  }

#ifdef ARDUINO
  void audioLock() { portENTER_CRITICAL(&audioMux); }
  void audioUnlock() { portEXIT_CRITICAL(&audioMux); }

  static void audioTaskEntry(void* context) {
    static_cast<IcomLanClient*>(context)->audioTaskMain();
  }

  static void buildAudioCtrl(uint8_t* packet, uint16_t length, uint16_t type,
                             uint16_t sequence, uint32_t myId, uint32_t remoteId) {
    memset(packet, 0, length);
    putLE32(packet + 0x00, length);
    putLE16(packet + 0x04, type);
    putLE16(packet + 0x06, sequence);
    putLE32(packet + 0x08, myId);
    putLE32(packet + 0x0C, remoteId);
  }

  int audioSendDatagram(const uint8_t* packet, size_t length) {
    if (!audioRuntime || audioRuntime->socketFd < 0) return -1;
    sockaddr_in destination = {};
    destination.sin_family = AF_INET;
    destination.sin_port = htons(audioPort);
    destination.sin_addr.s_addr = uint32_t(radioIP);
    uint32_t started = micros();
    // char* rather than uint8_t*: Winsock spells the buffer as const char*,
    // lwip as const void*, and char* satisfies both without an #ifdef.
    int sent = sendto(audioRuntime->socketFd, reinterpret_cast<const char*>(packet),
                      length, MSG_DONTWAIT,
                      reinterpret_cast<sockaddr*>(&destination), sizeof(destination));
    uint32_t elapsed = micros() - started;
    if (elapsed > audioRuntime->maxSendUs) audioRuntime->maxSendUs = elapsed;
    if (sent == int(length)) return 1;
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOMEM))
      return 0;
    return -1;
  }

  void audioRememberTracked(uint16_t sequence, const uint8_t* packet, size_t length) {
    audioLock();
    audioRuntime->tx.rememberTracked(sequence, packet, length);
    audioUnlock();
  }

  void audioSendTrackedControl(uint16_t type) {
    uint8_t packet[0x10];
    audioLock();
    uint16_t sequence = audioRuntime->tx.nextTrackedSequence();
    audioUnlock();
    buildAudioCtrl(packet, sizeof(packet), type, sequence, audioMyId, audioRemoteId);
    int result = audioSendDatagram(packet, sizeof(packet));
    if (result > 0) {
      audioRememberTracked(sequence, packet, sizeof(packet));
      audioLastIdle = millis();
    }
  }

  void audioSendControl(uint16_t type, uint16_t sequence) {
    uint8_t packet[0x10];
    buildAudioCtrl(packet, sizeof(packet), type, sequence, audioMyId, audioRemoteId);
    audioSendDatagram(packet, sizeof(packet));
  }

  void audioSendPing(bool reply, uint16_t sequence, uint32_t timestamp) {
    uint8_t packet[0x15];
    buildAudioCtrl(packet, sizeof(packet), 0x07, sequence, audioMyId, audioRemoteId);
    packet[0x10] = reply ? 0x01 : 0x00;
    putLE32(packet + 0x11, timestamp);
    audioSendDatagram(packet, sizeof(packet));
  }

  void audioServiceTx(uint32_t now) {
    for (int burst = 0; burst < 3; ++burst) {
      uint8_t packet[IcomLanAudioTx::MAX_PACKET];
      size_t length = 0;
      uint32_t epoch = 0;
      IcomLanAudioTx::PollResult result;
      audioLock();
      const uint8_t* prepared = nullptr;
      result = audioRuntime->tx.poll(now, prepared, length);
      epoch = audioRuntime->txEpoch;
      if (result == IcomLanAudioTx::PACKET && prepared && length <= sizeof(packet))
        memcpy(packet, prepared, length);
      audioUnlock();
      if (result != IcomLanAudioTx::PACKET) return;

      int sent = audioSendDatagram(packet, length);
      if (sent == 0) return;  // nonblocking socket backpressure; retry next wake
      audioLock();
      if (epoch == audioRuntime->txEpoch)
        audioRuntime->tx.commitSend(sent > 0, now);
      audioUnlock();
      if (sent < 0) return;
      audioLastIdle = now;
    }
  }

  void audioReplayOne(uint16_t sequence) {
    uint8_t packet[IcomLanAudioTx::MAX_PACKET];
    size_t length = 0;
    bool found = false;
    audioLock();
    const uint8_t* remembered = audioRuntime->tx.replay(sequence, length);
    if (remembered && length <= sizeof(packet)) {
      memcpy(packet, remembered, length);
      found = true;
    }
    audioUnlock();
    int sent = 0;
    if (found) {
      sent = audioSendDatagram(packet, length);
    } else {
      buildAudioCtrl(packet, 0x10, 0x00, sequence, audioMyId, audioRemoteId);
      sent = audioSendDatagram(packet, 0x10);
    }
    // Transient nonblocking backpressure is not a broken TX. The radio can ask
    // for this sequence again; only a hard socket failure enters the fault path.
    if (sent != 0) {
      audioLock();
      audioRuntime->tx.noteReplaySent(sent > 0);
      audioUnlock();
    }
  }

  void audioHandleRetransmit(const uint8_t* packet, int length) {
    static const int MAX_AUDIO_REPLAY_PER_WAKE = 8;
    int budget = MAX_AUDIO_REPLAY_PER_WAKE;
    if (length == 0x10) {
      audioReplayOne(getLE16(packet + 6));
      return;
    }
    for (int at = 0x10; at + 3 < length && budget > 0; at += 4) {
      uint16_t first = getLE16(packet + at);
      uint16_t last = getLE16(packet + at + 2);
      uint16_t count = uint16_t(last - first) + 1;
      if (count == 0 || count > 50) continue;
      for (uint16_t offset = 0; offset < count && budget > 0; ++offset, --budget)
        audioReplayOne(uint16_t(first + offset));
    }
  }

  void audioEnqueueRx(const uint8_t* payload, size_t length, uint16_t sequence) {
    if (!audioRuntime || length != AUDIO_RX_PACKET_BYTES) {
      if (audioRuntime) audioRuntime->rxDropped++;
      return;
    }
    audioLock();
    AudioRuntime& rt = *audioRuntime;
    if (rt.rxCount == AUDIO_RX_QUEUE_PACKETS) {
      rt.rxRead = (rt.rxRead + 1) % AUDIO_RX_QUEUE_PACKETS;
      rt.rxCount--;
      rt.rxDropped++;
    }
    // A replay that lost the race with the drain's bounded hold would insert at
    // the buffer head with a sequence the drain already released past, and
    // releasing it would walk rxNextRelease backwards -- every later packet
    // would then look like a fresh hole and eat a spurious hold. Too late is
    // simply dropped; lanAudioHandler would discard it anyway.
    if (rt.rxReleaseValid && int16_t(sequence - rt.rxNextRelease) < 0) {
      audioUnlock();
      return;
    }
    // Ordered insert by inner sequence (wrap-safe). Packets arrive in order
    // except a replayed one, which must land back in its hole rather than at
    // the tail: the drain releases strictly by sequence and lanAudioHandler
    // drops anything older than what it already forwarded. The scan is O(1) on
    // the in-order path (first compare wins) and only walks on a replay.
    size_t place = rt.rxCount;
    bool duplicate = false;
    while (place > 0) {
      AudioRxPacket& before =
          rt.rx[(rt.rxRead + place - 1) % AUDIO_RX_QUEUE_PACKETS];
      int16_t order = int16_t(before.sequence - sequence);
      if (order < 0) break;
      if (order == 0) { duplicate = true; break; }
      place--;
    }
    if (!duplicate) {
      if (place != rt.rxCount) rt.rtxRecovered++;
      for (size_t at = rt.rxCount; at > place; at--)
        rt.rx[(rt.rxRead + at) % AUDIO_RX_QUEUE_PACKETS] =
            rt.rx[(rt.rxRead + at - 1) % AUDIO_RX_QUEUE_PACKETS];
      AudioRxPacket& target = rt.rx[(rt.rxRead + place) % AUDIO_RX_QUEUE_PACKETS];
      target.sequence = sequence;
      target.length = uint16_t(length);
      memcpy(target.payload, payload, length);
      rt.rxCount++;
      rt.rxWrite = (rt.rxRead + rt.rxCount) % AUDIO_RX_QUEUE_PACKETS;
    }
    audioUnlock();
  }

  // Watch the inner (data-only) sequence for holes and open a chase for the
  // control-layer window that must contain the missing data packets. Detected
  // on inner so the radio's tracked idles can never fake a hole; the asked
  // outer window may cover an idle too -- the radio just replays it and the
  // stray copy is dropped as a duplicate on insert.
  void audioNoteRxSequence(uint16_t inner, uint16_t outer) {
    if (!audioRuntime) return;
    audioLock();
    AudioRuntime& rt = *audioRuntime;
    if (!rt.rxSeqValid) {
      rt.rxSeqValid = true;
      rt.rxLastInner = inner;
      rt.rxLastOuter = outer;
      audioUnlock();
      return;
    }
    int16_t innerStep = int16_t(inner - rt.rxLastInner);
    if (innerStep <= 0) { audioUnlock(); return; }  // a replay landing in its hole
    int16_t outerStep = int16_t(outer - rt.rxLastOuter);
    if (innerStep > 1 && outerStep > 1 && rt.rtxChase == 0) {
      uint16_t chase = uint16_t(outerStep - 1);
      if (chase <= AUDIO_RTX_MAX_CHASE) {
        rt.rtxFirstOuter = uint16_t(rt.rxLastOuter + 1);
        rt.rtxChase = chase;
        rt.rtxAttempts = 0;
        rt.rtxLastSendMs = 0;   // audioRetransmitTick fires on the next wake
        rt.rtxRequested += chase;
      }
    }
    rt.rxLastInner = inner;
    rt.rxLastOuter = outer;
    audioUnlock();
  }

  // Repeat the open ask every AUDIO_RTX_RESEND_MS until the attempts run out.
  // Runs in the audio task, so the ask leaves within ~1 ms of the hole being
  // seen and keeps leaving even while the cooperative loop is stalled -- which
  // is exactly when WiFi bursts eat packets. Sends happen outside the lock.
  void audioRetransmitTick(uint32_t now) {
    if (!audioRuntime) return;
    uint16_t first = 0, chase = 0;
    audioLock();
    AudioRuntime& rt = *audioRuntime;
    if (rt.rtxChase &&
        (rt.rtxLastSendMs == 0 || now - rt.rtxLastSendMs >= AUDIO_RTX_RESEND_MS)) {
      if (rt.rtxAttempts >= AUDIO_RTX_ATTEMPTS) {
        rt.rtxChase = 0;   // the drain's bounded hold is the backstop
      } else {
        first = rt.rtxFirstOuter;
        chase = rt.rtxChase;
        rt.rtxAttempts++;
        rt.rtxLastSendMs = now;
      }
    }
    audioUnlock();
    for (uint16_t at = 0; at < chase; at++)
      audioSendControl(0x01, uint16_t(first + at));
  }

  void audioHandleDatagram(uint8_t* packet, int length) {
    if (length < 0x10) return;
    uint16_t type = getLE16(packet + 4);
    if (length == 0x15 && type == 0x07 && packet[0x10] == 0x00) {
      audioSendPing(true, getLE16(packet + 6), getLE32(packet + 0x11));
      return;
    }
    if (length == 0x15 && type == 0x07 && packet[0x10] == 0x01) {
      uint32_t rtt = millis() - getLE32(packet + 0x11);
      audioPingRtt = rtt;
      if (rtt > audioPingRttMax) audioPingRttMax = rtt;
      return;
    }
    if (type == 0x01) {
      audioHandleRetransmit(packet, length);
      return;
    }
    if (length == 0x10) {
      if (type == 0x04) {
        audioRemoteId = getLE32(packet + 8);
        audioGotHere = true;
        audioHereTime = millis();
        audioLock();
        audioRuntime->tx.configure(audioMyId, audioRemoteId);
        audioUnlock();
        audioSendControl(0x06, 1);
        audioLastReady = millis();
      } else if (type == 0x06) {
        audioRemoteId = getLE32(packet + 8);
        audioGotReady = true;
        audioLock();
        audioRuntime->tx.configure(audioMyId, audioRemoteId);
        audioUnlock();
      }
      return;
    }
    uint32_t declared = getLE32(packet + 0);
    if (type != 0x01 && declared == uint32_t(length) && length > 0x18) {
      size_t payloadLength = size_t(length - 0x18);
      audioLastDataMs = millis();
      uint16_t inner = getBE16(packet + 0x12);
      audioNoteRxSequence(inner, getLE16(packet + 6));
      audioEnqueueRx(packet + 0x18, payloadLength, inner);
    }
  }

  void audioPumpSocket(int budget) {
    if (!audioRuntime || audioRuntime->socketFd < 0) return;
    while (budget-- > 0) {
      uint8_t packet[1500];
      sockaddr_in source = {};
      socklen_t sourceLength = sizeof(source);
      int received = recvfrom(audioRuntime->socketFd, reinterpret_cast<char*>(packet),
                              sizeof(packet), MSG_DONTWAIT,
                              reinterpret_cast<sockaddr*>(&source), &sourceLength);
      if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        return;
      }
      if (received == 0 || source.sin_addr.s_addr != uint32_t(radioIP)) continue;
      audioHandleDatagram(packet, received);
      audioServiceTx(millis());  // replay/RX bursts never own the next TX deadline
    }
  }

  void audioPeriodic(uint32_t now) {
    if (!audioGotHere) {
      if (now - audioLastAyt >= 500) {
        audioSendControl(0x03, 0);
        audioLastAyt = now;
      }
      return;
    }
    if (!audioGotReady && now - audioLastReady >= 500) {
      audioSendControl(0x06, 1);
      audioLastReady = now;
    }
    if (now - audioLastPing >= 500) {
      audioSendPing(false, audioPingSeq++, now);
      audioLastPing = now;
    }
    if (now - audioLastIdle >= 100) audioSendTrackedControl(0x00);
  }

  void audioTaskMain() {
    AudioRuntime* runtime = audioRuntime;
    runtime->socketFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (runtime->socketFd >= 0) {
      // Every other socket in this project sets SO_REUSEADDR -- WiFiUDP does it
      // for the control and CI-V channels, and the discovery scanner relies on
      // it. This raw one was the odd one out, which meant the audio channel
      // alone could not bind while anything else held the port. Without it the
      // failure below is silent and the channel retries for ever.
      // The cast is not decoration: Winsock declares the value as const char*,
      // lwip and POSIX as const void*, and char* converts cleanly to both.
      int reuse = 1;
      setsockopt(runtime->socketFd, SOL_SOCKET, SO_REUSEADDR,
                 reinterpret_cast<const char*>(&reuse), sizeof(reuse));

      int flags = fcntl(runtime->socketFd, F_GETFL, 0);
      if (flags >= 0) fcntl(runtime->socketFd, F_SETFL, flags | O_NONBLOCK);
      sockaddr_in local = {};
      local.sin_family = AF_INET;
      local.sin_port = htons(audioLocalPort);
      local.sin_addr.s_addr = htonl(INADDR_ANY);
      if (bind(runtime->socketFd, reinterpret_cast<sockaddr*>(&local), sizeof(local)) < 0) {
        close(runtime->socketFd);
        runtime->socketFd = -1;
      }
    }
    if (runtime->socketFd < 0) {
      // Said out loud once per attempt. This used to fail in complete silence
      // while openAudioChannel() kept reporting success, so the only symptom
      // was "the waterfall stays empty" with nothing in the log to explain it.
      Serial.print("LAN | audio socket bind FAILED on local port ");
      Serial.println(audioLocalPort);
      audioLock();
      runtime->tx.fail(IcomLanAudioTx::FAULT_NOT_READY);
      audioUnlock();
      audioOpened = false;
    }

    while (runtime->socketFd >= 0 && !runtime->stopRequested) {
      uint32_t now = millis();
      audioServiceTx(now);
      audioPumpSocket(12);
      audioServiceTx(millis());
      audioPeriodic(millis());
      audioRetransmitTick(millis());
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1));
    }

    if (runtime->socketFd >= 0) {
      uint8_t disconnect[0x10];
      buildAudioCtrl(disconnect, sizeof(disconnect), 0x05, 0, audioMyId, audioRemoteId);
      audioSendDatagram(disconnect, sizeof(disconnect));
      close(runtime->socketFd);
      runtime->socketFd = -1;
    }
    audioLock();
    if (runtime->tx.active()) runtime->tx.fail(IcomLanAudioTx::FAULT_LINK);
    audioUnlock();
    audioOpened = false;
    audioGotHere = audioGotReady = false;
    runtime->task = nullptr;
    vTaskDelete(nullptr);
  }

  void drainAudioRx() {
    if (!audioRuntime) return;
    for (int budget = 0; budget < 16; ++budget) {
      AudioRxPacket packet;
      bool have = false;
      uint32_t now = millis();
      audioLock();
      AudioRuntime& rt = *audioRuntime;
      if (rt.rxCount) {
        AudioRxPacket& head = rt.rx[rt.rxRead];
        bool release = true;
        // Hold a head-of-line hole briefly: the replay the task asked for
        // inserts in front of everything queued behind it. Bounded twice -- by
        // wall time and by occupancy -- so a request the radio ignores can only
        // add latency once, never dam the stream.
        if (rt.rxReleaseValid && int16_t(head.sequence - rt.rxNextRelease) > 0) {
          if (!rt.rxGapWaitStartMs) {
            rt.rxGapWaitStartMs = now;
            release = false;
          } else if (now - rt.rxGapWaitStartMs < AUDIO_RTX_HOLD_MS &&
                     rt.rxCount < AUDIO_RX_HOLD_HIGH) {
            release = false;
          } else {
            rt.rtxAbandoned++;   // the hole stays; lanAudioHandler accounts it
          }
        }
        if (release) {
          packet = head;
          rt.rxRead = (rt.rxRead + 1) % AUDIO_RX_QUEUE_PACKETS;
          rt.rxCount--;
          // Forward only: the enqueue guard drops too-late replays, but the
          // expectation must still never regress even if one slips through.
          uint16_t next = uint16_t(packet.sequence + 1);
          if (!rt.rxReleaseValid || int16_t(next - rt.rxNextRelease) > 0)
            rt.rxNextRelease = next;
          rt.rxReleaseValid = true;
          rt.rxGapWaitStartMs = 0;
          have = true;
        }
      }
      audioUnlock();
      if (!have) break;
      lanAudioHandler(packet.payload, packet.length, packet.sequence);
    }
  }
#else
  void audioLock() {}
  void audioUnlock() {}
  void drainAudioRx() {}

  void pumpAudio() {
    int n;
    while ((n = audioUdp.parsePacket()) > 0) {
      int r = audioUdp.read(buf, sizeof(buf));
      if (r < 0x10 || !fromRadio(audioUdp)) continue;
      handleAudio(buf, r);
    }
  }

  void handleAudio(uint8_t* r, int n) {
    uint16_t type = getLE16(r+4);
    if (n == 0x15 && type == 0x07 && r[0x10] == 0x00) {          // ping request -> reply
      sendPingReply(audioUdp, audioMyId, audioRemoteId, getLE16(r+6), getLE32(r+0x11));
      return;
    }
    if (n == 0x15 && type == 0x07 && r[0x10] == 0x01) {
      audioPingRtt = millis() - getLE32(r+0x11);
      if (audioPingRtt > audioPingRttMax) audioPingRttMax = audioPingRtt;
      return;
    }
    if (n == 0x10) {
      if (type == 0x04 && !audioGotHere) {                       // IAmHere
        audioGotHere = true; audioRemoteId = getLE32(r+8); audioHereTime = millis();
        audioLastDataMs = millis();   // restart the no-data window once linked
        sendCtrl(audioUdp, audioMyId, audioRemoteId, 0x06, 1);   // AreYouReady
        audioLastReady = millis();
        Serial.println("LAN | audio: I am here");
      } else if (type == 0x06) {                                 // Ready (rare)
        audioRemoteId = getLE32(r+8);
        audioGotReady = true;
      }
      return;
    }
    // audio data packet: header is 0x18 bytes, PCM/uLaw payload follows (wfview
    // icomudpaudio.cpp: type != 0x01 && len >= 0x20, data = r.mid(0x18)).
    uint32_t plen = getLE32(r+0);
    if (type != 0x01 && plen >= 0x20 && n > 0x18) {
      audioLastDataMs = millis();
      if (audioAllowed)
        lanAudioHandler(r + 0x18, (size_t)(n - 0x18), getBE16(r + 0x12));
    }
  }
#endif

  void handleCiv(uint8_t* r, int n) {
    uint16_t type = getLE16(r+4);
    uint32_t sentid = getLE32(r+8);

    if (n == 0x15 && type == 0x07 && r[0x10] == 0x00) {
      sendPingReply(civUdp, civMyId, civRemoteId, getLE16(r+6), getLE32(r+0x11));
      return;
    }
    if (n == 0x15 && type == 0x07 && r[0x10] == 0x01) {
      civPingRtt = millis() - getLE32(r+0x11);
      if (civPingRtt > civPingRttMax) civPingRttMax = civPingRtt;
      return;
    }
    if (handleRetransmitRequest(civUdp, r, n)) return;
    if (n == 0x10) {
      if (type == 0x04 && !civGotHere) {
        civGotHere = true; civRemoteId = sentid;
        Serial.println("LAN | civ: I am here");
        sendCtrl(civUdp, civMyId, civRemoteId, 0x06, 1);
        civLastReady = millis();
        setState(LAN_CIV_OPEN);
        maybeConnected();            // data may have raced ahead of this handshake
      } else if (type == 0x06) {                       // ready (rare on IC-705)
        civRemoteId = sentid;
        civGotReady = true;
        if (!civOpenSent) {
          Serial.println("LAN | civ: ready");
          civOpenSent = true;
          sendCivOpenClose(false);
          civNextOpen = millis()+500;
          lastFreqPoll = millis()-500;
        }
      }
      return;
    }
    if (n > 0x15 && type != 0x01) {                    // data packet
      uint16_t plen = getLE32(r+0) & 0xFFFF;
      uint16_t dlen = getLE16(r+0x11);
      if (((dlen + 0x15) & 0xFFFF) != plen) return;
      // split possibly-multiple CI-V frames FE FE .. FD in payload
      bool gotValidRadioFrame = false;
      int i = 0x15;
      while (i + 5 <= n) {
        if (r[i] != 0xFE || r[i+1] != 0xFE) { i++; continue; }
        int e = i + 2;
        while (e < n && r[e] != 0xFD) e++;
        if (e >= n) break;
        if (parseCivFrame(r + i, e - i + 1)) gotValidRadioFrame = true;
        i = e + 1;
      }
      if (gotValidRadioFrame) {
        if (civRecovering && Debug) Serial.println("LAN | CAT replies restored");
        civRecovering = false;
        civRecoveryStartedMs = 0;
        civGotData = true;
        lastCivDataMs = millis();
        maybeConnected();            // first real radio frame after handshake -> CONNECTED
      }
      return;
    }
  }

  bool parseCivFrame(const uint8_t* f, int len) {
    if (len < 6) return false;
    // CI-V frame: FE FE <to> <from> <cmd> ... FD. Only process frames FROM the
    // radio (from-addr == radioCivAddr); the radio echoes our own commands back
    // (from == 0xE1 controller), which must not be parsed as replies.
    if (f[3] != radioCivAddr) return false;
    if (f[4] == 0x27) return false;                      // scope data does not prove CAT replies
    lanCivFrameRoute(radioSlot, f, (size_t)len);         // slot-aware parse in the .ino
    // NOTE: state is intentionally NOT driven here — see maybeConnected(). A radio
    // that streams CI-V data before finishing its civ handshake used to flip the
    // state (and the log) CIV_OPEN<->CONNECTED on every frame.
    // A transceive broadcast (to=0x00, cmd=0x00) is useful radio state while
    // tuning, but it does not prove that the radio accepts our E1 CAT polls.
    bool addressedReply = f[2] == 0xE1;
    if (addressedReply) {
      if (civRequestPending) {
        civReqRtt = millis() - civRequestSentMs;
        if (civReqRtt > civReqRttMax) civReqRttMax = civReqRtt;
      }
      civRequestPending = false;
      if (f[4] == 0x03) civHealthProbePending = false;
      if (f[4] == 0x26 && len >= 7 && f[5] == 0x00) civSelectedModeSeen = true;
    }
    return addressedReply;
  }

  // Single promotion point to LAN_CONNECTED: reached only once the civ handshake
  // is done (civGotHere -> LAN_CIV_OPEN) AND at least one CI-V data frame has been
  // received. Called from both the handshake and the data path so whichever
  // completes the pair does the promotion, exactly once.
  void maybeConnected() {
    if (state == LAN_CIV_OPEN && civGotData) {
      Serial.println("LAN | CONNECTED");
      setState(LAN_CONNECTED);
    }
  }

  void setState(State s) { state = s; stateSince = millis(); }
};
