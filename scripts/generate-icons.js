// This script generates placeholder icons for the Chrome extension
// Run with: node scripts/generate-icons.js

import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sizes = [16, 32, 48, 128];
const outputDir = join(__dirname, '..', 'public', 'icons');

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#BF4045';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.125);
  ctx.fill();

  // Text
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${size * 0.5}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('墨', size / 2, size / 2 + size * 0.05);

  const buffer = canvas.toBuffer('image/png');
  writeFileSync(join(outputDir, `icon${size}.png`), buffer);
  console.log(`Generated icon${size}.png`);
});

console.log('All icons generated!');
