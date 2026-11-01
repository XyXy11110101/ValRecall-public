import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const payload = Buffer.concat([name, data]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  payload.copy(output, 4);
  output.writeUInt32BE(crc32(payload), data.length + 8);
  return output;
}

function createIcon(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const offset = 1 + x * 4;
      const edge = Math.min(x, y, size - x - 1, size - y - 1);
      const line =
        Math.abs(x - y) < Math.max(1, size / 12) ||
        Math.abs(x + y - size + 1) < Math.max(1, size / 12);
      const accent = edge > size * 0.12 && line;
      const rgb = accent ? [241, 179, 74] : edge < size * 0.1 ? [18, 48, 61] : [28, 77, 92];
      row[offset] = rgb[0];
      row[offset + 1] = rgb[1];
      row[offset + 2] = rgb[2];
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('public/icons', { recursive: true });
await Promise.all(
  [16, 32, 48, 128].map((size) => writeFile(`public/icons/icon${size}.png`, createIcon(size))),
);
