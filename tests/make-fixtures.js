// Builds test images for the browser test. Needs sharp: SHARP=/path/to/sharp node tests/make-fixtures.js <outdir>
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require(process.env.SHARP || 'sharp');
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

// A busy test pattern so JPEG sizes are realistic.
function pattern(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = (x * 7 + y * 3) % 256;
      buf[i + 1] = (x ^ y) % 256;
      buf[i + 2] = ((x / 8) | 0) % 2 === ((y / 8) | 0) % 2 ? 230 : 40;
    }
  }
  return buf;
}

(async () => {
  // 1. A 12-megapixel "camera photo" with location and owner details in its EXIF.
  await sharp(pattern(4032, 3024), { raw: { width: 4032, height: 3024, channels: 3 } })
    .withExif({
      IFD0: { Artist: 'SECRET-EXIF-MARKER', Make: 'TestCam' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '37/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '144/1 57/1 0/1' }
    })
    .jpeg({ quality: 90 })
    .toFile(path.join(out, 'camera.jpg'));

  // 2. Stored landscape (400x300) but flagged "rotate 90°", so it should show as portrait 300x400.
  await sharp(pattern(400, 300), { raw: { width: 400, height: 300, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(path.join(out, 'rotated.jpg'));

  // 3. A screenshot-style PNG with transparency.
  await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toFile(path.join(out, 'transparent.png'));

  // 4. Something that claims to be a JPEG but isn't.
  fs.writeFileSync(path.join(out, 'broken.jpg'), Buffer.from('this is not really a photo'));

  for (const f of fs.readdirSync(out)) {
    const buf = fs.readFileSync(path.join(out, f));
    console.log(f, buf.length, 'bytes', buf.includes(Buffer.from('SECRET-EXIF-MARKER')) ? '(has EXIF marker)' : '');
  }
})().catch((e) => { console.error(e); process.exit(1); });
