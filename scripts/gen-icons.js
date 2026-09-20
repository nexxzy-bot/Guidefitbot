#!/usr/bin/env node
/* Генерация иконок GuideFit для Android (RuStore):
   — лаунчер-иконки всех плотностей, полностью залитый фон (alpha=255 по всей площади),
   — ic-store-512.png (512×512, RGB без alpha) для карточки приложения в консоли RuStore.
   Запуск: node scripts/gen-icons.js */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'android/app/src/main/res');

// Фирменный градиент GuideFit (аква → глубина) + знак «дневник + пульс»
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#38BDF8"/>
      <stop offset="1" stop-color="#0E7490"/>
    </linearGradient>
    <linearGradient id="sh2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="0" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#sh2)"/>
  <g fill="none" stroke="#FFFFFF" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M150 178 h212 a26 26 0 0 1 26 26 v130 a26 26 0 0 1 -26 26 h-212 a26 26 0 0 1 -26 -26 v-130 a26 26 0 0 1 26 -26 z"/>
    <path d="M124 236 h264"/>
    <path d="M160 300 h84"/>
    <path d="M300 316 l30 -36 l26 24 l34 -48"/>
  </g>
  <g stroke="#FFFFFF" stroke-width="26" stroke-linecap="round">
    <path d="M124 250 h-20"/>
    <path d="M388 250 h20"/>
  </g>
</svg>`;

(async () => {
  const sizes = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
  for (const [dir, size] of Object.entries(sizes)) {
    const buf = Buffer.from(svg(size));
    await sharp(buf, { density: 300 }).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(outDir, dir, 'ic_launcher.png'));
    console.log('✓', dir, size + 'x' + size);
  }
  // Иконка для карточки RuStore: 512×512, без прозрачности, ≤1MB
  const buf512 = Buffer.from(svg(512));
  // .flatten() убирает alpha-канал: фон залит целиком, а PNG с неиспользуемой
  // прозрачностью валидаторы карточки RuStore считают «с прозрачностью».
  await sharp(buf512, { density: 300 }).resize(512, 512).flatten({ background: '#0E7490' })
    .png({ compressionLevel: 9 }).toFile(path.join(root, 'android', 'ic-store-512.png'));
  console.log('✓ ic-store-512.png (для консоли RuStore)');

  // Сплэш-экран 1080×1920: тот же знак, что у лаунчера, умеренного размера,
  // по центру на системном светлом фоне (совпадает с фоном сплэша в MainActivity)
  const W = 1080, H = 1920, icon = 240;
  const iconPng = await sharp(Buffer.from(svg(icon)), { density: 300 }).resize(icon, icon).png().toBuffer();
  await sharp({ create: { width: W, height: H, channels: 4, background: '#F2F7FC' } })
    .composite([{ input: iconPng, left: Math.round((W - icon) / 2), top: Math.round((H - icon) / 2) }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, 'drawable', 'splash.png'));
  console.log('✓ drawable/splash.png (1080×1920, знак 240px по центру)');
})();
