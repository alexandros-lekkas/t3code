#!/usr/bin/env node

// Fork: renders the Boat app icon (official T3 wordmark on a dithered graphite-to-Boat-blue pixel
// tile, after Cogenly's mark) into every BRAND_ASSET_PATHS icon, the apps/web/public copies, the
// Android artwork and favicon.svg. Replaces upstream's Icon Composer export; rerun after upstream
// merges that touch icons. `--check` fails when a tracked icon differs from a fresh render.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const BOX = 128;
const CORNER = 28;
const TILE_FROM = [0x14, 0x14, 0x18] as const;
const TILE_TO = [0x2b, 0x47, 0xbc] as const;
const TONE_STEPS = 4;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
const SMALL_MAX_SIZE = 32;

/** The colour Android shows behind the launcher artwork; the middle of the tile's gradient. */
export const BOAT_MARK_BACKGROUND = "#1C254F";

// T3 wordmark from assets/prod/logo.svg; it spans x 15.53..109.93, y 37..93.96 of the 128 box.
const T3_PATH =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";
const T3_BOUNDS = { x: 15.53, y: 37, width: 94.4, height: 56.96 };

const toHex = (channel: number) => Math.round(channel).toString(16).padStart(2, "0").toUpperCase();

const TONES = Array.from({ length: TONE_STEPS }, (_, index) => {
  const t = index / (TONE_STEPS - 1);
  return `#${[0, 1, 2].map((ch) => toHex(TILE_FROM[ch]! + (TILE_TO[ch]! - TILE_FROM[ch]!) * t)).join("")}`;
});

/** Tone for a cell: its row's place in the gradient, ordered-dithered by Bayer 4x4. */
function toneAt(column: number, row: number, gradientRows: number, firstRow: number): number {
  const position = ((row - firstRow + 0.5) / gradientRows) * (TONE_STEPS - 1);
  const value = Math.min(TONE_STEPS - 1, Math.max(0, position));
  const base = Math.floor(value);
  const threshold = (BAYER[(row & 3) * 4 + (column & 3)]! + 0.5) / 16;
  return Math.min(TONE_STEPS - 1, value - base > threshold ? base + 1 : base);
}

/**
 * The dithered fill as one `<rect>` per run of equal tone. `cells` covers the whole box; the
 * gradient runs over `gradientRows` rows starting at `firstRow` and holds its end tones outside.
 */
function pixelFill(cells: number, gradientRows = cells, firstRow = 0): string {
  const size = BOX / cells;
  const rects: string[] = [];
  for (let row = 0; row < cells; row++) {
    let column = 0;
    while (column < cells) {
      const tone = toneAt(column, row, gradientRows, firstRow);
      let end = column + 1;
      while (end < cells && toneAt(end, row, gradientRows, firstRow) === tone) end++;
      rects.push(
        `<rect x="${column * size}" y="${row * size}" width="${(end - column) * size}" height="${size}" fill="${TONES[tone]}"/>`,
      );
      column = end;
    }
  }
  return `<g shape-rendering="crispEdges">${rects.join("")}</g>`;
}

/** The wordmark scaled about its centre and moved to (cx, cy) in the box. */
function wordmark(scale: number, cx = BOX / 2, cy = BOX / 2): string {
  const gx = T3_BOUNDS.x + T3_BOUNDS.width / 2;
  const gy = T3_BOUNDS.y + T3_BOUNDS.height / 2;
  return `<path transform="translate(${cx} ${cy}) scale(${scale}) translate(${-gx} ${-gy})" d="${T3_PATH}" fill="#FFFFFF"/>`;
}

const svg = (body: string) =>
  `<svg width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${body}\n</svg>\n`;

const RIM = `<rect x="1.75" y="1.75" width="124.5" height="124.5" rx="26.25" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="1.5"/>`;

/** The full mark: rounded pixel tile, faint rim, wordmark where the T3 icon has it. */
export const BOAT_MARK = svg(
  `<defs><clipPath id="boat-tile"><rect width="${BOX}" height="${BOX}" rx="${CORNER}"/></clipPath></defs>\n` +
    `<g clip-path="url(#boat-tile)">${pixelFill(16)}</g>\n${RIM}\n${wordmark(1)}`,
);
/** The cut for 32px and below: coarser grid, no rim, larger wordmark. */
const BOAT_MARK_SMALL = svg(
  `<defs><clipPath id="boat-tile-small"><rect width="${BOX}" height="${BOX}" rx="${CORNER}"/></clipPath></defs>\n` +
    `<g clip-path="url(#boat-tile-small)">${pixelFill(8)}</g>\n${wordmark(1.1)}`,
);
/** Square and opaque, for iOS, which applies its own mask. */
const BOAT_MARK_FULL_BLEED = svg(`${pixelFill(16)}\n${wordmark(1)}`);

// Android masks the central 72dp of a 108dp adaptive canvas (and the splash the central two
// thirds of 288dp), so the tile is full bleed over 24 cells, its gradient spanning the visible
// middle 16, and the wordmark is a separate transparent layer at 48% of the canvas.
const ANDROID_BACKGROUND = svg(pixelFill(24, 16, 4));
const ANDROID_FOREGROUND = svg(wordmark((BOX * 0.48) / T3_BOUNDS.width));
const ANDROID_ADAPTIVE_SIZE = 432;
const ANDROID_SPLASH_SIZE = 1152;

// The classic macOS safe area: an 824px body inset 100px on a 1024px canvas.
const MAC_CANVAS = 1024;
const MAC_INSET = 100;

async function rasterize(source: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(source), { density: (72 * size) / BOX })
    .resize(size, size)
    .png()
    .toBuffer();
}

