#!/usr/bin/env node
"use strict";

const assert=require("assert");
const fs=require("fs");
const path=require("path");
const Aprs=require("../data/js8-aprs.js");
const Protocol=require("../data/js8-protocol.js");

// ---- payloads match docs/aprsis-cmd.md verbatim -----------------------------
// The addressee width is the whole point: SMSGTE(6)+3, EMAIL-2(7)+2, WXBOT(5)+4,
// APRS2SOTA(9)+0. Anything else and the gateway drops the message.
const byId=id=>Aprs.MENU.find(node=>node.id===id);

assert.strictEqual(Aprs.compose(byId("smsgte"),
  {phone:"+420123456789",text:"Ahoj, posilam zpravu z radia."}),
  "@APRSIS CMD :SMSGTE   :@+420123456789 AHOJ, POSILAM ZPRAVU Z RADIA.");
assert.strictEqual(Aprs.compose(byId("email2"),
  {email:"ok1abc@seznam.cz",text:"Dorazil jsem v poradku."}),
  "@APRSIS CMD :EMAIL-2  :OK1ABC@SEZNAM.CZ DORAZIL JSEM V PORADKU.");
assert.strictEqual(Aprs.compose(byId("wlnk1"),
  {email:"ok2xyz@winlink.org",subject:"Status",text:"Vse funguje."}),
  "@APRSIS CMD :WLNK-1   :OK2XYZ@WINLINK.ORG STATUS // VSE FUNGUJE.");
assert.strictEqual(Aprs.compose(byId("sota"),
  {call:"OK1ABC/P",ref:"OK/KR-001",freq:"7.078",mode:"JS8",comment:"Aktivace"}),
  "@APRSIS CMD :APRS2SOTA:OK1ABC/P OK/KR-001 7.078 JS8 AKTIVACE");
assert.strictEqual(Aprs.compose(byId("pota"),
  {call:"OK2XYZ/P",ref:"OK-0022",freq:"14.078",mode:"JS8",comment:""}),
  "@APRSIS CMD :APRS2POTA:OK2XYZ/P OK-0022 14.078 JS8");
assert.strictEqual(Aprs.compose(byId("whois"),{call:"ok1xyz"}),
  "@APRSIS CMD :WHO-IS   :OK1XYZ");
assert.strictEqual(Aprs.compose(byId("wxbot"),{city:"Prague"}),
  "@APRSIS CMD :WXBOT    :PRAGUE");
assert.strictEqual(Aprs.compose(byId("direct"),
  {call:"OK1ABC",text:"Ahoj Martine, slysis me na KV?"}),
  "@APRSIS CMD :OK1ABC   :AHOJ MARTINE, SLYSIS ME NA KV?");
assert.strictEqual(Aprs.compose(byId("direct"),{call:"OK2XYZ-9",text:"Jedu za tebou."}),
  "@APRSIS CMD :OK2XYZ-9 :JEDU ZA TEBOU.");
assert.strictEqual(Aprs.compose(Aprs.GRID,{locator:"jn79nx28"}),
  "@APRSIS GRID JN79NX28");

// Diacritics fold instead of disappearing.
assert.strictEqual(Aprs.sanitize("Příjezd v 18:00"),"PRIJEZD V 18:00");

// Every addressee is exactly nine characters, whatever went in.
for (const node of Aprs.SERVICES)
  assert.strictEqual(Aprs.addressee(node.dest).length,Aprs.ADDRESSEE_WIDTH);
assert.strictEqual(Aprs.addressee("VERYLONGDESTINATION"),"VERYLONGD");
assert.strictEqual(Aprs.addressee("a:b"),"AB       ");

// ---- parser walks the tree the menu renders ---------------------------------
assert.strictEqual(Aprs.parse("RR"),null);
assert.strictEqual(Aprs.parse("@APRSISX CMD"),null);

const atRoot=Aprs.parse("@APRSIS ");
assert.deepStrictEqual(atRoot.children.map(node=>node.token),["GRID","CMD"]);
assert.deepStrictEqual(atRoot.path.map(step=>step.id),["aprsis"]);

