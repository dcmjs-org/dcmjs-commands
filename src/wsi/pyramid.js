// src/wsi/pyramid.js
//
// Builds every level of a tiled whole-slide pyramid in one pass over the
// base image. The base arrives as row strips, top to bottom; each level
// keeps one band of `tile` rows, encodes the band's tiles when it is full,
// and passes the band, downsampled by `factor`, to the next level. Peak
// memory is about one band per level (tile x level width x spp bytes).

import { copyRect, downsampleBox } from "../pixel/resample.js";

/** Level geometry, from the base down to the first level that fits one tile. */
export function planLevels({ width, height, tile, factor }) {
  const levels = [];
  let w = width;
  let h = height;
  for (let level = 0; ; level++) {
    const tilesX = Math.ceil(w / tile);
    const tilesY = Math.ceil(h / tile);
    levels.push({
      level,
      width: w,
      height: h,
      tilesX,
      tilesY,
      frames: tilesX * tilesY,
      scale: factor ** level,
    });
    if (tilesX === 1 && tilesY === 1) {
      return levels;
    }
    w = Math.ceil(w / factor);
    h = Math.ceil(h / factor);
  }
}

class LevelBuilder {
  /**
   * @param {object} plan one entry of planLevels()
   * @param {(tile: object, plan: object) => Promise<void>} onTile receives
   *   each full `tile` x `tile` image, in row-major order.
   */
  constructor({ plan, tile, factor, spp, background, onTile, next }) {
    this.plan = plan;
    this.tile = tile;
    this.factor = factor;
    this.onTile = onTile;
    this.next = next;
    this.background = background;
    this.band = {
      data: new Uint8Array(tile * plan.width * spp),
      width: plan.width,
      height: tile,
      spp,
    };
    this.tileImage = {
      data: new Uint8Array(tile * tile * spp),
      width: tile,
      height: tile,
      spp,
    };
    this.filled = 0;
    this.rowsDone = 0;
  }

  /** Appends `strip` (full level width) below the rows received so far. */
  async addRows(strip) {
    let from = 0;
    while (from < strip.height) {
      const take = Math.min(strip.height - from, this.tile - this.filled);
      copyRect(strip, 0, from, this.band, 0, this.filled, strip.width, take);
      this.filled += take;
      from += take;
      if (this.filled === this.tile) {
        await this.flush();
      }
    }
  }

  async flush() {
    if (!this.filled) {
      return;
    }
    const rows = Math.min(this.filled, this.plan.height - this.rowsDone);
    for (let tx = 0; tx < this.plan.tilesX; tx++) {
      this.tileImage.data.fill(this.background);
      copyRect(
        this.band,
        tx * this.tile,
        0,
        this.tileImage,
        0,
        0,
        this.tile,
        rows
      );
      await this.onTile(this.tileImage, this.plan);
    }
    if (this.next) {
      const valid = { ...this.band, height: rows };
      valid.data = this.band.data.subarray(
        0,
        rows * this.band.width * this.band.spp
      );
      await this.next.addRows(downsampleBox(valid, this.factor));
    }
    this.rowsDone += rows;
    this.filled = 0;
  }

  async finish() {
    await this.flush();
    await this.next?.finish();
  }
}

/**
 * Chains one LevelBuilder per planned level. Feed the base image with
 * `addRows()` and close with `finish()`.
 */
export function createPyramidBuilder({
  levels,
  tile,
  factor,
  spp,
  background,
  onTile,
}) {
  let next;
  for (let i = levels.length - 1; i >= 0; i--) {
    next = new LevelBuilder({
      plan: levels[i],
      tile,
      factor,
      spp,
      background,
      onTile,
      next,
    });
  }
  return next;
}

/**
 * Turns decoded source tiles, which arrive in raster order, into full-width
 * row strips for the pyramid. Holds one row of source tiles.
 */
export class TileRowAssembler {
  constructor({
    width,
    height,
    tileWidth,
    tileHeight,
    spp,
    background,
    onStrip,
  }) {
    this.width = width;
    this.height = height;
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;
    this.onStrip = onStrip;
    this.background = background;
    this.strip = {
      data: new Uint8Array(tileHeight * width * spp).fill(background),
      width,
      height: tileHeight,
      spp,
    };
    this.rowY = 0;
  }

  /** `x`, `y` are 0-based positions in the total pixel matrix. */
  async addTile(tile, x, y) {
    if (y < this.rowY) {
      throw new Error(
        `source tiles are not in raster order (tile at row ${y} after row ${this.rowY})`
      );
    }
    while (y >= this.rowY + this.tileHeight) {
      await this.emitStrip();
    }
    copyRect(tile, 0, 0, this.strip, x, y - this.rowY, tile.width, tile.height);
  }

  async emitStrip() {
    const rows = Math.min(this.tileHeight, this.height - this.rowY);
    if (rows > 0) {
      await this.onStrip({
        ...this.strip,
        height: rows,
        data: this.strip.data.subarray(0, rows * this.width * this.strip.spp),
      });
    }
    this.strip.data.fill(this.background);
    this.rowY += this.tileHeight;
  }

  async finish() {
    while (this.rowY < this.height) {
      await this.emitStrip();
    }
  }
}
