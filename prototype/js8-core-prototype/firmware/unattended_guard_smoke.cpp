#include "unattended_guard.h"
#include "unattended_events.h"

#include <cstdint>
#include <string>
#include <iostream>

namespace {

bool check(bool condition, char const *what) {
    if (!condition) std::cerr << "UNATTENDED GUARD FAIL: " << what << '\n';
    return condition;
}

} // namespace

int main() {
    bool pass = true;

    // --- liveness is a hard gate on every new transmission -------------------
    {
        UnattendedGuard guard;
        // Nothing has ever arrived: refuse, do not treat silence as fresh.
        pass = check(unattendedEvaluate(guard, 0, false) == UNATTENDED_BLOCK_LIVENESS,
                     "cold start must block") && pass;

        unattendedNoteClient(guard, 10000);
        pass = check(unattendedEvaluate(guard, 10000, false) == UNATTENDED_OK,
                     "fresh client must pass") && pass;
        pass = check(unattendedEvaluate(guard, 14999, false) == UNATTENDED_OK,
                     "just inside the 5 s window must pass") && pass;
        pass = check(unattendedEvaluate(guard, 15000, false) == UNATTENDED_BLOCK_LIVENESS,
                     "exactly at the timeout must block") && pass;
        pass = check(unattendedEvaluate(guard, 60000, false) == UNATTENDED_BLOCK_LIVENESS,
                     "long silence must block") && pass;

        // TX audio counts as liveness, which is why a long transfer never trips it.
        unattendedNoteClient(guard, 60000);
        pass = check(unattendedEvaluate(guard, 60020, false) == UNATTENDED_OK,
                     "liveness must recover once frames resume") && pass;
        pass = check(guard.blockedLiveness == 3, "liveness blocks must be counted") && pass;
    }

    // --- arming never gates operator traffic --------------------------------
    {
        UnattendedGuard guard;
        unattendedNoteClient(guard, 1000);
        pass = check(!unattendedArmActive(guard, 1000), "must start disarmed") && pass;
        // Manual operating has to work with no arming at all.
        pass = check(unattendedEvaluate(guard, 1000, false) == UNATTENDED_OK,
                     "operator TX must not require arming") && pass;
        // A transmission the browser itself calls unattended is refused instead.
        pass = check(unattendedEvaluate(guard, 1000, true) == UNATTENDED_BLOCK_NOT_ARMED,
                     "unattended TX while disarmed must block") && pass;
        pass = check(guard.blockedNotArmed == 1, "disarmed blocks must be counted") && pass;
    }

    // --- arming window, expiry and revoke ------------------------------------
    {
        UnattendedGuard guard;
        unattendedNoteClient(guard, 1000);
        pass = check(unattendedArm(guard, 3600UL * 1000UL, 1000), "arm must succeed") && pass;
        pass = check(unattendedArmActive(guard, 1000), "arm must be active immediately") && pass;
        pass = check(unattendedEvaluate(guard, 1000, true) == UNATTENDED_OK,
                     "unattended TX must pass while armed") && pass;
        pass = check(unattendedRemainingMs(guard, 1000) == 3600UL * 1000UL,
                     "remaining must equal the requested window") && pass;

        // Liveness still applies to an armed station.
        pass = check(unattendedEvaluate(guard, 30000, true) == UNATTENDED_BLOCK_LIVENESS,
                     "arming must not bypass liveness") && pass;

        unattendedNoteClient(guard, 3600UL * 1000UL + 500);
        pass = check(!unattendedArmActive(guard, 3600UL * 1000UL + 1001),
                     "arming must lapse on its own") && pass;
        pass = check(unattendedRemainingMs(guard, 3600UL * 1000UL + 1001) == 0,
                     "remaining must be zero once lapsed") && pass;
        // Exactly one expiry event, so the log does not repeat every loop.
        pass = check(unattendedExpire(guard, 3600UL * 1000UL + 1001),
                     "expiry must fire once") && pass;
        pass = check(!unattendedExpire(guard, 3600UL * 1000UL + 1002),
                     "expiry must not repeat") && pass;

        unattendedNoteClient(guard, 5000000);
        unattendedArm(guard, 3600UL * 1000UL, 5000000);
        unattendedRevoke(guard);
        pass = check(!unattendedArmActive(guard, 5000000), "revoke must disarm") && pass;
        pass = check(unattendedEvaluate(guard, 5000000, true) == UNATTENDED_BLOCK_NOT_ARMED,
                     "revoke must stop unattended TX") && pass;
    }

    // --- clamping and extension ---------------------------------------------
    {
        UnattendedGuard guard;
        pass = check(!unattendedArm(guard, 0, 1000), "zero duration must be rejected") && pass;
        pass = check(unattendedArm(guard, 0xFFFFFFFFUL, 1000), "huge duration must clamp") && pass;
        pass = check(unattendedRemainingMs(guard, 1000) == UNATTENDED_ARM_MAX_MS,
                     "clamp must be the 168 h maximum") && pass;

        // Extending restarts from now so the shown deadline matches the button.
        unattendedArm(guard, 3600UL * 1000UL, 1000);
        unattendedExtend(guard, 6UL * 3600UL * 1000UL, 1800UL * 1000UL);
        pass = check(unattendedRemainingMs(guard, 1800UL * 1000UL) == 6UL * 3600UL * 1000UL,
                     "extend must restart the window") && pass;

        pass = check(unattendedIsArmChoiceH(1) && unattendedIsArmChoiceH(168),
                     "offered choices must validate") && pass;
        pass = check(!unattendedIsArmChoiceH(0) && !unattendedIsArmChoiceH(5),
                     "unoffered choices must be rejected") && pass;
    }

    // --- keying gate: the case the prepare-time check cannot see -------------
    // Browser prepares a slot 30 s out, ships the whole prebuffer, then dies.
    // The ring is satisfied, so the prebuffer test alone would key the radio.
    {
        UnattendedGuard guard;
        uint32_t const prepareAt = 100000;
        unattendedNoteClient(guard, prepareAt);
        pass = check(unattendedEvaluate(guard, prepareAt, false) == UNATTENDED_OK,
                     "prepare must be accepted while the browser is alive") && pass;
        pass = check(unattendedMayKey(guard, prepareAt), "keying right away is fine") && pass;

        uint32_t const slotAt = prepareAt + 30000; // firmware allows up to 35 s
        pass = check(!unattendedMayKey(guard, slotAt),
                     "must refuse to key 30 s after the browser went silent") && pass;

        // Audio still flowing means the session is alive and keying is correct.
        unattendedNoteClient(guard, slotAt - 100);
        pass = check(unattendedMayKey(guard, slotAt),
                     "must key when the browser is still streaming") && pass;
    }


    // --- event log: formatting and rotation ---------------------------------
    {
        char line[UNATTENDED_EVENT_LINE_MAX];
        size_t const n = unattendedFormatEvent(line, sizeof(line), 61234,
                                               UEV_BLOCK, "frontend liveness lost");
        pass = check(n > 0, "event must format") && pass;
        pass = check(std::string(line) == "61234 BLOCK frontend liveness lost\n",
                     "event line must be exact") && pass;

        // Newlines and quotes would break the one-line contract and the JSON.
        char dirty[UNATTENDED_EVENT_LINE_MAX];
        unattendedFormatEvent(dirty, sizeof(dirty), 1, UEV_TX_ABORT,
                              "bad\nline\"quote\\slash");
        pass = check(std::string(dirty) == "1 TX_ABORT bad line quote slash\n",
                     "event detail must be sanitised") && pass;

        pass = check(unattendedFormatEvent(line, sizeof(line), 1, UEV_TYPE_COUNT, "x") == 0,
                     "unknown event type must be rejected") && pass;

        pass = check(unattendedEventIsAlert(UEV_BLOCK) &&
                     unattendedEventIsAlert(UEV_PTT_SAFETY) &&
                     unattendedEventIsAlert(UEV_TX_ABORT),
                     "refusals and unsafe recoveries must be alerts") && pass;
        pass = check(!unattendedEventIsAlert(UEV_ARM) && !unattendedEventIsAlert(UEV_EXPIRE),
                     "routine events must not be alerts") && pass;

        pass = check(!unattendedLogNeedsRotate(0, 100), "empty log must not rotate") && pass;
        pass = check(!unattendedLogNeedsRotate(UNATTENDED_LOG_MAX_BYTES - 100, 100),
                     "exactly at the cap must not rotate") && pass;
        pass = check(unattendedLogNeedsRotate(UNATTENDED_LOG_MAX_BYTES - 100, 101),
                     "one byte past the cap must rotate") && pass;
        pass = check(unattendedLogRotateFrom(UNATTENDED_LOG_MAX_BYTES) ==
                     UNATTENDED_LOG_MAX_BYTES - UNATTENDED_LOG_KEEP_BYTES,
                     "rotation must keep the newest half") && pass;
        pass = check(unattendedLogRotateFrom(UNATTENDED_LOG_KEEP_BYTES - 1) == 0,
                     "a short log must be kept whole") && pass;
    }

    // --- millis() wrap -------------------------------------------------------
    // The sketch runs for months; every deadline comparison must survive the
    // ~49.7 day rollover.
    {
        UnattendedGuard guard;
        // 256 ms short of the rollover, so every offset below genuinely wraps.
        uint32_t const nearWrap = 0xFFFFFF00UL;
        auto const at = [nearWrap](uint32_t offset) -> uint32_t {
            return (uint32_t)(nearWrap + offset); // deliberate modular arithmetic
        };
        pass = check(at(2000) < nearWrap, "test offset must actually wrap") && pass;

        unattendedNoteClient(guard, nearWrap);
        pass = check(unattendedLivenessFresh(guard, at(2000)),
                     "liveness must survive the millis wrap") && pass;
        pass = check(!unattendedLivenessFresh(guard, at(6000)),
                     "liveness must still expire across the wrap") && pass;

        unattendedArm(guard, 3600UL * 1000UL, nearWrap);
        pass = check(unattendedArmActive(guard, at(2000)),
                     "arming must survive the millis wrap") && pass;
        pass = check(!unattendedArmActive(guard, at(3600UL * 1000UL + 1)),
                     "arming must still lapse across the wrap") && pass;
    }

    std::cout << "UNATTENDED GUARD " << (pass ? "PASS" : "FAIL")
              << " timeout=" << UNATTENDED_LIVENESS_TIMEOUT_MS << "ms"
              << " armMax=" << (UNATTENDED_ARM_MAX_MS / 3600000UL) << "h"
              << " choices=" << int(UNATTENDED_ARM_CHOICE_COUNT) << '\n';
    return pass ? 0 : 1;
}