const atCmd=Aprs.parse("@APRSIS CMD ");
assert.strictEqual(atCmd.command.id,"cmd");
assert.strictEqual(atCmd.service,null);
assert.deepStrictEqual(atCmd.children.map(node=>node.id),
  ["smsgte","email2","wlnk1","sota","pota","whois","wxbot","direct"]);
assert.deepStrictEqual(atCmd.path.map(step=>step.id),["aprsis","cmd"]);

const atWxbot=Aprs.parse("@APRSIS CMD :WXBOT    :PRAGUE");
assert.strictEqual(atWxbot.service.id,"wxbot");
assert.strictEqual(atWxbot.dest,"WXBOT");
assert.strictEqual(atWxbot.text,"PRAGUE");
assert.deepStrictEqual(atWxbot.path.map(step=>step.label),["@APRSIS","CMD","WXBOT"]);
// An unknown destination is still a valid direct message.
assert.strictEqual(Aprs.parse("@APRSIS CMD :ANSRVR   :HELLO").service.id,"direct");
// A colon inside the message text must not be mistaken for a second block.
assert.strictEqual(Aprs.parse("@APRSIS CMD :WXBOT    :QTH: PRAGUE").text,"QTH: PRAGUE");

// Breadcrumb clicks truncate the draft back to that level.
const deep="@APRSIS CMD :WXBOT    :PRAGUE";
assert.strictEqual(Aprs.truncateTo(deep,"root"),"");
assert.strictEqual(Aprs.truncateTo(deep,"aprsis"),"@APRSIS ");
assert.strictEqual(Aprs.truncateTo(deep,"cmd"),"@APRSIS CMD ");

// ---- compose/parse round trip ----------------------------------------------
// Reopening the popup from a breadcrumb has to recover exactly what built it.
const roundTrip=[
  ["smsgte",{phone:"+420123456789",text:"AHOJ SVETE"}],
  ["email2",{email:"OK1ABC@SEZNAM.CZ",text:"DORAZIL JSEM"}],
  ["wlnk1",{email:"OK2XYZ@WINLINK.ORG",subject:"STATUS",text:"VSE FUNGUJE"}],
  ["sota",{call:"OK1ABC/P",ref:"OK/KR-001",freq:"7.078",mode:"JS8",comment:"AKTIVACE"}],
  ["pota",{call:"OK2XYZ/P",ref:"OK-0022",freq:"14.078",mode:"JS8",comment:""}],
  ["whois",{call:"OK1XYZ"}],
  ["wxbot",{city:"PRAGUE"}],
  ["direct",{call:"OK2XYZ-9",text:"JEDU ZA TEBOU"}],
];
for (const [id,values] of roundTrip) {
  const node=byId(id);
  const parsed=Aprs.parse(Aprs.compose(node,values));
  assert.strictEqual(parsed.service.id,id,`round trip picked the wrong node for ${id}`);
  assert.deepStrictEqual(node.fields(parsed.text,parsed.dest),values,
    `round trip lost a field in ${id}`);
}
assert.deepStrictEqual(
  Aprs.GRID.fields(Aprs.parse(Aprs.compose(Aprs.GRID,{locator:"JN79NX28"})).text),
  {locator:"JN79NX28"});

// ---- normalize repairs what the operator cannot see -------------------------
assert.strictEqual(Aprs.normalize("@APRSIS CMD :OK1ABC:AHOJ"),
  "@APRSIS CMD :OK1ABC   :AHOJ");
assert.strictEqual(Aprs.normalize("@APRSIS CMD :SMSGTE  :@+420123456789 AHOJ"),
  "@APRSIS CMD :SMSGTE   :@+420123456789 AHOJ");
assert.strictEqual(Aprs.normalize("@APRSIS CMD :SMSGTE       :AHOJ"),
  "@APRSIS CMD :SMSGTE   :AHOJ");
assert.strictEqual(Aprs.normalize("@APRSIS CMD :VERYLONGDESTINATION:HI"),
  "@APRSIS CMD :VERYLONGD:HI");
