// The app icon, drawn in code so the repo holds no binaries: a lens ring with a handle,
// in the addon's signal orange on its base black. Used by the Overwolf and desktop builds.

import { deflateSync } from "node:zlib";

const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
export function png(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
export function draw(size, gray) {
    const bg = [11, 12, 15], fg = gray ? [150, 154, 160] : [200, 120, 58], rim = [255, 255, 255];
    const px = Buffer.alloc(size * size * 4);
    const S = 4; // supersampling
    const cx = 0.44, cy = 0.44, r1 = 0.21, r2 = 0.29;
    const inside = (x, y) => {
        // rounded square background with a hairline edge
        const m = 0.04, rad = 0.12;
        const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - rad), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - rad), 0);
        const d = Math.hypot(qx, qy) - rad;
        if (d > 0) return null;
        const dc = Math.hypot(x - cx, y - cy);
        if (dc >= r1 && dc <= r2) return fg;                       // lens ring
        // handle: a thick segment from the ring towards the bottom right
        const t = ((x - cx) + (y - cy)) / 2, px2 = cx + t, py2 = cy + t;
        const off = Math.hypot(x - px2, y - py2);
        if (t > (r2 - 0.02) / Math.SQRT2 && t < 0.36 && off < 0.055) return fg;
        if (d > -0.012) return rim.map((v, i) => Math.round(bg[i] + (v - bg[i]) * 0.12));
        return bg;
    };
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const acc = [0, 0, 0, 0];
            for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
                const c = inside((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
                if (c) { acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255; }
            }
            const n = S * S, a = acc[3] / n, i = (y * size + x) * 4;
            px[i] = a ? Math.round(acc[0] / (acc[3] / 255)) : 0;
            px[i + 1] = a ? Math.round(acc[1] / (acc[3] / 255)) : 0;
            px[i + 2] = a ? Math.round(acc[2] / (acc[3] / 255)) : 0;
            px[i + 3] = Math.round(a);
        }
    }
    return png(size, px);
}
export function ico(images) {
    const head = Buffer.alloc(6 + 16 * images.length);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
    let offset = head.length;
    images.forEach(({ size, data }, i) => {
        const e = 6 + i * 16;
        head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
        head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
        head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
        offset += data.length;
    });
    return Buffer.concat([head, ...images.map((i) => i.data)]);
}
