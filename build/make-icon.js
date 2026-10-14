#!/usr/bin/env node
// Draws the Session Board icon and bakes it into an .icns.
//
// The mark is the app at rest: the rail it collapses to, standing on edge with
// a session dot for each state it can report. Green working, amber waiting on
// you, grey closed — the same three colours the panel uses, so the icon and the
// window are demonstrably the same object.
//
//   node build/make-icon.js            writes build/icon.svg + build/icon.icns
//   node build/make-icon.js --preview  writes both marks at three sizes to the
//                                      scratch folder for a look first
//
// Needs Inkscape (for SVG -> PNG) and iconutil (ships with macOS).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const INKSCAPE = '/Applications/Inkscape.app/Contents/MacOS/inkscape';
const OUT = __dirname;

// The panel's own tokens. Nothing here is picked for the icon alone.
const PLATE_TOP = '#232a3a';
const PLATE_BOTTOM = '#0e1016';
const RAIL = '#171a23';
const RAIL_EDGE = '#333c50';
const WORKING = '#3ddc84';
const WAITING = '#ffb531';
const CLOSED = '#4a5366';
const INK_DIM = '#8b93a5';

// macOS draws app icons on an 824-point square inside a 1024 canvas, with the
// rounded-rect corner radius Big Sur settled on. Anything outside that is
// margin the system expects to be empty.
const PLATE = { x: 100, y: 100, size: 824, radius: 185 };

function field() {
  return `<linearGradient id="field" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PLATE_TOP}"/>
      <stop offset="1" stop-color="${PLATE_BOTTOM}"/>
    </linearGradient>`;
}

function plate() {
  return `<rect x="${PLATE.x}" y="${PLATE.y}" width="${PLATE.size}" height="${PLATE.size}"
        rx="${PLATE.radius}" fill="url(#field)"/>`;
}

// The rail: one tall pill, three dots. Sized so the dots survive the 32-point
// rendering, where anything finer than about four pixels is a smudge.
function railMark() {
  const W = 300;
  const H = 646;
  const x = 512 - W / 2;
  const y = 512 - H / 2;
  const r = 74;
  const cx = 512;
  const ys = [y + 132, 512, y + H - 132];
  const fills = [WORKING, WAITING, CLOSED];
  const dots = ys.map((cy, i) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fills[i]}"/>`).join('\n    ');
  return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${W / 2}"
        fill="${RAIL}" stroke="${RAIL_EDGE}" stroke-width="10"/>
    ${dots}`;
}

// The open list: a dot and a title per row. More literal, and more to lose at
// small sizes, which is the whole question the preview is for.
function panelMark() {
  const W = 540;
  const H = 580;
  const x = 512 - W / 2;
  const y = 512 - H / 2;
  const r = 40;
  const barH = 46;
  const rows = [
    { fill: WORKING, w: 1 },
    { fill: WAITING, w: 0.78 },
    { fill: CLOSED, w: 0.9 },
  ];
  const pad = 62;
  const gap = (H - pad * 2 - rows.length * barH) / (rows.length - 1);
  const body = rows.map((row, i) => {
    const cy = y + pad + barH / 2 + i * (barH + gap);
    const bx = x + pad + r * 2 + 34;
    const bw = (x + W - pad - bx) * row.w;
    return `<circle cx="${x + pad + r}" cy="${cy}" r="${r}" fill="${row.fill}"/>
    <rect x="${bx}" y="${cy - barH / 2}" width="${bw.toFixed(1)}" height="${barH}"
          rx="${barH / 2}" fill="${INK_DIM}" opacity=".5"/>`;
  }).join('\n    ');
  return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="58"
        fill="${RAIL}" stroke="${RAIL_EDGE}" stroke-width="10"/>
    ${body}`;
}

const MARKS = { rail: railMark, panel: panelMark };

function svg(mark) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    ${field()}
  </defs>

  ${plate()}

  ${MARKS[mark]()}
</svg>
`;
}

function render(svgPath, pngPath, size) {
  execFileSync(INKSCAPE, [
    svgPath,
    '--export-type=png',
    `--export-filename=${pngPath}`,
    `--export-width=${size}`,
    `--export-height=${size}`,
  ], { stdio: 'ignore' });
}

// The five sizes macOS asks for, each at 1x and 2x.
const ICONSET = [16, 32, 128, 256, 512];

function buildIcns(svgPath, icnsPath) {
  const set = icnsPath.replace(/\.icns$/, '.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set, { recursive: true });
  for (const size of ICONSET) {
    render(svgPath, path.join(set, `icon_${size}x${size}.png`), size);
    render(svgPath, path.join(set, `icon_${size}x${size}@2x.png`), size * 2);
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', icnsPath]);
  fs.rmSync(set, { recursive: true, force: true });
}

function main() {
  const preview = process.argv.includes('--preview');
  const which = (process.argv.find((a) => a.startsWith('--mark=')) || '').split('=')[1];

  if (preview) {
    const dir = process.env.PREVIEW_DIR || OUT;
    for (const name of Object.keys(MARKS)) {
      const s = path.join(dir, `icon-${name}.svg`);
      fs.writeFileSync(s, svg(name));
      for (const size of [512, 128, 32]) {
        render(s, path.join(dir, `icon-${name}-${size}.png`), size);
      }
    }
    console.log(`preview PNGs written to ${dir}`);
    return;
  }

  const mark = which || 'rail';
  if (!MARKS[mark]) throw new Error(`unknown mark "${mark}"`);
  const svgPath = path.join(OUT, 'icon.svg');
  fs.writeFileSync(svgPath, svg(mark));
  buildIcns(svgPath, path.join(OUT, 'icon.icns'));
  render(svgPath, path.join(OUT, 'icon.png'), 512);   // for non-mac packaging
  console.log('build/icon.svg, build/icon.icns and build/icon.png written');
}

main();
