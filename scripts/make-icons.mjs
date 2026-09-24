// Eklenti simgeleri: icons/icon{16,32,48,128}.png.
//
// Kullanım:  node scripts/make-icons.mjs
//
// Tasarım ilk icon128.png'yi üreten betikle AYNI: düz koyu zemin, 5×7 blok
// harf "R". O betik stdlib Python'du (zlib + struct + binascii) ve repoda
// değildi; burada yalnız Node'un yerleşik modülleriyle yeniden yazıldı —
// bağımlılık yok, tek araç zinciri.
//
// Hücre boyutu 128'de 14 px (orijinal). Diğer boyutlarda `size * 14 / 128`
// YUVARLANIYOR, aşağı değil: 16 px'te aşağı yuvarlama 1 px hücre, yani 5×7'lik
// bir harf verir ve simgenin üçte birini doldurur; yuvarlama 2 px hücreyle
// orijinal orana yakın kalıyor.
//
// Çıktı her koşuda aynı bayt (zaman damgası ya da metadata yok).

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SIZES = [16, 32, 48, 128];

const BG = [31, 41, 51]; // koyu kurşun
const FG = [235, 240, 245]; // kirli beyaz

// 5×7 blok harf "R"
const GLYPH = ["11110", "10001", "10001", "11110", "10100", "10010", "10001"];

/** Orijinal: 128 px'te 14 px hücre. */
function cellFor(size) {
  return Math.max(1, Math.round((size * 14) / 128));
}

function pixels(size) {
  const cell = cellFor(size);
  const glyphWidth = 5 * cell;
  const glyphHeight = 7 * cell;
  const offsetX = Math.floor((size - glyphWidth) / 2);
  const offsetY = Math.floor((size - glyphHeight) / 2);

  // Her satır: filtre baytı (0) + RGB.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0;
    const gy = Math.floor((y - offsetY) / cell);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - offsetX) / cell);
      const on =
        y >= offsetY &&
        y < offsetY + glyphHeight &&
        x >= offsetX &&
        x < offsetX + glyphWidth &&
        GLYPH[gy]?.[gx] === "1";
      const color = on ? FG : BG;
      raw[at++] = color[0];
      raw[at++] = color[1];
      raw[at++] = color[2];
    }
  }
  return raw;
}

function chunk(tag, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit derinliği
  header[9] = 2; // RGB
  header[10] = 0; // sıkıştırma
  header[11] = 0; // filtre
  header[12] = 0; // interlace yok
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels(size), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const data = png(size);
  const path = resolve(ROOT, `icons/icon${size}.png`);
  await writeFile(path, data);
  console.log(`icons/icon${size}.png: ${data.length} bayt, ${size}×${size} RGB, hücre ${cellFor(size)} px`);
}