assert.strictEqual(Aprs.normalize("@aprsis grid jn79nx28"),"@APRSIS GRID JN79NX28");
assert.strictEqual(Aprs.normalize("RR"),"RR");
// Already correct drafts survive normalization untouched.
for (const [id,values] of roundTrip) {
  const payload=Aprs.compose(byId(id),values);
  assert.strictEqual(Aprs.normalize(payload),payload,`normalize disturbed ${id}`);
}

// ---- completeness gating ----------------------------------------------------
const refuse=(draft,pattern)=>{
  const check=Aprs.validate(draft);
  assert.strictEqual(check.ok,false,`expected refusal: ${draft}`);
  assert.match(check.reason,pattern,`wrong reason for: ${draft}`);
};
refuse("@APRSIS",/GRID or CMD/);
refuse("@APRSIS ",/GRID or CMD/);
refuse("@APRSIS GRID",/needs a locator/);
refuse("@APRSIS GRID XX99",/4, 6 or 8/);
refuse("@APRSIS CMD",/APRS destination/);
refuse("@APRSIS CMD :WXBOT    :",/no message text/);
refuse(`@APRSIS CMD :WXBOT    :${"X".repeat(68)}`,/limit is 67/);
assert.strictEqual(Aprs.validate("@APRSIS GRID JN79").ok,true);
assert.strictEqual(Aprs.validate("@APRSIS GRID JN79NX").ok,true);
assert.strictEqual(Aprs.validate("@APRSIS GRID JN79NX28").ok,true);
assert.strictEqual(Aprs.validate(`@APRSIS CMD :WXBOT    :${"X".repeat(67)}`).ok,true);
assert.strictEqual(Aprs.validate("@APRSIS CMD :WXBOT    :PRAGUE").textLength,6);

// Field-level checks drive the popup's Insert button.
const sota=byId("sota");
assert.strictEqual(Aprs.checkParams(sota,
  {call:"OK1ABC/P",ref:"OK/KR-001",freq:"7.078",mode:"JS8"}).ok,true);
assert.match(Aprs.checkParams(sota,
  {call:"OK1ABC/P",ref:"NONSENSE",freq:"7.078",mode:"JS8"}).errors[0].reason,
  /association\/region/);
assert.match(Aprs.checkParams(byId("smsgte"),{phone:"not-a-number",text:"HI"})
  .errors[0].reason,/leading \+/);
assert.match(Aprs.checkParams(byId("email2"),{email:"nope",text:"HI"})
  .errors[0].reason,/name@domain/);
assert.match(Aprs.checkParams(byId("wxbot"),{city:""}).errors[0].reason,/required/);
// A body that overruns 67 is caught in the popup, before any airtime is spent.
assert.match(Aprs.checkParams(byId("wxbot"),{city:"X".repeat(68)}).errors[0].reason,
  /limit is 67/);

// Optional fields stay optional.
assert.strictEqual(Aprs.checkParams(byId("pota"),
  {call:"OK2XYZ/P",ref:"OK-0022",freq:"14.078",mode:"JS8",comment:""}).ok,true);

// ---- prefill ----------------------------------------------------------------
assert.deepStrictEqual(Aprs.prefill(sota,
  {myCall:"OK1HRA",grid:"JN79NX",dialFrequencyHz:7078000}),
  {call:"OK1HRA/P",ref:"",freq:"7.078",mode:"JS8",comment:""});
assert.deepStrictEqual(Aprs.prefill(Aprs.GRID,{grid:"JN79NX"}),{locator:"JN79NX"});
assert.strictEqual(Aprs.portable("OK1HRA/MM"),"OK1HRA/MM");
assert.strictEqual(Aprs.megahertz(14078000),"14.078");
assert.strictEqual(Aprs.megahertz(0),"");

// ---- transmit path ----------------------------------------------------------
// startTxTo() takes the recipient separately; the group call must come off the
// front and the padding must survive the split.
const draft="@APRSIS CMD :SMSGTE  :@+420123456789 AHOJ";
const transport=Aprs.splitForTx(draft);
assert.deepStrictEqual(transport,
  {toCall:"@APRSIS",text:"CMD :SMSGTE   :@+420123456789 AHOJ"});
