/* Pure-JS FLAC decoder: works on any phone, no browser codec needed.
   Returns {sampleRate, numberOfChannels, length, duration, bits, ints:[Int32Array], getChannelData(c)} */
function flacDecode(ab){
  const buf = new Uint8Array(ab); let pos = 0; // bit position
  const bits = (n)=>{ let v=0; while(n>0){ const off=pos&7, avail=8-off, take=avail<n?avail:n; v = v*(1<<take) + ((buf[pos>>3] >> (avail-take)) & ((1<<take)-1)); pos+=take; n-=take; } return v; };
  const sbits = (n)=>{ if(!n) return 0; const v=bits(n); return v >= 2**(n-1) ? v - 2**n : v; };
  const unary = ()=>{ let q=0; for(;;){ const off=pos&7, b=(buf[pos>>3]<<off)&0xFF; if (b===0){ q+=8-off; pos+=8-off; if ((pos>>3)>=buf.length) throw new Error("FLAC: обрыв данных"); } else { const lz=Math.clz32(b)-24; q+=lz; pos+=lz+1; return q; } } };
  if (String.fromCharCode(buf[0],buf[1],buf[2],buf[3])!=="fLaC"){
    // skip ID3v2 tag in front, if any
    if (buf[0]===0x49&&buf[1]===0x44&&buf[2]===0x33){ const sz=((buf[6]&127)<<21)|((buf[7]&127)<<14)|((buf[8]&127)<<7)|(buf[9]&127); pos=(10+sz)*8; if (String.fromCharCode(buf[10+sz],buf[11+sz],buf[12+sz],buf[13+sz])!=="fLaC") throw new Error("Это не FLAC"); }
    else throw new Error("Это не FLAC");
  }
  pos += 32;
  let sr=0, ch=0, bps=0, total=0, last=false;
  while(!last){
    last = bits(1)===1; const type=bits(7), len=bits(24); const start=pos;
    if (type===0){ bits(16); bits(16); bits(24); bits(24); sr=bits(20); ch=bits(3)+1; bps=bits(5)+1; total=bits(36); }
    pos = start + len*8;
  }
  if (!sr||!ch) throw new Error("FLAC: нет STREAMINFO");
  let cap = total || sr*60*10; let out=[]; for(let c=0;c<ch;c++) out.push(new Int32Array(cap));
  let n=0;
  const grow=(need)=>{ if (need<=cap) return; cap=Math.max(need, cap*2); out=out.map(a=>{ const b=new Int32Array(cap); b.set(a); return b; }); };
  const res=new Int32Array(65536); const tmp=[]; for(let c=0;c<8;c++) tmp.push(new Float64Array(65536));
  const BS=[0,192,576,1152,2304,4608,-8,-16,256,512,1024,2048,4096,8192,16384,32768];
  const SS=[0,8,12,0,16,20,24,32];
  const residual=(dst, bsize, order)=>{
    const method=bits(2); if (method>1) throw new Error("FLAC: неизвестный остаток");
    const pbits=method?5:4, esc=method?31:15, porder=bits(4), parts=1<<porder;
    let i=order;
    for (let p=0;p<parts;p++){
      const cnt=(bsize>>porder)-(p===0?order:0); const k=bits(pbits);
      if (k===esc){ const nb=bits(5); for (let j=0;j<cnt;j++) dst[i++]=sbits(nb); }
      else if (k===0){ for (let j=0;j<cnt;j++){ const u=unary(); dst[i++]=(u&1)?-((u+1)/2):u/2; } }
      else { const m=1<<k; for (let j=0;j<cnt;j++){ const u=unary()*m+bits(k); dst[i++]=(u%2)?-((u+1)/2):u/2; } }
    }
  };
  const subframe=(dst, bsize, sb)=>{
    bits(1); const type=bits(6); let wasted=0;
    if (bits(1)){ wasted=unary()+1; sb-=wasted; }
    if (type===0){ const v=sbits(sb); for (let i=0;i<bsize;i++) dst[i]=v; }
    else if (type===1){ for (let i=0;i<bsize;i++) dst[i]=sbits(sb); }
    else if (type>=8 && type<=12){
      const order=type-8; for (let i=0;i<order;i++) dst[i]=sbits(sb);
      residual(dst, bsize, order);
      if (order===1) for (let i=1;i<bsize;i++) dst[i]+=dst[i-1];
      else if (order===2) for (let i=2;i<bsize;i++) dst[i]+=2*dst[i-1]-dst[i-2];
      else if (order===3) for (let i=3;i<bsize;i++) dst[i]+=3*dst[i-1]-3*dst[i-2]+dst[i-3];
      else if (order===4) for (let i=4;i<bsize;i++) dst[i]+=4*dst[i-1]-6*dst[i-2]+4*dst[i-3]-dst[i-4];
    }
    else if (type>=32){
      const order=type-31; for (let i=0;i<order;i++) dst[i]=sbits(sb);
      const prec=bits(4)+1, shift=sbits(5), div=2**shift; const co=[]; for (let j=0;j<order;j++) co.push(sbits(prec));
      residual(dst, bsize, order);
      for (let i=order;i<bsize;i++){ let s=0; for (let j=0;j<order;j++) s+=co[j]*dst[i-1-j]; dst[i]+=Math.floor(s/div); }
    } else throw new Error("FLAC: неизвестный подкадр");
    if (wasted){ const m=2**wasted; for (let i=0;i<bsize;i++) dst[i]*=m; }
  };
  const endBit = buf.length*8;
  while (pos+16*8 < endBit){
    pos = (pos+7)&~7;
    // find frame sync 0xFFF8 / 0xFFF9
    let p=pos>>3; while (p+1<buf.length && !(buf[p]===0xFF && (buf[p+1]&0xFE)===0xF8)) p++;
    if (p+1>=buf.length) break;
    pos=p*8; const frameStart=pos;
    try{
      bits(15); bits(1);
      const bsc=bits(4), src=bits(4), ca=bits(4), ssc=bits(3); bits(1);
      // UTF-8 coded frame / sample number
      let x=bits(8); if (x&0x80){ let more= x>=0xFC?5 : x>=0xF8?4 : x>=0xF0?3 : x>=0xE0?2 : 1; while(more--) bits(8); }
      let bsize=BS[bsc]; if (bsize===-8) bsize=bits(8)+1; else if (bsize===-16) bsize=bits(16)+1;
      if (src===12) bits(8); else if (src===13||src===14) bits(16);
      bits(8); // CRC-8
      if (!bsize || bsize>65535) throw 0;
      const sbps = ssc ? SS[ssc] : bps; if (!sbps) throw 0;
      const nch = ca<8 ? ca+1 : 2; if (nch!==ch) throw 0;
      for (let c=0;c<nch;c++){
        let sb=sbps; if ((ca===8&&c===1)||(ca===9&&c===0)||(ca===10&&c===1)) sb++;
        subframe(tmp[c], bsize, sb);
      }
      grow(n+bsize);
      const a=tmp[0], b=tmp[1];
      if (ca===8){ for (let i=0;i<bsize;i++){ out[0][n+i]=a[i]; out[1][n+i]=a[i]-b[i]; } }
      else if (ca===9){ for (let i=0;i<bsize;i++){ out[0][n+i]=a[i]+b[i]; out[1][n+i]=b[i]; } }
      else if (ca===10){ for (let i=0;i<bsize;i++){ const side=b[i]; const mid=a[i]*2+(side&1); out[0][n+i]=(mid+side)/2; out[1][n+i]=(mid-side)/2; } }
      else for (let c=0;c<nch;c++){ const t=tmp[c], o=out[c]; for (let i=0;i<bsize;i++) o[n+i]=t[i]; }
      n+=bsize;
      pos=(pos+7)&~7; pos+=16; // CRC-16
    }catch(e){ if (e instanceof Error && /обрыв/.test(e.message)) break; pos=frameStart+8; }
  }
  if (!n) throw new Error("FLAC: не удалось декодировать");
  const ints = out.map(a=>a.subarray(0,n)); const scale = 2**(bps-1);
  return { sampleRate:sr, numberOfChannels:ch, length:n, duration:n/sr, bits:bps, ints,
    getChannelData:(c)=>{ const s=ints[c], f=new Float32Array(n); for (let i=0;i<n;i++) f[i]=s[i]/scale; return f; } };
}
/* PCM WAV file from decoded integer samples (lossless, keeps 16/24-bit) */
function wavFromInts(ints, sr, srcBits){
  const ch=ints.length, n=ints[0].length, ob = srcBits>16 ? 24 : 16, bps=ob/8, shift=srcBits-ob;
  const dataLen=n*ch*bps, ab=new ArrayBuffer(44+dataLen), dv=new DataView(ab), u8=new Uint8Array(ab);
  const w=(o,s)=>{ for(let i=0;i<4;i++) u8[o+i]=s.charCodeAt(i); };
  w(0,"RIFF"); dv.setUint32(4,36+dataLen,true); w(8,"WAVE"); w(12,"fmt "); dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,ch,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*ch*bps,true); dv.setUint16(32,ch*bps,true); dv.setUint16(34,ob,true); w(36,"data"); dv.setUint32(40,dataLen,true);
  let o=44; const div=2**Math.max(0,shift), mul=2**Math.max(0,-shift);
  for (let i=0;i<n;i++) for (let c=0;c<ch;c++){
    let v=ints[c][i]; v = shift>0 ? Math.floor(v/div) : v*mul;
    if (ob===16){ dv.setInt16(o,v,true); o+=2; } else { u8[o]=v&255; u8[o+1]=(v>>8)&255; u8[o+2]=(v>>16)&255; o+=3; }
  }
  return new Blob([ab], {type:"audio/wav"});
}
if (typeof module!=="undefined") module.exports={flacDecode, wavFromInts};
