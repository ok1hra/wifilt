#include "js8_session.h"

#include <cstdint>
#include <iostream>
#include <string>

namespace {

bool check(bool condition, char const *what) {
    if (!condition) std::cerr << "JS8 SESSION FAIL: " << what << '\n';
    return condition;
}

const char *A = "0123456789abcdef0123456789abcdef";
const char *B = "fedcba9876543210fedcba9876543210";

} // namespace

int main() {
    bool pass = true;

    // --- one operator at a time ---------------------------------------------
    {
        Js8Session session;
        pass = check(!js8SessionLive(session, 0), "a fresh device holds nothing") && pass;

        pass = check(js8SessionClaim(session, 1000, A, 0x0A000001u, false) == JS8_SESSION_GRANTED,
                     "first claim must be granted") && pass;
        pass = check(js8SessionOwns(session, 1000, A), "the claimant must own it") && pass;

        // The second computer is the whole point: it must be refused, and the
        // refusal must not disturb the live session.
        pass = check(js8SessionClaim(session, 1200, B, 0x0A000002u, false) == JS8_SESSION_BUSY,
                     "a second page must be refused") && pass;
        pass = check(js8SessionOwns(session, 1200, A), "a refusal must not evict the owner") && pass;
        pass = check(session.refusals == 1, "refusals must be counted") && pass;
    }

    // --- reload and same-tab navigation ------------------------------------
    {
        Js8Session session;
        js8SessionClaim(session, 1000, A, 0x0A000001u, false);
        // /data -> /setup -> /data keeps the token, so the page comes back to
        // its own lock rather than fighting itself for it.
        pass = check(js8SessionClaim(session, 4000, A, 0x0A000001u, false) == JS8_SESSION_RENEWED,
                     "re-claiming with the same token must renew") && pass;
        pass = check(session.refusals == 0, "a renewal is not a refusal") && pass;
    }

    // --- the lease expires so a dead tab cannot hold the radio ---------------
    {
        Js8Session session;
        js8SessionClaim(session, 1000, A, 0x0A000001u, false);
        pass = check(js8SessionLive(session, 1000 + JS8_SESSION_LEASE_MS - 1),
                     "the lease must survive right up to the deadline") && pass;
        pass = check(!js8SessionLive(session, 1000 + JS8_SESSION_LEASE_MS),
                     "the lease must expire exactly at the deadline") && pass;
        pass = check(js8SessionClaim(session, 1000 + JS8_SESSION_LEASE_MS, B, 0x0A000002u, false)
                         == JS8_SESSION_GRANTED,
                     "an expired lock must be free to claim") && pass;
        pass = check(session.takeovers == 0, "expiry is not a takeover") && pass;
    }

    // --- heartbeats hold it, silence loses it -------------------------------
    {
        Js8Session session;
        js8SessionClaim(session, 1000, A, 0x0A000001u, false);
        for (uint32_t at = 6000; at <= 60000; at += 5000)
            pass = check(js8SessionHeartbeat(session, at, A, 0x0A000001u) == JS8_SESSION_RENEWED,
                         "heartbeats must keep the lock") && pass;
        pass = check(js8SessionLive(session, 61000), "a heartbeating page must still own it") && pass;

        // AUD1 traffic is evidence too, so a page busy with audio never loses
        // the radio to a starved HTTP heartbeat.
        js8SessionNoteTraffic(session, 70000);
        pass = check(js8SessionOwns(session, 75000, A), "audio traffic must renew the lease") && pass;

        // A half-open socket from a browser that is already gone must not be
        // able to resurrect a lease that has run out.
        js8SessionNoteTraffic(session, 70000 + JS8_SESSION_LEASE_MS);
        pass = check(!js8SessionLive(session, 70000 + JS8_SESSION_LEASE_MS),
                     "traffic must not resurrect an expired lease") && pass;
    }

    // --- takeover is deliberate and complete --------------------------------
    {
        Js8Session session;
        js8SessionClaim(session, 1000, A, 0x0A000001u, false);
        pass = check(js8SessionClaim(session, 2000, B, 0x0A000002u, true) == JS8_SESSION_TAKEOVER,
                     "force must win against a live holder") && pass;
        pass = check(js8SessionOwns(session, 2000, B), "the forcing page must own it") && pass;
        pass = check(!js8SessionOwns(session, 2000, A), "the old holder must lose it") && pass;
        pass = check(session.takeovers == 1, "takeovers must be counted") && pass;
        // How the losing page finds out: its next heartbeat is refused.
        pass = check(js8SessionHeartbeat(session, 3000, A, 0x0A000001u) == JS8_SESSION_BUSY,
                     "the evicted page must be told on its next heartbeat") && pass;
    }

    // --- release only frees your own lock -----------------------------------
    {
        Js8Session session;
        js8SessionClaim(session, 1000, A, 0x0A000001u, false);
        pass = check(!js8SessionRelease(session, B), "a stranger must not free the lock") && pass;
        pass = check(js8SessionOwns(session, 1000, A), "the owner must survive that") && pass;
        pass = check(js8SessionRelease(session, A), "the owner must be able to release") && pass;
        pass = check(!js8SessionLive(session, 1000), "release must free the lock") && pass;

        // A page that was taken over still fires its unload beacon. That late
        // release must not cancel the new holder's lease.
        js8SessionClaim(session, 2000, A, 0x0A000001u, false);
        js8SessionClaim(session, 2100, B, 0x0A000002u, true);
        pass = check(!js8SessionRelease(session, A), "a late beacon must not free the new holder") && pass;
        pass = check(js8SessionOwns(session, 2100, B), "the new holder must keep the lock") && pass;
    }

    // --- a heartbeat reclaims a free lock -----------------------------------
    {
        // Same-tab navigation fires the release beacon and the new page load in
        // either order. If the beacon lands last, the page is left heartbeating
        // into a lock nobody owns and the next page to open would win the radio.
        Js8Session session;
        js8SessionClaim(session, 1000, A, 0x0A000001u, false);
        js8SessionRelease(session, A);
        pass = check(js8SessionHeartbeat(session, 1100, A, 0x0A000001u) == JS8_SESSION_GRANTED,
                     "a heartbeat must reclaim a lock nobody holds") && pass;
        pass = check(js8SessionOwns(session, 1100, A), "and the page must own it again") && pass;
    }

    // --- tokens are validated before they are echoed into JSON ---------------
    {
        Js8Session session;
        pass = check(!js8SessionTokenValid(""), "empty token must be rejected") && pass;
        pass = check(!js8SessionTokenValid("short"), "a too-short token must be rejected") && pass;
        pass = check(!js8SessionTokenValid("0123456789abcdef\"injected"),
                     "a token with quotes must be rejected") && pass;
        pass = check(!js8SessionTokenValid("0123456789abcdef0123456789abcdef0123456789"),
                     "an over-long token must be rejected") && pass;
        pass = check(js8SessionTokenValid("6ba7b8109dad11d180b400c04fd430c8"),
                     "a full-width token must be accepted") && pass;
        pass = check(js8SessionClaim(session, 1000, "bad token!", 0x0A000001u, false)
                         == JS8_SESSION_BAD_TOKEN,
                     "a malformed claim must be refused") && pass;
        pass = check(!js8SessionLive(session, 1000), "a refused claim must install nothing") && pass;
    }

    // --- role (grilled 2026-08-28: who QRPLOG sees holding AUD1) ------------
    {
        Js8Session session;
        pass = check(session.role[0] == 0, "a fresh session names no role") && pass;

        pass = check(js8SessionClaim(session, 1000, A, 0x0A000001u, false, "rtty") == JS8_SESSION_GRANTED,
                     "a claim carrying a role must still grant normally") && pass;
        pass = check(std::string(session.role) == "rtty", "the claimed role must be recorded") && pass;

        // A claim that doesn't mention a role (older client, or a heartbeat)
        // must not blank out what was already recorded.
        pass = check(js8SessionHeartbeat(session, 6000, A, 0x0A000001u) == JS8_SESSION_RENEWED,
                     "a roleless heartbeat must still renew") && pass;
        pass = check(std::string(session.role) == "rtty",
                     "a roleless heartbeat must not clear the recorded role") && pass;

        // A takeover installs a fresh holder with no say yet about what it is
        // -- carrying the PREVIOUS holder's role forward would misattribute a
        // USB-D QSO to whoever held AUD1 last, not whoever holds it now.
        pass = check(js8SessionClaim(session, 7000, B, 0x0A000002u, true, "js8") == JS8_SESSION_TAKEOVER,
                     "a forced claim with a role must still take over") && pass;
        pass = check(std::string(session.role) == "js8", "the new holder's role must replace the old one") && pass;

        js8SessionRelease(session, B);
        pass = check(session.role[0] == 0, "release must clear the role along with everything else") && pass;
    }

    // --- millis() wrap ------------------------------------------------------
    {
        const uint32_t nearWrap = 0xFFFFF000u;
        auto at = [&](uint32_t offset) { return uint32_t(nearWrap + offset); };
        Js8Session session;
        js8SessionClaim(session, nearWrap, A, 0x0A000001u, false);
        pass = check(js8SessionOwns(session, at(5000), A),
                     "ownership must survive the millis wrap") && pass;
        pass = check(!js8SessionLive(session, at(JS8_SESSION_LEASE_MS + 1)),
                     "the lease must still expire across the wrap") && pass;
    }

    std::cout << "JS8 SESSION " << (pass ? "PASS" : "FAIL")
              << " lease=" << (JS8_SESSION_LEASE_MS / 1000) << "s"
              << " tokenMax=" << int(JS8_SESSION_TOKEN_MAX) << '\n';
    return pass ? 0 : 1;
}
