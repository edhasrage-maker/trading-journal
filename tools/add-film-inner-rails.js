const sharp = require('sharp');

const input = process.argv[2];
const output = process.argv[3];

if (!input || !output) {
  throw new Error('Usage: node add-film-inner-rails.js <input> <output>');
}

(async () => {
  const { width, height } = await sharp(input).metadata();
  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1024 558">
      <defs>
        <linearGradient id="bronze" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#C09663"/>
          <stop offset="0.52" stop-color="#A77B4A"/>
          <stop offset="1" stop-color="#80572E"/>
        </linearGradient>
        <clipPath id="above-word"><rect width="1024" height="258"/></clipPath>
        <clipPath id="below-word"><rect y="318" width="1024" height="240"/></clipPath>
      </defs>

      <!-- Inner edge of the upper film ribbon; the wordmark naturally occludes its lower end. -->
      <path d="M505 264 L610 159 L657 206"
            fill="none" stroke="#442F1B" stroke-opacity="0.55" stroke-width="9"
            stroke-linecap="butt" stroke-linejoin="miter" transform="translate(2 2)"
            clip-path="url(#above-word)"/>
      <path d="M505 264 L610 159 L657 206"
            fill="none" stroke="url(#bronze)" stroke-width="6"
            stroke-linecap="butt" stroke-linejoin="miter"
            clip-path="url(#above-word)"/>

      <!-- Inner edge of the lower film ribbon; no sprocket holes belong on this border. -->
      <path d="M407 368 L445 330 L494 405 L626 273"
            fill="none" stroke="#442F1B" stroke-opacity="0.55" stroke-width="9"
            stroke-linecap="butt" stroke-linejoin="miter" transform="translate(2 2)"
            clip-path="url(#below-word)"/>
      <path d="M407 368 L445 330 L494 405 L626 273"
            fill="none" stroke="url(#bronze)" stroke-width="6"
            stroke-linecap="butt" stroke-linejoin="miter"
            clip-path="url(#below-word)"/>
    </svg>`);

  await sharp(input)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(output);
})();
