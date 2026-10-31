/* ==========================================================================
   MediFlow Pharmacy ERP - QR Code generator (bundled locally, no CDN)
   --------------------------------------------------------------------------
   A compact ISO/IEC 18004 QR Code encoder supporting byte-mode payloads,
   automatic version selection (1-40) and automatic data-mask selection.
   Implements the standard algorithm: data encoding -> Reed-Solomon error
   correction -> block interleaving -> module placement -> masking.

   Public API:
     qrMatrix(text, ecc)            -> boolean[][]  (true = dark module)
     qrSvg(text, options)           -> SVG markup string
     qrSvgFromMatrix(matrix, opts)  -> SVG markup string

   Error correction levels: 'L' (7%), 'M' (15%), 'Q' (25%), 'H' (30%).
   ========================================================================== */

/* ---------------------------------------------------------------- tables */

// Error-correction codewords per block, indexed [ecc][version].
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
];

// Number of error-correction blocks, indexed [ecc][version].
const NUM_ECC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 5, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
];

const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
// Format-information bit patterns for each level (not the same order as above).
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ------------------------------------------------------- helper functions */

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

/** Total number of data+ECC modules available in a version. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Number of 8-bit data codewords (excluding ECC) for a version/level. */
function dataCodewords(version, ecc) {
  const e = ECC_INDEX[ecc];
  return Math.floor(rawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[e][version] * NUM_ECC_BLOCKS[e][version];
}

/** Multiply two bytes in GF(2^8) with the QR primitive polynomial 0x11D. */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Reed-Solomon remainder (the ECC codewords) for a data block. */
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

/** Alignment-pattern centre coordinates for a version. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const size = version * 4 + 17;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/* ------------------------------------------------------------- encoding */

/** UTF-8 encode the payload into a byte array. */
function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

/** Build the bit stream for a single byte-mode segment. */
function buildBitStream(bytes, version, capacityBits) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push(getBit(value, i) ? 1 : 0);
  };

  push(0b0100, 4);                                 // byte mode indicator
  push(bytes.length, version <= 9 ? 8 : 16);       // character count
  bytes.forEach((b) => push(b, 8));                // payload

  // Terminator (up to four zero bits) then pad to a byte boundary.
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);

  // Alternating pad codewords until the data capacity is filled.
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    push(pad, 8);
  }

  const out = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => { if (bit) out[i >>> 3] |= 0x80 >>> (i & 7); });
  return out;
}