assert.strictEqual(Aprs.splitForTx("RR"),null);

const frames=Protocol.buildReplyFrames({myCall:"OK1HRA",toCall:transport.toCall,
  text:transport.text});
assert(frames.length>1);
// @APRSIS is a group call: it packs only because SPECIAL_CALLS carries it.
assert.strictEqual(Protocol.formatDirectedMessage({myCall:"OK1HRA",
  toCall:transport.toCall,text:transport.text}).startsWith("OK1HRA: @APRSIS CMD "),true);

// The frames must decode back to the exact padded payload, checksum included:
// CMD is a checksummed command (Varicode.cpp:134 {24,16}) and the APRS skip
// applies only to MSG / MSG TO:, so the CRC belongs on the wire here.
const dictionary=new Protocol.JscDictionary(fs.readFileSync(
  path.join(__dirname,"../data/js8-jsc.bin")));
const decoded=frames.slice(1).map(frame=>Protocol.decodeFrame({...frame,submode:0,
  offsetHz:1500,slotUtcMs:0},dictionary).text).join("");
assert(decoded.startsWith(":SMSGTE   :@+420123456789 AHOJ"),
  `padding lost on the wire: ${JSON.stringify(decoded)}`);
assert.strictEqual(decoded.trimEnd().slice(-4,-3)," ");
assert.strictEqual(Protocol.checksum16(":SMSGTE   :@+420123456789 AHOJ"),
  decoded.trimEnd().slice(-3));

// Airtime, the number the operator is warned about.
assert.strictEqual(Aprs.airtimeSeconds(8,0),120);
assert.strictEqual(Aprs.airtimeSeconds(8,2),48);
assert.strictEqual(Aprs.airtimeSeconds(0,0),0);

// ---- inbound reply recognition ---------------------------------------------
// AprsInboundRelay.cpp:192 addresses the reply to the group, not to us.
const reply={callsigns:["OK1XYZ","@APRSIS"],
  text:"OK1XYZ: @APRSIS MSG to:OK1HRA SUNNY 25C DE WXBOT"};
assert.strictEqual(Aprs.replyForMe(reply,"OK1HRA"),true);
assert.strictEqual(Aprs.replyForMe(reply,"OK2ABC"),false);
assert.strictEqual(Aprs.replyForMe({callsigns:["OK1XYZ","OK1HRA"],
  text:"OK1XYZ: OK1HRA RR"},"OK1HRA"),false);
assert.strictEqual(Aprs.replyForMe(reply,""),false);

// ---- recent direct callsigns ------------------------------------------------
let recent=[];
recent=Aprs.rememberCall(recent,"ok1abc");
recent=Aprs.rememberCall(recent,"OK2XYZ-9");
recent=Aprs.rememberCall(recent,"OK1ABC");
assert.deepStrictEqual(recent,["OK1ABC","OK2XYZ-9"]);
for (const call of ["A1AA","B2BB","C3CC","D4DD"]) recent=Aprs.rememberCall(recent,call);
assert.strictEqual(recent.length,Aprs.RECENT_MAX);
assert.strictEqual(recent[0],"D4DD");
assert.deepStrictEqual(Aprs.rememberCall(recent,""),recent);

const store=new Map();
const storage={getItem:key=>store.has(key)?store.get(key):null,
  setItem:(key,value)=>store.set(key,value)};
Aprs.saveRecent(storage,recent);
assert.deepStrictEqual(Aprs.loadRecent(storage),recent);
storage.setItem(Aprs.RECENT_KEY,"{not json");
assert.deepStrictEqual(Aprs.loadRecent(storage),[]);

console.log(`JS8 APRS PASS services=${Aprs.SERVICES.length} `+
  `payload=${JSON.stringify(Aprs.compose(byId("wxbot"),{city:"PRAGUE"}))} `+
  `frames=${frames.length} airtime=${Aprs.airtimeSeconds(frames.length,0)}s`);
