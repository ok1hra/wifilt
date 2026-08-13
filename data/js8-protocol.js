// PROTOTYPE — portable JS8 frame semantics and in-memory receive activity.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Protocol = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const ALPHABET72 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.";
  const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@";
  const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
  const NBASEGRID = 180 * 180;
  const NUSERGRID = NBASEGRID + 10;
  const NMAXGRID = (1 << 15) - 1;
  const FRAME = {HEARTBEAT: 0, COMPOUND: 1, COMPOUND_DIRECTED: 2,
                 DIRECTED: 3, DATA: 4, UNKNOWN: 255};
  const COMMANDS = [
    " SNR?", " DIT DIT", " NACK", " HEARING?", " GRID?", ">",
    " STATUS?", " STATUS", " HEARING", " MSG", " MSG TO:", " QUERY",
    " QUERY MSGS", " QUERY CALL", " ACK", " GRID", " INFO?", " INFO",
    " FB", " HW CPY?", " SK", " RR", " QSL?", " QSL", " CMD", " SNR",
    " NO", " YES", " 73", " HEARTBEAT SNR", " AGN?", " "
  ];
  const CHECKSUM_COMMANDS = new Set([5, 9, 10, 11, 12, 13, 24]);
  const DIRECTED_COMMANDS = COMMANDS.map((command, index) =>
    ({command, index, token:command.trim()}))
    .filter(item => item.token && item.index !== 31)
    .sort((left, right) => right.token.length - left.token.length);
  DIRECTED_COMMANDS.push({command:" SNR?", index:0, token:"?"});
  const SPECIAL_CALLS = [
    "<....>", "@ALLCALL", "@JS8NET", "@DX/NA", "@DX/SA", "@DX/EU",
    "@DX/AS", "@DX/AF", "@DX/OC", "@DX/AN", "@REGION/1", "@REGION/2",
    "@REGION/3", "@GROUP/0", "@GROUP/1", "@GROUP/2", "@GROUP/3",
    "@GROUP/4", "@GROUP/5", "@GROUP/6", "@GROUP/7", "@GROUP/8",
    "@GROUP/9", "@COMMAND", "@CONTROL", "@NET", "@NTS", "@RESERVE/0",
    "@RESERVE/1", "@RESERVE/2", "@RESERVE/3", "@RESERVE/4", "@APRSIS",
    "@RAGCHEW", "@JS8", "@EMCOMM", "@ARES", "@MARS", "@AMRRON",
    "@RACES", "@RAYNET", "@RADAR", "@SKYWARN", "@CQ", "@HB", "@QSO",
    "@QSOPARTY", "@CONTEST", "@FIELDDAY", "@SOTA", "@IOTA", "@POTA",
    "@QRP", "@QRO"
  ];
  const CQ = ["CQ CQ CQ", "CQ DX", "CQ QRP", "CQ CONTEST",
              "CQ FIELD", "CQ FD", "CQ CQ", "CQ"];
  const HUFF = {
    "01":" ", "100":"E", "1101":"T", "0011":"A", "11111":"O",
    "11100":"I", "10111":"N", "10100":"S", "00011":"H", "00000":"R",
    "111011":"D", "110011":"L", "110001":"C", "101101":"U",
    "101011":"M", "001011":"W", "001001":"F", "000101":"G",
    "000011":"Y", "1111011":"P", "1111001":"B", "1110100":".",
    "1100101":"V", "1100100":"K", "1100001":"-", "1100000":"+",
    "1011001":"?", "1011000":"!", "1010101":"\"", "1010100":"X",
    "0010101":"0", "0010100":"J", "0010001":"1", "0010000":"Q",
    "0001001":"2", "0001000":"Z", "0000101":"3", "0000100":"5",
    "11110101":"4", "11110100":"9", "11110001":"8", "11110000":"6",
    "11101011":"7", "11101010":"/"
  };
  const HUFF_ENCODE = Object.fromEntries(
    Object.entries(HUFF).map(([code, character]) => [character, code])
  );
  // Stable literal prefix of the upstream JSC map. Dense frames are required
  // for gateway payload characters (notably @, _, and :) absent from Huffman.
  const JSC_LITERALS = ["E","T","A","O","I","N","S","H","R","D","L","C",
    "U","M","W","F","G","Y","P","B",",",".","V","K","-","+","\"","?",
    "!","'","X",")","(","0","J","1","Q","=","2",":","Z","3","5","4",
    "9","8","6","7","_","/","&","$","%","#","@","*",">","<","[",
    "]","{","}","|",";","^","`","~"," ","\\","\n"];
  const JSC_LITERAL_INDEX = Object.fromEntries(JSC_LITERALS.map((value,index)=>[value,index]));

  function bytesOf(input) {
    return input instanceof Uint8Array ? input : new Uint8Array(input);
  }

  class JscDictionary {
    constructor(input) {
      this.bytes = bytesOf(input);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset,
                               this.bytes.byteLength);
      this.format = String.fromCharCode(...this.bytes.subarray(0, 4));
      if (this.format !== "JSC1" && this.format !== "JSC2")
        throw new Error("invalid JSC dictionary");
      this.count = this.view.getUint32(4, true);
      if (this.count !== 262144) throw new Error("unexpected JSC dictionary size");
      if (this.format === "JSC1") {
        this.dataStart = 8 + (this.count + 1) * 4;
        this.offsets = null;
      } else {
        this.dataStart = 8 + this.count;
        this.offsets = new Uint32Array(this.count + 1);
        for (let i = 0; i < this.count; i += 1)
          this.offsets[i + 1] = this.offsets[i] + this.bytes[8 + i];
        if (this.dataStart + this.offsets[this.count] !== this.bytes.length)
          throw new Error("invalid JSC2 payload length");
      }
    }

    word(index) {
      if (index < 0 || index >= this.count) return "";
      const start = this.offsets ? this.offsets[index] :
        this.view.getUint32(8 + index * 4, true);
      const end = this.offsets ? this.offsets[index + 1] :
        this.view.getUint32(12 + index * 4, true);
      let result = "";
      for (let i = start; i < end; i += 1)
        result += String.fromCharCode(this.bytes[this.dataStart + i]);
      return result;
    }

    decompress(bits) {
      const terminal = 7;
      const continuation = 9;
      const base = [0];
      for (let i = 1; i < 8; i += 1)
        base[i] = base[i - 1] + terminal * (continuation ** (i - 1));
      const values = [];
      const separators = new Set();
      let cursor = 0;
      while (cursor + 4 <= bits.length) {
        const value = bitsToNumber(bits, cursor, 4);
        values.push(value);
        cursor += 4;
        if (value < terminal) {
          if (cursor < bits.length && bits[cursor]) separators.add(values.length - 1);
          cursor += 1;
        }
      }
      let output = "";
      for (let start = 0; start < values.length;) {
        let k = 0;
        let index = 0;
        while (start + k < values.length && values[start + k] >= terminal) {
          index = index * continuation + values[start + k] - terminal;
          k += 1;
        }
        if (start + k >= values.length || k >= base.length) break;
        index = index * terminal + values[start + k] + base[k];
        if (index >= this.count) break;
        output += this.word(index);
        if (separators.has(start + k)) output += " ";
        start += k + 1;
      }
      return output;
    }
  }

  function unpack72(raw) {
    if (typeof raw !== "string" || raw.length !== 12 || raw.includes(" "))
      throw new Error("JS8 raw frame must contain 12 packed characters");
    let high = 0n;
    for (let i = 0; i < 10; i += 1) {
      const value = ALPHABET72.indexOf(raw[i]);
      if (value < 0) throw new Error("invalid packed JS8 character");
      high |= BigInt(value) << BigInt(58 - 6 * i);
    }
    const remHigh = ALPHABET72.indexOf(raw[10]);
    const remLow = ALPHABET72.indexOf(raw[11]);
    if (remHigh < 0 || remLow < 0) throw new Error("invalid packed JS8 character");
    high |= BigInt(remHigh >> 2);
    return (high << 8n) | BigInt(((remHigh & 3) << 6) | remLow);
  }

  function pack72(value) {
    let raw = "";
    for (let shift = 66; shift >= 0; shift -= 6)
      raw += ALPHABET72[Number((value >> BigInt(shift)) & 63n)];
    return raw;
  }

  function toBits(value, width = 72) {
    const result = new Array(width);
    for (let i = 0; i < width; i += 1)
      result[i] = ((value >> BigInt(width - i - 1)) & 1n) === 1n;
    return result;
  }

  function bitsToNumber(bits, start, count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + (bits[start + i] ? 1 : 0);
    return value;
  }

  function bitField(value, start, count) {
    const shift = BigInt(72 - start - count);
    return (value >> shift) & ((1n << BigInt(count)) - 1n);
  }

  function unpackCallsign(value, portable) {
    const special = Number(value) - NBASECALL - 1;
    if (special >= 0 && special < SPECIAL_CALLS.length) return SPECIAL_CALLS[special];
    const word = new Array(6);
    let packed = Number(value);
    word[5] = ALPHANUMERIC[(packed % 27) + 10]; packed = Math.floor(packed / 27);
    word[4] = ALPHANUMERIC[(packed % 27) + 10]; packed = Math.floor(packed / 27);
    word[3] = ALPHANUMERIC[(packed % 27) + 10]; packed = Math.floor(packed / 27);
    word[2] = ALPHANUMERIC[packed % 10]; packed = Math.floor(packed / 10);
    word[1] = ALPHANUMERIC[packed % 36]; packed = Math.floor(packed / 36);
    word[0] = ALPHANUMERIC[packed];
    let call = word.join("").trim();
    if (call.startsWith("3D0")) call = `3DA0${call.slice(3)}`;
    if (/^Q[A-Z]/.test(call)) call = `3X${call.slice(1)}`;
    return portable ? `${call}/P` : call;
  }

  function packCallsign(input) {
    let call = String(input).toUpperCase().trim();
    const special = SPECIAL_CALLS.indexOf(call);
    if (special >= 0) return {value: NBASECALL + special + 1, portable: false};
    let portable = false;
    if (call.endsWith("/P")) { call = call.slice(0, -2); portable = true; }
    if (call.startsWith("3DA0")) call = `3D0${call.slice(4)}`;
    if (/^3X[A-Z]/.test(call)) call = `Q${call.slice(2)}`;
    if (call.length < 2 || call.length > 6) return null;
    const permutations = [call];
    if (call.length === 2) permutations.push(` ${call}   `);
    if (call.length === 3) permutations.push(` ${call}  `, `${call}   `);
    if (call.length === 4) permutations.push(` ${call} `, `${call}  `);
    if (call.length === 5) permutations.push(` ${call}`, `${call} `);
    const packedCall = permutations.find(value =>
      /^([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])$/.test(value));
    if (!packedCall) return null;
    let value = ALPHANUMERIC.indexOf(packedCall[0]);
    value = 36 * value + ALPHANUMERIC.indexOf(packedCall[1]);
    value = 10 * value + ALPHANUMERIC.indexOf(packedCall[2]);
    value = 27 * value + ALPHANUMERIC.indexOf(packedCall[3]) - 10;
    value = 27 * value + ALPHANUMERIC.indexOf(packedCall[4]) - 10;
    value = 27 * value + ALPHANUMERIC.indexOf(packedCall[5]) - 10;
    return value > 0 ? {value, portable} : null;
  }

  function unpackAlphaNumeric50(packed) {
    const word = new Array(11);
    for (const position of [10, 9, 8]) {
      word[position] = ALPHANUMERIC[Number(packed % 38n)]; packed /= 38n;
    }
    word[7] = packed % 2n ? "/" : " "; packed /= 2n;
    for (const position of [6, 5, 4]) {
      word[position] = ALPHANUMERIC[Number(packed % 38n)]; packed /= 38n;
    }
    word[3] = packed % 2n ? "/" : " "; packed /= 2n;
    for (const position of [2, 1]) {
      word[position] = ALPHANUMERIC[Number(packed % 38n)]; packed /= 38n;
    }
    word[0] = ALPHANUMERIC[Number(packed % 39n)];
    return word.join("").replaceAll(" ", "");
  }

  function packAlphaNumeric50(input) {
    let word = String(input).toUpperCase().replace(/[^A-Z0-9 /@]/g, "");
    if (word.length > 3 && word[3] !== "/") word = `${word.slice(0, 3)} ${word.slice(3)}`;
    if (word.length > 7 && word[7] !== "/") word = `${word.slice(0, 7)} ${word.slice(7)}`;
    word = word.padEnd(11, " ").slice(0, 11);
    const index = position => ALPHANUMERIC.indexOf(word[position]);
    if (index(0) < 0 || [1,2,4,5,6,8,9,10].some(position => index(position) < 0))
      return 0n;
    let packed = BigInt(index(0));
    packed = packed * 38n + BigInt(index(1));
    packed = packed * 38n + BigInt(index(2));
    packed = packed * 2n + BigInt(word[3] === "/");
    for (const position of [4,5,6]) packed = packed * 38n + BigInt(index(position));
    packed = packed * 2n + BigInt(word[7] === "/");
    for (const position of [8,9,10]) packed = packed * 38n + BigInt(index(position));
    return packed;
  }

  function packGrid(input) {
    const grid = String(input).toUpperCase().trim();
    if (!/^[A-R]{2}[0-9]{2}/.test(grid)) return NMAXGRID;
    const longitude = Math.trunc(180 - 20 * (grid.charCodeAt(0) - 65) -
      2 * (grid.charCodeAt(2) - 48) - 62.5 / 60);
    const latitude = Math.trunc(-90 + 10 * (grid.charCodeAt(1) - 65) +
      (grid.charCodeAt(3) - 48) + 31.25 / 60);
    return Math.trunc((longitude + 180) / 2) * 180 + latitude + 90;
  }

  function unpackGrid(value) {
    if (value > NBASEGRID) return "";
    const latitude = value % 180 - 90;
    const longitude = Math.floor(value / 180) * 2 - 178;
    const nlong = Math.trunc(60 * (180 - longitude) / 5);
    const nlat = Math.trunc(60 * (latitude + 90) / 2.5);
    return String.fromCharCode(65 + Math.floor(nlong / 240),
      65 + Math.floor(nlat / 240), 48 + Math.floor((nlong % 240) / 24),
      48 + Math.floor((nlat % 240) / 24));
  }

  function formatSnr(value) {
    const clamped = Math.max(-60, Math.min(60, value));
    return clamped >= 0 ? `+${String(clamped).padStart(2,"0")}`
      : `-${String(Math.abs(clamped)).padStart(2,"0")}`;
  }

  function parseDirectedCommand(input) {
    const source = String(input).trim().toUpperCase();
    for (const item of DIRECTED_COMMANDS) {
      const token = item.token;
      // A token ending in ":" continues without a space -- "MSG TO:OK1BT HI" is
      // how it is typed and how JS8Call's regex (`MSG TO[:]`) matches it. The
      // space-only rule made that text fall through to the shorter " MSG" token
      // with "TO:..." left in the data frames; a JS8Call receiver then filed the
      // whole thing as the intermediary's OWN mail and never stored it for the
      // third party. Only ever visible against a real JS8Call station, because a
      // WIFILT receiver mirrored the same wrong shape on RX.
      if (source !== token && !source.startsWith(`${token} `) &&
          !(token === ">" && source.startsWith(">")) &&
          !(token.endsWith(":") && source.startsWith(token))) continue;
      let consumed = token.length;
      let packedNumber = 0;
      let suffix = "";
      if (item.index === 25 || item.index === 29) {
        const number = source.slice(consumed).match(/^\s+([+-]?\d{1,2})(?=\s|$)/);
        if (number) {
          const normalized = Math.max(-30, Math.min(31, Number(number[1])));
          packedNumber = normalized + 31;
          suffix = ` ${formatSnr(normalized)}`;
          consumed += number[0].length;
        }
      }
      return {...item, source, consumed, packedNumber, suffix};
    }
    return {source, consumed:0, index:31, command:" ", packedNumber:0, suffix:""};
  }

  function huffmanDecode(bits) {
    let code = "";
    let output = "";
    for (const bit of bits) {
      code += bit ? "1" : "0";
      if (Object.hasOwn(HUFF, code)) {
        output += HUFF[code];
        code = "";
      }
    }
    return output;
  }

  function packHuffmanData(input) {
    const text = String(input).toUpperCase();
    const bits = [true, false];
    let consumed = 0;
    for (const character of text) {
      const code = HUFF_ENCODE[character];
      if (!code) return {raw:"",consumed:0};
      if (bits.length + code.length >= 72) break;
      for (const bit of code) bits.push(bit === "1");
      consumed += 1;
    }
    if (consumed === 0) throw new Error("text does not fit a JS8 data frame");
    const used = bits.length;
    while (bits.length < 72) bits.push(bits.length !== used);
    let value = 0n;
    for (const bit of bits) value = (value << 1n) | (bit ? 1n : 0n);
    return {raw: pack72(value), consumed};
  }

  function appendBits(bits,value,width) {
    for(let shift=width-1;shift>=0;shift-=1)bits.push(((value>>shift)&1)===1);
  }

  function denseCodeword(index) {
    const parts=[];
    parts.unshift({value:(index%7)<<1,width:5});
    let quotient=Math.floor(index/7);
    while(quotient>0){
      quotient-=1;
      parts.unshift({value:(quotient%9)+7,width:4});
      quotient=Math.floor(quotient/9);
    }
    const bits=[];
    for(const part of parts)appendBits(bits,part.value,part.width);
    return bits;
  }

  function packDenseData(input, prefix = [true, true]) {
    const text=String(input).toUpperCase(),bits=[...prefix];
    let consumed=0;
    for(const character of text){
      const index=JSC_LITERAL_INDEX[character];
      if(index==null)break;
      const code=denseCodeword(index);
      if(bits.length+code.length>=72)break;
      bits.push(...code); consumed+=1;
    }
    if(consumed===0)return {raw:"",consumed:0};
    const used=bits.length;
    while(bits.length<72)bits.push(bits.length!==used);
    let value=0n;
    for(const bit of bits)value=(value<<1n)|(bit?1n:0n);
    return {raw:pack72(value),consumed};
  }

  function packData(input) {
    const huffman=packHuffmanData(input),dense=packDenseData(input);
    const packed=huffman.consumed>dense.consumed?huffman:dense;
    if(!packed.consumed)throw new Error(`character not supported by JS8: ${String(input)[0]||""}`);
    return packed;
  }

  // Fast data: JSC over all 72 bits with NO prefix. Upstream builds every submode except
  // Normal this way (packFastDataMessage, with JS8_FAST_DATA_CAN_USE_HUFF switched off),
  // and the absence of a Huffman variant is deliberate on their side too -- with no header
  // bit there is nothing to say which of the two encodings a frame carries. The two spare
  // bits are why the fast form exists at all.
  function packFastData(input) {
    const packed=packDenseData(input, []);
    if(!packed.consumed)throw new Error(`character not supported by JS8: ${String(input)[0]||""}`);
    return packed;
  }
  // Which data form to put on the air. Upstream sends the 2-bit-header form on Normal and
  // the headerless one everywhere else (Varicode.cpp:2148), but the RECEIVER decides by the
  // transmitted type bit, not by its own submode (DecodedText::tryUnpackFastData tests
  // `bits_ & JS8CallData`), so both forms are legal in every submode.
  //
  // That matters, because copying upstream's rule blindly makes our messages LONGER: the
  // fast form has no Huffman variant (upstream compiles it out — with no header bit there
  // is nothing to say which encoding a frame holds), and for plain English our Huffman
  // path often beats the dense one. So outside Normal we compute both and keep whichever
  // carries more characters, which is never worse than either rule alone. On Normal we
  // stay byte-for-byte on upstream's choice.
  function chooseDataForm(input, submode) {
    const normal = packData(input);
    if (Number(submode) === 0) return {packed: normal, fast: false};
    let fast = null;
    try { fast = packFastData(input); } catch (_error) { fast = null; }
    return fast && fast.consumed >= normal.consumed
      ? {packed: fast, fast: true} : {packed: normal, fast: false};
  }

  function checksum16(input) {
    let crc=0;
    for(const character of String(input)){
      crc^=character.charCodeAt(0)&0xff;
      for(let bit=0;bit<8;bit+=1)crc=(crc&1)?(crc>>>1)^0x8408:crc>>>1;
    }
    const alphabet="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?";
    return alphabet[Math.floor(crc/(41*41))]+alphabet[Math.floor(crc/41)%41]+alphabet[crc%41];
  }

  function packDirectedHeader(fromCall, toCall, command = 31, number = 0) {
    const from = packCallsign(fromCall);
    const to = packCallsign(toCall);
    if (!from || !to) throw new Error("reply requires two packable base callsigns");
    let value = BigInt(FRAME.DIRECTED);
    value = (value << 28n) | BigInt(from.value);
    value = (value << 28n) | BigInt(to.value);
    value = (value << 5n) | BigInt(command & 31);
    const extra = (from.portable ? 0x80 : 0) | (to.portable ? 0x40 : 0) |
      (number & 0x3f);
    return pack72((value << 8n) | BigInt(extra));
  }

  function directedMessageLayout({myCall, toCall, text}) {
    const parsed = parseDirectedCommand(text);
    const from = String(myCall).trim().toUpperCase();
    const to = String(toCall).trim().toUpperCase();
    if (parsed.consumed) {
      const headerText = `${from}: ${to}${parsed.command}${parsed.suffix}`;
      const remainder = parsed.source.slice(parsed.consumed);
      return {...parsed, headerText, remainder, messageText:headerText + remainder};
    }
    const headerText = `${from}: ${to}${parsed.source ? " " : ""}`;
    return {...parsed, headerText, remainder:parsed.source,
            messageText:headerText + parsed.source};
  }

  function formatDirectedMessage(request) {
    return directedMessageLayout(request).messageText;
  }

  // [3 flag][50 callsign][11][5][3] = 72 — the layout of Varicode::packCompoundFrame.
  function packCompoundFrame(flag, call, number, bits3 = 0) {
    const callsign = packAlphaNumeric50(call);
    if (callsign === 0n) return null;
    const packed11 = BigInt((number >> 5) & 0x7ff);
    const packed8 = BigInt(((number & 0x1f) << 3) | (bits3 & 7));
    const value = (((BigInt(flag) << 50n) | callsign) << 11n) | packed11;
    return pack72((value << 8n) | packed8);
  }

  // A directed command squeezed into the compound frame's number field. SNR commands
  // carry their report in the low six bits; everything else is just the index.
  function compoundCommandNumber(index, packedNumber) {
    if (index !== 25 && index !== 29) return NUSERGRID + (index & 0x7f);
    return NUSERGRID + (0x80 | (index === 29 ? 0x40 : 0) | (packedNumber & 0x3f));
  }

  // True when the addressee does not fit the 28-bit callsign field: a custom group
  // (@ARESGA) or a compound callsign (PA/OK1ABC). Both then travel the long way round.
  function needsCompoundTo(toCall) {
    return packCallsign(toCall) === null;
  }

  // Case 2 of the comment in Varicode.cpp:2205 — a compound addressee. The ordinary
  // directed frame is NOT transmitted at all; the pair below replaces it, which is why
  // a custom group costs one extra slot per message.
  function buildCompoundDirectedFrames({myCall, grid, toCall, text}) {
    const layout = directedMessageLayout({myCall, toCall, text});
    const from = packCompoundFrame(FRAME.COMPOUND, myCall, packGrid(grid || ""));
    const to = packCompoundFrame(FRAME.COMPOUND_DIRECTED, toCall,
      compoundCommandNumber(layout.index, layout.packedNumber));
    if (!from || !to) throw new Error("reply requires a packable callsign and group");
    return {layout, frames: [
      {raw:from, frameType:0, role:"compound", textStart:0, textEnd:0,
       messageText:layout.messageText},
      {raw:to, frameType:0, role:"directed", textStart:0,
       textEnd:layout.headerText.length, messageText:layout.messageText}]};
  }

  function buildReplyFrames({myCall, toCall, text, grid = "", mode = 0}) {
    const compound = needsCompoundTo(toCall)
      ? buildCompoundDirectedFrames({myCall, grid, toCall, text}) : null;
    const layout = compound ? compound.layout : directedMessageLayout({myCall, toCall, text});
    const frames = compound ? compound.frames
      : [{raw:packDirectedHeader(myCall, toCall, layout.index,
                                 layout.packedNumber), frameType:0,
      role:"directed", textStart:0, textEnd:layout.headerText.length,
      messageText:layout.messageText}];
    let remaining = layout.remainder;
    if(layout.consumed&&CHECKSUM_COMMANDS.has(layout.index)&&remaining){
      remaining=remaining.trimStart();
      const skipAprsChecksum=String(toCall).trim().toUpperCase()==="@APRSIS"&&
        (layout.index===9||layout.index===10);
      if(!skipAprsChecksum)remaining+=` ${checksum16(remaining)}`;
    }
    let textStart = layout.headerText.length;
    while (remaining) {
      // Bit 2 of the frame type is what tells the receiver which unpacker to use, and it
      // is transmitted, so the choice can be made per frame on what actually fits.
      const {packed, fast} = chooseDataForm(remaining, mode);
      const textEnd = textStart + packed.consumed;
      frames.push({raw:packed.raw, frameType:fast?4:0, role:"data", textStart, textEnd,
                   messageText:layout.messageText});
      remaining = remaining.slice(packed.consumed);
      textStart = textEnd;
    }
    frames[0].frameType |= 1;
    frames[frames.length - 1].frameType |= 2;
    return frames;
  }

  function buildHeartbeatFrames({myCall, grid}) {
    const callsign = packAlphaNumeric50(myCall);
    if (callsign === 0n) throw new Error("heartbeat requires a valid callsign");
    const normalizedGrid = String(grid).trim().toUpperCase();
    const grid4 = /^[A-R]{2}[0-9]{2}/.test(normalizedGrid) ? normalizedGrid.slice(0,4) : "";
    const number = packGrid(grid4);
    const packed11 = BigInt((number >> 5) & 0x7ff);
    const packed8 = BigInt((number & 0x1f) << 3); // bits3=0: HEARTBEAT, not CQ.
    const value = (((BigInt(FRAME.HEARTBEAT) << 50n) | callsign) << 11n) | packed11;
    const messageText = `${String(myCall).trim().toUpperCase()}: @HB${grid4 ? ` ${grid4}` : ""}`;
    return [{raw:pack72((value << 8n) | packed8), frameType:3, role:"heartbeat",
             textStart:0, textEnd:messageText.length, messageText}];
  }

  function buildCqFrames({myCall, grid, cq = "CQ CQ CQ"}) {
    const callsign = packAlphaNumeric50(myCall);
    if (callsign === 0n) throw new Error("CQ requires a valid callsign");
    const cqIndex = CQ.indexOf(String(cq).trim().toUpperCase());
    if (cqIndex < 0) throw new Error("unsupported CQ type");
    const normalizedGrid = String(grid).trim().toUpperCase();
    const grid4 = /^[A-R]{2}[0-9]{2}/.test(normalizedGrid) ? normalizedGrid.slice(0,4) : "";
    const number = packGrid(grid4) | 0x8000;
    const packed11 = BigInt((number >> 5) & 0x7ff);
    const packed8 = BigInt(((number & 0x1f) << 3) | cqIndex);
    const value = (((BigInt(FRAME.HEARTBEAT) << 50n) | callsign) << 11n) | packed11;
    const messageText = `${String(myCall).trim().toUpperCase()}: @ALLCALL ${CQ[cqIndex]}${grid4 ? ` ${grid4}` : ""}`;
    return [{raw:pack72((value << 8n) | packed8), frameType:3, role:"cq",
             textStart:0, textEnd:messageText.length, messageText}];
  }

  function buildTxFrames(request) {
    if(request && request.kind === "heartbeat")return buildHeartbeatFrames(request);
    if(request && request.kind === "cq")return buildCqFrames(request);
    return buildReplyFrames(request);
  }

  function extractCallsigns(text) {
    const calls = text.match(/\b(?:[0-9A-Z]?[0-9A-Z][0-9][A-Z]{1,3})(?:\/P)?\b/g) || [];
    return [...new Set(calls)];
  }

  function decodeData(value, fast, dictionary) {
    let bits = toBits(value);
    let compressed = true;
    if (!fast) {
      if (!bits[0]) return null;
      compressed = bits[1];
      bits = bits.slice(2);
    }
    const lastPad = bits.lastIndexOf(false);
    if (lastPad < 0) return {kind: "data", protocolType: FRAME.DATA, text: ""};
    bits = bits.slice(0, lastPad);
    const text = compressed
      ? (dictionary ? dictionary.decompress(bits) : "")
      : huffmanDecode(bits);
    return {kind: "data", protocolType: FRAME.DATA, text,
            callsigns: extractCallsigns(text),
            needsDictionary: compressed && !dictionary};
  }

  function decodeDirected(value) {
    if (Number(bitField(value, 0, 3)) !== FRAME.DIRECTED) return null;
    const extra = Number(value & 0xffn);
    const from = unpackCallsign(bitField(value, 3, 28), (extra & 0x80) !== 0);
    const to = unpackCallsign(bitField(value, 31, 28), (extra & 0x40) !== 0);
    const command = COMMANDS[Number(bitField(value, 59, 5))] || "";
    const number = extra & 0x3f;
    let suffix = "";
    if (number !== 0) suffix = command === " SNR" || command === " HEARTBEAT SNR"
      ? formatSnr(number - 31) : String(number - 31);
    const text = `${from}: ${to}${command}${suffix ? ` ${suffix}` : ""} `;
    return {kind: "directed", protocolType: FRAME.DIRECTED, from, to, command,
            number: suffix, callsigns: [from, to], text};
  }

  function decodeCompound(value) {
    const flag = Number(bitField(value, 0, 3));
    if (![FRAME.HEARTBEAT, FRAME.COMPOUND, FRAME.COMPOUND_DIRECTED].includes(flag))
      return null;
    const callsign = unpackAlphaNumeric50(bitField(value, 3, 50));
    const packed11 = Number(bitField(value, 53, 11));
    const extraByte = Number(value & 0xffn);
    const number = (packed11 << 5) | (extraByte >> 3);
    const bits3 = extraByte & 7;
    if (flag === FRAME.HEARTBEAT) {
      const isCq = (number & 0x8000) !== 0;
      const grid = unpackGrid(number & 0x7fff);
      const target = isCq ? "@ALLCALL" : "@HB";
      const command = isCq ? CQ[bits3] : "HEARTBEAT";
      const text = isCq
        ? `${callsign}: ${target} ${command}${grid ? ` ${grid}` : ""} `
        : `${callsign}: ${target}${grid ? ` ${grid}` : ""} `;
      return {kind: isCq ? "cq" : "heartbeat", protocolType: flag, from: callsign,
              to: target, command, grid, callsigns: [callsign],
              text};
    }
    // The number field is either a grid or a reduced-fidelity command, exactly as in
    // Varicode::unpackCompoundMessage. Keep the command in the same shape decodeDirected
    // produces (leading space, report separate), so a stitched pair is indistinguishable
    // downstream from a plain directed frame.
    let grid = "";
    let command = "";
    let suffix = "";
    if (number <= NBASEGRID) grid = unpackGrid(number);
    else if (number >= NUSERGRID && number < NMAXGRID) {
      const packed = number - NUSERGRID;
      const commandIndex = packed & 0x80 ? (packed & 0x40 ? 29 : 25) : packed;
      command = COMMANDS[commandIndex] || "";
      if (packed & 0x80) suffix = formatSnr((packed & 0x3f) - 31);
    }
    const directed = flag === FRAME.COMPOUND_DIRECTED;
    // In a compound-directed frame the packed callsign is the ADDRESSEE, not the sender.
    // Reporting it as `from` credited the recipient with the transmitter's signal report
    // in the stations table -- harmless for a group (@ is skipped there) and a plain lie
    // for a compound callsign.
    const base = {protocolType: flag, grid, callsigns: [callsign]};
    return directed
      ? {...base, kind: "compound-directed", to: callsign, command, number: suffix,
         text: `${callsign}${command}${suffix ? ` ${suffix}` : ""} `}
      : {...base, kind: "compound", from: callsign, command: "", text: `${callsign}: `};
  }

  function decodeFrame(frame, dictionary) {
    const value = unpack72(frame.raw);
    let decoded;
    if ((frame.frameType & 4) === 4) decoded = decodeData(value, true, dictionary);
    else decoded = decodeData(value, false, dictionary) || decodeCompound(value) ||
                   decodeDirected(value);
    return {...frame, ...(decoded || {kind: "unknown", protocolType: FRAME.UNKNOWN,
                                      text: frame.raw, callsigns: []})};
  }

  // Commands that append a 3-char CRC to their payload (Varicode 5,9,10,11,12,
  // 13,24). The token strings, since RX works from decoded command strings.
  const CHECKSUM_COMMAND_STRINGS = new Set(
    [5, 9, 10, 11, 12, 13, 24].map(index => COMMANDS[index]));

  // Extract the clean payload from a fully assembled directed message and, for
  // checksummed commands, verify + strip the trailing CRC. This is the RX
  // counterpart of the ` ${checksum16(remaining)}` the encoder appends.
  function assembledDirectedPayload(directed, fullText) {
    if (!directed) return {payload: "", checksumOk: true};
    const header = `${directed.from}: ${directed.to}${directed.command}`;
    let after = fullText.startsWith(header) ? fullText.slice(header.length) : fullText;
    after = after.replace(/^\s+/, "").trimEnd();
    if (!CHECKSUM_COMMAND_STRINGS.has(directed.command) || !after)
      return {payload: after, checksumOk: true};
    const match = after.match(/^([\s\S]*) ([0-9A-Z+\-./?]{3})$/);
    if (!match) return {payload: after, checksumOk: false};
    return {payload: match[1], checksumOk: checksum16(match[1]) === match[2]};
  }

  // Maps a decoded directed command + assembled payload onto the command the
  // inbox/relay engines expect. The wire uses base tokens (" MSG", " QUERY",
  // ">") with the specifics in the payload: "MSG TO:..." is command MSG with a
  // "TO:" payload, "QUERY MSG 5" is command QUERY with an "MSG 5" payload, etc.
  // Returns {kind:"relay"|"inbox", command?, text} or null when the command has
  // no text-bearing engine (single-frame queries go through the auto-reply path).
  function normalizeAssembledCommand(command, payload) {
    const c = String(command || "").trim().toUpperCase();
    const p = String(payload || "").trim();
    if (c === ">") return {kind: "relay", text: p};
    if (c === "MSG") return /^TO:/i.test(p)
      ? {kind: "inbox", command: "MSG TO:", text: p}
      : {kind: "inbox", command: "MSG", text: p};
    if (c === "MSG TO:") return {kind: "inbox", command: "MSG TO:", text: p};
    if (c === "QUERY CALL") return {kind: "inbox", command: "QUERY CALL", text: p};
    if (c === "QUERY MSGS" || c === "QUERY MSGS?")
      return {kind: "inbox", command: "QUERY MSGS", text: ""};
    if (c === "QUERY") {
      if (/^MSGS\b/i.test(p)) return {kind: "inbox", command: "QUERY MSGS", text: ""};
      if (/^MSG\b/i.test(p)) return {kind: "inbox", command: "QUERY MSG", text: p.replace(/^MSG\s*/i, "")};
      if (/^CALL\b/i.test(p)) return {kind: "inbox", command: "QUERY CALL", text: p.replace(/^CALL\s*/i, "")};
    }
    return null;
  }

  // Slot length per submode. Frames of one message occupy consecutive slots, so a jump
  // in slotUtcMs is the only evidence that says how many frames were lost and where in
  // the text they belonged -- the payload itself carries no frame counter.
  const MODE_PERIOD_SECONDS = {0: 15, 1: 10, 2: 6, 4: 30, 8: 4};
  // Four periods without a frame ends a reassembly. Generous on purpose: a shorter
  // window splits one faded message into two rows (torso + tail), which reads as two
  // unrelated messages and cannot be joined again by hand. Three consecutive missed
  // slots also mean the path is gone anyway.
  const REASSEMBLY_TIMEOUT_PERIODS = 4;
  // Occupied audio width per submode: eight tones spaced 12000/samplesPerSymbol12k
  // apart, i.e. SubmodeSpec::bandwidthHz() in js8_core.cpp evaluated for the five
  // submodes (1920 -> 50, 1200 -> 80, 600 -> 160, 3840 -> 25, 384 -> 250). The
  // reported offset is the LOWEST tone, so a signal occupies offset .. offset+width
  // -- the same convention the modulator uses and the decoder reports back.
  const MODE_BANDWIDTH_HZ = {0: 50, 1: 80, 2: 160, 4: 25, 8: 250};
  function slotPeriodMs(submode) {
    return (MODE_PERIOD_SECONDS[Number(submode)] || 15) * 1000;
  }
  function bandwidthHz(submode) {
    return MODE_BANDWIDTH_HZ[Number(submode)] || 50;
  }

  // FNV-1a. Any stable hash would do; what matters is that it is a pure function of the
  // callsign, so the offset a station picks is reproducible in a test instead of being
  // a different number on every run.
  function callsignHash(call) {
    let hash = 0x811c9dc5;
    for (const character of String(call || "").toUpperCase()) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // Where to answer a query that was addressed to a group. Every member answers the same
  // question in the same slot, so keying on our own fixed offset means two members who
  // never moved off the default collide every single time.
  //
  // Occupancy is exact -- it comes from decoded frames, not from a guess -- but it
  // describes the PAST. The other members are silent right now, so their free-slot lists
  // look like ours, and "take the first free one" would send us all to the same place.
  // The difference therefore has to appear in the CHOICE among free slots, and hashing
  // our own callsign produces it without randomness.
  //
  // Returns null when nothing is free, which is a real state on TURBO: 250 Hz signals
  // leave only about six slots in the whole range. The caller then keys on its own
  // offset and says so, because silently colliding is worse than colliding out loud.
  function pickGroupReplyOffsetHz({frames, myCall, submode, nowMs,
                                   lowHz = 1000, highHz = 2700, periods = 4}) {
    const width = bandwidthHz(submode);
    const horizon = slotPeriodMs(submode) * periods;
    const busy = [];
    for (const frame of frames || []) {
      const offset = Number(frame && frame.offsetHz);
      if (!Number.isFinite(offset)) continue;
      if (Number.isFinite(Number(nowMs)) && Number.isFinite(Number(frame.slotUtcMs))
          && Number(nowMs) - Number(frame.slotUtcMs) > horizon) continue;
      busy.push([offset, offset + bandwidthHz(frame.submode)]);
    }
    const free = [];
    for (let hz = lowHz; hz + width <= highHz; hz += width)
      if (!busy.some(([low, high]) => hz < high && hz + width > low)) free.push(hz);
    return free.length ? free[callsignHash(myCall) % free.length] : null;
  }

  class ActivityStore {
    constructor(dictionary = null) {
      this.dictionary = dictionary;
      this.seen = new Set();
      this.seenOrder = [];
      this.channels = new Map();
      this.calls = new Map();
      this.messages = [];
      this.frames = [];
      this.timing = new Map();
    }

    // A stream reset used to drop every partial reassembly without a trace, which is
    // exactly when frames are being lost. Finalize first, clear after.
    discontinuity() {
      return [...this.channels.values()]
        .map(channel => ({type: "message", message: this.finalizeChannel(channel, false)}));
    }

    // The reassembly clock is the audio window, not the wall clock: drainWindows() emits
    // one per slot whether anything decoded or not, so this keeps working on a dead band
    // and stays deterministic in tests. Also driven from the page on a 1 s job, so a
    // stalled audio path still lands the torso in messages[] where it gets persisted.
    expire(nowMs) {
      const emitted = [];
      for (const channel of [...this.channels.values()]) {
        const deadline = REASSEMBLY_TIMEOUT_PERIODS * slotPeriodMs(channel.submode);
        if (Number(nowMs) - Number(channel.lastSlotUtcMs) < deadline) continue;
        emitted.push({type: "message", message: this.finalizeChannel(channel, false)});
      }
      return emitted;
    }

    // Every way a channel can end funnels through here. `complete` is the decoded EOT
    // frame and nothing else: an incomplete message keeps whatever text did arrive
    // instead of being dropped, and carries the flag that keeps it out of the relay,
    // inbox, file transfer and chat paths.
    finalizeChannel(channel, complete) {
      this.channels.delete(channel.key);
      const text = channel.text.trimEnd();
      const {payload, checksumOk} = assembledDirectedPayload(channel.directed, text);
      const message = {...channel, text, payload, checksumOk,
                       complete: Boolean(complete), incomplete: !complete};
      this.messages.push(message);
      if (this.messages.length > 200) this.messages.shift();
      return message;
    }

    push(frame) {
      const key = `${frame.slotUtcMs}|${frame.submode}|${Number(frame.offsetHz).toFixed(1)}|${frame.raw}`;
      if (this.seen.has(key)) return [];
      this.seen.add(key);
      this.seenOrder.push(key);
      if (this.seenOrder.length > 2048) this.seen.delete(this.seenOrder.shift());
      const decoded = decodeFrame(frame, this.dictionary);
      this.frames.push(decoded);
      if (this.frames.length > 500) this.frames.shift();
      const previousTiming = this.timing.get(frame.submode);
      this.timing.set(frame.submode, {submode: frame.submode,
        samples: (previousTiming ? previousTiming.samples : 0) + 1,
        meanDtMs: previousTiming
          ? previousTiming.meanDtMs * 0.8 + Number(frame.dtMs || 0) * 0.2
          : Number(frame.dtMs || 0), lastSlotUtcMs: frame.slotUtcMs});
      const channelKey = `${frame.submode}|${Math.round(Number(frame.offsetHz) / 5) * 5}`;
      let channel = this.channels.get(channelKey);
      // A new message taking the channel used to overwrite the old text. Finalize it
      // instead: a lost final frame then costs the ending, not the whole reception.
      const superseded = channel && (frame.frameType & 1)
        ? this.finalizeChannel(channel, false) : null;
      if (!channel || (frame.frameType & 1))
        channel = {key: channelKey, id: `${channelKey}|${frame.slotUtcMs}`,
                   text: "", raw: [], kinds: [], firstSlotUtcMs: frame.slotUtcMs,
                   lastSlotUtcMs: frame.slotUtcMs, submode: frame.submode,
                   offsetHz: frame.offsetHz, callsigns: [], directed: null, compoundFrom: "",
                   // A channel opened by a frame that is not the first one means we tuned
                   // into the middle: the header, and with it from/to/command, is gone.
                   headerMissing: !(frame.frameType & 1), gaps: [], frameCount: 0};
      else {
        // Consecutive slots are the rule, so the jump names the loss exactly. textIndex
        // is where the missing text belonged; the marker never claims a character count,
        // because JSC compression makes chars-per-frame variable.
        const period = slotPeriodMs(channel.submode);
        const missed = Math.max(0,
          Math.round((Number(frame.slotUtcMs) - Number(channel.lastSlotUtcMs)) / period) - 1);
        if (missed > 0) channel.gaps.push({textIndex: channel.text.length, frames: missed,
                                           slotUtcMs: Number(channel.lastSlotUtcMs) + period});
      }
      channel.frameCount += 1;
      // The first frame carries the structured {from,to,command}; keep it so the
      // completed message can yield a clean, checksum-verified payload.
      if (!channel.directed && decoded.kind === "directed")
        channel.directed = {from: decoded.from, to: decoded.to, command: decoded.command};
      // A compound addressee arrives as a PAIR -- `MYCALL GRID` then `@GROUP CMD` -- and
      // the ordinary directed frame is never sent, so from/to/command exist only once the
      // two are put back together. Without this the message has no addressee at all and
      // every engine downstream (auto-reply, inbox, relay, the chat thread) ignores it.
      if (decoded.kind === "compound" && decoded.from) channel.compoundFrom = decoded.from;
      if (decoded.kind === "compound-directed" && !channel.directed)
        channel.directed = {from: channel.compoundFrom || "<....>", to: decoded.to,
                            command: decoded.command};
      channel.text += decoded.text;
      channel.raw.push(frame.raw);
      channel.kinds.push(decoded.kind);
      channel.lastSlotUtcMs = frame.slotUtcMs;
      // SNR of the LAST frame, deliberately not a mean over the reception: every other
      // number the finished message carries (timestamp, age) is the last slot too, and a
      // mean would be the single field pointing at a different moment than the rest. It
      // rides into the message through the spread in finalizeChannel(), so nothing
      // downstream has to be told about it.
      channel.snr = frame.snr;
      channel.callsigns = [...new Set([...channel.callsigns, ...(decoded.callsigns || [])])];
      this.channels.set(channelKey, channel);
      for (const call of decoded.callsigns || []) {
        if (!call || call.startsWith("@") || call === "<....>") continue;
        const previous = this.calls.get(call);
        // A callsign enters this table two ways: it transmitted the frame, or it was
        // merely named in one (the addressee of somebody else's directed message, a
        // call listed in a HEARING report). Only the first kind was actually heard,
        // so only it may claim the frame's signal numbers -- crediting the sender's
        // SNR to the station being talked about is a lie the map would then draw.
        const direct = decoded.from === call;
        this.calls.set(call, {call, lastSlotUtcMs: frame.slotUtcMs,
                             snr: direct ? frame.snr : (previous ? previous.snr : null),
                             offsetHz: direct ? frame.offsetHz : (previous ? previous.offsetHz : null),
                             submode: direct ? frame.submode : (previous ? previous.submode : null),
                             dtMs: direct ? frame.dtMs : (previous ? previous.dtMs : null),
                             quality: direct ? frame.quality : (previous ? previous.quality : null),
                             heardDirectly: direct || Boolean(previous && previous.heardDirectly),
                             grid: direct ? decoded.grid || previous?.grid || "" : previous?.grid || ""});
      }
      const emitted = [{type: "protocol-frame", frame: decoded}];
      if (superseded) emitted.push({type: "message", message: superseded});
      if (frame.frameType & 2)
        emitted.push({type: "message", message: this.finalizeChannel(channel, true)});
      return emitted;
    }

    snapshot() {
      return {frames: this.frames.slice(), messages: this.messages.slice(),
              channels: [...this.channels.values()],
              calls: [...this.calls.values()].sort((a, b) => a.call.localeCompare(b.call)),
              timing: [...this.timing.values()].sort((a, b) => a.submode - b.submode)};
    }
  }

  return {ActivityStore, FRAME, JscDictionary, SPECIAL_CALLS, MODE_PERIOD_SECONDS, MODE_BANDWIDTH_HZ,
          REASSEMBLY_TIMEOUT_PERIODS, buildCqFrames, buildHeartbeatFrames, buildReplyFrames,
          checksum16, formatDirectedMessage, normalizeAssembledCommand,
          callsignHash, pickGroupReplyOffsetHz, needsCompoundTo, chooseDataForm,
          buildTxFrames, decodeFrame, slotPeriodMs, bandwidthHz,
          pack72, unpack72};
});