/** Split data into blocks, append ECC, then interleave into the final stream. */
function addEccAndInterleave(data, version, ecc) {
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ECC_BLOCKS[e][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = Array.from(data.slice(k, k + len));
    k += len;
    const block = dat.slice();
    if (i < numShortBlocks) block.push(0); // placeholder keeps blocks equal length
    blocks.push(block.concat(Array.from(rsRemainder(dat, divisor))));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // Skip the placeholder byte of every short block.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return Uint8Array.from(result);
}

/* --------------------------------------------------------- symbol drawing */

class Symbol2D {
  constructor(version, ecc) {
    this.version = version;
    this.ecc = ecc;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFunction(x, y, dark) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFunction(x + dx, y + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(mask) {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // First copy, around the top-left finder pattern.
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

    // Second copy, split between the other two finder patterns.
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, getBit(bits, i));
    this.setFunction(8, this.size - 8, true); // mandatory dark module
  }

  drawVersionBits() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawFunctionPatterns() {
    // Timing patterns on row and column 6.
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // The three finder corners have no alignment pattern.
        const corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
        if (!corner) this.drawAlignment(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  /** Place the interleaved codewords in the standard upward/downward zigzag. */
  drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** XOR the data region with one of the eight standard masks (reversible). */
  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Standard penalty score used to pick the most scannable mask. */
  penaltyScore() {
    const size = this.size;
    let result = 0;

    const runPenalty = (runLength) => (runLength >= 5 ? PENALTY_N1 + (runLength - 5) : 0);

    // Rule 1: runs of five or more same-colour modules in a row/column.
    for (let y = 0; y < size; y++) {
      let runColor = false; let runLen = 0;
      for (let x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) { runLen++; }
        else { result += runPenalty(runLen); runColor = this.modules[y][x]; runLen = 1; }
      }
      result += runPenalty(runLen);
    }
    for (let x = 0; x < size; x++) {
      let runColor = false; let runLen = 0;
      for (let y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) { runLen++; }
        else { result += runPenalty(runLen); runColor = this.modules[y][x]; runLen = 1; }
      }
      result += runPenalty(runLen);
    }

    // Rule 2: 2x2 blocks of the same colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with a 4-module light margin.
    const finder = [true, false, true, true, true, false, true];
    const hasFinder = (get, i, limit) => {
      for (let k = 0; k < 7; k++) if (get(i + k) !== finder[k]) return false;
      let light = 0;
      for (let k = i - 1; k >= 0 && light < 4; k--, light++) if (get(k)) return false;
      if (light >= 4) return true;
      light = 0;
      for (let k = i + 7; k < limit && light < 4; k++, light++) if (get(k)) return false;
      return light >= 4;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x <= size - 7; x++) {
        if (hasFinder((i) => this.modules[y][i], x, size)) result += PENALTY_N3;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y <= size - 7; y++) {
        if (hasFinder((i) => this.modules[i][x], y, size)) result += PENALTY_N3;
      }
    }

    // Rule 4: deviation of dark-module proportion from 50%.
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(0, k) * PENALTY_N4;

    return result;
  }
}

/* --------------------------------------------------------------- public API */

/**
 * Encode text into a QR Code module matrix.
 * @param {string} text payload (UTF-8, byte mode)
 * @param {'L'|'M'|'Q'|'H'} ecc error-correction level
 * @returns {boolean[][]} matrix[y][x], true for dark modules
 */
export function qrMatrix(text, ecc = 'M') {
  const level = ECC_INDEX[ecc] === undefined ? 'M' : ecc;
  const bytes = utf8Bytes(text);

  // Smallest version whose data capacity holds the payload.
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const capacityBits = dataCodewords(v, level) * 8;
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    if (headerBits + bytes.length * 8 <= capacityBits) { version = v; break; }
  }
  if (!version) throw new Error('QR payload too long to encode (max 40 versions exceeded).');

  const capacityBits = dataCodewords(version, level) * 8;
  const dataBytes = buildBitStream(bytes, version, capacityBits);
  const codewords = addEccAndInterleave(dataBytes, version, level);

  const sym = new Symbol2D(version, level);
  sym.drawFunctionPatterns();
  sym.drawCodewords(codewords);

  // Try all eight masks and keep the one with the lowest penalty.
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    sym.applyMask(mask);
    sym.drawFormatBits(mask);
    const score = sym.penaltyScore();
    if (score < bestScore) { bestScore = score; bestMask = mask; }
    sym.applyMask(mask); // XOR again to revert
  }
  sym.applyMask(bestMask);
  sym.drawFormatBits(bestMask);

  return sym.modules;
}

/**
 * Render a module matrix as a crisp, scalable SVG string.
 * @param {boolean[][]} matrix
 * @param {{size?:number, margin?:number, dark?:string, light?:string, title?:string}} options
 */
export function qrSvgFromMatrix(matrix, options = {}) {
  const {
    size = 0,            // 0 = responsive (uses viewBox only)
    margin = 2,          // quiet zone in modules (4 is the spec minimum, 2 is fine for labels)
    dark = '#000000',
    light = '#ffffff',
    title = ''
  } = options;

  const count = matrix.length;
  const dim = count + margin * 2;

  // Build one path for all dark modules - far fewer DOM nodes than per-module rects.
  let path = '';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (matrix[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }

  const dims = size ? ` width="${size}" height="${size}"` : '';
  const label = title ? `<title>${String(title).replace(/[<>&]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"${dims} `
    + `shape-rendering="crispEdges" role="img" aria-label="QR Code">${label}`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}

/**
 * One-step helper: encode text and return SVG markup.
 * Returns a small error placeholder instead of throwing, so a single bad
 * payload can never break a page full of labels.
 */
export function qrSvg(text, options = {}) {
  try {
    return qrSvgFromMatrix(qrMatrix(text, options.ecc || 'M'), options);
  } catch (error) {
    console.error('[qrcode] generation failed:', error);
    const dim = 25;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="QR unavailable">`
      + `<rect width="${dim}" height="${dim}" fill="#fff"/>`
      + `<text x="${dim / 2}" y="${dim / 2}" font-size="3" text-anchor="middle" fill="#dc2626">QR error</text></svg>`;
  }
}

export default { qrMatrix, qrSvg, qrSvgFromMatrix };
