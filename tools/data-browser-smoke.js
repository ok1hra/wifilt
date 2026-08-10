#!/usr/bin/env node
"use strict";

// Serves the production DATA assets plus a minimal AUD1 fixture, then checks
// the real page in headless Chrome. No radio or firmware is required.

const crypto=require("crypto"), fs=require("fs"), http=require("http"), path=require("path"), {spawn}=require("child_process");
const root=path.resolve(__dirname,".."), data=path.join(root,"data");
let unattendedPosts=[], inboxWrites=[];
// One message already waiting for K0OG, so the restore path is exercised too.
const inboxSeed=JSON.stringify({id:1,from:"KD8SKZ",to:"K0OG",text:"MEET AT NOON",atMs:0,delivered:false})+"\n";

// Mirror of the firmware's single-operator lock, enough to exercise the page's
// claim/heartbeat/release path and to prove an unowned audio upgrade is refused.
const session={token:"",claims:0,refusals:0,releases:0,wsRefusals:0};
function sessionOwns(token){return Boolean(session.token)&&session.token===token;}
function sessionBody(req,res,handler){let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{let parsed={};try{parsed=JSON.parse(body);}catch(_error){}handler(parsed,res);});}
function sessionReply(res,status){res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:status===200,owner:"192.168.1.99",ageMs:1200,leaseMs:15000}));}
// unaReboot fakes an ESP restart: the arming window is RAM-only, so it is gone
// and millis() starts over. Any arm/extend brings the fixture back, exactly like
// the firmware would; revoke leaves it as it was, so the revoke check below is
// unaffected by this switch.
let unaReboot=false;
function unattendedState(){return{armed:!unaReboot,remainingMs:unaReboot?0:43200000,clientLive:false,clientAgeMs:31000,clientSeen:true,blockedLiveness:2,blockedNotArmed:0,livenessTimeoutMs:5000,ptt:false,txState:0,txUsed:0,txCapacity:12288,rxPackets:5,lan:true,upMs:unaReboot?1200:90500,choicesH:[1,6,12,24,168]};}
let lanStateRequests=0, primaryStateRequests=0, primaryCommands=[];
// The radio's own power level and link, as far as this fixture is concerned.
let radioRfPower=128, radioConnected=true;
// The station identity every page now reads instead of keeping its own.
const identity={call:"OK1HRA",grid:"JO70"};
// The station calibration table, as the firmware stores it: a blob it never
// looks inside.
let txgainDoc='{"v":1,"entries":{}}';
// Decoded exactly as the radio decodes 14 0A: two BCD bytes, 0..255 (02 55).
// The page confirms its writes by reading this back, so getting it wrong here
// would make every power test pass on a number the page itself invented.
function applyCivRaw(parsed) {
  if(!parsed||parsed.type!=="civ.raw")return;
  const data=String(parsed.data||"");
  if(!data.startsWith("140A")||data.length<8)return;
  const hundreds=parseInt(data.slice(4,6),16), rest=parseInt(data.slice(6,8),16);
  radioRfPower=hundreds*100+(rest>>4)*10+(rest&0x0f);
}
let chrome, finished=false, timer, sequence=0, firstSample=0, streamId=707, txPrepares=0, txPackets=0, wsConnections=0, earlyWsConnections=0, jscRequests=0, jscStartedAt=0, jscCompleteAt=0, wsOpenedAt=0, jscComplete=false, js8Gzip=0, js8Brotli=0, commands=[], setupSaveBody="", setupRestartRequests=0, lanReconnectRequests=0, icomScanStarts=0, icomScanPolls=0, icomTestPolls=0, icomTestBody="", wifiTryPolls=0;
const mime={".html":"text/html",".css":"text/css",".js":"application/javascript",".wasm":"application/wasm",".bin":"application/octet-stream"};
function frame(opcode,payload){const body=Buffer.isBuffer(payload)?payload:Buffer.from(payload);return body.length<126?Buffer.concat([Buffer.from([0x80|opcode,body.length]),body]):Buffer.concat([Buffer.from([0x80|opcode,126,body.length>>8,body.length&255]),body]);}
function aud1(){const wire=Buffer.alloc(200,0xff);wire.write("AUD1");wire[4]=1;wire[5]=1;wire.writeUInt16BE(sequence===0?1:0,6);wire.writeUInt16BE(40,8);wire.writeUInt16BE(0,10);wire.writeUInt32BE(streamId,12);wire.writeUInt32BE(sequence++,16);wire.writeUInt32BE(8000,20);wire.writeBigUInt64BE(BigInt(firstSample),24);wire.writeUInt32BE(0,32);wire.writeUInt32BE(160,36);firstSample+=160;return wire;}
function readClientFrames(socket){let input=Buffer.alloc(0);return chunk=>{input=Buffer.concat([input,chunk]);for(;;){if(input.length<2)return;let at=2,length=input[1]&127;if(length===126){if(input.length<4)return;length=input.readUInt16BE(2);at=4;}else if(length===127)return socket.destroy();const masked=Boolean(input[1]&128);if(masked)at+=4;if(input.length<at+length)return;const opcode=input[0]&15,maskAt=at-4,payload=Buffer.from(input.subarray(at,at+length));if(masked)for(let i=0;i<payload.length;i++)payload[i]^=input[maskAt+(i%4)];input=input.subarray(at+length);if(opcode===1){const message=JSON.parse(payload.toString());if(message.type==="tx.prepare"){txPrepares++;socket.write(frame(1,JSON.stringify({type:"tx-ready",txId:message.txId,ptt:false})));}}else if(opcode===2){txPackets++;const txId=payload.readUInt32BE(32),flags=payload.readUInt16BE(6);if(flags&1)socket.write(frame(1,JSON.stringify({type:"tx-state",txId,ptt:true})));if(flags&2)socket.write(frame(1,JSON.stringify({type:"tx-drained",txId,ptt:false})));}}};}
// lanTargetPass: radio polling and tuning must address the LAN radio
// (?radio=lan), which is TRX1 only when the operator put LAN there. Plain
// /state is still expected -- fw-version.js reads the badge from it everywhere.
function finish(ok,text){if(finished)return;finished=true;clearTimeout(timer);if(chrome)chrome.kill("SIGTERM");server.close();const encodingPass=js8Gzip>0&&js8Brotli===0;const frequencyPass=commands.some(command=>command.type==="setFrequency"&&Number(command.frequency)===14078000), setupArgs=new URLSearchParams(setupSaveBody), setupSavePass=setupArgs.get("trx1transport")==="lan"&&setupArgs.get("trx1lanip")==="192.168.1.60"&&setupArgs.get("trx1lanuser")==="operator"&&setupArgs.get("trx1lanpass")==="secret123"&&setupArgs.get("noRestart")==="1"&&setupRestartRequests===1;const unattendedRevokePass=unattendedPosts.some(post=>post.action==="revoke");const unattendedRearmPass=unattendedPosts.some(post=>post.action==="arm"&&post.afterReboot===true);const inboxWritePass=inboxWrites.length>0;let icomTestSlotPass=false;try{icomTestSlotPass=JSON.parse(icomTestBody||'{}').slot===1;}catch(_){}const sessionPass=session.claims>0&&session.wsRefusals===0;const lanTargetPass=lanStateRequests>0&&primaryCommands.length===0;ok=ok&&icomTestSlotPass&&encodingPass&&frequencyPass&&earlyWsConnections===0&&jscRequests===1&&setupSavePass&&lanReconnectRequests===1&&unattendedRevokePass&&unattendedRearmPass&&inboxWritePass&&sessionPass&&lanTargetPass;const report=`${text} lanTarget=${lanTargetPass}(lanState=${lanStateRequests} primaryState=${primaryStateRequests} primaryCmds=${primaryCommands.length}) js8Gzip=${js8Gzip} js8Brotli=${js8Brotli} jscRequests=${jscRequests} jscMs=${jscCompleteAt-jscStartedAt} wsAfterJscMs=${wsOpenedAt-jscCompleteAt} ws=${wsConnections} earlyWs=${earlyWsConnections} icomTestSlot=${icomTestSlotPass} setupSave=${setupSavePass} setupRestarts=${setupRestartRequests} unattendedRevoke=${unattendedRevokePass} unattendedRearm=${unattendedRearmPass} session=${sessionPass}(claims=${session.claims} refusals=${session.refusals} wsRefusals=${session.wsRefusals}) inboxWrites=${inboxWrites.length} reconnects=${lanReconnectRequests} commands=${JSON.stringify(commands)} prepares=${txPrepares} packets=${txPackets}`;(ok?console.log:console.error)(report);if(!ok)process.exitCode=1;}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,"http://fixture");
  if(url.pathname==="/result"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{res.writeHead(204).end();const result=JSON.parse(body);finish(result.pass,result.text);});return;}
  // Icom LAN discovery: the scan reports "running" once, then a single hit, so
  // the page has to survive at least one poll before the list appears.
  if(url.pathname==="/icom/scan"&&req.method==="POST"){icomScanStarts++;icomScanPolls=0;res.statusCode=202;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');return;}
  if(url.pathname==="/icom/scan.json"){icomScanPolls++;const done=icomScanPolls>1;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({state:done?"done":"running",scanned:done?254:120,total:254,subnet:"192.168.1",truncated:false,found:done?[{ip:"192.168.1.60",id:"c0a8013c"}]:[]}));return;}
  if(url.pathname==="/icom/test"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{icomTestBody=body;icomTestPolls=0;res.statusCode=202;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
  if(url.pathname==="/icom/test.json"){icomTestPolls++;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({state:"ok",model:"IC-7610"}));return;}
  // AP handoff: one scanning poll, then the station is up. The page has to walk
  // both phases before it may show an address.
  if(url.pathname==="/setup/wifi-try"&&req.method==="POST"){wifiTryPolls=0;res.statusCode=202;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');return;}
  if(url.pathname==="/setup/wifi-try.json"){wifiTryPolls++;const up=wifiTryPolls>1;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({state:up?"ok":"scanning",ip:up?"192.168.1.55":"",ssid:"fixture-wifi",reason:"",host:"wifilt"}));return;}
  if(url.pathname==="/setup/save"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{setupSaveBody=body;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
  if(url.pathname==="/restart"&&req.method==="POST"){setupRestartRequests++;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');return;}
  if(url.pathname==="/lan/reconnect"&&req.method==="POST"){lanReconnectRequests++;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');return;}
  if(url.pathname==="/msgbox"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{inboxWrites.push(body);res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
  if(url.pathname==="/msgbox"){res.setHeader("Content-Type","text/plain");res.end(inboxSeed);return;}
  if(url.pathname==="/js8/session/claim"&&req.method==="POST"){return sessionBody(req,res,(body)=>{if(session.token&&!sessionOwns(body.token)&&!body.force){session.refusals++;return sessionReply(res,409);}session.token=body.token||"";session.claims++;sessionReply(res,200);});}
  if(url.pathname==="/js8/session/ping"&&req.method==="POST"){return sessionBody(req,res,(body)=>{if(session.token&&!sessionOwns(body.token))return sessionReply(res,409);session.token=body.token||"";sessionReply(res,200);});}
  if(url.pathname==="/js8/session/release"&&req.method==="POST"){return sessionBody(req,res,(body)=>{if(sessionOwns(body.token)){session.token="";session.releases++;}res.writeHead(200,{"Content-Type":"application/json"});res.end('{"ok":true}');});}
  if(url.pathname==="/fixture/unattended-reboot"&&req.method==="POST"){unaReboot=true;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');return;}
  // What the page actually wrote back, so the migration can be asserted on the
  // wire rather than on the mirror it lives in.
  if(url.pathname==="/fixture/msgbox-writes"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({count:inboxWrites.length,last:inboxWrites[inboxWrites.length-1]||""}));return;}
  if(url.pathname==="/unattended"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{try{const post=JSON.parse(body);unattendedPosts.push({...post,afterReboot:unaReboot});if(post.action==="arm"||post.action==="extend")unaReboot=false;}catch(_error){}res.setHeader("Content-Type","application/json");res.end(JSON.stringify(unattendedState()));});return;}
  if(url.pathname==="/unattended"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(unattendedState()));return;}
  if(url.pathname==="/unattended/log"){res.setHeader("Content-Type","text/plain");res.end("1200 ARM 12 h\n90500 BLOCK liveness lost before keying\n");return;}
  // The radio's own state, so the power write can be tested end to end: the page
  // sends 14 0A, the fixture decodes it exactly as the radio would, and the page
  // reads the result back through /state. Poking state.radio from __dataTest
  // instead would bypass the poll -- and the poll is where the page decides
  // whether a level it did not write means somebody turned the knob.
  if(url.pathname==="/setRfPower"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{radioRfPower=Math.max(0,Math.min(255,Number(body)||0));res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
  // The FIRMWARE reporting the radio gone, which is a different thing from
  // /state not answering at all -- only the former counts as a reconnect.
  if(url.pathname==="/setConnected"&&req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{radioConnected=body==="true";res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
  // Lets the browser side assert on what the page actually sent the firmware.
  if(url.pathname==="/commands"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(commands));return;}
  // The JS8 page must ask for the LAN radio by name -- plain /state means TRX1,
  // which is a different radio whenever LAN sits on TRX2/TRX3.
  if(url.pathname==="/txgain.json"){
    if(req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{txgainDoc=body;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
    res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(txgainDoc);return;}
  if(url.pathname==="/state"){if(url.searchParams.get("radio")==="lan")lanStateRequests++;else primaryStateRequests++;/* fw-version.js badge, shared by every page */res.setHeader("Content-Type","application/json");res.end(JSON.stringify({connected:radioConnected,lanStatus:radioConnected?"linked":"disconnected",transceiverType:"ICOM-LAN",power:true,frequency:7078000,mode:"USB",tx:false,rfPower:radioRfPower,rfPowerSeen:true,radioName:"IC-705",fwRev:"20260718",wifiRssi:-51,bdSupported:true}));return;}
  // fixture=trx2 moves LAN to the second slot with one credential still blank:
  // the page must name TRX 2 and read that slot's fields, while staying gated so
  // it never competes with the main frame for the single-operator lease.
  if(url.pathname==="/setup-data.json"){const js8=url.searchParams.get("scope")==="js8call",fixture=url.searchParams.get("fixture"),lanOnTrx2=fixture==="trx2",missing=fixture==="missing"||lanOnTrx2||!js8,lanip=missing?"":"192.168.1.60",lanuser=missing?"":"operator",lanpass=missing?"":"secret123";res.setHeader("Content-Type","application/json");res.end(JSON.stringify({fwRev:20260718,hwRev:4,apModeText:"AP mode ON",mac:"00:11:22:33:44:55",ssid:"fixture-wifi",pswd:"fixture-password",ssid2:"",pswd2:"",trxnetid:"01",lanip,lanuser,lanpass,civaddr:"A4",trx1enabled:true,trx1label:"IC-705",trx1transport:lanOnTrx2?"trxnet":"lan",trx1lanip:lanip,trx1lanuser:lanuser,trx1lanpass:lanpass,trx1civaddr:"A4",trx1netid:"02",trx2enabled:lanOnTrx2,trx2label:"TRX2",trx2transport:lanOnTrx2?"lan":"trxnet",trx2lanip:lanOnTrx2?"192.168.1.61":"",trx2lanuser:lanOnTrx2?"operator":"",trx2lanpass:"",trx2netid:"02",trx2civaddr:"94",trx3enabled:false,trx3label:"TRX3",trx3transport:"trxnet",trx3netid:"03",trx3civaddr:"A2"}));return;}
  // The station's identity, out of the interface's EEPROM. Its own route because
  // /setup-data.json is two kilobytes and three filesystem reads for two strings,
  // and the pages re-read this one on a timer.
  if(url.pathname==="/identity"){
    if(req.method==="POST"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{try{const w=JSON.parse(body);if(w.call!==undefined)identity.call=String(w.call).toUpperCase();if(w.grid!==undefined)identity.grid=String(w.grid).toUpperCase();}catch(_e){}res.setHeader("Content-Type","application/json");res.end(JSON.stringify({ok:true,...identity}));});return;}
    res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(identity));return;}
  if(url.pathname==="/cmd"&&req.method==="POST"){const lanTarget=url.searchParams.get("radio")==="lan";let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{try{const parsed=JSON.parse(body);commands.push(parsed);if(!lanTarget)primaryCommands.push(parsed);applyCivRaw(parsed);}catch(_error){}res.setHeader("Content-Type","application/json");res.end('{"ok":true}');});return;}
  if(url.pathname==="/smoke.html"){
    // Without the charset the inline checks below are decoded as windows-1252,
    // so any literal comparing non-ASCII page text (the "·" separators the UI is
    // full of) silently never matches. data.html declares utf-8 itself.
    res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<!doctype html>
<iframe id="app" src="/data?test=1&audioPort=${server.address().port}" style="width:1100px;height:800px"></iframe>
<iframe id="setup" src="/setup" style="display:none"></iframe>
<iframe id="lanGate" src="/data?test=1&lanFixture=missing" style="display:none"></iframe>
<iframe id="lanSlot" src="/data?test=1&lanFixture=trx2" style="display:none"></iframe>
<script>
addEventListener('error',event=>fetch('/result',{method:'POST',body:JSON.stringify({pass:false,text:'DATA BROWSER SCRIPT ERROR: '+event.message+' at '+event.filename+':'+event.lineno+':'+event.colno})}));
addEventListener('unhandledrejection',event=>fetch('/result',{method:'POST',body:JSON.stringify({pass:false,text:'DATA BROWSER SCRIPT REJECTION: '+String(event.reason?.stack||event.reason)})}));
const f=document.querySelector('#app');
const setupFrame=document.querySelector('#setup');
const lanGateFrame=document.querySelector('#lanGate');
const lanSlotFrame=document.querySelector('#lanSlot');
f.onload=()=>{
  const d=f.contentDocument;
  setTimeout(()=>{
    window.loadingObserved=!!d.querySelector('#startupLoader:not([hidden])')&&d.querySelector('#linkState').textContent.includes('LOADING');
    window.firstVisitHelpObserved=d.querySelector('#trxHelpDialog')?.open===true;
    d.querySelector('#trxHelpDialog .trx-help-close')?.click();
  },250);
  setTimeout(()=>{
    try {
    const now=Date.now();
    // The identity comes from the interface, not from this browser and not from
    // typing it here: the fields are displays now. A second tablet used to boot
    // with an empty callsign and transmit under it.
    const stationIdentityShown=d.querySelector('#myCall').textContent==='OK1HRA'&&d.querySelector('#myGrid').textContent==='JO70';
    const defaultDisclosuresInitially=d.querySelector('details[data-section="spectrum"]').open&&d.querySelector('details[data-section="reply"]').open&&[...d.querySelectorAll('details[data-section="traffic"],details[data-section="stations"],details[data-section="settings"],details[data-section="timing"]')].every(node=>!node.open);
    f.contentWindow.__dataTest.setActivity({frames:[],timing:[],channels:[],messages:[
      {text:'K0OG: OK1HRA OLDER',callsigns:['K0OG','OK1HRA'],kinds:['directed','data'],submode:0,offsetHz:700,firstSlotUtcMs:now-3000,lastSlotUtcMs:now-3000},
      {text:'KN4CRD: GENERAL',callsigns:['KN4CRD'],kinds:['compound','data'],submode:0,offsetHz:750,firstSlotUtcMs:now-2500,lastSlotUtcMs:now-2500},
      {text:'KN4CRD: DL1ABC PRIVATE',callsigns:['KN4CRD','DL1ABC'],kinds:['directed','data'],submode:0,offsetHz:750,firstSlotUtcMs:now-2200,lastSlotUtcMs:now-2200},
      {text:'KN4CRD: @HB EM73',callsigns:['KN4CRD'],kinds:['heartbeat'],submode:0,offsetHz:750,firstSlotUtcMs:now-2000,lastSlotUtcMs:now-2000},
      {text:'KN4CRD: OK1HRA FOR YOU',callsigns:['KN4CRD','OK1HRA'],kinds:['directed','data'],submode:0,offsetHz:750,firstSlotUtcMs:now-1800,lastSlotUtcMs:now-1800},
      {text:'K0OG: OK1HRA NEWEST',callsigns:['K0OG','OK1HRA'],kinds:['directed','data'],submode:0,offsetHz:700,firstSlotUtcMs:now-1000,lastSlotUtcMs:now-1000}
    ],calls:[
      {call:'KN4CRD',snr:-12,offsetHz:750,submode:0,lastSlotUtcMs:now-2000,grid:'EM73'},
      {call:'K0OG',snr:2,offsetHz:700,submode:0,lastSlotUtcMs:now-1000},
      {call:'OK1HRA',snr:-7,offsetHz:900,submode:0,lastSlotUtcMs:now-500,grid:'JO70'}
    ]});
    const originalBandActivity=f.contentWindow.__dataTest.activityCounts();
    f.contentWindow.__dataTest.setRadioFrequency(14078000);
    const otherBandStartsEmpty=f.contentWindow.__dataTest.activityCounts();
    f.contentWindow.__dataTest.setActivity({frames:[],timing:[],channels:[],messages:[
      {text:'DL1ABC: 20M ONLY',callsigns:['DL1ABC'],kinds:['directed','data'],submode:0,offsetHz:800,firstSlotUtcMs:now,lastSlotUtcMs:now}
    ],calls:[
      {call:'DL1ABC',snr:-5,offsetHz:800,submode:0,lastSlotUtcMs:now}
    ]});
    const otherBandActivity=f.contentWindow.__dataTest.activityCounts();
    f.contentWindow.__dataTest.setRadioFrequency(7078000);
    const restoredBandActivity=f.contentWindow.__dataTest.activityCounts();
    f.contentWindow.__dataTest.setRadioFrequency(7079500);
    const withinToleranceActivity=f.contentWindow.__dataTest.activityCounts();
    // The activity list keeps a tolerance around the band it counts for; the dial
    // button deliberately does not. 7.0795 is not the preset the menu offers, and
    // a station 1.5 kHz off the JS8 dial is on a band nobody is listening on, so
    // the button that opens the presets is marked.
    const offDialMarksButton=d.querySelector('#trxFrequency').classList.contains('off-dial');
    f.contentWindow.__dataTest.setRadioFrequency(7078000);
    const onDialClearsButton=!d.querySelector('#trxFrequency').classList.contains('off-dial');
    d.querySelector('#trxFrequency').click();
    const originalPreset=d.querySelector('[data-frequency="14078000"]');
    const editingCall=d.querySelector('#myCall'),editingGrid=d.querySelector('#myGrid'),editingTxGain=d.querySelector('#txGain');
    const defaultTxGain=editingTxGain.value==='0.25';
    // Not fields any more, so there is nothing half-typed to protect -- and no
    // second place for a locator to be validated differently, which is how a typo
    // here used to wipe the square the WSPR beacon transmits.
    const identityIsReadOnly=editingCall.tagName==='OUTPUT'&&editingGrid.tagName==='OUTPUT'
      &&!!d.querySelector('.identity-note a[href="/setup#identitySection"]');
    editingTxGain.focus();editingTxGain.value='0.35';editingTxGain.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));
    f.contentWindow.__dataTest.setRadioConnection(true,'linked');
    f.contentWindow.__dataTest.setAudioLive(false);
    const connectedWithoutAudioIsNotLive=!d.querySelector('#linkState').textContent.includes('RX LIVE');
    setTimeout(async ()=>{
      try {
      const identityStableAcrossRenders=editingCall.textContent==='OK1HRA'&&editingGrid.textContent==='JO70';
      const txGainEditingStable=editingTxGain.value==='0.35';
      editingCall.value='OK1HRA';editingCall.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      editingGrid.value='JO70';editingGrid.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      editingTxGain.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      const savedTxGain=JSON.parse(f.contentWindow.localStorage.getItem('wifilt.data.js8-settings')).modems.js8call.txGain;

      // ---- automatic TX gain: the limiter half of the design -------------
      //
      // This page never calibrates -- its tune carrier is one pre-rendered
      // buffer, so the level cannot move while it plays. What it must do is USE
      // the station's table, keep the level per band and power, and take the
      // level DOWN when the radio reports ALC. All three are checked through the
      // page's own functions rather than by poking the DOM, because the paths
      // that matter (frame gain, guard, persistence) have no DOM at all.
      const T=f.contentWindow.__dataTest;
      T.setRadioPower(128,true,'IC-705');
      T.setRadioFrequency(7078000);
      await T.gainReload();
      const gainUncalibrated=T.gainState();
      // Seed the station table for exactly this radio, band and power.
      const percent=gainUncalibrated.resolved.percent;
      await f.contentWindow.fetch('/txgain.json',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({v:1,entries:{['IC-705|40m|'+percent]:{knee:0.62,gain:0.62,band:'40m',percent,model:'IC-705',at:Date.now()}}})});
      await T.gainReload();
      const gainCalibrated=T.gainState();
      // A band the table says nothing about: the manual level, said out loud.
      T.setRadioFrequency(14078000);
      const gainOtherBand=T.gainState();
      T.setRadioFrequency(7078000);
      T.gainState();
      // The limiter. One reading takes a dB off; the readings that arrive while
      // the meter is still falling must not take another.
      T.alcBegin();
      const guardStart=T.gainState().guard.gain;
      T.alcFeed({consumed:8000,alc:30,alcSeq:1});
      const guardAfterOne=T.gainState().guard.gain;
      T.alcFeed({consumed:9600,alc:30,alcSeq:2});
      T.alcFeed({consumed:11200,alc:20,alcSeq:3});
      const guardAfterDecay=T.gainState().guard.gain;
      // And it reaches the air: the next frame is modulated at the reduced level.
      const frameGainDuring=T.gainState().frame;
      const firstWitness=T.alcEnd();
      // One witness is not evidence: the stored level is untouched.
      await T.gainReload();
      const tableAfterOne=JSON.parse(JSON.stringify(T.gainState().resolved.entry||{}));
      // A second, independent transmission saying the same thing is.
      T.alcBegin();
      T.alcFeed({consumed:8000,alc:30,alcSeq:1});
      T.alcEnd();
      await new Promise(resolve=>setTimeout(resolve,200));
      await T.gainReload();
      const tableAfterTwo=JSON.parse(JSON.stringify(T.gainState().resolved.entry||{}));
      const currentPreset=d.querySelector('[data-frequency="14078000"]');
      const stationObserved={speed:d.querySelector('#stationRows tr[data-call="K0OG"] td:nth-child(5)')?.textContent.trim(),fallbackTitle:d.querySelector('#stationRows tr[data-call="K0OG"] .station-direction span')?.title,gridTitle:d.querySelector('#stationRows tr[data-call="KN4CRD"] .station-direction span')?.title,distance:d.querySelector('#stationRows tr[data-call="K0OG"] .station-distance')?.textContent};
      const overlay=d.querySelector('#waterfallOverlay'),overlayContext=overlay.getContext('2d'),hzX=hz=>Math.round((hz-500)/(2700-500)*overlay.width);
      const heartbeatX=hzX(1000),heartbeatPixels=overlayContext.getImageData(heartbeatX-2,0,5,8).data,outside=overlayContext.getImageData(hzX(700),30,1,1).data;
      const heartbeatEdgePresent=Array.from({length:heartbeatPixels.length/4},(_,i)=>heartbeatPixels[i*4+3]).some(alpha=>alpha>0);
      const cleanSpectrum=Float32Array.from({length:8192},(_,i)=>.035*Math.sin(2*Math.PI*1450*i/8000)+.008*Math.sin(2*Math.PI*730*i/8000));
      f.contentWindow.__dataTest.feedSpectrum(cleanSpectrum);
      const spectrumBeforeTx=f.contentWindow.__dataTest.spectrumState();
      f.contentWindow.__dataTest.setRadioTx(true);
      const txContamination=Float32Array.from({length:8192},(_,i)=>(((i*73)%257)/128-1)*.9);
      const decoderBeforeTx=f.contentWindow.__dataTest.decoderPushes();
      const testAud1=new Uint8Array(200);testAud1.fill(0xff,40);testAud1.set([65,85,68,49,1,1],0);
      const testAud1View=new DataView(testAud1.buffer);testAud1View.setUint16(6,1);testAud1View.setUint16(8,40);
      testAud1View.setUint32(12,1);testAud1View.setUint32(16,0);testAud1View.setUint32(20,8000);
      testAud1View.setBigUint64(24,0n);testAud1View.setUint32(36,160);
      f.contentWindow.__dataTest.feedAudio(txContamination,{aud1Wire:testAud1,streamId:1,
        mediaEpoch:99,anchorUtcMs:Date.now(),arrivalMs:f.contentWindow.performance.now()});
      const decoderDuringTx=f.contentWindow.__dataTest.decoderPushes();
      const spectrumDuringTx=f.contentWindow.__dataTest.spectrumState();
      f.contentWindow.__dataTest.setRadioTx(false);
      f.contentWindow.__dataTest.feedSpectrum(cleanSpectrum);
      const spectrumAfterTx=f.contentWindow.__dataTest.spectrumState();
      f.contentWindow.__dataTest.setRadioConnection(false,'disconnected');
      const reconnectButton=d.querySelector('#trxReconnect');
      const reconnectVisible=!reconnectButton.hidden&&reconnectButton.textContent.trim()==='Reconnect';
      reconnectButton.click();
      const reconnectRequested=reconnectButton.disabled&&reconnectButton.textContent.includes('Connecting');
      // Offline the header already says OFFLINE; a power bar frozen on the last
      // reading would be the one element still claiming to describe the radio.
      const trxPowerHiddenOffline=d.querySelector('#trxPower').hidden===true;
      f.contentWindow.__dataTest.setRadioConnection(true,'linked');
      const checks={
        frequencyScopedActivity:originalBandActivity.messages===6&&originalBandActivity.calls===3&&otherBandStartsEmpty.messages===0&&otherBandStartsEmpty.calls===0&&otherBandActivity.messages===1&&otherBandActivity.calls===1&&restoredBandActivity.messages===6&&restoredBandActivity.calls===3&&withinToleranceActivity.messages===6&&withinToleranceActivity.calls===3,
        offDialFrequencyMarked:offDialMarksButton&&onDialClearsButton,
        stationIdentityShown,
        // This harness browses http://wifilt.test, a named host rather than
        // loopback, so it is NOT a secure context and navigator.wakeLock is
        // undefined here exactly as it is on http://192.168.x.x. That makes the
        // state deterministic: the keeper must fall through to the video, and
        // "video" is what the operator's phone will really get. Anything else
        // means the fallback broke. (tools/wspr-browser-smoke.js browses
        // 127.0.0.1, which IS secure, so it sees the other branch.)
        wakeLockFallback:d.querySelector('#wakeLockDot')?.dataset.wakelockState==='video',
        wakeLockVideoPlaying:(()=>{const video=d.querySelector('video');return Boolean(video)&&!video.paused&&video.muted;})(),
        // The dot's meaning is its colour, and only a real browser can prove the
        // injected rule actually resolves --green from data.css instead of
        // silently falling back or landing transparent. #5ad18a = rgb(90,209,138).
        wakeLockDotIsGreen:(()=>{const dot=d.querySelector('#wakeLockDot');return Boolean(dot)&&f.contentWindow.getComputedStyle(dot).backgroundColor==='rgb(90, 209, 138)';})(),
        wakeLockDotHasNoText:d.querySelector('#wakeLockDot')?.textContent==='',
        identityIsReadOnly,identityStableAcrossRenders,
        defaultTxGain,
        txGainEditingStable,
        txGainSaved:savedTxGain===0.35,
        gainAmberWithoutCalibration:gainUncalibrated.resolved.calibrated===false&&gainUncalibrated.amber&&gainUncalibrated.text.includes('not calibrated'),
        gainUsesTheStationTable:gainCalibrated.resolved.calibrated===true&&Math.abs(gainCalibrated.frame-0.62)<1e-9&&!gainCalibrated.amber,
        gainIsPerBand:gainOtherBand.resolved.calibrated===false&&Math.abs(gainOtherBand.frame-0.35)<1e-9,
        alcLimiterTakesOneDbOff:Math.abs(guardAfterOne-0.62*Math.pow(10,-1/20))<1e-6&&guardStart===0.62,
        alcLimiterIgnoresAFallingMeter:guardAfterDecay===guardAfterOne,
        alcLimiterReachesTheNextFrame:Math.abs(frameGainDuring-guardAfterOne)<1e-9,
        alcOneWitnessDoesNotRewriteTheTable:firstWitness&&firstWitness.witnesses===1&&Math.abs((tableAfterOne.gain||0)-0.62)<1e-9,
        alcTwoWitnessesDo:Math.abs((tableAfterTwo.gain||0)-0.62*Math.pow(10,-1/20))<5e-4&&tableAfterTwo.autoTrimmed===true,
        reconnectVisible,
        reconnectRequested,
        trxPowerHiddenOffline,
        connectedWithoutAudioIsNotLive,
        english:d.body.textContent.includes('TX SESSION'),
        js8:d.querySelector('#modeSelect').value==='js8call',
        modemApi:['AudioSource','Modems','registerModem','Decoder','Encoder'].every(name=>name in f.contentWindow),
        modemOnly:d.querySelectorAll('#modeSelect option').length===1,
        modemRowHidden:getComputedStyle(d.querySelector('.modem-menu')).display==='none',
        noFutureSlot:!d.querySelector('#modemUnavailable'),
        waterfall:!!d.querySelector('#waterfallCanvas'),
        compactWaterfall:d.querySelector('#waterfall').getBoundingClientRect().height<=90,
        heartbeatGuide:overlay.width>1000&&heartbeatEdgePresent,
        heartbeatOutsideClear:outside[3]===0,
        heartbeatRangeLabel:d.querySelector('#waterfall').title.includes('500')&&d.querySelector('#waterfall').title.includes('1000')&&d.querySelector('#waterfall').title.includes('Heartbeat'),
        waterfallTxIsolation:spectrumDuringTx.rows===spectrumBeforeTx.rows&&spectrumDuringTx.agcLow===spectrumBeforeTx.agcLow&&spectrumDuringTx.agcHigh===spectrumBeforeTx.agcHigh&&spectrumAfterTx.rows>spectrumDuringTx.rows&&spectrumAfterTx.agcReady===true&&spectrumAfterTx.agcHigh-spectrumAfterTx.agcLow>=22,
        decoderRxDuringTx:decoderDuringTx===decoderBeforeTx+1,
        presets:d.querySelectorAll('[data-frequency]').length===12,
        presetStable:originalPreset===currentPreset,
        recipientInSession:!!d.querySelector('#composer #recipient'),
        heartbeat:!!d.querySelector('#heartbeatButton'),
        heartbeatUsesTx:d.querySelector('#heartbeatOffset').textContent.trim()===d.querySelector('#txOffset').value+' Hz',
        tune:!!d.querySelector('#tuneButton')&&d.querySelector('#tuneOffset').textContent.trim()===d.querySelector('#txOffset').value+' Hz',
        txSession:[...d.querySelectorAll('details[data-section="reply"] > summary span')].some(node=>node.textContent.trim()==='TX SESSION'),
        defaultDisclosures:defaultDisclosuresInitially,
        ownCallPanelsExpanded:d.querySelector('details[data-section="traffic"]').open&&d.querySelector('details[data-section="stations"]').open,
        ownCallTraffic:[...d.querySelectorAll('#traffic [data-own-call="true"]')].some(node=>node.textContent==='OK1HRA'&&getComputedStyle(node).color==='rgb(255, 107, 107)'),
        ownCallStation:(()=>{const node=d.querySelector('#stationRows tr[data-call="OK1HRA"] [data-own-call="true"]');return node?.textContent==='OK1HRA'&&getComputedStyle(node).color==='rgb(255, 107, 107)';})(),
        // EMAIL and BIN are deliberately absent from the selector; both composers are
        // still shipped and still checked below through the test hook. CHAT alone is
        // nothing to choose from, so the row itself is hidden too.
        txModes:[...d.querySelectorAll('#txSessionMode option')].map(option=>option.value).join(',')==='CHAT'&&d.querySelector('.tx-session-toolbar')?.hidden===true,
        autoSpeed:d.querySelector('#txSpeedResolved')?.textContent.includes('A')===true,
        stationSpeed:(d.querySelector('#stationRows tr[data-call="K0OG"] td:nth-child(5)')?.textContent.trim()||'').startsWith('A')&&(d.querySelector('#stationRows tr[data-call="K0OG"] td:nth-child(5)')?.textContent.trim()||'').endsWith('15 s'),
        stationCountry:(()=>{const own=d.querySelector('#stationRows tr[data-call="OK1HRA"] td.station-country'),us=d.querySelector('#stationRows tr[data-call="K0OG"] td.station-country');return own?.textContent.trim()==='Czech Republic'&&own?.title==='Czech Republic'&&(us?.textContent.trim()||'').length>0&&d.querySelector('[data-station-sort="country"]')?.textContent.trim().startsWith('DXCC')===true;})(),
        stationDirection:Number.isFinite(parseFloat(d.querySelector('#stationRows tr[data-call="K0OG"] .station-distance')?.textContent))&&d.querySelector('#stationRows tr[data-call="K0OG"] .station-direction span')?.title.includes('DXCC estimate')===true&&d.querySelector('#stationRows tr[data-call="KN4CRD"] .station-direction span')?.title.includes('EM73')===true,
        slotMeter:!d.querySelector('#decodeMeter')&&parseFloat(d.querySelector('#slotFill').style.width)>0&&d.querySelector('.waterfall-rhythm').getBoundingClientRect().top>=d.querySelector('#waterfall').getBoundingClientRect().bottom&&getComputedStyle(d.querySelector('#slotFill')).boxShadow==='none',
        recentNewest:d.querySelector('#traffic .message')?.textContent.includes('NEWEST'),
        recentSingleLine:d.querySelector('#traffic .message')?.getBoundingClientRect().height<=36&&!!d.querySelector('#traffic .message-meta')&&!!d.querySelector('#traffic .message-text'),
        recentMessageWhite:getComputedStyle(d.querySelector('#traffic .message-text')).color==='rgb(255, 255, 255)',
        operationalDim:d.querySelectorAll('#traffic .message.operational').length===1,
        noDebugNav:![...d.querySelectorAll('.tabs .tab')].some(link=>link.textContent.trim()==='DEBUG'),
        // The brand mark must never make the bar taller than the text tabs
        // already do -- hence padding:0 on the disclosure. Its fill is
        // currentColor, so it has to land on the same muted colour the tabs use;
        // a hard-coded grey would be one more thing to keep in step per theme.
        brandLogo:(()=>{const box=d.querySelector('.tabs')?.firstElementChild,logo=box?.querySelector('summary svg'),text=d.querySelector('.tabs a[href="/log"]');
          return box?.tagName==='DETAILS'&&!!logo?.querySelector('path')&&
            Math.round(logo.getBoundingClientRect().height)===26&&
            box.getBoundingClientRect().height<=text.getBoundingClientRect().height&&
            getComputedStyle(logo).fill===getComputedStyle(text).color&&
            box.querySelector('a[href^="https://github.com/"]')?.target==='_blank'&&
            box.querySelector('a[href="https://remoteqth.com"]')?.target==='_blank'&&
            box.querySelector('a[href="https://remoteqth.com"]')?.textContent.trim()==='by RemoteQTH.com';})(),
        // The About panel behaves like the timetable one: it hangs under its own
        // trigger and an outside click puts it away. Closed means not rendered at
        // all, which is what <details> buys instead of a hidden overlay.
        brandAboutPanel:(()=>{const box=d.querySelector('.brand-about'),panel=box.querySelector('div');
          // A closed <details> still gives its content a box, so a rect cannot
          // tell open from closed here -- checkVisibility can, because Chrome
          // hides the content slot. It reads cached style though, so every call
          // below follows a rect read that flushes layout first.
          const visible=()=>{panel.getBoundingClientRect();return panel.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true});};
          const closed=!box.open&&!visible();
          box.querySelector('summary').click();
          const opened=box.open&&panel.getBoundingClientRect().top>=box.getBoundingClientRect().bottom&&visible();
          // Clicking the nav, not the body: a stray body click reaches the page's
          // own document handlers and knocked the TX sequence off course.
          d.querySelector('.tabs').click();
          return closed&&opened&&!box.open&&!visible();})(),
        removedPagesAbsentFromNav:!d.querySelector('.bd-nav,.tab-cat-muted,a[href="/bd"],a[href="/"]'),
        messagePresets:d.querySelectorAll('[data-message-preset]').length>=18&&!!d.querySelector('#messagePresetsButton')&&
          ['qsl-query','yes','no','tu','dit-dit','grid-query','info-query','status-query']
            .every(key=>!!d.querySelector('[data-message-preset="'+key+'"]')),
        sendHidden:d.querySelector('#sendButton').hidden===true&&d.querySelector('#sendHint').textContent.trim()==='Enter sends',
        js8Nav:d.querySelector('.tabs a[href="/data"]')?.textContent.trim()==='DATA'&&d.querySelector('.tabs a[href="/data"]')?.title==='JS8Call-ICOM and WSPR over ICOM-LAN',
        // WSPR moved one level down: it is reachable from DATA, not from the
        // primary bar. The sub-nav must sit outside .data-page so the gate and
        // session-busy blanking cannot strand an operator on one sub-page.
        wsprOnlyInSubnav:!d.querySelector('.tabs a[href="/wspr.html"]')&&
          d.querySelector('.subtabs a[href="/wspr.html"]')?.textContent.trim()==='WSPR-Beacon'&&
          d.querySelector('.subtabs a[href="/data"]')?.textContent.trim()==='JS8Call-ICOM'&&
          d.querySelector('.subtabs a[href="/data"]')?.classList.contains('subtab-active')===true&&
          !d.querySelector('.subtabs a[target]')&&
          !d.querySelector('.data-page .subtabs'),
        pageFooter:d.querySelector('.js8-page-footer a[href^="https://github.com/"]')?.textContent.trim()==='GitHub'&&d.querySelector('.js8-page-footer a[href="/THIRD-PARTY-NOTICES.txt"]')?.textContent.trim()==='Licenses',
        idleNoLeaveWarning:(()=>{const event=new f.contentWindow.Event('beforeunload',{cancelable:true});return f.contentWindow.dispatchEvent(event)!==false&&!event.defaultPrevented;})(),
        helpButton:d.querySelector('#trxHelpButton')?.textContent.trim()==='?',
        // Nine steps on a PRESET radio: the eight it always had plus the one that
        // measures the audio level. The count is asserted so a step cannot be
        // silently dropped, and 'WLAN' proves the IC-705's own word for the path
        // reached the guide instead of the generic one.
        helpSteps:d.querySelectorAll('#trxHelpDialog .trx-setup-steps > li').length===9&&d.querySelector('#trxHelpDialog').textContent.includes('DATA MOD')&&d.querySelector('#trxHelpDialog').textContent.includes('WLAN'),
        helpAudioPath:[...d.querySelectorAll('#trxHelpDialog code')].some(node=>{const text=node.textContent;return text.startsWith('MENU')&&text.includes('SET')&&text.includes('Connectors')&&text.includes('MOD Input')&&text.endsWith('WLAN MOD Level');}),
        // The guide used to hand out two starting numbers -- MOD level 25 % and
        // TX audio gain 0.25 -- and leave the operator to trim the second by eye
        // against the ALC needle. Only the MOD level is still a number to type;
        // the audio gain is measured, so the guide has to name the tool that
        // measures it and must NOT print a gain to copy.
        helpAudioLevels:(()=>{const codes=[...d.querySelectorAll('#trxHelpDialog code')].map(node=>node.textContent);return codes.includes('25%')&&codes.includes('WLAN MOD Level')&&codes.includes('Automatic TX gain')&&codes.includes('CAL PLAN')&&!codes.includes('TX audio gain 0.25')&&!codes.includes('50%');})(),
        // The identity moved to SETUP, so the guide must send the operator there
        // rather than describe fields that are read-only outputs on this page.
        helpIdentityPointsAtSetup:(()=>{const text=d.querySelector('#trxHelpDialog').textContent;return text.includes('SETUP → Identity')&&text.includes('read-only')&&!/set\s+My callsign/.test(text);})(),
        // The eyebrow above the title used to say WLAN for every radio, which is
        // the one word the model table exists to get right.
        helpEyebrowFollowsModel:d.querySelector('#trxHelpEyebrow')?.textContent.trim()==='JS8CALL-ICOM OVER WLAN',
        firstVisitHelp:window.firstVisitHelpObserved===true,
        txSafe:d.querySelector('#sendButton').disabled,
        worker:d.querySelector('#modemState').textContent.includes('ready'),
        loading:window.loadingObserved===true,
        directedCommandFrame:(()=>{const frames=f.contentWindow.Js8Protocol.buildReplyFrames({myCall:'OK1HRA',toCall:'K0OG',text:'SNR -12'}),decoded=f.contentWindow.Js8Protocol.decodeFrame({...frames[0],submode:0,offsetHz:1500,slotUtcMs:0});return frames.length===1&&frames[0].raw==='TBx2Q-uJkbaJ'&&frames[0].messageText==='OK1HRA: K0OG SNR -12'&&decoded.command===' SNR'&&decoded.number==='-12';})(),
        heartbeatProtocolFrame:(()=>{const frames=f.contentWindow.Js8Protocol.buildHeartbeatFrames({myCall:'OK1HRA',grid:'JO70AA'}),decoded=f.contentWindow.Js8Protocol.decodeFrame({...frames[0],submode:0,offsetHz:1500,slotUtcMs:0});return frames.length===1&&frames[0].raw==='31-QkpgqOT6W'&&frames[0].messageText==='OK1HRA: @HB JO70'&&decoded.command==='HEARTBEAT'&&decoded.text==='OK1HRA: @HB JO70 ';})()
      };
      // Frequency timetable: activation applies the current filled slot; a due
      // change is held back during TX and lands once it clears; an empty current
      // slot never catches up. ttRuntime is probed synchronously, then reset so
      // no pending frequency or schedule leaks into the checks that follow.
      (function(){
        const T=f.contentWindow.__dataTest, idx=T.ttSlotNow(), other=(idx+1)%48;
        T.setRadioConnection(true); T.setRadioTx(false);
        T.ttReset(); T.ttSet(idx,7078000,'40 m'); T.ttEnable(true);
        checks.timetableActivationApplies=T.ttRuntime().appliedHz===7078000;
        const btn=T.ttButton(); checks.timetableButtonActive=btn.active&&btn.text==='40 m';
        T.ttReset(); T.setRadioTx(true); T.ttSet(idx,14078000,'20 m'); T.ttEnable(true); T.ttTick();
        checks.timetableTxDefers=T.ttRuntime().appliedHz===null;
        T.setRadioTx(false); T.ttTick();
        checks.timetableTxResumes=T.ttRuntime().appliedHz===14078000;
        T.ttReset(); T.setRadioTx(false); T.ttSet(other,7078000,'40 m'); T.ttEnable(true); T.ttTick();
        checks.timetableNoCatchup=T.ttRuntime().appliedHz===null;
        T.ttReset(); T.setRadioTx(false);
      })();
      // Session snapshot round-trip on the real persist/restore path (the ?test
      // build only skips the automatic hooks, not the functions): keep a draft,
      // write to sessionStorage, restore into state and confirm the frequency
      // buckets, messages and draft return with the paused divider rendered.
      d.querySelector('#messageInput').value='DRAFT KEEP';
      const preSnap=f.contentWindow.__dataTest.snapshotBuild();
      checks.snapshotBuildScope=Array.isArray(preSnap.buckets)&&preSnap.buckets.length>=2&&preSnap.draft==='DRAFT KEEP'&&preSnap.buckets.some(bucket=>bucket.messages.length>0);
      f.contentWindow.__dataTest.snapshotWrite();
      const stored=(()=>{try{return JSON.parse(f.contentWindow.sessionStorage.getItem('js8lan.session.v1'));}catch(_error){return null;}})();
      checks.snapshotStored=stored?.version===1&&stored.draft==='DRAFT KEEP'&&stored.buckets.length===preSnap.buckets.length;
      d.querySelector('#messageInput').value='';
      const restoreResult=f.contentWindow.__dataTest.snapshotRestore();
      checks.snapshotRestored=restoreResult===true&&f.contentWindow.__dataTest.activityCounts().messages>0&&d.querySelector('#messageInput').value==='DRAFT KEEP';
      checks.snapshotDivider=d.querySelectorAll('#traffic .restore-divider').length===1;
      f.contentWindow.sessionStorage.removeItem('js8lan.session.v1');
      d.querySelector('#messageInput').value='';
      const sd=setupFrame.contentDocument,radioSection=sd.querySelector('#radioSection'),lanWarning=sd.querySelector('#radioConfigWarning');
      // The card is built by lan-gate.js and worded for both sub-pages, so it
      // says DATA rather than JS8Call and names the transports that still exist.
      const gd=lanGateFrame.contentDocument,lanGate=gd.querySelector('#lanGate');
      checks.lanRequiredGate=gd.body.classList.contains('lan-gate-blocked')&&!!lanGate&&!lanGate.hidden&&!gd.querySelector('.brand')&&getComputedStyle(gd.querySelector('.radio-bar')).display==='none'&&getComputedStyle(gd.querySelector('#js8Interface')).display==='none'&&lanGate.querySelector('h1')?.textContent.trim()==='DATA requires a TRX over ICOM-LAN'&&lanGate.textContent.includes('TRXNET and CI-V carry commands only')&&!lanGate.textContent.includes('Bluetooth')&&lanGate.textContent.includes('Any Icom transceiver')&&!!lanGate.querySelector('a[href="/setup#radioSection"]');
      // The sub-nav is the one thing that must outlive the blanking, otherwise a
      // blocked WSPR page would have no way back to JS8LAN.
      checks.lanGateKeepsSubnav=getComputedStyle(gd.querySelector('.subtabs')).display!=='none'&&
        !!gd.querySelector('.subtabs a[href="/wspr.html"]');
      // The frequency button names the slot that actually carries LAN.
      checks.trxSlotLabelPrimary=d.querySelector('#trxSlotLabel')?.textContent.trim()==='TRX 1';
      const sld=lanSlotFrame.contentDocument;
      checks.trxSlotLabelFollowsLan=sld.querySelector('#trxSlotLabel')?.textContent.trim()==='TRX 2'&&
        sld.querySelector('#lanGateDetail')?.textContent.trim()==='network password is missing';
      checks.lanGateNoLeaveWarning=(()=>{const event=new lanGateFrame.contentWindow.Event('beforeunload',{cancelable:true});return lanGateFrame.contentWindow.dispatchEvent(event)!==false&&!event.defaultPrevented;})();
      checks.setupJs8Nav=sd.querySelector('a[href="/data"]')?.textContent.trim()==='DATA'&&sd.querySelector('a[href="/data"]')?.title==='JS8Call-ICOM and WSPR over ICOM-LAN'&&!sd.querySelector('a[href="/wspr.html"]');
      checks.setupRemovedPagesAbsentFromNav=!sd.querySelector('.bd-nav,.tab-cat-muted,a[href="/bd"],a[href="/"]');
      checks.setupBrandLogo=(()=>{const box=sd.querySelector('.tabs')?.firstElementChild,logo=box?.querySelector('summary svg');
        return box?.tagName==='DETAILS'&&!!logo?.querySelector('path')&&
          getComputedStyle(logo).fill===getComputedStyle(sd.querySelector('.tabs a[href="/log"]')).color&&
          box.querySelector('a[href="https://remoteqth.com"]')?.target==='_blank';})();
      const missingInputs=[...sd.querySelectorAll('[name="trx1lanip"],[name="trx1lanuser"],[name="trx1lanpass"]')];
      const setupMissingObserved=radioSection?.open===true&&lanWarning?.hidden===false&&missingInputs.length===3&&missingInputs.every(input=>input.classList.contains('setup-radio-field-missing')&&input.getAttribute('aria-invalid')==='true');
      const setupValues={trx1lanip:'192.168.1.60',trx1lanuser:'operator',trx1lanpass:'secret123'};
      missingInputs.forEach(input=>{input.value=setupValues[input.name];input.dispatchEvent(new setupFrame.contentWindow.Event('input',{bubbles:true}));});
      checks.setupLanWarning=setupMissingObserved&&lanWarning.hidden===true&&missingInputs.every(input=>!input.classList.contains('setup-radio-field-missing')&&input.getAttribute('aria-invalid')==='false');
      // ---- SETUP: the station's identity ---------------------------------
      //
      // The one place a callsign and a locator can be typed, which is why the
      // checking lives here: three editable copies meant three validations, and
      // the JS8 one had none -- a half-typed locator posted an empty grid, and
      // the firmware stores what it is given.
      const identitySection=sd.querySelector('#identitySection');
      const identityLocator=sd.querySelector('#identityLocator');
      const identityError=sd.querySelector('#identityLocatorError');
      checks.setupIdentityAboveCluster=!!identitySection&&
        (identitySection.compareDocumentPosition(sd.querySelector('#dxcSection'))&
         setupFrame.contentWindow.Node.DOCUMENT_POSITION_FOLLOWING)!==0&&
        !!sd.querySelector('#identitySection [name="dxccall"]')&&
        !!sd.querySelector('#identitySection [name="dxclocator"]')&&
        !sd.querySelector('#dxcSection [name="dxccall"]');
      // Coordinates are a locator nobody converted yet; the field does it on the
      // way out, so the operator sees the square that will be stored.
      identityLocator.value='50.0755, 14.4378';
      identityLocator.dispatchEvent(new setupFrame.contentWindow.Event('change',{bubbles:true}));
      checks.setupLocatorTakesCoordinates=identityLocator.value==='JO70FB'&&identityError.hidden===true;
      // And what it must NOT do: turn something unreadable into an empty field,
      // which is a stored instruction to forget the station's square.
      identityLocator.value='JN6';
      identityLocator.dispatchEvent(new setupFrame.contentWindow.Event('change',{bubbles:true}));
      checks.setupLocatorRefusesGarbage=identityLocator.value==='JN6'&&identityError.hidden===false&&
        identityError.textContent.includes('Maidenhead');
      checks.setupSaveRefusesBadLocator=await setupFrame.contentWindow.setupSaveQuiet()
        .then(()=>false).catch(()=>true);
      identityLocator.value='JO70FD';
      identityLocator.dispatchEvent(new setupFrame.contentWindow.Event('change',{bubbles:true}));
      checks.setupLocatorClears=identityError.hidden===true;

      // ---- SETUP: the station's TX gain calibrations --------------------
      //
      // SETUP shows them and links to where they are measured; it must never
      // key anything itself. Three things worth guarding: the section only
      // exists when a slot actually carries ICOM-LAN (without it there is no
      // audio path to calibrate), the link goes to the page that owns the
      // carrier, and the knee is translated into an instruction about the
      // radio's MOD level rather than shown as a bare number.
      const txGainSection=sd.querySelector('#txGainSection');
      await setupFrame.contentWindow.fetch('/txgain.json',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({v:1,entries:{'IC-705|20m|1':{knee:0.031,gain:0.031,band:'20m',percent:1,model:'IC-705',at:Date.now(),autoTrimmed:true}}})});
      txGainSection.open=true;
      txGainSection.dispatchEvent(new setupFrame.contentWindow.Event('toggle'));
      await new Promise(resolve=>setTimeout(resolve,300));
      const txGainRow=sd.querySelector('#txGainTable .txgain-row');
      // The JS8 page now hosts the identical tool rather than pointing at the
      // page that has it. What matters is that it is the SAME module (one panel,
      // one search, one table) and that it is reachable without leaving the page,
      // because leaving stops the modem and the decoding.
      const calHint=d.querySelector('.cal-hint');
      const flatHint=!calHint?'':calHint.textContent
        .split(String.fromCharCode(10)).join(' ').replace(/ +/g,' ');
      checks.js8HostsTheCalibrationTool=Boolean(d.querySelector('#calField .cal-target'))&&
        Boolean(d.querySelector('#calField #calStart'))&&
        d.querySelector('#calField #calStart').textContent==='START CALIBRATION';
      checks.js8SaysWhatTheMeasurementIsFiledUnder=
        flatHint.includes('set this band and power first');
      // It keys the transmitter, so it must refuse until the page's own gates are
      // clear -- and say which one is not.
      checks.js8CalRefusesUntilItMay=(()=>{
        const target=d.querySelector('#calField .cal-target').textContent;
        const disabled=d.querySelector('#calField #calStart').disabled;
        return disabled===true&&target.length>0;
      })();
      // The batch plan, on the page that is not WSPR. The sequencer itself is
      // exhausted in tools/tx-gain-plan-smoke.js and the whole run in
      // tools/wspr-browser-smoke.js; what is unique HERE is the rule that keeps a
      // heartbeat out of the plan's pauses.
      checks.js8HostsTheCalibrationPlan=Boolean(d.querySelector('#planField [data-plan="run"]'))&&
        Boolean(d.querySelector('#planField [data-plan="grid"]'))&&
        d.querySelector('#planField').textContent.includes('antenna');
      // It draws itself, and the two axes are separately editable. An empty frame with
      // no estimate and no way to add a power is how this was first reported.
      checks.js8PlanDrawsItself=
        d.querySelector('#planField [data-plan="estimate"]').textContent.length>0;
      checks.js8PlanHasBothAxes=
        d.querySelectorAll('#planField .plan-axis').length===2&&
        Boolean(d.querySelector('#planField [data-plan="addpower"]'));
      // A pop-out window in the topbar, in the same shape as the TIMETABLE beside it:
      // discoverable from the bar (not hidden behind a URL fragment as it briefly was)
      // and closed until its button is pressed.
      checks.js8PlanIsATopbarWindow=Boolean(d.querySelector('#planButton'))&&
        d.querySelector('#planField').classList.contains('freq-timetable-panel')&&
        d.querySelector('#planField').hidden===true;
      d.querySelector('#planButton').click();
      await new Promise(resolve=>setTimeout(resolve,150));
      checks.js8PlanButtonOpensIt=d.querySelector('#planField').hidden===false;
      // A column first: on a fixture radio that has never reported a power setting the
      // seeded plan has a row and no columns, so there is no cell to click yet.
      d.querySelector('#planField [data-plan="newpower"]').value='7';
      d.querySelector('#planField [data-plan="addpower"]').click();
      await new Promise(resolve=>setTimeout(resolve,250));
      // The grid is the point of it, and a cell click had no coverage at all -- which
      // is how two methods with the same name (window vs cell) survived in one class.
      const planCell=d.querySelector('#planField [data-cell]');
      const cellBefore=planCell?planCell.className:'';
      if(planCell)planCell.click();
      // The tick is stored before it is drawn -- savePlan() writes the station's file
      // and the grid is rebuilt when that resolves -- so reading the class in the same
      // turn measures the state before the click.
      await new Promise(resolve=>setTimeout(resolve,400));
      const cellAfter=d.querySelector('#planField [data-cell]');
      checks.js8PlanCellTicks=Boolean(planCell)&&Boolean(cellAfter)&&
        cellAfter.className!==cellBefore;
      // A calibration owns the transmitter. Between cells the plan waits minutes for
      // an antenna answer with PTT down and txStatus idle, and without this a
      // heartbeat would key on the plan's band, at the plan's power, into the antenna
      // the operator is being asked about at that very moment.
      // Read through the DOM like everything else on this page: there is no test
      // global here, and adding one for a single assertion would be a second surface
      // to keep true. Turning the automatic answers on and pressing RUN is exactly
      // the operator's path, and the refusal has to name what to switch off -- the
      // plan must never switch it off itself, because a tab that dies mid-run would
      // leave the station silent with nobody told.
      const autoReply=d.querySelector('#autoReply');
      const autoWas=autoReply?autoReply.checked:false;
      if(autoReply&&!autoWas){autoReply.checked=true;
        autoReply.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      d.querySelector('#planField [data-plan="run"]').click();
      await new Promise(resolve=>setTimeout(resolve,400));
      const planError=d.querySelector('#planField [data-plan="error"]').textContent;
      checks.js8PlanRefusesWhileUnattendedIsArmed=/unattended/i.test(planError);
      checks.js8PlanDoesNotDisarmItForYou=Boolean(autoReply)&&autoReply.checked===true;
      if(autoReply&&!autoWas){autoReply.checked=false;
        autoReply.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      checks.setupTxGainVisibleWithLan=!txGainSection.hidden;
      checks.setupTxGainShowsTheTable=!!txGainRow&&txGainRow.textContent.includes('IC-705')&&
        txGainRow.textContent.includes('20m')&&txGainRow.textContent.includes('0.031');
      checks.setupTxGainSaysWhenItWasTrimmed=!!txGainRow&&txGainRow.textContent.toLowerCase().includes('trimmed');
      // 0.031 against the 0.7 target is about 27 dB of surplus MOD level.
      checks.setupTxGainTranslatesTheKnee=!!txGainRow&&/MOD level 2[0-9]\.[0-9] dB too high/.test(txGainRow.textContent);
      // Same tab, always: both DATA pages share one session token, so a new tab
      // asks for a lease the open one already holds and lands on "session busy".
      checks.setupTxGainLinksToTheCarrier=sd.querySelector('.txgain-link')?.getAttribute('href')==='/wspr.html#autogain'&&
        sd.querySelector('.txgain-link')?.hasAttribute('target')===false;
      // Dropping one entry is a read-modify-write, so this also proves the page
      // does not write back a copy it opened before the click.
      sd.querySelector('.txgain-drop').click();
      await new Promise(resolve=>setTimeout(resolve,300));
      checks.setupTxGainCanForgetOne=!sd.querySelector('#txGainTable .txgain-row')&&
        sd.querySelector('#txGainTable').textContent.includes('Nothing measured yet');
      // Icom LAN scan: the firmware finds the radio so the operator does not
      // have to read the address off the radio's own menu. The result list is
      // rebuilt on every poll, so the row click also proves the delegation
      // survives innerHTML replacing the node under the pointer.
      const scanPanel=sd.querySelector('[data-icom-scan-panel="trx1"]');
      const scanHiddenBefore=scanPanel?.hidden===true;
      sd.querySelector('[data-icom-scan="trx1"]').click();
      await new Promise(resolve=>setTimeout(resolve,1300));
      const scanHit=sd.querySelector('[data-icom-scan-panel="trx1"] .icom-scan-hit');
      checks.icomScanLists=scanHiddenBefore&&scanPanel.hidden===false&&!!scanHit&&
        scanHit.getAttribute('data-ip')==='192.168.1.60';
      sd.querySelector('[name="trx1lanip"]').value='';
      scanHit?.click();
      checks.icomScanFillsIp=sd.querySelector('[name="trx1lanip"]').value==='192.168.1.60';
      sd.querySelector('[data-icom-test="trx1"]').click();
      await new Promise(resolve=>setTimeout(resolve,1300));
      // The credential test doubles as model detection: the capabilities packet
      // has already arrived by the time the login completes, and WSPR needs the
      // model to know whether 100 % of the power scale is 10 W or 100 W.
      checks.icomTestVerdict=sd.querySelector('[data-icom-test-result="trx1"]').textContent.includes('IC-7610')&&
        sd.querySelector('[data-icom-model="trx1"]').textContent.includes('IC-7610');
      // AP-mode handoff. The fixture serves this page as a station, so the AP
      // state is injected and the module driven directly; the AP_STA transition
      // and the QR itself can only be judged on hardware. Reset to station at
      // the end -- leaving apMode set would divert the save test into handoff.
      const sw=setupFrame.contentWindow;
      sw.setupDeviceInfo={apMode:true,hostname:'wifilt',lastStaIp:'192.168.1.55'};
      sw.setupWifiHandoff.showLastKnown();
      const lastKnown=sd.querySelector('#wifiLastKnown');
      checks.wifiLastKnownHint=lastKnown.hidden===false&&
        lastKnown.querySelector('a')?.getAttribute('href')==='http://192.168.1.55'&&
        sw.setupWifiHandoff.available()===true;
      sw.setupDeviceInfo={apMode:false,hostname:'wifilt',lastStaIp:'192.168.1.55'};
      sw.setupWifiHandoff.showLastKnown();
      checks.wifiLastKnownStationHidden=lastKnown.hidden===true&&sw.setupWifiHandoff.available()===false;
      // The handover screen itself. Driven into a scratch container because
      // renderSuccess() clears its host -- pointed at the real page that would
      // wipe the form the save test still needs.
      const holder=sd.createElement('div');
      sd.body.appendChild(holder);
      const handoffMsg=sd.createElement('p');
      holder.appendChild(handoffMsg);
      sw.setupWifiHandoff.run(handoffMsg);
      await new Promise(resolve=>setTimeout(resolve,2400));
      const handoffLink=holder.querySelector('.wifi-handoff-url a');
      checks.wifiHandoffAddress=!!handoffLink&&handoffLink.getAttribute('href')==='http://192.168.1.55'&&
        !!holder.querySelector('a[href="http://wifilt.local/"]')&&
        !!holder.querySelector('#wifiHandoffDone');
      // The handover has to END. Left at the address screen with the hotspot
      // still running, the device sits in both modes at once -- station joined,
      // AP up, TrxNet and the radio clients still refusing because APmode says
      // so. Pressing the button restarts and hands the operator a screen that
      // opens the real address by itself once they are back on their network.
      holder.querySelector('#wifiHandoffDone').click();
      await new Promise(resolve=>setTimeout(resolve,200));
      checks.wifiHandoffFinishes=!!holder.querySelector('#wifiHandoffGo')&&
        !!holder.querySelector('a[href="http://wifilt.local/"]')&&
        !!holder.querySelector('a[href="http://192.168.1.55/"]')&&
        /Reconnect to/.test(holder.textContent);
      holder.remove();
      // Unattended panel: armed, but the fixture says the modem tab has been
      // silent for 31 s. A timer alone would still read "armed" -- the point of
      // the panel is that this state is visibly flagged.
      const unaSection=sd.querySelector('#unattendedSection');
      unaSection.open=true;
      unaSection.dispatchEvent(new setupFrame.contentWindow.Event('toggle'));
      await new Promise(resolve=>setTimeout(resolve,400));
      const unaText=sd.querySelector('#unattendedGrid').textContent;
      const unaBad=[...sd.querySelectorAll('#unattendedGrid .unattended-bad')].map(node=>node.textContent);
      checks.unattendedPanel=unaText.includes('12 h')&&unaText.includes('silent for')&&
        unaBad.some(text=>text.includes('silent for'))&&
        sd.querySelector('#unattendedLog').textContent.includes('BLOCK liveness lost')&&
        [...sd.querySelectorAll('#unattendedExtend button')].map(b=>b.textContent).join('|')==='Extend 1 h|Extend 6 h|Extend 12 h|Extend 24 h|Extend 168 h';
      sd.querySelector('#unattendedRevoke').click();
      await new Promise(resolve=>setTimeout(resolve,300));
      // ---- RF power ------------------------------------------------------
      //
      // Percent, not the WSPR dBm grid: JS8 announces no power in the protocol,
      // so nothing pins this page to that grid, and percent is both the radio's
      // display unit and its real resolution. 30 % is level 77 (BCD 00 77), and
      // reading 77 back is 30 % again -- the round trip has to close, or the
      // page would keep rewriting a level it had just written.
      const pw=async ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const commandsSoFar=async()=>(await (await fetch('/commands')).json());
      const wroteRf=async from=>(await commandsSoFar()).slice(from||0)
        .filter(command=>String(command.data||'').startsWith('140A')).map(command=>command.data);
      const rfSafety=d.querySelector('#txSafety'); const rfSafetyWas=rfSafety.checked;
      const rfField=d.querySelector('#rfPercent'), rfSet=d.querySelector('#rfPercentSet');
      // Typing sets a draft the renders must not stomp. Verified rather than
      // assumed: the SETTINGS panel opens collapsed, so focus() on this field is
      // a no-op, and a page that only protected the FOCUSED field would throw
      // the number away between typing it and pressing the button beside it.
      const rfType=value=>{rfField.value=value;
        rfField.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));};
      // Nothing has ever been chosen, so the page must not have touched the
      // radio: a QSO mode has no safe level to invent, unlike the WSPR beacon.
      checks.rfPowerUntouchedUntilChosen=(await wroteRf()).length===0;

      if(!rfSafety.checked){rfSafety.checked=true;rfSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      rfType('30');
      await pw(700);            // several renders, none of which may stomp it
      checks.rfPowerDraftSurvivesRender=rfField.value==='30'&&
        d.querySelector('#rfPercentWatts').textContent==='3.0 W';
      rfSet.click();
      await pw(1500);
      checks.rfPowerSetWrites=(await wroteRf()).includes('140A0077');
      checks.rfPowerStored=f.contentWindow.__dataTest.js8Settings().rfPercent===30;
      checks.rfPowerReadBack=f.contentWindow.__dataTest.radioState().rfPower===77;
      checks.rfPowerWattsShown=d.querySelector('#rfPercentWatts').textContent==='3.0 W';
      checks.rfPowerNoMismatch=!d.querySelector('#rfPowerField').classList.contains('mismatch')&&
        !d.querySelector('#trxPower').classList.contains('mismatch');

      // A hand on the front panel outranks the automation, and the header bar
      // has to carry that: the SETTINGS panel opens collapsed, so an amber row
      // inside it is not a warning anybody sees.
      await fetch('/setRfPower',{method:'POST',body:'200'});
      await pw(1500);
      checks.rfPowerKnobNoticed=d.querySelector('#rfPowerField').classList.contains('mismatch')&&
        d.querySelector('#trxPower').classList.contains('mismatch')&&
        d.querySelector('#rfPercentState').textContent.includes('changed on the radio');
      const rfBeforeKnobReconnect=(await commandsSoFar()).length;
      await fetch('/setConnected',{method:'POST',body:'false'});
      await pw(1200);
      await fetch('/setConnected',{method:'POST',body:'true'});
      await pw(2000);
      checks.rfPowerKnobSurvivesReconnect=(await wroteRf(rfBeforeKnobReconnect)).length===0&&
        f.contentWindow.__dataTest.radioState().rfPower===200;

      // SET is a deliberate act and needs no pledge; the AUTOMATIC write does,
      // because unlike WSPR -- whose automatic value is always the minimum --
      // this one can raise power into whatever is on the antenna socket.
      rfSet.click();
      await pw(1500);
      rfSafety.checked=false;rfSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      const rfBeforePledgeOff=(await commandsSoFar()).length;
      await fetch('/setConnected',{method:'POST',body:'false'});
      await pw(1200);
      await fetch('/setRfPower',{method:'POST',body:'255'});
      await fetch('/setConnected',{method:'POST',body:'true'});
      await pw(2000);
      checks.rfPowerAutoNeedsPledge=(await wroteRf(rfBeforePledgeOff)).length===0&&
        f.contentWindow.__dataTest.radioState().rfPower===255;

      // With the pledge back on, a radio that forgot while it was away is put
      // right. Asserted on the command log rather than on rfPower: the last poll
      // before the link returned still holds the old reading, so a state test
      // could pass without the automation having done anything at all.
      rfSafety.checked=true;rfSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      const rfBeforeForgetful=(await commandsSoFar()).length;
      await pw(2500);
      checks.rfPowerForgetfulRadioFixed=(await wroteRf(rfBeforeForgetful)).includes('140A0077')&&
        f.contentWindow.__dataTest.radioState().rfPower===77;
      if(!rfSafetyWas){rfSafety.checked=false;rfSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}

      // Auto-reply wiring: a decoded directed query must reach the engine and
      // come back as a composed answer. AUTO is off here, so the answer belongs
      // in the message box rather than on the air.
      f.contentWindow.__dataTest.setActivity({messages:[],frames:[],
        calls:[{call:'K0OG',snr:-12,offsetHz:1500,submode:0,dtMs:0,quality:1,lastSlotUtcMs:Date.now()}]});
      const composer=d.querySelector('#messageInput');
      composer.value='';
      f.contentWindow.__dataTest.feedDirected({from:'K0OG',to:'OK1HRA',command:' HW CPY?'});
      const bufferedAnswer=composer.value;
      // "How do you copy me?" is the signal report asked in words, and it is the
      // reply JS8Call offers by default to a CQ -- so on an unattended station it
      // is the first thing that arrives. It is answered with the same report SNR?
      // would get, which is also why the two share one restriction window.
      checks.hwCpyAnswersSnr=bufferedAnswer==='K0OG SNR -12';
      // A second identical query inside the window must be refused, not answered.
      composer.value='';
      f.contentWindow.__dataTest.feedDirected({from:'K0OG',to:'OK1HRA',command:' SNR?'});
      const afterRepeat=composer.value;
      // A query for somebody else must be ignored outright.
      f.contentWindow.__dataTest.feedDirected({from:'K0OG',to:'OK2XYZ',command:' GRID?'});
      const autoState=f.contentWindow.__dataTest.autoReplyState();
      // The immediate repeat is caught by the QSO lock, not the restriction
      // window: two directed frames in a row mean a conversation is running,
      // and the station stays quiet. The window itself is covered by
      // protocol/restrictions_smoke.js, which can control time.
      checks.autoReplyWiring=bufferedAnswer==='K0OG SNR -12'&&afterRepeat===''&&
        autoState.restrictions.granted===1&&autoState.skipped===2&&
        autoState.lockUntilMs>Date.now();
      // TX arbiter: an answer produced while the radio is busy must be queued
      // with an expiry, not refused and not sent late. AUTO on for this part.
      // TX arbiter: with AUTO on, an answer must reach the queue rather than be
      // refused. The QSO lock is cleared first because the checks above armed it
      // and it would otherwise mask the queue entirely.
      d.querySelector('#autoReply').click();
      // Enabling radio TX is a precondition: without it the engine correctly
      // refuses with tx-not-enabled and nothing ever reaches the queue.
      const txSafetyBox=d.querySelector('#txSafety');
      const txSafetyWas=txSafetyBox.checked;
      if(!txSafetyWas){txSafetyBox.checked=true;txSafetyBox.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      f.contentWindow.__dataTest.resetAutoReplyLock();
      f.contentWindow.__dataTest.feedDirected({from:'KD8SKZ',to:'OK1HRA',command:' GRID?'});
      const queued=f.contentWindow.__dataTest.txQueueState();
      // Either it was taken straight away (radio idle) or it is waiting with a
      // finite expiry -- never queued forever.
      checks.txQueue=(queued.sent+queued.size)>=1&&
        queued.items.every(item=>item.source!=='autoreply'||typeof item.inMs==='number');
      // ---- newly added functions ----
      // IMPORTANT: MSG/MSG TO:/relay-text/QUERY MSG are multi-frame checksummed
      // commands. The production ActivityStore does not yet CRC-reassemble them,
      // so those paths are gated off and NOT asserted here as working end-to-end.
      // What is asserted: the single-frame HB-SNR advertisement logic and the
      // inbox reading UI, verified against a directly stored message (the store
      // is what the firmware will populate once reassembly lands).
      const dt=f.contentWindow.__dataTest;

      // HB ACK requires unattended mode + radio TX enabled; turn both on for this
      // check and restore afterwards.
      const hbSafety=d.querySelector('#txSafety'); const hbSafetyWas=hbSafety.checked;
      if(!hbSafetyWas){hbSafety.checked=true;hbSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      const hbAuto=d.querySelector('#autoReply'); const hbAutoWas=hbAuto.checked;
      if(!hbAutoWas){hbAuto.click();}
      const hbEnabled=d.querySelector('#hbEnabled'); const hbEnabledWas=hbEnabled.checked;
      if(!hbEnabledWas){hbEnabled.click();}
      // Seed a stored message the way the firmware will, bypassing the missing
      // RX reassembly, then check the beacon advertises it instead of a plain ACK.
      dt.storeInboxDirect({from:'OK7DEP',to:'OK8HB',text:'STORED FOR YOU'});
      dt.clearTxCaptured();
      dt.feedHeartbeat({from:'OK8HB',to:'@HB',command:'HEARTBEAT',grid:'JO70'});
      const advert=dt.txCaptured().find(item=>item.to==='OK8HB'&&
        item.text.indexOf('HEARTBEAT SNR ')===0&&item.text.indexOf(' MSG ID ')>0);
      checks.heartbeatSnrWiring=Boolean(advert);
      d.querySelector('#abortButton').click();
      await new Promise(resolve=>setTimeout(resolve,120));
      // AUTO is on here, so this is the place to prove the arming window comes
      // back by itself after the ESP restarts. The window is RAM-only firmware
      // state; left alone the AUTO pill reads on with no countdown until the
      // operator switches it off and on again. The fixture drops arming and
      // rewinds uptime, one poll has to notice and re-arm.
      await fetch('/fixture/unattended-reboot',{method:'POST'});
      await dt.unattendedPoll();
      await new Promise(resolve=>setTimeout(resolve,250));
      checks.unattendedRearmAfterRestart=dt.autoExpiry()>Date.now();
      if(!hbEnabledWas){hbEnabled.click();}
      if(!hbAutoWas){hbAuto.click();}
      if(!hbSafetyWas){hbSafety.checked=false;hbSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}

      // Inbox reading UI shows the stored message and the QUERY MSGS control.
      dt.renderInboxNow();
      const inboxRows=[...d.querySelectorAll('#inboxRows tr')];
      checks.inboxUiWiring=inboxRows.some(row=>row.textContent.includes('OK8HB'))&&
        Boolean(d.querySelector('#inboxQueryMsgs'));

      // MSG BOX: unread mail must be findable without reading the table (header
      // badge + tab title), a click is what marks it read, and DELETE must be
      // undoable back to the SAME id -- the id is what NEXT MSG ID quotes on air.
      dt.storeInboxDirect({type:'UNREAD',from:'OK5MAIL',to:'OK1HRA',text:'CALL ME BACK'});
      dt.msgBoxSetFilter('mine');
      const unreadState=dt.msgBoxState();
      const unreadRow=[...d.querySelectorAll('#inboxRows tr[data-msg-id]')]
        .find(row=>row.textContent.includes('OK5MAIL'));
      checks.msgBoxUnreadBadge=unreadState.unread===1&&
        d.querySelector('#inboxSummary').textContent.includes('1 NEW')&&
        unreadState.title.indexOf('(1)')===0;
      unreadRow.querySelector('.inbox-text').click();
      await new Promise(resolve=>setTimeout(resolve,60));
      const readState=dt.msgBoxState();
      checks.msgBoxClickMarksRead=readState.unread===0&&readState.read===1&&
        readState.title.indexOf('(')!==0;
      const readRow=[...d.querySelectorAll('#inboxRows tr[data-msg-id]')]
        .find(row=>row.textContent.includes('OK5MAIL'));
      const readId=Number(readRow.dataset.msgId);
      readRow.querySelector('[data-msg-action="delete"]').click();
      await new Promise(resolve=>setTimeout(resolve,60));
      const deletedState=dt.msgBoxState();
      const undoVisible=!d.querySelector('#msgBoxUndo').hidden;
      d.querySelector('#msgBoxUndoButton').click();
      await new Promise(resolve=>setTimeout(resolve,60));
      const restored=dt.inboxState().items.find(item=>item.id===readId);
      checks.msgBoxDeleteUndo=deletedState.read===0&&undoVisible&&
        Boolean(restored)&&restored.from==='OK5MAIL'&&
        d.querySelector('#msgBoxUndo').hidden===true;
      dt.msgBoxSetFilter('all');

      // CQ interval selector: values offered and the setting applied.
      const cqSel=d.querySelector('#cqRepeat');
      const cqFlag=()=>[...d.querySelectorAll('#settingsFlags .summary-flag')].find(node=>node.textContent.trim()==='CQ');
      cqSel.value='5'; cqSel.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      checks.cqIntervalWiring=[...cqSel.options].map(o=>o.value).join(',')==='0,2,5,10,15'&&
        d.querySelector('#cqState').textContent.includes('5 min');
      // SETTINGS header pills report the switches without being switches: they
      // follow the CQ selector, and none of them is clickable.
      const cqFlagOn=cqFlag()?.classList.contains('on')===true&&cqFlag()?.title.includes('5 min');
      cqSel.value='0'; cqSel.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      // AUTO and HB carry a live countdown inline (hh:mm to deactivation / to the
      // next beacon). AUTO is already armed; turn HB on too (auto stays on) and
      // let one radio poll re-render the flags, because enabling HB re-renders
      // before applyHeartbeatSettings arms the schedule. This block is served in
      // a template literal with no charset, so avoid backslash regex classes and
      // the middle-dot separator: match the leading uppercase key and validate
      // the hh:mm tail character by character. Restore HB afterwards so a stray
      // auto-beacon cannot fire during the manual-TX checks that follow.
      const hbFlag=d.querySelector('#hbEnabled'),hbFlagWas=hbFlag.checked;
      if(!hbFlagWas){hbFlag.click();}
      await new Promise(resolve=>setTimeout(resolve,700));
      const flagNodes=[...d.querySelectorAll('#settingsFlags .summary-flag')];
      const flagKeys=flagNodes.map(node=>(node.textContent.trim().match(/^[A-Z]+/)||[''])[0]).join(',');
      const isDigit=ch=>ch>='0'&&ch<='9';
      const hhMmTail=text=>{const t=(text||'').slice(-5);return t.length===5&&t[2]===':'&&[0,1,3,4].every(i=>isDigit(t[i]));};
      const flagText=key=>flagNodes.find(node=>node.textContent.trim().startsWith(key))?.textContent.trim()||'';
      checks.settingsFlags=flagKeys==='TX,AUTO,CQ,HB,ACK'&&hhMmTail(flagText('AUTO'))&&hhMmTail(flagText('HB'))&&
        cqFlagOn&&cqFlag()?.classList.contains('on')===false&&
        !d.querySelector('#settingsFlags button,#settingsFlags input,#settingsFlags a');
      // Turning Radio TX off must stand down every TX-dependent pill (AUTO/CQ/HB/ACK):
      // none of them can reach the air without it, so a lit pill would promise a
      // function that cannot fire. TX itself reads off; the dependents name the reason
      // in their tooltip. AUTO and HB are on here, so configure CQ on too, then drop TX.
      cqSel.value='5'; cqSel.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      txSafetyBox.checked=false; txSafetyBox.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      const flagOn=key=>[...d.querySelectorAll('#settingsFlags .summary-flag')]
        .find(node=>node.textContent.trim().startsWith(key))?.classList.contains('on');
      const flagTip=key=>[...d.querySelectorAll('#settingsFlags .summary-flag')]
        .find(node=>node.textContent.trim().startsWith(key))?.title||'';
      checks.settingsFlagsTxGate=flagOn('TX')===false&&flagOn('AUTO')===false&&flagOn('CQ')===false&&
        flagOn('HB')===false&&flagOn('ACK')===false&&flagTip('AUTO').includes('needs Radio TX');
      // Restore Radio TX (the manual-TX checks below expect it on) and the CQ selector.
      txSafetyBox.checked=true; txSafetyBox.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      cqSel.value='0'; cqSel.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      if(!hbFlagWas){hbFlag.click();}

      // Multi-frame reassembly: a fully assembled, checksum-verified MSG message
      // must be stored; a checksum-failed one must be dropped. This is the real
      // path (dispatchAssembledMessage), fed a message the way the worker's
      // ActivityStore produces it.
      const inboxSizeBefore=dt.inboxState().size;
      dt.feedAssembled({directed:{from:'OK9MSG',to:'OK1HRA',command:' MSG'},
        payload:'HELLO FROM REASSEMBLY',checksumOk:true});
      const afterStore=dt.inboxState();
      checks.reassemblyStore=afterStore.size===inboxSizeBefore+1&&
        afterStore.items.some(item=>item.text==='HELLO FROM REASSEMBLY'&&item.from==='OK9MSG');
      dt.feedAssembled({directed:{from:'OK9BAD',to:'OK1HRA',command:' MSG'},
        payload:'SHOULD BE DROPPED',checksumOk:false});
      checks.reassemblyChecksum=dt.inboxState().size===afterStore.size;

      // MSG BOX stage E2. An ordinary message somebody typed at us is mail: it
      // has to survive in the box, not only scroll past in the traffic feed.
      const beforePlain=dt.inboxState().size;
      dt.feedAssembled({directed:{from:'OK4TXT',to:'OK1HRA',command:' '},
        payload:'ARE YOU AT THE RADIO',checksumOk:true});
      const afterPlain=dt.inboxState();
      checks.msgBoxFilesPlainText=afterPlain.size===beforePlain+1&&
        afterPlain.items.some(item=>item.type==='UNREAD'&&item.from==='OK4TXT'&&
          item.text==='ARE YOU AT THE RADIO');
      // Machine chatter is not mail; filing SNR reports would bury the one line
      // that matters.
      dt.feedAssembled({directed:{from:'OK4TXT',to:'OK1HRA',command:' SNR'},
        payload:'-12',checksumOk:true});
      checks.msgBoxIgnoresMachineTraffic=dt.inboxState().size===afterPlain.size;

      // An advertisement inside ordinary traffic ("... MSG ID 32") is a pointer
      // to mail held elsewhere. AUTO and Radio TX are on here, so the station
      // must ask for it by itself -- upstream announces this and waits forever.
      dt.clearTxCaptured();
      dt.feedAssembled({directed:{from:'OK6HLD',to:'OK1HRA',command:' HEARTBEAT SNR'},
        payload:'-12 MSG ID 32',checksumOk:true});
      const waiting=dt.msgBoxState().waitingMail;
      const fetchTx=dt.txCaptured().find(item=>item.to==='OK6HLD'&&item.text==='QUERY MSG 32');
      checks.msgBoxAdvertNoted=waiting.some(item=>item.station==='OK6HLD'&&item.id===32);
      checks.msgBoxAutoFetch=Boolean(fetchTx);
      const pickupRow=[...d.querySelectorAll('#inboxRows tr[data-pickup-key]')]
        .find(row=>row.textContent.includes('OK6HLD'));
      checks.msgBoxPickupRow=Boolean(pickupRow)&&
        Boolean(pickupRow.querySelector('[data-msg-action="fetch"]'));
      // The delivery clears the pointer, keeps the text readable and turns the
      // NEXT MSG ID tail into the following pickup instead of leaving it in the
      // operator's mail.
      dt.feedAssembled({directed:{from:'OK6HLD',to:'OK1HRA',command:' MSG'},
        payload:'BRING THE ANTENNA FROM OK7ORIG NEXT MSG ID 33',checksumOk:true});
      const afterDelivery=dt.msgBoxState();
      checks.msgBoxDeliveryUnwrapped=dt.inboxState().items.some(item=>
        item.text==='BRING THE ANTENNA FROM OK7ORIG'&&item.type==='UNREAD')&&
        !afterDelivery.waitingMail.some(item=>item.id===32)&&
        afterDelivery.waitingMail.some(item=>item.station==='OK6HLD'&&item.id===33);
      // Those adverts queued real transmissions (the fetch, the chained fetch and
      // the ACK for the delivery). Leave the arbiter empty, or they key the radio
      // in the middle of the manual-TX checks further down and those time out.
      dt.clearTxQueue();
      d.querySelector('#abortButton').click();
      await new Promise(resolve=>setTimeout(resolve,150));

      // MSG BOX stage E3: a message parked for a station that is not here, and
      // the appearance that releases it. SEND LATER must work with the recipient
      // absent -- that is the whole point -- so it is driven through the button.
      const laterButton=d.querySelector('#sendLaterButton');
      const messageBox=d.querySelector('#messageInput');
      dt.selectCallForLog('OK8LTE');
      messageBox.value='SKED ON 40M AT 1900';
      messageBox.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));
      checks.msgBoxSendLaterEnabled=laterButton.disabled===false;
      laterButton.click();
      await new Promise(resolve=>setTimeout(resolve,60));
      const deferred=dt.msgBoxDeferred();
      checks.msgBoxDeferred=deferred.length===1&&deferred[0].to==='OK8LTE'&&
        deferred[0].state==='waiting'&&messageBox.value==='';
      // A group can never show up, so it can never be parked for one.
      dt.selectCallForLog('@NET');
      messageBox.value='HELLO GROUP';
      messageBox.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));
      checks.msgBoxRefusesGroupDefer=laterButton.disabled===true&&
        laterButton.title.includes('group');
      messageBox.value='';
      messageBox.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));

      // Nothing goes out until that station proves it is listening. A frame from
      // somebody else must not release it.
      dt.clearTxCaptured();
      dt.feedHeartbeat({from:'OK9OTH',to:'@HB',command:'HEARTBEAT',grid:'JO70'});
      checks.msgBoxWaitsForTheRightStation=
        !dt.txCaptured().some(item=>item.text.includes('SKED ON 40M'));
      dt.clearTxQueue(); dt.clearTxCaptured();
      // Its own heartbeat is the invitation.
      dt.feedHeartbeat({from:'OK8LTE',to:'@HB',command:'HEARTBEAT',grid:'JO70'});
      const sent=dt.txCaptured().find(item=>item.to==='OK8LTE'&&
        item.text==='MSG SKED ON 40M AT 1900');
      checks.msgBoxSendsOnAppearance=Boolean(sent);
      checks.msgBoxDeferredCountsAttempt=dt.msgBoxDeferred()[0]?.attempts===1;
      // The ACK is the proof of delivery, and it is what removes the record.
      dt.feedInbox({from:'OK8LTE',to:'OK1HRA',command:' ACK'});
      await new Promise(resolve=>setTimeout(resolve,60));
      checks.msgBoxAckClosesDeferred=dt.msgBoxDeferred().length===0;

      // MSG BOX stage E4. Mail we hold for a third station is pushed the moment
      // that station shows up -- upstream waits to be asked with QUERY MSG, and
      // nobody ever asks, so it would rot in the store.
      dt.clearTxQueue(); dt.clearTxCaptured();
      dt.storeInboxDirect({type:'STORE',from:'OK7DEP',to:'OK5RCV',text:'PARCEL ARRIVED'});
      dt.feedHeartbeat({from:'OK5RCV',to:'@HB',command:'HEARTBEAT',grid:'JO70'});
      const pushed=dt.txCaptured().find(item=>item.to==='OK5RCV'&&
        item.text==='MSG PARCEL ARRIVED FROM OK7DEP');
      checks.msgBoxPushesHeldMail=Boolean(pushed);
      dt.feedInbox({from:'OK5RCV',to:'OK1HRA',command:' ACK'});
      await new Promise(resolve=>setTimeout(resolve,60));
      checks.msgBoxPushAckDelivers=dt.inboxState().items.some(item=>
        item.to==='OK5RCV'&&item.type==='DELIVERED');

      dt.clearTxQueue();
      d.querySelector('#abortButton').click();
      await new Promise(resolve=>setTimeout(resolve,150));

            // The answer really did go out; stop it so the page is idle again for the
      // BIN and TX checks that follow.
      d.querySelector('#abortButton').click();
      await new Promise(resolve=>setTimeout(resolve,150));
      if(!txSafetyWas){txSafetyBox.checked=false;txSafetyBox.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      d.querySelector('#autoReply').click();
      // Heartbeat: an incoming beacon must produce an ACK, and the station's own
      // beacon must be postponed by that traffic rather than firing into it.
      d.querySelector('#hbEnabled').click();
      const hbBefore=f.contentWindow.__dataTest.heartbeatState();
      f.contentWindow.__dataTest.feedHeartbeat({from:'K0OG',to:'@HB',command:'HEARTBEAT',grid:'EM73'});
      const hbAfter=f.contentWindow.__dataTest.heartbeatState();
      // 60 minutes since schema v9: the default moved there and the migration
      // rewrites stored profiles too, because a stored 15 could not be told
      // apart from v8's own default.
      checks.heartbeatWiring=hbBefore.enabled===true&&hbBefore.intervalMs===60*60000&&
        typeof hbBefore.dueInMs==='number'&&
        (hbAfter.acked===1||hbAfter.ackSkipped>=1)&&
        [...d.querySelectorAll('#hbMinutes option')].map(o=>o.value).join(',')==='5,10,15,30,60';
      d.querySelector('#hbEnabled').click();
      // Relay via the assembled path: an armed station must forward a relayed
      // message to the next hop with attribution. Needs unattended mode + TX.
      const rSafety=d.querySelector('#txSafety'); const rSafetyWas=rSafety.checked;
      if(!rSafetyWas){rSafety.checked=true;rSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      const rAuto=d.querySelector('#autoReply'); const rAutoWas=rAuto.checked;
      if(!rAutoWas){rAuto.click();}
      dt.clearTxCaptured();
      dt.feedAssembled({directed:{from:'KN4CRD',to:'OK1HRA',command:'>'},
        payload:'OH8STN>HELLO JULIAN',checksumOk:true});
      const fwd=dt.txCaptured().find(item=>item.to==='OH8STN'&&item.text==='>HELLO JULIAN DE KN4CRD');
      checks.relayForward=Boolean(fwd);
      d.querySelector('#abortButton').click();
      await new Promise(resolve=>setTimeout(resolve,120));
      if(!rAutoWas){rAuto.click();}
      if(!rSafetyWas){rSafety.checked=false;rSafety.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
      // Durable copy: the record seeded by the firmware /msgbox fixture must have
      // been restored on load. (The K0OG entry from the seed; plus OK8HB we stored
      // directly above.) The seed carries no type -- it is a pre-MSG-BOX record,
      // so restoring it also proves the migration: filed for a third station, it
      // must come back as held stock and be written back in the typed shape.
      const inboxNow=f.contentWindow.__dataTest.inboxState();
      const seeded=inboxNow.items.find(item=>item.to==='K0OG');
      checks.inboxLoad=Boolean(seeded);
      const writes=await (await fetch('/fixture/msgbox-writes')).json();
      checks.msgBoxMigration=Boolean(seeded)&&seeded.type==='STORE'&&
        writes.count>0&&writes.last.includes('"type":"STORE"');
      // Groups: the always-joined pair must be present without being stored, a joined
      // group must be answered and get a row of its own in the stations table, and one
      // we never joined must be ignored. A custom group is refused OUT LOUD -- stage 1
      // packs the recipient into a single frame, so it can only carry the built-in
      // names, and accepting @ARESGA here is what used to leave a station believing it
      // was in a group it could never transmit to.
      // The palette lives behind a button now, in SETTINGS and above STATIONS alike.
      d.querySelector('#groupsButton').click();
      const paletteOpen=!d.querySelector('#groupPanel').hidden&&
        d.querySelectorAll('#groupPanel .group-pill').length>40;
      const groupsField=d.querySelector('#groups');
      const addGroup=name=>{groupsField.value=name;
        d.querySelector('#groupAddForm').dispatchEvent(
          new f.contentWindow.Event('submit',{bubbles:true,cancelable:true}));};
      addGroup('@NET');
      // A pill is a toggle: one click joins, the same click leaves.
      const pill=d.querySelector('#groupPanel .group-pill[data-group="@NET"]');
      const pillLit=pill&&pill.getAttribute('aria-pressed')==='true';
      // The field ADDS. A whole-list field cannot carry an autocomplete -- the datalist
      // completes the entire value -- so joining a second group used to throw the first
      // one away, which is the exact question this check now answers.
      d.querySelector('#groupPanel .group-pill[data-group="@EMCOMM"]').click();
      const joined=f.contentWindow.__dataTest.myGroups();
      const bothJoined=joined.includes('@NET')&&joined.includes('@EMCOMM')&&groupsField.value==='';
      const chipNames=[...d.querySelectorAll('#groupPanel .group-pill[aria-pressed="true"]')]
        .map(button=>button.dataset.group).sort().join(" ");
      // Clicking a lit pill leaves exactly that group and keeps the rest.
      d.querySelector('#groupPanel .group-pill[data-group="@EMCOMM"]').click();
      const chipLeave=f.contentWindow.__dataTest.myGroups().includes('@NET')&&
        !f.contentWindow.__dataTest.myGroups().includes('@EMCOMM');
      const groupRow=[...d.querySelectorAll('#stationRows tr')].some(tr=>tr.dataset.call==='@NET');
      f.contentWindow.__dataTest.resetAutoReplyLock();
      const composerG=d.querySelector('#messageInput'); composerG.value='';
      f.contentWindow.__dataTest.feedDirected({from:'OK5GRP',to:'@NET',command:' SNR?'});
      const groupAnswer=composerG.value;
      composerG.value='';
      f.contentWindow.__dataTest.resetAutoReplyLock();
      f.contentWindow.__dataTest.feedDirected({from:'OK6GRP',to:'@NOTMINE',command:' SNR?'});
      const strangerGroup=composerG.value;
      // Since stage 2 a custom name joins like any other and is marked as the two-frame
      // target it is, so the extra air time is visible where the choice is made.
      addGroup('@ARESGA');
      const customPill=d.querySelector('#groupPanel .group-pill[data-group="@ARESGA"]');
      const customAccepted=f.contentWindow.__dataTest.myGroups().includes('@ARESGA')&&
        !!customPill&&!!customPill.querySelector('.group-cost')&&
        !d.querySelector('#groupPanel .group-pill[data-group="@NET"]').querySelector('.group-cost');
      customPill.click();
      // A joined group is selectable; a gateway never is, whatever gets typed.
      f.contentWindow.__dataTest.chooseCall('@NET');
      const groupSelected=d.querySelector('#recipient').value==='@NET';
      f.contentWindow.__dataTest.chooseCall('@APRSIS');
      const gatewayRefused=d.querySelector('#recipient').value==='@NET';
      const groupLogRefused=d.querySelector('#logQsoButton').disabled;
      // Leaving is the palette's job alone; the rows only select. The pill has to be
      // looked up HERE and not earlier -- every render rewrites the grid, so a node
      // grabbed further up is detached by now and clicking it would do nothing while the
      // test went green.
      d.querySelector('#groupPanel .group-pill[data-group="@NET"]').click();
      // Leaving the selected group must also drop it as the recipient, and take its row
      // with it, or the composer would go on pointing at a group we are no longer in.
      const leftGroup=!f.contentWindow.__dataTest.myGroups().includes('@NET')&&
        ![...d.querySelectorAll('#stationRows tr')].some(tr=>tr.dataset.call==='@NET')&&
        d.querySelector('#recipient').value==='';
      // The rows carry no leave button any more: two ways out next to a row whose other
      // click selects the group is a way to leave one by accident.
      const noRowLeaveButton=!d.querySelector('#stationRows [data-leave-group]');
      // renderControls() refuses to rewrite a focused input; in a real browser the next
      // click moves focus by itself, here it would leave the field stale for every later
      // check.
      d.querySelector('#recipient').blur();
      checks.groupsWiring=joined.includes('@ALLCALL')&&joined.includes('@HB')&&
        joined.includes('@NET')&&paletteOpen&&pillLit&&bothJoined&&
        chipNames==='@EMCOMM @NET'&&chipLeave&&
        groupRow&&groupAnswer.startsWith('OK5GRP SNR')&&
        strangerGroup===''&&customAccepted&&groupSelected&&gatewayRefused&&groupLogRefused&&
        leftGroup&&noRowLeaveButton;
      groupsField.value='';
      groupsField.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      checks.autoReplySettings=!!d.querySelector('#infoText')&&!!d.querySelector('#statusText')&&
        d.querySelector('#autoReply').checked===false&&
        [...d.querySelectorAll('#armHours option')].map(o=>o.value).join(',')==='1,6,12,24,168';
      // The reassembly/relay/HB tests can leave an auto-triggered TX in flight
      // (driveEncoder is async, so an immediate abort is a no-op). Settle to idle
      // before the manual TX test, which fails with "TX is busy" otherwise.
      for(let i=0;i<15;i+=1){
        const st=f.contentWindow.__dataTest.txStatus();
        if(['idle','completed','aborted','fault'].includes(st))break;
        d.querySelector('#abortButton').click();
        await new Promise(resolve=>setTimeout(resolve,100));
      }
            sd.querySelector('#setup-form').requestSubmit();
      d.querySelector('#trxHelpButton').click();
      checks.manualHelp=d.querySelector('#trxHelpDialog').open===true&&d.querySelector('#trxHelpModeWarning').hidden===true;
      d.querySelector('#trxHelpDialog .trx-help-close').click();
      checks.usbModeNeutral=!d.querySelector('#trxMode').classList.contains('incompatible');
      f.contentWindow.__dataTest.setRadioMode('CW');
      checks.incompatibleMode=d.querySelector('#trxMode').classList.contains('incompatible')&&d.querySelector('#trxMode').title.includes('USB');
      checks.modeHelp=d.querySelector('#trxHelpDialog').open===true&&d.querySelector('#trxHelpModeWarning').hidden===false;
      d.querySelector('#trxHelpDialog .trx-help-close').click();
      f.contentWindow.__dataTest.setRadioMode('USB');
      // RF power bar: ten segments over the timetable button's height, one per
      // 10 % of the radio's own 0..255 CI-V scale, with the watts beside them
      // derived from the model's full scale exactly as the WSPR page does it.
      const pwrLit=()=>Array.from(d.querySelectorAll('#trxPower .pwr-bar i')).filter(segment=>segment.classList.contains('on')).length;
      const pwrText=()=>d.querySelector('#trxPowerWatts').textContent.trim();
      f.contentWindow.__dataTest.setRadioPower(128,true,'IC-705');
      // 128/255 is 50.2 %, and a part-filled segment lights: six of ten.
      checks.trxPowerBar=pwrLit()===6&&pwrText()==='5.0 W';
      // The bar is specified as the height of the TIMETABLE button beside it, and
      // its ten segments divide whatever that height is. Both are in CSS, in two
      // different rules, so nothing but a measurement keeps them equal.
      const barBox=d.querySelector('#trxPower .pwr-bar').getBoundingClientRect();
      const ttBox=d.querySelector('#freqTimetableButton').getBoundingClientRect();
      checks.trxPowerBarHeight=Math.abs(barBox.height-ttBox.height)<1&&
        d.querySelectorAll('#trxPower .pwr-bar i').length===10;
      // Every pop-out in the radio bar is dismissed the same way. Escape and a
      // second click on the button that opened it both work, but neither is
      // discoverable on a tablet -- CAL PLAN had the button the other two lacked.
      d.querySelector('#trxFrequency').click();
      d.querySelector('#frequencyMenu [data-menu-close]').click();
      checks.dialMenuCloses=d.querySelector('#frequencyMenu').hidden&&
        d.querySelector('#trxFrequency').getAttribute('aria-expanded')==='false';
      d.querySelector('#freqTimetableButton').click();
      d.querySelector('#freqTimetableClose').click();
      checks.timetableCloses=d.querySelector('#freqTimetablePanel').hidden&&
        d.querySelector('#freqTimetableButton').getAttribute('aria-expanded')==='false';
      f.contentWindow.__dataTest.setRadioPower(3,true,'IC-705');
      // A radio left where the WSPR beacon put it is not a dead radio: 1.2 %
      // still lights one segment, and 118 mW must not be shown as "0 W".
      checks.trxPowerMinSegment=pwrLit()===1&&pwrText()==='118 mW';
      f.contentWindow.__dataTest.setRadioPower(128,true,'');
      // Percent belongs to the level alone, so the bar survives a model we
      // cannot convert; only the watts go unknown.
      checks.trxPowerUnknownModel=pwrLit()===6&&pwrText()==='--';
      f.contentWindow.__dataTest.setRadioPower(205,false,'IC-705');
      // 205 is the firmware's fabricated default. Drawing it as a reading would
      // put an invented 8 W in the header of a radio that has never answered.
      checks.trxPowerUnseen=pwrLit()===0&&pwrText()==='--'&&d.querySelector('#trxPower').title.includes('has not reported');
      f.contentWindow.__dataTest.setRadioPower(128,true,'IC-705');
      const change=id=>d.querySelector(id).dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));
      const callSort=d.querySelector('[data-station-sort="call"]');
      callSort.click();
      const sortAscObserved={call:d.querySelector('#stationRows tr')?.dataset.call,direction:callSort.closest('th').getAttribute('aria-sort')};
      checks.sortAsc=sortAscObserved.call==='K0OG'&&sortAscObserved.direction==='ascending';
      callSort.click();
      const sortDescObserved={call:d.querySelector('#stationRows tr')?.dataset.call,direction:callSort.closest('th').getAttribute('aria-sort')};
      checks.sortDesc=sortDescObserved.call==='OK1HRA'&&sortDescObserved.direction==='descending';
      d.querySelector('#stationRows tr[data-call="KN4CRD"]').click();
      checks.stationSelect=d.querySelector('#recipient').value==='KN4CRD'&&f.contentWindow.__dataTest.selectedCall()==='KN4CRD';
      const recipientThread=d.querySelector('#chatThread').textContent;
      checks.recipientTrafficFilter=recipientThread.includes('FOR YOU')&&recipientThread.includes('GENERAL')&&recipientThread.includes('@HB EM73')&&!recipientThread.includes('HEARTBEAT')&&!recipientThread.includes('PRIVATE');
      d.querySelector('#messagePresetsButton').click();
      d.querySelector('[data-message-preset="snr"]').click();
      checks.snrPreset=d.querySelector('#messageInput').value==='SNR -12'&&d.querySelector('#messagePresetsMenu').hidden===true;
      d.querySelector('#messagePresetsButton').click();
      d.querySelector('[data-message-preset="cq"]').click();
      checks.cqPreset=d.querySelector('#messageInput').value==='CQ CQ CQ';
      // HEARING? is the one query that fills in the stations map: the answer names
      // who the other station copies, which is what the green arrows between
      // third-party dots are drawn from. It has to encode as ONE directed frame --
      // a two-frame query costs the same airtime as the answer it asks for.
      d.querySelector('#messagePresetsButton').click();
      d.querySelector('[data-message-preset="hearing-query"]').click();
      checks.hearingPreset=d.querySelector('#messageInput').value==='HEARING?'&&
        (()=>{const frames=f.contentWindow.Js8Protocol.buildReplyFrames(
                {myCall:'OK1HRA',toCall:'KN4CRD',text:'HEARING?'});
              return frames.length===1&&f.contentWindow.Js8Protocol.decodeFrame(
                {...frames[0],submode:0,offsetHz:1500,slotUtcMs:0}).command===' HEARING?';})();
      // INFO without the question mark describes THIS station, so it has nothing to say
      // until SETTINGS carries that description -- and once it does, it must say exactly
      // what the auto-reply would say, or the station describes itself two ways.
      // renderMessagePresets() runs from renderControls(), so writing the field is enough to
      // update the item -- no menu interaction, which would leave the open/closed state
      // different from how the checks below expect to find it.
      const infoPreset=()=>d.querySelector('[data-message-preset="info"]');
      const infoField=d.querySelector('#infoText'),infoWas=infoField.value;
      const setInfo=value=>{infoField.value=value;
        infoField.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));};
      setInfo('');
      const infoRefused=infoPreset().disabled===true;
      setInfo('50W VERT');
      d.querySelector('#messagePresetsButton').click();
      infoPreset().click();
      checks.infoPreset=infoRefused&&infoPreset().disabled===false&&
        d.querySelector('#messageInput').value==='INFO 50W VERT';
      // Hand the composer back exactly as cqPreset left it: the APRS builder below derives
      // its menu from this text.
      setInfo(infoWas);
      d.querySelector('#messagePresetsButton').click();
      d.querySelector('[data-message-preset="cq"]').click();
      // ---- @APRSIS command builder (docs/aprsis-implementace.md) -------------
      // The menu is re-derived from the composer text, so walking it here proves
      // the parser, the catalogue and the DOM agree. KN4CRD is still selected:
      // an APRS command must not disturb the operator's chosen station.
      const setInput=(node,value)=>{node.value=value;node.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));};
      const composerA=d.querySelector('#messageInput'), presetMenu=d.querySelector('#messagePresetsMenu');
      const aprsNodes=()=>[...presetMenu.querySelectorAll('[data-aprs-node]')].map(button=>button.dataset.aprsNode);
      d.querySelector('#messagePresetsButton').click();
      d.querySelector('[data-message-preset="aprsis"]').click();
      // The menu stays open after @APRSIS: the next level is one click away.
      checks.aprsRoot=composerA.value==='@APRSIS '&&presetMenu.hidden===false&&
        JSON.stringify(aprsNodes())===JSON.stringify(['grid','cmd']);
      presetMenu.querySelector('[data-aprs-node="cmd"]').click();
      checks.aprsServices=composerA.value==='@APRSIS CMD '&&
        JSON.stringify(aprsNodes())===JSON.stringify(['smsgte','email2','wlnk1','sota','pota','whois','wxbot','direct']);
      presetMenu.querySelector('[data-aprs-node="wxbot"]').click();
      const aprsDialog=d.querySelector('#aprsParamDialog');
      // An empty required field keeps Insert disabled, so a half-filled popup
      // can never reach the composer.
      checks.aprsPopupGate=aprsDialog.open===true&&d.querySelector('#aprsParamInsert').disabled===true;
      setInput(aprsDialog.querySelector('[data-aprs-param="city"]'),'Prague');
      // No regex here: this whole page is a template literal in the harness, so
      // a backslash class would arrive as a literal "d". Plain substrings also
      // pin the numbers, which are deterministic for this payload.
      const aprsCost=d.querySelector('#aprsParamCost').textContent;
      checks.aprsPopupPreview=d.querySelector('#aprsParamPreview').textContent==='@APRSIS CMD :WXBOT    :PRAGUE'&&
        d.querySelector('#aprsParamInsert').disabled===false&&
        aprsCost.startsWith('6/67 characters · 4 frames · ')&&aprsCost.includes(' at ');
      d.querySelector('#aprsParamForm').requestSubmit();
      // WXBOT is five characters, so the addressee needs exactly four spaces.
      checks.aprsInserted=aprsDialog.open===false&&composerA.value==='@APRSIS CMD :WXBOT    :PRAGUE';
      checks.aprsSendHint=d.querySelector('#sendHint').textContent.startsWith('Enter sends to @APRSIS, not KN4CRD');
      checks.aprsSelectionKept=f.contentWindow.__dataTest.selectedCall()==='KN4CRD'&&d.querySelector('#recipient').value==='KN4CRD';
      presetMenu.querySelector('[data-aprs-crumb="cmd"]').click();
      checks.aprsBreadcrumb=composerA.value==='@APRSIS CMD '&&
        JSON.stringify(aprsNodes()).includes('wxbot');
      // Editing by hand cannot break the invisible padding: normalize() rebuilds
      // it, and a bare callsign is padded the same way the catalogue would.
      setInput(composerA,'@APRSIS CMD :OK1ABC:AHOJ');
      checks.aprsNormalize=f.contentWindow.Js8Aprs.normalize(composerA.value)==='@APRSIS CMD :OK1ABC   :AHOJ'&&
        f.contentWindow.Js8Aprs.splitForTx(composerA.value).toCall==='@APRSIS';
      // Leaving the branch restores the ordinary preset list.
      setInput(composerA,'RR');
      checks.aprsMenuRestored=presetMenu.querySelector('[data-message-preset="cq"]')!==null&&aprsNodes().length===0;
      d.querySelector('#messageInput').value='';d.querySelector('#messageInput').dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));
      d.querySelector('#recipientClear')?.click();
      checks.recipientClear=d.querySelector('#recipient').value===''&&f.contentWindow.__dataTest.selectedCall()==='';
      // With nothing selected, a plain draft is refused for the missing
      // recipient and an APRS command is not -- it carries its own.
      setInput(composerA,'HELLO');
      const plainGate=d.querySelector('#sendButton').title;
      setInput(composerA,'@APRSIS CMD :WXBOT    :PRAGUE');
      const aprsGate=d.querySelector('#sendButton').title;
      checks.aprsNoRecipientNeeded=plainGate.includes('select a recipient')&&!aprsGate.includes('select a recipient');
      setInput(composerA,'@APRSIS CMD');
      const aprsIncompleteGate=d.querySelector('#sendButton').title;
      setInput(composerA,'@APRSIS CMD :WXBOT    :'+'X'.repeat(68));
      const aprsOverLimitGate=d.querySelector('#sendButton').title;
      checks.aprsCompleteness=aprsIncompleteGate.includes('pick an APRS destination')&&
        aprsOverLimitGate.includes('limit is 67')&&d.querySelector('#sendButton').disabled===true;
      setInput(composerA,'');
      // An IGate relays the answer addressed to the group, not to us
      // (AprsInboundRelay.cpp:192), so without replyForMe() our own WXBOT reply
      // would vanish behind the MYCALL filter with nothing to mark it.
      f.contentWindow.__dataTest.pushMessage({callsigns:['OK1XYZ','@APRSIS'],
        text:'OK1XYZ: @APRSIS MSG to:OK1HRA SUNNY 25C DE WXBOT',
        lastSlotUtcMs:Date.now(),submode:0,offsetHz:1500,kinds:['directed','data']});
      d.querySelector('[data-traffic-filter="mycall"]').click();
      const aprsReplyRow=[...d.querySelectorAll('#traffic .message')].find(row=>row.textContent.includes('DE WXBOT'));
      checks.aprsReplyVisible=Boolean(aprsReplyRow)&&Boolean(aprsReplyRow.querySelector('.aprs-badge'));
      d.querySelector('[data-traffic-filter="all"]').click();
      // The Mode selector offers neither EMAIL nor BIN, so both composers are opened
      // the only way that is left. Everything below is unchanged: the modules ship.
      f.contentWindow.__dataTest.setTxSessionMode('EMAIL');
      d.querySelector('#emailGatewayAdd')?.click();
      const setEmailField=(selector,value)=>{const input=d.querySelector(selector);input.value=value;input.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));};
      setEmailField('#emailGatewayName','Fixture APRS');setEmailField('#emailGatewayTarget','@APRSIS');setEmailField('#emailGatewayDial','7078000');setEmailField('#emailGatewayOffset','1500');
      d.querySelector('#emailGatewayFormat').value='aprs-email2';change('#emailGatewayFormat');
      setEmailField('#emailGatewayMaxBody','40');d.querySelector('#emailGatewayPolicy').value='aprs';
      d.querySelector('#emailGatewayForm').requestSubmit();
      setEmailField('#emailAddress','user@example.com');setEmailField('#emailMessage','TEST');
      checks.emailReady=d.querySelector('#emailSession')?.hidden===false&&d.querySelector('#emailPreview').textContent==='@APRSIS CMD :EMAIL-2  :USER@EXAMPLE.COM TEST'&&d.querySelector('#emailSession').textContent.includes('Gateway callsign')&&d.querySelector('#emailSend').disabled;
      f.contentWindow.__dataTest.setTxSessionMode('BIN');
      checks.binReady=d.querySelector('#binSession')?.hidden===false&&!d.querySelector('#binFile').disabled&&!d.querySelector('#binRecipient').disabled&&d.querySelector('#binOffer').disabled&&d.querySelector('#binSession').textContent.includes('Reliable point-to-point');
      d.querySelector('#txSpeed').value='E';change('#txSpeed');
      const slowLimits=d.querySelector('#binFileDetails').textContent;
      d.querySelector('#txSpeed').value='C';change('#txSpeed');
      const js840Limits=d.querySelector('#binFileDetails').textContent;
      d.querySelector('#txSpeed').value='A';change('#txSpeed');
      const normalLimits=d.querySelector('#binFileDetails').textContent;
      checks.binLimits=slowLimits.includes('Hard limit')&&slowLimits.includes('1 KiB')&&js840Limits.includes('Hard limit')&&js840Limits.includes('8 KiB')&&normalLimits.includes('Recommended')&&normalLimits.includes('1 KiB')&&normalLimits.includes('2 KiB');
      checks.binPrepared=false;
      checks.binStorage=false;
      const binInput=d.querySelector('#binFile'),oversizeFixture=new f.contentWindow.File([new Uint8Array(2049)],'too-large.bin',{type:'application/octet-stream'});
      Object.defineProperty(binInput,'files',{configurable:true,value:[oversizeFixture]});change('#binFile');
      checks.binOversizeRejected=f.contentWindow.__dataTest.fileProtocol().prepared===null&&d.querySelector('#binError').textContent.includes('exceeds')&&d.querySelector('#binOffer').disabled;
      const binFixture=new f.contentWindow.File([new Uint8Array([0,1,2,3,4])],'tiny.bin',{type:'application/octet-stream'});
      Object.defineProperty(binInput,'files',{configurable:true,value:[binFixture]});change('#binFile');
      setTimeout(()=>{const prepared=f.contentWindow.__dataTest.fileProtocol().prepared;checks.binPrepared=prepared?.manifest.originalSize===5&&prepared?.manifest.blockCount===1&&prepared?.manifest.sha256Hex.length===64;},500);
      const binStore=new f.contentWindow.Js8FileTransfer.TransferStore();
      binStore.save({id:'SMOKE1',direction:'tx',state:'complete',blocks:[new Uint8Array([1,2,3])]}).then(()=>binStore.get('SMOKE1')).then(saved=>{checks.binStorage=saved?.blocks?.[0]?.[2]===3;return binStore.delete('SMOKE1');}).catch(()=>{});
      f.contentWindow.__dataTest.setTxSessionMode('CHAT');
      currentPreset.click();
      d.querySelector('#recipient').value='K0OG';change('#recipient');
      d.querySelector('#txSpeed').value='I';change('#txSpeed');
      d.querySelector('#txSafety').checked=true;change('#txSafety');
      checks.txEnabled=!d.querySelector('#sendButton').disabled;
      const gate=d.querySelector('#sendButton').title,diag=d.querySelector('#diagnostics').textContent;
      if(!checks.txEnabled){checks.txCompleted=false;return fetch('/result',{method:'POST',body:JSON.stringify({pass:false,text:'DATA BROWSER FAIL '+JSON.stringify(checks)+' sort='+JSON.stringify({sortAscObserved,sortDescObserved})+' gate='+gate+' diag='+diag})});}
      const longTxText='THIS IS A LONG JS8 MESSAGE';
      d.querySelector('#messageInput').value=longTxText;
      const enterEvent=new f.contentWindow.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
      d.querySelector('#messageInput').dispatchEvent(enterEvent);
      checks.enterSends=enterEvent.defaultPrevented&&d.querySelector('#messageInput').value==='';
      const fullLongTxText='OK1HRA: K0OG '+longTxText;
      checks.txQueuedVisual=d.querySelector('.chat-row.outgoing:last-child .tx-copy-pending')?.textContent===fullLongTxText&&d.querySelector('#txPayload')?.textContent.includes(fullLongTxText);
      checks.leaveWarningDuringTx=(()=>{const event=new f.contentWindow.Event('beforeunload',{cancelable:true});return f.contentWindow.dispatchEvent(event)===false&&event.defaultPrevented;})();
      let tries=0,sawPartialTx=false,sawPausedTx=false;
      const poll=setInterval(()=>{
        const summary=d.querySelector('#txSummary').textContent,completed=summary.toLowerCase().includes('completed');
        const outgoing=d.querySelector('.chat-row.outgoing:last-child');
        const sentLength=outgoing?.querySelector('.tx-copy-sent')?.textContent.length||0;
        const hasPending=Boolean(outgoing?.querySelector('.tx-copy-pending'));
        const hasActive=Boolean(outgoing?.querySelector('.tx-copy-active'));
        if(sentLength>0&&hasPending)sawPartialTx=true;
        if(summary.toLowerCase().includes('waiting-slot')&&sentLength>0&&hasPending&&!hasActive)sawPausedTx=true;
        if(completed||++tries>110){
          clearInterval(poll);checks.txCompleted=completed;
          if(!completed){const pass=false;return fetch('/result',{method:'POST',body:JSON.stringify({pass,text:'DATA BROWSER FAIL '+JSON.stringify(checks)+' station='+JSON.stringify(stationObserved)+' sort='+JSON.stringify({sortAscObserved,sortDescObserved})+' gate='+gate+' tx='+summary})});}
          const completedText=d.querySelector('.chat-row.outgoing:last-child .tx-copy-sent');
          checks.txProgressVisual=sawPartialTx;
          checks.txSlotPauseVisual=sawPausedTx;
          checks.txCompletedVisual=completedText?.textContent===fullLongTxText&&!d.querySelector('.chat-row.outgoing:last-child .tx-copy-pending')&&getComputedStyle(completedText).backgroundColor!=='rgba(0, 0, 0, 0)';
          d.querySelector('#messageInput').value='WILL FAIL';
          d.querySelector('#messageInput').dispatchEvent(new f.contentWindow.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          d.querySelector('#abortButton').click();
          checks.txFailedVisual=d.querySelector('.chat-row.outgoing:last-child .tx-copy-failed')?.textContent==='OK1HRA: K0OG WILL FAIL';
          // ---- RESEND and the one automatic retry (docs/js8-tx-resend-plan.md) ----
          // Clicking ABORT is an OPERATOR abort, so the row it just produced must NOT
          // offer a button: a deliberate stop is a decision, not a failure. Every other
          // case needs a real fault, which no click can produce -- hence txFail().
          const test=f.contentWindow.__dataTest;
          const newestRow=()=>{const rows=test.outgoingRows();return rows[rows.length-1];};
          checks.resendNotOnOperatorAbort=newestRow().status==='aborted'&&
            newestRow().resendable===false&&
            test.trafficTxRows().find(node=>node.text.includes('WILL FAIL'))?.resend===false;
          // Inject one failure per class and read the verdict straight off the row. Rows
          // are matched by their text, not by position: several can share a millisecond.
          const failCase=(text,reason,status)=>{
            test.txQueueClear();
            d.querySelector('#messageInput').value=text;
            d.querySelector('#messageInput').dispatchEvent(new f.contentWindow.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
            test.txFail(reason,status);
            const row=newestRow();
            return {row,sent:row.text.includes(text),
              node:test.trafficTxRows().find(node=>node.text.includes(text))||{}};
          };
          // A lost link is the commonest real failure and arrives as "aborted", not
          // "fault". It earns both the button and an armed retry.
          const wsLost=failCase('LINK DROP','websocket lost','aborted');
          checks.resendOnLinkLoss=wsLost.sent&&wsLost.row.status==='aborted'&&wsLost.row.resendable===true&&
            wsLost.node.resend===true&&wsLost.row.attempts===1&&wsLost.row.retryUntilMs>Date.now();
          // The frame almost certainly radiated: red, not struck through, and no machine
          // repeat -- but the operator may still decide to send it again.
          const drained=failCase('DRAIN LOST','drain watchdog','fault');
          checks.resendUnconfirmed=drained.sent&&drained.row.status==='unconfirmed'&&drained.node.emitted===true&&
            drained.node.struck===false&&drained.node.resend===true&&drained.row.retryUntilMs===0;
          // A permanent error repeats identically, so it keeps the button and loses the
          // automatic attempt.
          const permanent=failCase('BAD TONE','invalid TX mode or tone','fault');
          checks.resendPermanentNoRetry=permanent.sent&&permanent.row.status==='fault'&&
            permanent.node.resend===true&&permanent.row.retryUntilMs===0;
          // One row per message, not per attempt: resending must move the existing row on
          // to attempt 2 rather than opening a second one.
          const rowsBefore=test.outgoingRows().length;
          test.resendRow(permanent.row.id);
          const resent=test.outgoingRows().find(row=>row.id===permanent.row.id);
          checks.resendOneRowPerMessage=test.outgoingRows().length===rowsBefore&&resent.attempts===2;
          // The resend really keyed the encoder, so stop it before the next case: a busy
          // TX would refuse the send and the check below would read a stale row.
          d.querySelector('#abortButton').click();
          test.txQueueClear();
          // TX used to mean "went on air", which would have hidden every row that needs
          // the button. It now means "my transmissions".
          d.querySelector('[data-traffic-filter="tx"]').click();
          checks.txFilterShowsFailures=[...d.querySelectorAll('#traffic .message-tx')]
            .some(node=>node.dataset.txStatus==='fault'||node.dataset.txStatus==='aborted');
          d.querySelector('[data-traffic-filter="all"]').click();
          // A machine never carries a message to another band. Arm a retry, retune, and
          // the release must drop it instead of keying on the wrong frequency.
          const strayed=failCase('WRONG BAND','websocket lost','aborted');
          test.setItemFrequency(strayed.row.id,7074000);
          test.drainNow();
          const strayedAfter=test.outgoingRows().find(row=>row.id===strayed.row.id);
          checks.resendBandGuard=strayed.sent&&strayedAfter.status==='expired'&&strayedAfter.attempts===1;
          test.txQueueClear();
          // @APRSIS carries its own recipient: the frame must be addressed to the
          // group, appear in the traffic feed, and leave K0OG's thread alone --
          // otherwise the spot would claim a LOG QSO button and an SNR history.
          const threadRowsBefore=d.querySelectorAll('.chat-row.outgoing').length;
          d.querySelector('#messageInput').value='@APRSIS CMD :OK1ABC:AHOJ';
          d.querySelector('#messageInput').dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));
          d.querySelector('#messageInput').dispatchEvent(new f.contentWindow.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          checks.aprsTxPayload=d.querySelector('#txPayload')?.textContent.includes('OK1HRA: @APRSIS CMD :OK1ABC   :AHOJ');
          checks.aprsTxFeedLabel=d.querySelector('#traffic .message-tx strong')?.textContent==='@APRSIS';
          checks.aprsTxNotInThread=d.querySelectorAll('.chat-row.outgoing').length===threadRowsBefore&&
            f.contentWindow.__dataTest.selectedCall()==='K0OG';
          d.querySelector('#abortButton').click();
          d.querySelector('#heartbeatButton').click();
          checks.heartbeatQueued=!d.querySelector('#txSummary').textContent.toLowerCase().includes('completed');
          checks.heartbeatPayload=d.querySelector('#txPayload')?.textContent.includes('OK1HRA: @HB JO70')&&!d.querySelector('#txPayload')?.textContent.includes('HEARTBEAT');
          let hbTries=0;
          const hbPoll=setInterval(()=>{
            const hbSummary=d.querySelector('#txSummary').textContent,hbCompleted=hbSummary.toLowerCase().includes('completed');
            if(hbCompleted||++hbTries>50){
              clearInterval(hbPoll);checks.heartbeatTx=hbCompleted;
              d.querySelector('#tuneButton').click();
              checks.tuneQueued=d.querySelector('#tuneLabel').textContent==='STOP';
              let tuneTries=0;
              const tunePoll=setInterval(()=>{
                const tuneSummary=d.querySelector('#txSummary').textContent,tuneTransmitting=tuneSummary.toLowerCase().includes('transmitting');
                if(tuneTransmitting||++tuneTries>30){
                  clearInterval(tunePoll);checks.tuneTransmitting=tuneTransmitting;
                  checks.viewportTx=d.body.classList.contains('radio-transmitting')&&getComputedStyle(d.body,'::after').borderTopWidth==='3px';
                  d.querySelector('#tuneButton').click();
                  checks.tuneStopped=d.querySelector('#txSummary').textContent.toLowerCase().includes('aborted')&&d.querySelector('#tuneLabel').textContent==='TUNE';
                  checks.viewportTxCleared=!d.body.classList.contains('radio-transmitting');
                  // Hearing links: third-party propagation between two remote dots. A fresh
                  // frequency gives an empty activity bucket, so the fixture below is the
                  // only thing on the map and the geometry stays predictable.
                  f.contentWindow.__dataTest.setRadioFrequency(10136000);
                  const mapSection=d.querySelector('details[data-section="stations-map"]');mapSection.open=true;
                  const hearNow=Date.now();
                  const hearMsg=(from,to,command,payload,atMs)=>({directed:{from,to,command},payload,text:from+': '+to+command+' '+payload,callsigns:[from,to],kinds:['directed'],submode:0,offsetHz:900,firstSlotUtcMs:atMs,lastSlotUtcMs:atMs});
                  const hearLinks=()=>[...d.querySelectorAll('#stationMap .map-hearing')];
                  const hearTitles=()=>hearLinks().map(node=>node.querySelector('title').textContent).join('|');
                  const hearDot=call=>[...d.querySelectorAll('#stationMap .map-dot')].find(node=>node.textContent.trim().startsWith(call));
                  f.contentWindow.__dataTest.setActivity({frames:[],timing:[],channels:[],messages:[
                    hearMsg('SN9GK','MM0VIK',' HEARTBEAT SNR','-13',hearNow-60000),
                    hearMsg('SN9GK','DL1ABC',' ACK','',hearNow-5400000),
                    hearMsg('SN9GK','G0XYZ',' SNR?','',hearNow-30000)
                  ],calls:[
                    {call:'SN9GK',snr:-7,offsetHz:900,submode:0,lastSlotUtcMs:hearNow-60000,grid:'JO90',heardDirectly:true},
                    {call:'MM0VIK',snr:null,offsetHz:null,submode:null,lastSlotUtcMs:hearNow-60000,grid:'IO75',heardDirectly:false},
                    {call:'DL1ABC',snr:-9,offsetHz:910,submode:0,lastSlotUtcMs:hearNow-5400000,grid:'JN58',heardDirectly:true},
                    {call:'G0XYZ',snr:-11,offsetHz:920,submode:0,lastSlotUtcMs:hearNow-30000,grid:'IO91',heardDirectly:true}
                  ]});
                  const oneWay=hearLinks(),oneWayLine=oneWay[0]?.querySelector('.map-hearing-line');
                  checks.hearingLinkOne=oneWay.length===1&&hearTitles().includes('MM0VIK \\u2192 SN9GK \\u00b7 -13 dB')&&
                    oneWayLine.getAttribute('marker-end')==='url(#mapHearingArrow)'&&!oneWayLine.hasAttribute('marker-start')&&
                    d.querySelector('#stationMapSummary').textContent.includes('1 link');
                  // An hour-old ACK and a fresh question are both silent: propagation expires,
                  // and calling a station blind proves nothing about hearing it.
                  checks.hearingLinkStale=!hearTitles().includes('DL1ABC');
                  checks.hearingLinkQueryIgnored=!hearTitles().includes('G0XYZ');
                  checks.hearingPhantomHollow=Boolean(hearDot('MM0VIK'))&&hearDot('MM0VIK').classList.contains('phantom')&&
                    Boolean(hearDot('SN9GK'))&&!hearDot('SN9GK').classList.contains('phantom')&&
                    d.querySelector('#stationRows tr[data-call="MM0VIK"] td:nth-child(3)')?.textContent==='\\u2014'&&
                    d.querySelector('#stationRows tr[data-call="SN9GK"] td:nth-child(3)')?.textContent==='-7';
                  // The same pair reported the other way stays one line, now with a head at
                  // each end -- two arrows on identical geometry would only fight each other.
                  f.contentWindow.__dataTest.setActivity({frames:[],timing:[],channels:[],
                    messages:[hearMsg('MM0VIK','SN9GK',' SNR','-09',hearNow-30000)],
                    calls:[{call:'MM0VIK',snr:-15,offsetHz:905,submode:0,lastSlotUtcMs:hearNow-30000,grid:'IO75',heardDirectly:true}]});
                  const bothWays=hearLinks(),bothWaysLine=bothWays[0]?.querySelector('.map-hearing-line');
                  checks.hearingLinkBidir=bothWays.length===1&&bothWaysLine.hasAttribute('marker-start')&&
                    bothWaysLine.getAttribute('marker-end')==='url(#mapHearingArrow)'&&
                    bothWays[0].querySelector('title').textContent.split('\\n').length===2;
                  d.querySelector('#stationMapLinks').click();
                  checks.hearingToggleOff=hearLinks().length===0&&d.querySelectorAll('#stationMap .map-dot').length>0&&
                    d.querySelector('#stationMapLinks').getAttribute('aria-pressed')==='false'&&
                    f.contentWindow.__dataTest.snapshotBuild().hearingLinksVisible===false;
                  d.querySelector('#stationMapLinks').click();
                  checks.hearingToggleBack=hearLinks().length===1&&d.querySelector('#stationMapLinks').getAttribute('aria-pressed')==='true';
                  // LOG distance scale. The map is a radar plot, so a neighbour and a DX
                  // station on the same picture put the neighbour under the operator's own
                  // dot. The defining property of the fix is that the NEAR dot moves
                  // outward while the far one stays on the rim -- asserted by measuring,
                  // not by trusting the formula.
                  {
                    const logNow=Date.now();
                    f.contentWindow.__dataTest.setActivity({frames:[],timing:[],channels:[],messages:[],calls:[
                      // A couple of hundred km out, on a bearing the other fixtures do not
                      // use, and NOT the operator's own square: zero distance maps to the
                      // centre in both scales, so it would prove nothing.
                      {call:'OK2NEAR',snr:-3,offsetHz:930,submode:0,lastSlotUtcMs:logNow-1000,grid:'JN70',heardDirectly:true},
                      {call:'VK3DX',snr:-19,offsetHz:940,submode:0,lastSlotUtcMs:logNow-1000,grid:'QF22',heardDirectly:true}
                    ]});
                    // setActivity MERGES into the store, so the map still carries the
                    // stations the hearing-links block put there -- match on "contains".
                    // Whether the dot had to be shared is not noise here: being swallowed
                    // into a cluster on top of the operator IS the symptom this feature
                    // cures, so the test asserts on it in both directions.
                    // (No backticks in this file: every line of it lives inside a template
                    // literal, and one would end the string mid-scenario.)
                    const dotOf=call=>{
                      const g=[...d.querySelectorAll('#stationMap .map-dot')]
                        .find(node=>(node.querySelector('title')?.textContent||'').includes(call));
                      if(!g)return null;
                      const c=g.querySelector('circle');
                      return {merged:Boolean(g.querySelector('.map-badge')),
                        r:Math.hypot(Number(c.getAttribute('cx'))-150,Number(c.getAttribute('cy'))-150)};
                    };
                    const linNear=dotOf('OK2NEAR'), linFar=dotOf('VK3DX');
                    const logButton=d.querySelector('#stationMapLog');
                    logButton.click();
                    const logNear=dotOf('OK2NEAR'), logFar=dotOf('VK3DX');
                    // Linear: 110 km against a 16 000 km rim is under one pixel, so the
                    // neighbour is swallowed into a knot of dots on top of the operator.
                    // LOG: it comes out as its own dot, half way to the rim -- while the DX
                    // station stays exactly where it was, because the rim is still the rim.
                    checks.mapLogSpreadsNearStations=Boolean(linNear&&logNear&&linFar&&logFar)&&
                      linNear.r<10&&linNear.merged&&
                      !logNear.merged&&logNear.r>40&&
                      Math.abs(logFar.r-linFar.r)<1&&
                      logButton.getAttribute('aria-pressed')==='true'&&
                      f.contentWindow.__dataTest.snapshotBuild().mapLogScale===true;
                    // A log plot whose rings still sat at a third and two thirds of the
                    // radius would be a picture with no scale, so the rings become decades
                    // and say so.
                    const ringLabels=[...d.querySelectorAll('#stationMap .map-ring-label')].map(n=>n.textContent);
                    checks.mapLogLabelsItsRings=ringLabels.length>0&&ringLabels.includes('1k')&&
                      d.querySelector('#stationMap .map-scale').textContent.startsWith('LOG');
                    logButton.click();
                    checks.mapLogTogglesBack=Math.abs(dotOf('OK2NEAR').r-linNear.r)<0.5&&
                      d.querySelectorAll('#stationMap .map-ring-label').length===0&&
                      logButton.getAttribute('aria-pressed')==='false';
                  }
                  // Recent traffic: the signal report in the row, the multi-step HIDE,
                  // REPLY on a CQ, and the two row states (already worked / addressed
                  // to me). One activity set drives all of them.
                  {
                    const feedNow=Date.now();
                    const traffic=d.querySelector('#traffic');
                    const cqRow=(from,atMs,snr)=>({callsigns:[from],kinds:['cq'],submode:0,offsetHz:1200,
                      snr,firstSlotUtcMs:atMs,lastSlotUtcMs:atMs,text:from+': @ALLCALL CQ JO60 '});
                    f.contentWindow.__dataTest.setActivity({frames:[],timing:[],channels:[],calls:[],messages:[
                      cqRow('S51FRESH',feedNow-20000,-12),
                      cqRow('S52STALE',feedNow-600000,-8),
                      // A directed frame addressed to us: the one row the operator must act on.
                      {directed:{from:'DL9ME',to:'OK1HRA',command:' SNR'},kinds:['directed'],submode:0,
                       offsetHz:1300,snr:-5,firstSlotUtcMs:feedNow-15000,lastSlotUtcMs:feedNow-15000,
                       text:'DL9ME: OK1HRA SNR -05 ',callsigns:['DL9ME','OK1HRA']}
                    ]});
                    const rowFor=call=>[...traffic.querySelectorAll('article.message')]
                      .find(node=>node.querySelector('strong')?.textContent===call);
                    // The report is stated as a number, not only as the stripe's opacity.
                    checks.feedShowsSnr=rowFor('S51FRESH')?.querySelector('.meta-snr')?.textContent==='-12 dB';
                    const freshReply=rowFor('S51FRESH')?.querySelector('.cq-reply');
                    const staleReply=rowFor('S52STALE')?.querySelector('.cq-reply');
                    // A CQ is recognised from the decoder's frame kind, and the answer is
                    // the report this very row was decoded at.
                    checks.cqReplyOffered=Boolean(freshReply)&&!freshReply.disabled&&
                      freshReply.dataset.replyText==='SNR -12'&&freshReply.dataset.replyCall==='S51FRESH';
                    // Ten minutes old: refused, but still drawn and still saying why. A
                    // button that vanishes on some rows reads as a rendering fault.
                    checks.cqReplyRefusesStale=Boolean(staleReply)&&staleReply.disabled&&
                      /10 min old/.test(staleReply.title);
                    // Addressed to us: its own row state and badge, and nothing transmitted.
                    const mineRow=rowFor('DL9ME');
                    checks.feedMarksCallsToMe=Boolean(mineRow)&&mineRow.classList.contains('message-for-me')&&
                      mineRow.querySelector('.forme-badge')?.textContent==='TO YOU';
                    // Being merely mentioned is not being addressed: a CQ row must not
                    // borrow the state that means "somebody is talking to you".
                    checks.feedDoesNotMarkPlainTraffic=!rowFor('S51FRESH')?.classList.contains('message-for-me');
                    // HIDE walks one column per press and wraps back to everything.
                    const hideButton=d.querySelector('[data-traffic-hide]');
                    const shown=cls=>{const node=rowFor('S51FRESH')?.querySelector(cls);
                      return Boolean(node)&&f.contentWindow.getComputedStyle(node).display!=='none';};
                    const hideStart=shown('.meta-hz')&&shown('.meta-speed')&&shown('.meta-snr')&&shown('.meta-time');
                    hideButton.click();
                    const hide1=!shown('.meta-hz')&&shown('.meta-speed')&&shown('.meta-snr')&&shown('.meta-time');
                    hideButton.click(); hideButton.click();
                    const hide3=!shown('.meta-hz')&&!shown('.meta-speed')&&!shown('.meta-snr')&&shown('.meta-time');
                    hideButton.click();
                    const hide4=!shown('.meta-time')&&hideButton.textContent==='SHOW ALL';
                    hideButton.click();
                    checks.trafficHideCycles=hideStart&&hide1&&hide3&&hide4&&
                      shown('.meta-hz')&&shown('.meta-time')&&hideButton.textContent==='HIDE Hz'&&
                      f.contentWindow.__dataTest.snapshotBuild().trafficHide===0;
                    // A station already in the JS8CALL log on THIS band reads dimmer, so
                    // the eye lands on the ones still worth working. It stays clickable and
                    // its REPLY stays live: answering again is legitimate.
                    f.contentWindow.__dataTest.markLogged('S52STALE');
                    const workedName=rowFor('S52STALE')?.querySelector('strong');
                    checks.feedDimsWorkedCalls=Boolean(workedName)&&
                      workedName.classList.contains('worked')&&
                      /already logged on/.test(workedName.title)&&
                      !rowFor('S51FRESH')?.querySelector('strong')?.classList.contains('worked')&&
                      Boolean(rowFor('S51FRESH')?.querySelector('.cq-reply:not([disabled])'));
                  }
                  // MSG BOX stage E4: the same "who hears whom" evidence decides
                  // where to park a message for a station we cannot reach. SN9GK
                  // reported a signal to MM0VIK, so SN9GK hears MM0VIK.
                  {
                    const dtE4=f.contentWindow.__dataTest;
                    const txSafe=d.querySelector('#txSafety'), txSafeWas=txSafe.checked;
                    if(!txSafeWas){txSafe.checked=true;txSafe.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
                    dtE4.msgBoxDefer('MM0VIK','BRING THE KEY');
                    checks.msgBoxHearingEvidence=dtE4.msgBoxHeardBy('SN9GK').includes('MM0VIK');
                    dtE4.clearTxQueue(); dtE4.clearTxCaptured();
                    const parkRefusal=dtE4.msgBoxParkVia('SN9GK',{manual:true});
                    const parked=dtE4.txCaptured().find(item=>item.to==='SN9GK'&&
                      item.text==='MSG TO:MM0VIK BRING THE KEY');
                    checks.msgBoxParksViaHearingStation=parkRefusal===''&&Boolean(parked);
                    // Its ACK proves storage at SN9GK, never delivery to MM0VIK,
                    // so the automation stops there and records who has it.
                    dtE4.feedInbox({from:'SN9GK',to:'OK1HRA',command:' ACK'});
                    const handed=dtE4.msgBoxDeferred().find(item=>item.to==='MM0VIK');
                    checks.msgBoxHandoffIsTerminal=Boolean(handed)&&handed.state==='handed'&&
                      handed.via==='SN9GK';
                    checks.msgBoxNoSecondHandoff=dtE4.msgBoxParkVia('SN9GK',{manual:true})==='nothing waiting';
                    dtE4.clearTxQueue();
                    d.querySelector('#abortButton').click();
                    if(!txSafeWas){txSafe.checked=false;txSafe.dispatchEvent(new f.contentWindow.Event('change',{bubbles:true}));}
                  }
                  // Partial receptions: a long message must be readable while it arrives,
                  // and one that never ended must say so instead of vanishing. Fed the way
                  // the worker's ActivityStore reports it -- reassembly in progress in
                  // channels, finalized torso in messages.
                  const pnow=Date.now();
                  f.contentWindow.__dataTest.setActivity({frames:[],timing:[],calls:[],
                    channels:[{key:'0|1500',id:'0|1500|'+(pnow-15000),
                      text:'K0OG: OK1HRA MSG ARRIVING NOW',callsigns:['K0OG','OK1HRA'],
                      kinds:['directed','data'],submode:0,offsetHz:1500,
                      firstSlotUtcMs:pnow-15000,lastSlotUtcMs:pnow-3000,
                      directed:{from:'K0OG',to:'OK1HRA',command:' MSG'},
                      gaps:[],headerMissing:false,frameCount:2}],
                    messages:[{id:'0|1600|'+(pnow-120000),
                      text:'DL9TOR: OK1HRA MSG BROKEN OFF HERE',callsigns:['DL9TOR','OK1HRA'],
                      kinds:['directed','data'],submode:0,offsetHz:1600,
                      firstSlotUtcMs:pnow-120000,lastSlotUtcMs:pnow-90000,
                      directed:{from:'DL9TOR',to:'OK1HRA',command:' MSG'},
                      gaps:[{textIndex:25,frames:2,slotUtcMs:pnow-105000}],
                      headerMissing:false,complete:false,incomplete:true,checksumOk:false}]});
                  const rxRow=state=>d.querySelector('#traffic article[data-rx-state="'+state+'"]');
                  const liveRow=rxRow('receiving'),torsoRow=rxRow('incomplete');
                  checks.partialRow=Boolean(liveRow)&&
                    liveRow.querySelector('.rx-state').textContent==='receiving'&&
                    liveRow.querySelector('.message-text').textContent.indexOf('ARRIVING NOW')>=0&&
                    liveRow.querySelector('strong').dataset.call==='K0OG'&&
                    !liveRow.querySelector('.rx-eot')&&
                    d.querySelector('#trafficSummary').textContent.indexOf('1 receiving')>=0;
                  // The torso is the case that was invisible until now: a lost final frame
                  // stranded the reassembly in the worker and no row was ever drawn. The end
                  // marker must be absent here and present on an intact row, otherwise its
                  // absence proves nothing.
                  checks.partialFinalized=Boolean(torsoRow)&&
                    torsoRow.querySelector('.rx-state').textContent==='incomplete'&&
                    !torsoRow.querySelector('.rx-eot')&&
                    Boolean(d.querySelector('#traffic article .rx-eot'));
                  const gapNode=torsoRow&&torsoRow.querySelector('.rx-gap');
                  checks.gapMarker=Boolean(gapNode)&&
                    gapNode.title.indexOf('2 frames lost')>=0&&
                    // one fixed block per lost frame, 3 characters each: the count is a
                    // fact, the width of the hole is not
                    gapNode.textContent.length===6&&
                    // and it must sit where the frames were lost, not at the end
                    gapNode.previousSibling.textContent.slice(-6)==='BROKEN'&&
                    torsoRow.querySelector('.message-text').textContent.indexOf('OFF HERE')>=0;
                  // The signal stripe is only worth drawing if its axis IS the waterfall's
                  // axis, so this measures both boxes on screen instead of trusting the
                  // percentage string. A stripe positioned against the wrong reference --
                  // the row's content box instead of its padding box, say -- would still
                  // carry a "correct" left:45.45% and pass any DOM-level check while
                  // pointing tens of pixels away from the signal it belongs to.
                  const sn=Date.now();
                  f.contentWindow.__dataTest.setActivity({frames:[],timing:[],calls:[],channels:[],
                    messages:[
                      {id:'stripeA',text:'K0OG: OK1HRA NARROW',callsigns:['K0OG','OK1HRA'],
                       kinds:['directed','data'],submode:0,offsetHz:1500,snr:-11,
                       firstSlotUtcMs:sn-4000,lastSlotUtcMs:sn-4000,gaps:[],complete:true},
                      {id:'stripeI',text:'DL1ABC: OK1HRA WIDE',callsigns:['DL1ABC','OK1HRA'],
                       kinds:['directed','data'],submode:8,offsetHz:600,snr:3,
                       firstSlotUtcMs:sn-3000,lastSlotUtcMs:sn-3000,gaps:[],complete:true},
                      // The one message that proves its sender reached APRS-IS, and so the
                      // only one that may carry an aprs.fi link.
                      {id:'stripeAprs',text:'DL8KM: @APRSIS GRID',callsigns:['DL8KM'],
                       kinds:['directed'],submode:0,offsetHz:900,snr:-4,
                       firstSlotUtcMs:sn-2500,lastSlotUtcMs:sn-2500,gaps:[],complete:true}]});
                  const canvas=d.querySelector('#waterfallCanvas');
                  // Deliberately the DISPLAYED box, not the drawing buffer: Waterfall clamps
                  // canvas.width to minWidth 320, so on a narrow window the buffer is wider
                  // than what is on screen. Both are linear maps of the same 500..2700 Hz, so
                  // the displayed box is the one the operator's eye actually uses.
                  const stripeError=(hz,widthHz)=>{
                    // Received rows only. Own transmissions carry stripes too, and
                    // one of them sitting on the same offset at a different speed
                    // would be measured against this fixture's width.
                    const node=[...d.querySelectorAll('#traffic .signal-stripe.stripe-rx')]
                      .find(item=>Number(item.dataset.stripeOffset)===hz);
                    if(!node)return null;
                    const box=canvas.getBoundingClientRect(),rect=node.getBoundingClientRect();
                    return {left:Math.abs(rect.left-(box.left+(hz-500)/2200*box.width)),
                            width:Math.abs(rect.width-widthHz/2200*box.width)};
                  };
                  // Two submodes an order of magnitude apart in width, and two offsets: a
                  // single sample would pass on a wrong slope through the right point.
                  const wideA=stripeError(1500,50),wideI=stripeError(600,250);
                  checks.stripeAlignedToWaterfall=Boolean(wideA&&wideI)&&
                    wideA.left<=1&&wideI.left<=1;
                  checks.stripeWidthIsBandwidth=Boolean(wideA&&wideI)&&
                    wideA.width<=1&&wideI.width<=1;
                  // The same identity at the narrowest window the page supports, where the
                  // .data-page padding media query fires and the canvas buffer stops matching
                  // its displayed width. Percentages re-lay out synchronously, and only the
                  // displayed boxes are read, so no wait is needed; the drawing buffer may
                  // still be catching up and that is fine.
                  const frameWidth=f.style.width;
                  f.style.width='320px';
                  void d.body.offsetWidth;
                  const narrowA=stripeError(1500,50),narrowI=stripeError(600,250);
                  checks.stripeAlignedWhenNarrow=Boolean(narrowA&&narrowI)&&
                    narrowA.left<=1&&narrowI.left<=1&&narrowA.width<=1&&narrowI.width<=1;
                  f.style.width=frameWidth;
                  void d.body.offsetWidth;
                  // A row whose offset was never recorded -- own TX restored from a session
                  // written before the encoder's tone was logged -- must draw nothing rather
                  // than invent a position. The received rows stay on screen so the own-TX
                  // bars can be compared against one.
                  f.contentWindow.__dataTest.setOutgoingLog([
                    // sentChars is what splits the copy into radiated and not; without it
                    // even a completed row renders entirely as pending.
                    {id:901,direction:'outgoing',to:'K0OG',text:'ON AIR',status:'completed',
                     sentChars:6,utcMs:sn-2000,offsetHz:1200,submode:0,frequencyHz:0,restored:true},
                    {id:902,direction:'outgoing',to:'K0OG',text:'NEVER SENT',status:'aborted',
                     utcMs:sn-1500,offsetHz:1300,submode:0,frequencyHz:0,restored:true},
                    {id:903,direction:'outgoing',to:'K0OG',text:'NO OFFSET',status:'completed',
                     utcMs:sn-1000,frequencyHz:0,restored:true}]);
                  const txRows=[...d.querySelectorAll('#traffic .message-tx')];
                  const txRow=text=>txRows.find(row=>row.textContent.indexOf(text)>=0);
                  const withoutOffset=txRow('NO OFFSET');
                  checks.stripeAbsentWithoutOffset=Boolean(withoutOffset)&&
                    !withoutOffset.querySelector('.signal-stripe');
                  // Asserted as an ordering rather than as literal colours, because the exact
                  // shades are a judgement tuned by eye and were already toned down once. What
                  // must not drift is the ranking: an own transmission is quieter than a
                  // received signal -- it is not what you attribute to a trace in the waterfall
                  // -- and one that went on air is still the stronger of the two TX marks.
                  // [0-9] rather than \d: this whole page is emitted from a template literal,
                  // where an unrecognised escape collapses to the bare letter -- \d would
                  // silently become /d+/g and match nothing in "rgb(46, 61, 57)".
                  const lightness=node=>{const m=getComputedStyle(node).backgroundColor.match(/[0-9]+/g);
                    return m?Number(m[0])+Number(m[1])+Number(m[2]):-1;};
                  const rxStripe=d.querySelector('#traffic .message:not(.message-tx) .signal-stripe');
                  const onAir=txRow('ON AIR')?.querySelector('.signal-stripe');
                  const offAir=txRow('NEVER SENT')?.querySelector('.signal-stripe');
                  checks.stripeCarriesTxColour=Boolean(onAir&&offAir&&rxStripe)&&
                    onAir.classList.contains('stripe-tx-on-air')&&
                    offAir.classList.contains('stripe-tx-off-air')&&
                    lightness(offAir)<lightness(onAir)&&lightness(onAir)<lightness(rxStripe);
                  // The chat thread's progress bar must not leak into the feed. Scoped, not
                  // deleted: the same class still has to fill in green where a message is
                  // being watched on its way out, so both halves are asserted here -- red
                  // text on a green background is the one pairing that must never come back.
                  const feedCopy=txRow('ON AIR')?.querySelector('.tx-copy-sent');
                  const chatCopy=d.querySelector('.chat-row.outgoing .tx-copy-sent');
                  const transparent=node=>{const c=getComputedStyle(node).backgroundColor;
                    return c==='rgba(0, 0, 0, 0)'||c==='transparent';};
                  checks.txCopyPlainInFeed=Boolean(feedCopy&&chatCopy)&&
                    transparent(feedCopy)&&!transparent(chatCopy);
                  // Hovering the waterfall proposes a TX frequency and asks the feed whether
                  // anybody is already there. The hairline has to land on the SAME screen
                  // column as the waterfall's own preview line, otherwise the collision it
                  // draws is imaginary -- so it is measured against the canvas, like the bars.
                  const wf=d.querySelector('#waterfall'),wfBox=wf.getBoundingClientRect();
                  const hoverHz=1500,hoverX=wfBox.left+(hoverHz-500)/2200*wfBox.width;
                  const feed=d.querySelector('#traffic');
                  const barHeight=()=>d.querySelector('#trafficHistogram .histogram-bar')
                    .getBoundingClientRect().height;
                  const barAtRest=barHeight();
                  checks.collisionHiddenUntilHover=!feed.classList.contains('collision-preview')&&
                    getComputedStyle(d.querySelector('#traffic .signal-band')).opacity==='0'&&
                    // the histogram is a low ruler until asked, matching the row bars
                    barAtRest<=4;
                  wf.dispatchEvent(new f.contentWindow.MouseEvent('mousemove',
                    {bubbles:true,clientX:hoverX,clientY:wfBox.top+10}));
                  const hairline=getComputedStyle(feed,'::after');
                  const hairlineX=feed.getBoundingClientRect().left+parseFloat(hairline.left);
                  checks.collisionHairlineTracksWaterfall=feed.classList.contains('collision-preview')&&
                    Math.abs(hairlineX-hoverX)<=1;
                  checks.collisionBandsRevealed=
                    getComputedStyle(d.querySelector('#traffic .signal-band')).opacity==='1'&&
                    // behind the text, not over it
                    getComputedStyle(d.querySelector('#traffic .signal-band')).zIndex==='-1';
                  // The histogram answers the same question at the same moment, so it grows
                  // with the bands: a low ruler at rest, full height while the pointer asks.
                  checks.histogramGrowsOnHover=barHeight()>barAtRest*2;
                  // Station labels are a DWELL gesture: three seconds of stillness, so that
                  // sweeping the pointer across on the way somewhere else never summons them.
                  // They are painted on canvas, so the DOM cannot be asked -- dueInMs proves
                  // the timer is armed and how long it is, without the test waiting for it.
                  const labelState=()=>f.contentWindow.__dataTest.stationLabelState();
                  const shown=labelState();
                  // Up the moment the pointer crosses the edge, with a three-second countdown
                  // to HIDING already running -- the timer takes them away, it does not bring
                  // them. Two earlier versions had that backwards.
                  checks.stationLabelsShowOnEntry=shown.visible===true&&
                    shown.dueInMs>2500&&shown.dueInMs<=3000;
                  // Movement must push the hiding back. Proving a reset needs time to actually
                  // pass, so a short spin drains the countdown first: after the next move it has
                  // to be back up, which cannot happen unless the task was re-registered.
                  const spin=ms=>{const until=Date.now()+ms;while(Date.now()<until);};
                  spin(150);
                  const draining=labelState();
                  wf.dispatchEvent(new f.contentWindow.MouseEvent('mousemove',
                    {bubbles:true,clientX:hoverX+40,clientY:wfBox.top+14}));
                  const refreshed=labelState();
                  checks.stationLabelsCountdownResetsOnMove=
                    draining.dueInMs<shown.dueInMs-100&&
                    refreshed.dueInMs>draining.dueInMs+100&&
                    refreshed.visible===true&&refreshed.armedAtMs>shown.armedAtMs;
                  // One entry per station at the frequency it was last heard on, newest
                  // first, own transmissions excluded -- they are not stations to avoid.
                  // Concatenation, not a template literal: this page is itself emitted from
                  // one, so an interpolation here would be evaluated by Node before the
                  // browser ever sees it -- and a dollar-brace pair is a syntax error even
                  // inside a comment, since the comment is still part of that string. Same
                  // family of trap as the backslash-d in a regex a few lines up.
                  // Asserted as properties, not as an exact list: earlier parts of this
                  // harness leave their own stations in the feed, and pinning the whole set
                  // would make this check break every time one of them changes.
                  const labelAt=new Map(shown.labels.map(item=>[item.call,Math.round(item.offsetHz)]));
                  const labelTimes=shown.labels.map(item=>item.lastSlotUtcMs);
                  checks.stationLabelsPerStation=
                    labelAt.size===shown.labels.length&&
                    labelTimes.every((value,index)=>index===0||value<=labelTimes[index-1])&&
                    labelAt.get('DL8KM')===900&&labelAt.get('DL1ABC')===600&&
                    labelAt.get('K0OG')===1500&&
                    // own call never labels the band: we are not a station to steer around
                    !labelAt.has('OK1HRA');
                  wf.dispatchEvent(new f.contentWindow.MouseEvent('mouseleave',{bubbles:true}));
                  checks.collisionClearsOnLeave=!feed.classList.contains('collision-preview');
                  checks.stationLabelsCancelOnLeave=labelState().dueInMs===null&&
                    labelState().visible===false;
                  // The histogram is the same bars again, so it must hold exactly one per
                  // visible row that has an offset, on the same axis.
                  const bars=[...d.querySelectorAll('#trafficHistogram .histogram-bar')];
                  const rowStripes=[...d.querySelectorAll('#traffic .signal-stripe')];
                  const barBox=d.querySelector('#trafficHistogram').getBoundingClientRect();
                  // aprs.fi lookup: on the callsign inside the text, never on the <strong>
                  // that picks whom to answer -- so the selector must still be a plain
                  // element with no href, or the primary interaction of the page is gone.
                  const rowWith=text=>[...d.querySelectorAll('#traffic .message:not(.message-tx)')]
                    .find(row=>row.textContent.indexOf(text)>=0);
                  const aprsRow=rowWith('@APRSIS GRID'),plainRow=rowWith('WIDE');
                  const lookup=aprsRow&&aprsRow.querySelector('.message-text .call-lookup');
                  checks.senderLookupLink=Boolean(lookup)&&
                    lookup.getAttribute('href')==='https://aprs.fi/DL8KM'&&
                    lookup.getAttribute('target')==='_blank'&&
                    lookup.textContent==='DL8KM'&&
                    getComputedStyle(lookup).textDecorationLine==='underline';
                  // aprs.fi only has a page for a station that reached APRS-IS. An ordinary
                  // JS8 exchange is no evidence of that, and a link to "no data" would teach
                  // the operator to stop trusting the underline.
                  checks.senderLookupOnlyForAprs=Boolean(plainRow)&&
                    !plainRow.querySelector('.call-lookup');
                  checks.senderSelectorStaysPlain=Boolean(aprsRow)&&
                    aprsRow.querySelector('strong[data-call="DL8KM"]')!==null&&
                    !aprsRow.querySelector('strong a')&&
                    !d.querySelector('#stationRows a');
                  checks.histogramMirrorsRows=bars.length===rowStripes.length&&bars.length>0&&
                    Math.abs(barBox.left-feed.getBoundingClientRect().left)<=1&&
                    Math.abs(barBox.width-feed.getBoundingClientRect().width)<=1;
                  // CLEAR cannot reach the store inside the worker, so without the watermark
                  // the live row pops straight back and CLEAR reads as a broken button.
                  d.querySelector('[data-traffic-clear]').click();
                  checks.clearWatermark=!d.querySelector('#traffic article[data-rx-state]')&&
                    Boolean(d.querySelector('#traffic .empty-row'));
                  // Last, because it leaves the modem dead. A startup that stops advancing
                  // must say so: this page held the operator on "Loading JS8Call-ICOM modem
                  // 0%" for ever whenever the worker never reported, with RETRY hidden
                  // because no failure had been declared. The gate has to come back even
                  // though a session was restored above -- the inline modem line that would
                  // otherwise carry the news lives in a section the page keeps hidden.
                  const stalled=f.contentWindow.__dataTest.stallModem('fixture stall');
                  checks.modemStallDeclared=stalled.failed===true&&
                    stalled.label==='Modem loading failed'&&stalled.detail==='fixture stall'&&
                    stalled.status==='fixture stall';
                  checks.modemStallVisible=stalled.retryVisible===true&&stalled.gateVisible===true&&
                    d.querySelector('#startupLabel').textContent==='Modem loading failed'&&
                    d.querySelector('#startupDetail').textContent==='fixture stall'&&
                    !d.querySelector('#startupRetry').hidden&&
                    d.querySelector('#modemState').className.includes('error');
                  const pass=Object.values(checks).every(Boolean);
                  fetch('/result',{method:'POST',body:JSON.stringify({pass,text:'DATA BROWSER '+(pass?'PASS ':'FAIL ')+JSON.stringify(checks)+' station='+JSON.stringify(stationObserved)+' sort='+JSON.stringify({sortAscObserved,sortDescObserved})+' gate='+gate+' tx='+d.querySelector('#txSummary').textContent+' modem='+d.querySelector('#modemState').textContent+' diag='+diag})});
                }
              },100);
            }
          },200);
        }
      },200);
      } catch(error) {
        fetch('/result',{method:'POST',body:JSON.stringify({pass:false,text:'DATA BROWSER CHECK ERROR: '+String(error?.stack||error)})});
      }
    },650);
    } catch(error) {
      fetch('/result',{method:'POST',body:JSON.stringify({pass:false,text:'DATA BROWSER INIT ERROR: '+String(error?.stack||error)+' body='+d.body.className+' detail='+d.querySelector('#lanGateDetail')?.textContent})});
    }
  },5000);
};
</script>`);return;
  }
  const relative=url.pathname==="/data"?"data.html":url.pathname==="/setup"?"setup.html":url.pathname.slice(1);
  const target=path.resolve(data,relative);
  if(!target.startsWith(data+path.sep))return res.writeHead(403).end();
  // Match firmware handleFileFromSPIFFS(): only use advertised encodings.
  const br=target+".br", gz=target+".gz";
  const accepts=String(req.headers["accept-encoding"]||"");
  const encoded=accepts.includes("br")&&fs.existsSync(br)?br:(accepts.includes("gzip")&&fs.existsSync(gz)?gz:target);
  if(path.basename(target).startsWith("js8-")){if(encoded===br)js8Brotli++;if(encoded===gz)js8Gzip++;}
  fs.readFile(encoded,(error,bytes)=>{if(error)return res.writeHead(404).end();res.setHeader("Content-Type",mime[path.extname(target)]||"application/octet-stream");if(encoded===br)res.setHeader("Content-Encoding","br");if(encoded===gz)res.setHeader("Content-Encoding","gzip");if(url.pathname==="/js8-jsc.bin.br"){jscRequests++;jscStartedAt=Date.now();res.setHeader("Cache-Control","no-store");res.setHeader("Content-Length",bytes.length);const chunk=Math.ceil(bytes.length/8);let at=0;const tick=()=>{res.write(bytes.subarray(at,Math.min(bytes.length,at+chunk)));at+=chunk;if(at>=bytes.length){jscComplete=true;jscCompleteAt=Date.now();return res.end();}setTimeout(tick,150);};tick();return;}res.end(bytes);});
});
// This harness serves data/*.gz exactly as the firmware does, so a .gz older than its
// source means the run is grading the PREVIOUS version of that file. It has cost two
// long debugging sessions already: the WSPR harness reads the sources and went green
// while this one, on stale assets, failed with a symptom that pointed at the wrong
// place entirely. So refuse to start instead.
{
  const stale=[];
  for(const name of fs.readdirSync(data)){
    if(!name.endsWith(".js")&&!name.endsWith(".css")&&!name.endsWith(".html"))continue;
    const source=path.join(data,name), gz=source+".gz";
    if(!fs.existsSync(gz))continue;
    if(fs.statSync(source).mtimeMs>fs.statSync(gz).mtimeMs)stale.push(name);
  }
  if(stale.length){
    console.error("DATA BROWSER STALE ASSETS: "+stale.join(", "));
    console.error("  this harness serves .gz like the firmware, so it would grade the");
    console.error("  previous version. Run: tools/minify-spiffs-js.sh && tools/gzip-assets.sh");
    process.exit(2);
  }
}

server.on("upgrade",(req,socket)=>{const wsUrl=new URL(req.url,"http://fixture");if(wsUrl.pathname!=="/audiows")return socket.destroy();
// Same gate as the firmware: the audio socket is where the lock actually bites,
// so a handshake without the owning token never reaches the stream.
if(!sessionOwns(wsUrl.searchParams.get("token"))){session.wsRefusals++;socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");return socket.destroy();}
wsConnections++;wsOpenedAt=Date.now();if(!jscComplete)earlyWsConnections++;const accept=crypto.createHash("sha1").update(req.headers["sec-websocket-key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n");socket.write(frame(1,JSON.stringify({type:"hello",protocol:"AUD1",version:1,streamId,rx:[{kind:"RX_ULAW",sampleRate:8000}],tx:[{kind:"TX_PCM16",sampleRate:48000}],maxPayloadBytes:1920})));const interval=setInterval(()=>{if(socket.destroyed)return clearInterval(interval);socket.write(frame(2,aud1()));},20);socket.on("data",readClientFrames(socket));socket.on("close",()=>clearInterval(interval));socket.on("error",()=>clearInterval(interval));});
// The operator's device is an Android phone or tablet on the LAN, so the harness
// says so. It costs nothing -- no page reads the user agent -- and it is what
// makes the wake lock checks meaningful: the video fallback is a mobile technique
// and a desktop user agent would (correctly) refuse to use it.
const ANDROID_UA="Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
server.listen(0,"127.0.0.1",()=>{chrome=spawn("google-chrome",["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--no-proxy-server",`--user-agent=${ANDROID_UA}`,"--host-resolver-rules=MAP wifilt.test 127.0.0.1",`http://wifilt.test:${server.address().port}/smoke.html`]);let errors="";chrome.stderr.on("data",c=>errors+=c);chrome.on("close",code=>{if(!finished)finish(false,`DATA BROWSER FAIL Chrome exited ${code}\n${errors}`);});timer=setTimeout(()=>finish(false,`DATA BROWSER FAIL timeout prepares=${txPrepares} packets=${txPackets}`),55000);});