const markPng = (size: number) =>
  rasterize(size <= SMALL_MAX_SIZE ? BOAT_MARK_SMALL : BOAT_MARK, size);

async function renderOutputs(): Promise<ReadonlyArray<readonly [string, Buffer]>> {
  const ico = encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await markPng(size) })),
    ),
  );
  const mac = await sharp(await markPng(MAC_CANVAS - MAC_INSET * 2))
    .extend({
      top: MAC_INSET,
      bottom: MAC_INSET,
      left: MAC_INSET,
      right: MAC_INSET,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const universal = await markPng(1024);
  const ios = await sharp(await rasterize(BOAT_MARK_FULL_BLEED, 1024))
    .removeAlpha()
    .png()
    .toBuffer();
  const appleTouch = await markPng(180);
  const icon192 = await markPng(192);
  const icon512 = await markPng(512);
  const favicon16 = await markPng(16);
  const favicon32 = await markPng(32);

  const androidForeground = await rasterize(ANDROID_FOREGROUND, ANDROID_ADAPTIVE_SIZE);
  const androidBackground = await rasterize(ANDROID_BACKGROUND, ANDROID_ADAPTIVE_SIZE);
  const androidSplash = await sharp(await rasterize(ANDROID_BACKGROUND, ANDROID_SPLASH_SIZE))
    .composite([{ input: await rasterize(ANDROID_FOREGROUND, ANDROID_SPLASH_SIZE) }])
    .png()
    .toBuffer();

  const P = BRAND_ASSET_PATHS;
  const outputs: Array<readonly [string, Buffer]> = [];
  for (const brand of ["development", "nightly", "production"] as const) {
    const at = (key: string) => P[`${brand}${key}` as keyof typeof P];
    outputs.push(
      [brand === "development" ? P.developmentDesktopIconPng : at("MacIconPng"), mac],
      [brand === "development" ? P.developmentUniversalIconPng : at("LinuxIconPng"), universal],
      [at("IosIconPng"), ios],
      [at("WindowsIconIco"), ico],
      [at("WebFaviconIco"), ico],
      [at("WebFavicon16Png"), favicon16],
      [at("WebFavicon32Png"), favicon32],
      [at("WebAppleTouchIconPng"), appleTouch],
      [at("WebIcon192Png"), icon192],
      [at("WebIcon512Png"), icon512],
    );
  }
  // apps/web/public serves the development set to the dev server and the boot splash.
  const bySource = new Map(outputs);
  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    outputs.push([override.targetRelativePath, bySource.get(override.sourceRelativePath)!]);
  }
  outputs.push(["apps/mobile/assets/android-icon-foreground.png", androidForeground]);
  for (const variant of ["dev", "nightly", "prod"] as const) {
    outputs.push(
      [`apps/mobile/assets/android-icon-background-${variant}.png`, androidBackground],
      [`apps/mobile/assets/android-splash-icon-${variant}.png`, androidSplash],
    );
  }
  outputs.push(["favicon.svg", Buffer.from(BOAT_MARK)]);
  return outputs;
}

/** RGBA pixels of a PNG, or of each PNG inside an ICO. */
async function decodeImages(path: string, contents: Buffer): Promise<Buffer[]> {
  if (path.endsWith(".ico")) {
    const count = contents.readUInt16LE(4);
    return Promise.all(
      Array.from({ length: count }, (_, index) => {
        const entry = 6 + index * 16;
        const length = contents.readUInt32LE(entry + 8);
        const offset = contents.readUInt32LE(entry + 12);
        return decodeImages("rendition.png", contents.subarray(offset, offset + length)).then(
          ([pixels]) => pixels!,
        );
      }),
    );
  }
  return [await sharp(contents).ensureAlpha().raw().toBuffer()];
}

/** Rasterizers differ by a few levels across platforms, so pixels match within a tolerance. */
async function matches(path: string, expected: Buffer, actual: Buffer): Promise<boolean> {
  if (expected.equals(actual)) return true;
  if (!path.endsWith(".png") && !path.endsWith(".ico")) return false;
  try {
    const [a, b] = await Promise.all([decodeImages(path, expected), decodeImages(path, actual)]);
    if (a.length !== b.length) return false;
    return a.every((pixels, index) => {
      const other = b[index]!;
      if (pixels.length !== other.length) return false;
      let total = 0;
      for (let i = 0; i < pixels.length; i++) {
        const delta = Math.abs(pixels[i]! - other[i]!);
        if (delta > 48) return false;
        total += delta;
      }
      return total / pixels.length < 1;
    });
  } catch {
    return false;
  }
}

const renderBoatMark = Effect.fn("renderBoatMark")(function* (check: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const outputs = yield* Effect.promise(renderOutputs);
  if (!check) {
    for (const [relativePath, contents] of outputs) {
      yield* fs.writeFile(path.join(repoRoot, relativePath), contents);
    }
    yield* Console.log(`Rendered the Boat mark into ${outputs.length} files.`);
    return;
  }
  const stale: string[] = [];
  for (const [relativePath, expected] of outputs) {
    const actual = yield* fs
      .readFile(path.join(repoRoot, relativePath))
      .pipe(Effect.orElseSucceed(() => null));
    const same =
      actual !== null &&
      (yield* Effect.promise(() => matches(relativePath, expected, Buffer.from(actual))));
    if (!same) stale.push(relativePath);
  }
  if (stale.length > 0) {
    return yield* Effect.die(
      `These icons differ from scripts/render-boat-mark.ts; run \`vp run icons:export\`:\n  ${stale.join("\n  ")}`,
    );
  }
  yield* Console.log(`All ${outputs.length} icons match scripts/render-boat-mark.ts.`);
});

if (import.meta.main) {
  renderBoatMark(process.argv.includes("--check")).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
