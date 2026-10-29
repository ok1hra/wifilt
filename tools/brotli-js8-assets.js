#!/usr/bin/env node
"use strict";

const fs=require("fs"), path=require("path"), zlib=require("zlib");
const directory=path.resolve(process.argv[2] || path.join(__dirname,"..","data"));
// mercury-host.wasm ships as .br too, expanded by data/brotli-asset.js.
const candidates=fs.readdirSync(directory).filter(name=>
  /^js8-.*\.(?:js|wasm|bin)$/.test(name) || name==="mercury-host.wasm").sort();
for(const name of candidates){
  const source=path.join(directory,name), target=`${source}.br`;
  const input=fs.readFileSync(source);
  // Brotli's FONT context model is occasionally smaller even for opaque
  // binary tables/WASM. Both modes produce the same standard Brotli stream;
  // retain the smaller result to protect the tight SPIFFS working margin.
  const modes=name.endsWith(".js") ? [zlib.constants.BROTLI_MODE_TEXT] :
    [zlib.constants.BROTLI_MODE_GENERIC,zlib.constants.BROTLI_MODE_FONT];
  const output=modes.map(mode=>zlib.brotliCompressSync(input,{params:{
    [zlib.constants.BROTLI_PARAM_QUALITY]:11,
    [zlib.constants.BROTLI_PARAM_MODE]:mode,
  }})).sort((a,b)=>a.length-b.length)[0];
  fs.writeFileSync(target,output);
}
for(const name of fs.readdirSync(directory).filter(name=>name.endsWith(".br"))){
  const source=path.join(directory,name.slice(0,-3));
  if(!fs.existsSync(source)) fs.unlinkSync(path.join(directory,name));
}
console.log(`==> Brotli JS8 assets ready (${candidates.length} files)`);
