// JS8Call @APRSIS command catalogue, draft parser and payload rules.
//
// @APRSIS is a group callsign, not a station: any listening IGate picks the
// directed frame off the air and forwards it to APRS-IS. Two commands reach it,
// both verified against the bundled JS8Call-improved-master source:
//
//   GRID <locator>   UI_Constructor::spotAprsGrid  -- position beacon
//   CMD  <text>      UI_Constructor::spotAprsCmd   -- third-party text tunnel
//
// What CMD carries is APRS, not JS8, so two APRS rules bind the payload:
//
//   The addressee is EXACTLY nine characters, space padded and truncated, as in
//   APRSISClient.cpp:401 `to_call.left(9).leftJustified(9, ' ', true)`. In a
//   single-line <input> that padding is invisible, so it is never typed: it is
//   computed on insert and recomputed by normalize() on the way to the encoder.
//
//   The message text after the addressee is at most 67 characters. Past that
//   the gateway truncates, so a longer draft is refused instead of transmitted
//   -- two minutes of NORMAL-speed airtime is too much to spend on a payload
//   that arrives cut in half.
//
// The module holds no DOM and no state. data.js re-derives the menu from the
// composer text on every keystroke, so a hand-edited draft can never disagree
// with what the menu offers.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Aprs = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const GROUP = "@APRSIS";
  const ADDRESSEE_WIDTH = 9;
  const MESSAGE_TEXT_LIMIT = 67;
  const RECENT_KEY = "wifilt.data.js8-aprs-recent.v1";
  const RECENT_MAX = 5;
  // Mirrors MODE_PERIOD_SECONDS in data.js: seconds of airtime per JS8 frame.
  const PERIOD_SECONDS = {0:15, 1:10, 2:6, 4:30, 8:4};

  // Upstream grid_pattern (Varicode.cpp:33) accepts 4, 6 and 8 characters; the
  // station setting only stores 4 or 6, so the popup takes the longer form too.
  const LOCATOR_RE = /^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/;
  const CALL_RE = /^[A-Z0-9]+(?:[/-][A-Z0-9]+)*$/;
  const PHONE_RE = /^\+?[0-9]{6,15}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const FREQ_RE = /^[0-9]{1,3}(?:\.[0-9]{1,4})?$/;
  const SOTA_RE = /^[A-Z0-9]{1,3}\/[A-Z]{2}-[0-9]{3}$/;
  const POTA_RE = /^[A-Z0-9]{2}-[0-9]{4}$/;

  // JS8 transmits upper case only and directedMessageLayout() upper-cases the
  // draft anyway, so fold it here where the operator can still see the result.
  // Diacritics are stripped rather than dropped so "Příjezd" survives as
  // "PRIJEZD" instead of losing three letters.
  function sanitize(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[^A-Z0-9 .,?!/+@:_'"()=&$%#*><[\]{}|;^`~\-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // A colon inside the addressee would fake a second block and shift the whole
  // payload, so it is removed before padding.
  function addressee(value) {
    return sanitize(value).replace(/:/g, "")
      .slice(0, ADDRESSEE_WIDTH).padEnd(ADDRESSEE_WIDTH, " ");
  }

  const cmd = (dest, text) => `CMD :${addressee(dest)}:${String(text).trim()}`;

  function portable(call) {
    const clean = sanitize(call).replace(/[^A-Z0-9/-]/g, "");
    if (!clean) return "";
    return clean.includes("/") ? clean : `${clean}/P`;
  }

  function megahertz(hz) {
    const value = Number(hz);
    return Number.isFinite(value) && value > 0 ? (value / 1e6).toFixed(3) : "";
  }

  // Every parameter but the last takes one whitespace-delimited token; the last
  // one swallows the remainder, because free text is always the tail.
  function splitFields(text, count) {
    const fields = [];
    let rest = String(text == null ? "" : text).trim();
    for (let index = 0; index < count - 1; index += 1) {
      const match = /^(\S+)\s*/.exec(rest);
      if (!match) { fields.push(""); continue; }
      fields.push(match[1]);
      rest = rest.slice(match[0].length);
    }
    fields.push(rest);
    return fields;
  }

  const TEXT_PARAM = {key:"text", label:"Message", placeholder:"Short plain text",
    required:true};

  const GRID = {
    id:"grid", token:"GRID", label:"GRID", hint:"Beacon your locator to APRS-IS",
    params:[{key:"locator", label:"Locator", placeholder:"JN79NX28", prefill:"grid",
      pattern:LOCATOR_RE, patternHint:"4, 6 or 8 character Maidenhead locator",
      required:true}],
    tail: values => `GRID ${values.locator}`,
    fields: text => ({locator:splitFields(text, 1)[0]}),
  };

  const CMD = {
    id:"cmd", token:"CMD", label:"CMD", hint:"Third-party text into APRS-IS",
    params:[], tail: () => "CMD ", fields: () => ({}),
  };

  const COMMANDS = [GRID, CMD];

  const SERVICES = [
    {id:"smsgte", dest:"SMSGTE", label:"SMSGTE", hint:"SMS to a mobile phone",
      params:[
        {key:"phone", label:"Phone", placeholder:"+420123456789", pattern:PHONE_RE,
          patternHint:"digits, optionally with a leading +", required:true},
        TEXT_PARAM],
      // The gateway wants the number prefixed with @, then a space, then the text.
      tail: values => cmd("SMSGTE", `@${values.phone} ${values.text}`),
      fields: text => {
        const [phone, rest] = splitFields(text, 2);
        return {phone:phone.replace(/^@/, ""), text:rest};
      }},

    {id:"email2", dest:"EMAIL-2", label:"EMAIL-2", hint:"Email through APRS-IS",
      params:[
        {key:"email", label:"Address", placeholder:"ok1abc@seznam.cz",
          pattern:EMAIL_RE, patternHint:"name@domain.tld", required:true},
        TEXT_PARAM],
      tail: values => cmd("EMAIL-2", `${values.email} ${values.text}`),
      fields: text => {
        const [email, rest] = splitFields(text, 2);
        return {email, text:rest};
      }},

    {id:"wlnk1", dest:"WLNK-1", label:"WLNK-1", hint:"Winlink message",
      params:[
        {key:"email", label:"Address", placeholder:"ok2xyz@winlink.org",
          pattern:EMAIL_RE, patternHint:"name@domain.tld", required:true},
        {key:"subject", label:"Subject", placeholder:"STATUS", required:true},
        TEXT_PARAM],
      // Winlink splits subject from body on a literal " // " separator.
      tail: values => cmd("WLNK-1",
        `${values.email} ${values.subject} // ${values.text}`),
      fields: text => {
        const [email, rest] = splitFields(text, 2);
        const cut = rest.indexOf(" // ");
        return cut < 0 ? {email, subject:rest, text:""}
          : {email, subject:rest.slice(0, cut).trim(), text:rest.slice(cut + 4).trim()};
      }},

    {id:"sota", dest:"APRS2SOTA", label:"APRS2SOTA", hint:"SOTA summit spot",
      params:[
        {key:"call", label:"Callsign", placeholder:"OK1ABC/P", prefill:"myCallPortable",
          pattern:CALL_RE, required:true},
        {key:"ref", label:"Summit ref", placeholder:"OK/KR-001", pattern:SOTA_RE,
          patternHint:"association/region-number, e.g. OK/KR-001", required:true},
        {key:"freq", label:"Frequency MHz", placeholder:"7.078", prefill:"dialMhz",
          pattern:FREQ_RE, required:true},
        {key:"mode", label:"Mode", placeholder:"JS8", prefill:"js8", required:true},
        {key:"comment", label:"Comment", placeholder:"optional", required:false}],
      tail: values => cmd("APRS2SOTA", spot(values)),
      fields: text => spotFields(text)},

    {id:"pota", dest:"APRS2POTA", label:"APRS2POTA", hint:"POTA park spot",
      params:[
        {key:"call", label:"Callsign", placeholder:"OK2XYZ/P", prefill:"myCallPortable",
          pattern:CALL_RE, required:true},
        {key:"ref", label:"Park ref", placeholder:"OK-0022", pattern:POTA_RE,
          patternHint:"two letters, dash, four digits, e.g. OK-0022", required:true},
        {key:"freq", label:"Frequency MHz", placeholder:"14.078", prefill:"dialMhz",
          pattern:FREQ_RE, required:true},
        {key:"mode", label:"Mode", placeholder:"JS8", prefill:"js8", required:true},
        {key:"comment", label:"Comment", placeholder:"optional", required:false}],
      tail: values => cmd("APRS2POTA", spot(values)),
      fields: text => spotFields(text)},

    {id:"whois", dest:"WHO-IS", label:"WHO-IS", hint:"Look a callsign up",
      params:[{key:"call", label:"Callsign", placeholder:"OK1XYZ", pattern:CALL_RE,
        required:true}],
      tail: values => cmd("WHO-IS", values.call),
      fields: text => ({call:splitFields(text, 1)[0]})},

    {id:"wxbot", dest:"WXBOT", label:"WXBOT", hint:"Weather forecast for a place",
      params:[{key:"city", label:"Place", placeholder:"PRAGUE", required:true}],
      tail: values => cmd("WXBOT", values.city),
      fields: text => ({city:splitFields(text, 1)[0]})},
  ];

  // The addressee is whatever the operator typed, so this node is also the
  // fallback for any destination the catalogue does not know.
  const DIRECT = {
    id:"direct", dest:"", destParam:"call", label:"Direct callsign",
    hint:"Message an APRS user directly",
    params:[
      {key:"call", label:"Callsign", placeholder:"OK2XYZ-9", pattern:CALL_RE,
        patternHint:"callsign, optionally with an SSID such as -9", required:true,
        recent:true},
      TEXT_PARAM],
    // The callsign lives in the addressee, not in the text, so reopening the
    // popup has to be handed the destination parse() already matched.
    tail: values => cmd(values.call, values.text),
    fields: (text, dest) => ({call:String(dest || "").trim(),
      text:String(text || "").trim()}),
  };

  const MENU = [...SERVICES, DIRECT];

  function spot(values) {
    const head = `${values.call} ${values.ref} ${values.freq} ${values.mode}`;
    return values.comment ? `${head} ${values.comment}` : head;
  }

  function spotFields(text) {
    const [call, ref, freq, mode, comment] = splitFields(text, 5);
    return {call, ref, freq, mode, comment};
  }

  function isDraft(value) {
    const upper = String(value == null ? "" : value).replace(/^\s+/, "").toUpperCase();
    return upper === GROUP || upper.startsWith(`${GROUP} `);
  }

  // Returns null when the draft is not an APRS command at all, so the caller can
  // fall straight through to the ordinary directed-message path.
  //
  //   path      breadcrumb; each step carries the field text truncated to it
  //   children  what the menu should offer at this depth
  //   text      the APRS message text (or the GRID argument)
  function parse(value) {
    const draft = String(value == null ? "" : value).replace(/^\s+/, "");
    if (!isDraft(draft)) return null;

    const path = [{id:"aprsis", label:GROUP, text:`${GROUP} `}];
    const tail = draft.slice(GROUP.length).replace(/^\s+/, "");
    const tailUpper = tail.toUpperCase();
    const command = COMMANDS.find(node => {
      if (!tailUpper.startsWith(node.token)) return false;
      const next = tailUpper.charAt(node.token.length);
      return next === "" || next === " " || next === ":";
    }) || null;

    if (!command)
      return {draft, tail, command:null, service:null, dest:"", text:tail, path,
        children:COMMANDS.slice()};

    path.push({id:command.id, label:command.token, text:`${GROUP} ${command.token} `});
    const argument = tail.slice(command.token.length).replace(/^\s+/, "");

    if (command.id !== "cmd")
      return {draft, tail, command, service:null, dest:"", text:argument, path,
        children:[]};

    const block = /^:([^:]*):/.exec(argument);
    if (!block)
      return {draft, tail, command, service:null, dest:"", text:argument, path,
        children:MENU.slice()};

    const dest = block[1].trim().toUpperCase();
    const service = SERVICES.find(node => node.dest && node.dest === dest) || DIRECT;
    path.push({id:service.id, label:dest || service.label,
      text:`${GROUP} ${command.token} ${argument.slice(0, block[0].length)}`});
    return {draft, tail, command, service, dest,
      text:argument.slice(block[0].length).replace(/^\s+/, ""), path, children:[]};
  }

  // Recompute the addressee padding the operator cannot see, exactly as
  // APRSISClient.cpp:401 does, and fold the draft to the upper case the encoder
  // would apply anyway. The message text is otherwise left untouched -- an
  // unencodable character should fail loudly in packData(), not vanish here.
  function normalize(value) {
    const parsed = parse(value);
    if (!parsed) return String(value == null ? "" : value);
    if (!parsed.command) return `${GROUP} ${parsed.tail}`.trim().toUpperCase();
    if (parsed.command.id !== "cmd")
      return `${GROUP} ${parsed.command.token} ${parsed.text}`.trim().toUpperCase();
    if (!parsed.dest) return `${GROUP} CMD ${parsed.text}`.trim().toUpperCase();
    return `${GROUP} CMD :${addressee(parsed.dest)}:${parsed.text}`.toUpperCase();
  }

  // A half-built command costs the same airtime as a whole one and the gateway
  // has nothing to do with it, so SEND stays disabled until this passes.
  function validate(value) {
    const parsed = parse(value);
    if (!parsed) return {ok:false, reason:"not an APRS command", textLength:0};
    if (!parsed.command)
      return {ok:false, reason:"pick GRID or CMD", textLength:0};
    if (parsed.command.id === "grid") {
      const locator = parsed.text.trim().toUpperCase();
      if (!locator) return {ok:false, reason:"GRID needs a locator", textLength:0};
      if (!LOCATOR_RE.test(locator))
        return {ok:false, reason:"locator must be 4, 6 or 8 characters", textLength:0};
      return {ok:true, reason:"", textLength:0};
    }
    if (!parsed.dest)
      return {ok:false, reason:"pick an APRS destination", textLength:0};
    const text = parsed.text.trim();
    if (!text)
      return {ok:false, reason:"APRS command has no message text", textLength:0};
    if (text.length > MESSAGE_TEXT_LIMIT)
      return {ok:false, textLength:text.length,
        reason:`APRS message text is ${text.length} characters, limit is ${MESSAGE_TEXT_LIMIT}`};
    return {ok:true, reason:"", textLength:text.length};
  }

  // startTxTo() takes the recipient separately, so peel @APRSIS off the front.
  // state.selectedCall is deliberately left alone: an APRS spot in the middle of
  // a QSO must not cost the operator the station they had selected.
  function splitForTx(value) {
    if (!isDraft(value)) return null;
    const text = normalize(value);
    return {toCall:GROUP, text:text.slice(GROUP.length).replace(/^\s+/, "")};
  }

  function compose(node, values) {
    const clean = {};
    for (const param of node.params) clean[param.key] = sanitize(values?.[param.key]);
    return `${GROUP} ${node.tail(clean)}`;
  }

  function prefill(node, context = {}) {
    const values = {};
    for (const param of node.params) {
      values[param.key] =
        param.prefill === "myCall" ? sanitize(context.myCall) :
        param.prefill === "myCallPortable" ? portable(context.myCall) :
        param.prefill === "grid" ? sanitize(context.grid) :
        param.prefill === "dialMhz" ? megahertz(context.dialFrequencyHz) :
        param.prefill === "js8" ? "JS8" : "";
    }
    return values;
  }

  // Per-field errors for the popup, plus the whole-payload checks, so the
  // operator sees why Insert is disabled without transmitting first.
  function checkParams(node, values) {
    const errors = [];
    const clean = {};
    for (const param of node.params) {
      const field = sanitize(values?.[param.key]);
      clean[param.key] = field;
      if (!field) {
        if (param.required) errors.push({key:param.key, reason:`${param.label} is required`});
        continue;
      }
      if (param.pattern && !param.pattern.test(field))
        errors.push({key:param.key,
          reason:param.patternHint ? `${param.label}: ${param.patternHint}` : `${param.label} is not valid`});
    }
    if (errors.length) return {ok:false, errors, payload:"", textLength:0};
    const payload = compose(node, clean);
    const check = validate(payload);
    if (!check.ok) errors.push({key:"", reason:check.reason});
    return {ok:errors.length === 0, errors, payload, textLength:check.textLength};
  }

  function truncateTo(value, id) {
    if (id === "root") return "";
    const parsed = parse(value);
    if (!parsed) return "";
    const step = parsed.path.find(item => item.id === id);
    return step ? step.text : "";
  }

  function airtimeSeconds(frameCount, submode) {
    return Math.max(0, Number(frameCount) || 0) * (PERIOD_SECONDS[submode] || 15);
  }

  // Only the direct-callsign field is worth remembering: every other
  // destination is in the catalogue and the rest is genuinely new each time.
  function rememberCall(list, call) {
    const previous = Array.isArray(list) ? list : [];
    const clean = sanitize(call).replace(/[^A-Z0-9/-]/g, "");
    if (!clean) return previous.slice(0, RECENT_MAX);
    return [clean, ...previous.filter(item => item !== clean)].slice(0, RECENT_MAX);
  }

  function loadRecent(storage) {
    try {
      const parsed = JSON.parse(storage?.getItem(RECENT_KEY) || "[]");
      return Array.isArray(parsed)
        ? parsed.map(item => sanitize(item).replace(/[^A-Z0-9/-]/g, ""))
          .filter(Boolean).slice(0, RECENT_MAX)
        : [];
    } catch (_error) { return []; }
  }

  function saveRecent(storage, list) {
    const clean = (Array.isArray(list) ? list : []).slice(0, RECENT_MAX);
    storage?.setItem(RECENT_KEY, JSON.stringify(clean));
    return clean;
  }

  // The IGate relays an inbound APRS message back as "@APRSIS MSG to:<DEST>
  // <TEXT> DE <SENDER>" (AprsInboundRelay.cpp:192) -- addressed to the group,
  // not to us. Without this the reply is invisible under the "mycall" traffic
  // filter and lands in no conversation at all.
  function replyForMe(message, myCall) {
    const call = sanitize(myCall);
    if (!call) return false;
    const calls = (message && message.callsigns) || [];
    if (!calls.some(item => sanitize(item) === GROUP)) return false;
    return new RegExp(`\\bTO:\\s*${call}\\b`).test(sanitize(message && message.text));
  }

  // LOCATOR_RE is exported for js8-aprs-gate.js: what this module will compose
  // into a GRID command and what the gate will accept out of one have to be the
  // same rule, or the station gates positions it would refuse to send.
  return {GROUP, ADDRESSEE_WIDTH, MESSAGE_TEXT_LIMIT, LOCATOR_RE, RECENT_KEY, RECENT_MAX,
    COMMANDS, SERVICES, MENU, GRID, CMD, DIRECT,
    sanitize, addressee, portable, megahertz, isDraft, parse, normalize, validate,
    splitForTx, compose, prefill, checkParams, truncateTo, airtimeSeconds,
    rememberCall, loadRecent, saveRecent, replyForMe};
});
