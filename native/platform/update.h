// The native build's side of "update from the web" (SOFTWARE.md, native/update/).
//
// wifilt itself never downloads or installs anything: it has no TLS client and
// runs without root. It only
//   * tells the page which update path this installation has (mode),
//   * hands an action to the updater -- on Linux by dropping req/request.json
//     into /var/lib/wifilt-update, which wifilt-update.path turns into a root
//     run of wifilt-update --
//   * and serves the updater's own progress file back to the page.
// The updater takes only the action name from the request; what gets installed
// is decided by its channel and verified against SHA256 there.
#pragma once

#include <string>

// "systemd"   installed by install.sh with the updater units, running from it
// "pi"        the same, on a Raspberry Pi set up by pi-setup
// "pi-locked" the same, root filesystem currently read-only (fslock)
// "manual"    anything else: a run from an unpacked archive or a checkout, an
//             older install without the updater -- the page offers a download
const char *nativeUpdateMode();

// {"mode":..., "locked":bool, "check":{...}|null, "state":"idle|running|..."}
// check is the updater's check.json verbatim (newest REV, asset, error).
std::string nativeUpdateInfoJson();

// The updater's status.json verbatim, or {"state":"idle"} when there is none.
std::string nativeUpdateStatusJson();

// Queue an action for the updater: "check" or "update" (dry = simulate only).
// Returns "" on success or a short reason for the page.
std::string nativeUpdateRequest(const char *action, bool dry, std::string *idOut);

// Ask a running update to stop (honoured until the old version is stopped).
std::string nativeUpdateCancel();

// Store the access token a private channel needs (config dir, mode 0600).
std::string nativeUpdateSaveToken(const std::string &token);

// Windows: the updater asks wifilt to quit cleanly before replacing it
// (native/main.cpp; same path as Ctrl+C, radio sessions logged out).
void nativeRequestStop();
