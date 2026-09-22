const sharp = require('sharp');

const input = process.argv[2];
const output = process.argv[3];

if (!input || !output) {
  throw new Error('Usage: node remove-logo-stars.js <input> <output>');
}

(async () => {
  // Use nearby untouched background as the fill source, then feather it only over
  // the two sparkle silhouettes. This preserves the central logo pixel-for-pixel.
  const patch = await sharp(input)
    .extract({ left: 900, top: 275, width: 124, height: 170 })
    .modulate({ brightness: 0.965 })
    .png()
    .toBuffer();

  const mask = await sharp({
    create: { width: 124, height: 170, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="124" height="170" xmlns="http://www.w3.org/2000/svg">
          <defs><filter id="f"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
          <ellipse cx="42" cy="114" rx="29" ry="29" fill="white" filter="url(#f)"/>
          <ellipse cx="88" cy="134" rx="42" ry="35" fill="white" filter="url(#f)"/>
        </svg>`),
    }])
    .ensureAlpha()
    .png()
    .toBuffer();

  const maskedPatch = await sharp(patch)
    .joinChannel(await sharp(mask).extractChannel(3).toBuffer())
    .png()
    .toBuffer();

  const edgePatch = await sharp(input)
    .extract({ left: 1019, top: 300, width: 5, height: 80 })
    .modulate({ brightness: 0.965 })
    .png()
    .toBuffer();

  await sharp(input)
    .composite([
      { input: maskedPatch, left: 900, top: 355 },
      { input: edgePatch, left: 1019, top: 450 },
    ])
    .png()
    .toFile(output);
})();
