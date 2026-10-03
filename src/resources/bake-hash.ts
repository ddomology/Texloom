/** Portable synchronous SHA-256 for verified inline bake preparation (no Node or WebCrypto dependency). */
export function sha256BakeBytes(bytes:Uint8Array):string {
  if(!(bytes instanceof Uint8Array))throw new TypeError('SHA-256 expects a Uint8Array.');
  const constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const hash=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const word=new Uint32Array(64),rotate=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  const blocks=Math.floor(bytes.length/64)+1+(bytes.length%64>=56?1:0),bitLength=BigInt(bytes.length)*8n;
  for(let block=0;block<blocks;block++){
    const start=block*64;
    for(let i=0;i<16;i++){
      let value=0;for(let byte=0;byte<4;byte++){
        const index=start+i*4+byte;
        const input=index<bytes.length?bytes[index]:index===bytes.length?0x80:index>=blocks*64-8?Number((bitLength>>BigInt((blocks*64-1-index)*8))&255n):0;
        value=(value<<8)|input;
      }word[i]=value;
    }
    for(let i=16;i<64;i++){
      const a=word[i-15],b=word[i-2],s0=rotate(a,7)^rotate(a,18)^(a>>>3),s1=rotate(b,17)^rotate(b,19)^(b>>>10);
      word[i]=(word[i-16]+s0+word[i-7]+s1)>>>0;
    }
    let [a,b,c,d,e,f,g,h]=hash;
    for(let i=0;i<64;i++){
      const s1=rotate(e,6)^rotate(e,11)^rotate(e,25),choose=(e&f)^(~e&g),t1=(h+s1+choose+constants[i]+word[i])>>>0;
      const s0=rotate(a,2)^rotate(a,13)^rotate(a,22),majority=(a&b)^(a&c)^(b&c),t2=(s0+majority)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((v,i)=>{hash[i]=(hash[i]+v)>>>0;});
  }
  return Array.from(hash,v=>v.toString(16).padStart(8,'0')).join('');
}
