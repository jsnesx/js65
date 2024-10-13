
"use strict";

const hs = Array.from(Array(16), (_, i) => i.toString(16));
const hsr = hs.slice().reverse();
const h2s =  hs.join("").match(/../g), h2sr = hsr.join("").match(/../g);
const h2mix = hs.map((h, i) => `${hsr[i]}${h}`);
const hseq = h2s.concat(h2sr, h2mix).map(hex => parseInt(hex, 16));
const H = new Uint32Array(Uint8Array.from(hseq.slice(0, 20)).buffer);
const K = Uint32Array.from(
    [2, 3, 5, 10], v => Math.floor(Math.sqrt(v) * (2 ** 30)));
const F = [
    (b, c, d) => ((b & c) | ((~b >>> 0) & d)) >>> 0,
    (b, c, d) => b ^ c ^ d,
    (b, c, d) => (b & c) | (b & d) | (c & d),
    (b, c, d) => b ^ c ^ d,    
];
function rotl(v, n) {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
}

export function sha1(buffer) {
    const u8a = ArrayBuffer.isView(buffer) ?
          new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) :
          new Uint8Array(buffer);
    const total = Math.ceil((u8a.length + 9) / 64) * 64;
    const chunks = new Uint8Array(total);
    chunks.set(u8a);
    chunks.fill(0, u8a.length);
    chunks[u8a.length] = 0x80;
    const lenbuf = new DataView(chunks.buffer, total - 8);
    const low = u8a.length % (1 << 29);
    const high = (u8a.length - low) / (1 << 29);
    lenbuf.setUint32(0, high, false);
    lenbuf.setUint32(4, low << 3, false);
    
    const hash = H.slice();
    const w = new Uint32Array(80);
    for (let offs = 0; offs < total; offs += 64) {
        const chunk = new DataView(chunks.buffer, offs, 64);
        for (let i = 0; i < 16; i++) w[i] = chunk.getUint32(i * 4, false);
        for (let i = 16; i < 80; i++) {
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        }
        let [a, b, c, d, e] = hash;
        for (let s = 0; s < 4; s++) {
            for (let i = s * 20, end = i + 20; i < end; i++) {
                const ne = rotl(a, 5) + F[s](b, c, d) + e + K[s] + w[i];
                [a, b, c, d, e] = [ne >>> 0, a, rotl(b, 30), c, d];
            }
        }
        hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d; hash[4] += e;
    }
    const digest = new DataView(new ArrayBuffer(20));
    hash.forEach((v, i) => digest.setUint32(i * 4, v, false));
    return digest.buffer;
}