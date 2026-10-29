#!/usr/bin/env node
// PROTOTYPE — mechanically compacts the upstream read-only JSC decode map.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EXPECTED_MAP_SHA256 = "ab2bd62ef594f4629a2c93b6de43f5469b1fd6fe67ebf4d24f915bd11ccef813";

function decodeCString(source) {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "\\") {
      out += source[i];
      continue;
    }
    const escaped = source[++i];
    if (escaped === "n") out += "\n";
    else if (escaped === "r") out += "\r";
    else if (escaped === "t") out += "\t";
    else if (escaped === "x") {
      const hex = source.slice(i + 1, i + 3);
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 2;
    } else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(source[i + 1] || ""))
        octal += source[++i];
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else out += escaped;
  }
  return out;
}

function main() {
  if (process.argv.length !== 4) {
    console.error("usage: build-jsc-map.js JSC_map.cpp OUTPUT.bin");
    process.exit(2);
  }
  const source = fs.readFileSync(path.resolve(process.argv[2]));
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  if (digest !== EXPECTED_MAP_SHA256)
    throw new Error(`unreviewed JSC map: ${digest}`);
  const input = source.toString("utf8");
  const tuple = /\{\s*"((?:\\.|[^"\\])*)"(?:\s|\/\*[\s\S]*?\*\/)*,\s*(\d+)\s*,\s*(\d+)\s*\}/g;
  const words = [];
  let declaredLengthDifferences = 0;
  let match;
  while ((match = tuple.exec(input)) !== null) {
    const word = Buffer.from(decodeCString(match[1]), "latin1");
    const declaredLength = Number(match[2]);
    const declaredIndex = Number(match[3]);
    if (word.length !== declaredLength) declaredLengthDifferences += 1;
    if (declaredIndex !== words.length)
      throw new Error(`bad JSC tuple ${words.length}: ${match[0]}`);
    words.push(word);
  }
  if (words.length !== 262144)
    throw new Error(`expected 262144 JSC entries, found ${words.length}`);

  // JSC3: the words themselves, NUL-separated, instead of JSC2's length table
  // followed by the concatenated text. Same bytes either way, but Brotli sees
  // the word boundaries in the text and the shipped .br is ~21 kB smaller.
  // NUL, not newline: one upstream word contains "\n", none contains NUL.
  const payloadBytes = words.reduce((sum, word) => sum + word.length, 0);
  const output = Buffer.alloc(8 + payloadBytes + words.length - 1);
  output.write("JSC3", 0, "ascii");
  output.writeUInt32LE(words.length, 4);
  let dataOffset = 8;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].includes(0))
      throw new Error(`JSC word ${i} contains NUL, the JSC3 separator`);
    if (i > 0) dataOffset += 1;
    words[i].copy(output, dataOffset);
    dataOffset += words[i].length;
  }
  fs.mkdirSync(path.dirname(path.resolve(process.argv[3])), {recursive: true});
  fs.writeFileSync(path.resolve(process.argv[3]), output);
  console.log(`JSC entries=${words.length} raw_bytes=${output.length} ` +
              `text_bytes=${payloadBytes} declared_length_differences=${declaredLengthDifferences}`);
}

main();
