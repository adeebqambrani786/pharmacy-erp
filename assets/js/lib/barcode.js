/* ==========================================================================
   MediFlow Pharmacy ERP - Code 128 barcode generator (bundled locally)
   --------------------------------------------------------------------------
   Renders Code 128 (code set B, with automatic code set C compression for
   long digit runs) as SVG. Code 128 is used for shelf-edge and batch labels
   because it encodes the full ASCII range, so SKUs such as "PCM500TAB" and
   13-digit GS1 barcodes both fit the same symbology.

   Public API:
     code128Svg(text, options) -> SVG markup string
   ========================================================================== */

/**
 * Bar/space width patterns for Code 128 values 0-106.
 * Each string is six digits: bar, space, bar, space, bar, space widths.
 * Index 103/104/105 are START A/B/C, 106 is STOP (seven elements).
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

/** Code set B value for a printable ASCII character (space = 0). */
function valueB(char) {
  const code = char.charCodeAt(0);
  if (code < 32 || code > 126) return null; // unsupported character
  return code - 32;
}

/**
 * Encode text into Code 128 symbol values, including start, checksum and stop.
 * Long runs of digits (4+ at the start, 6+ mid-string) switch to code set C,
 * which packs two digits per symbol and keeps labels narrow.
 */
function encode(text) {
  const input = String(text);
  const values = [];
  let position = 0;
  let mode = null;

  /** Count the consecutive digits starting at a position. */
  const digitRun = (from) => {
    let n = 0;
    while (from + n < input.length && /[0-9]/.test(input[from + n])) n++;
    return n;
  };

  // Choose the opening code set.
  const leadingDigits = digitRun(0);
  if (leadingDigits >= 4 || (leadingDigits === input.length && leadingDigits % 2 === 0 && leadingDigits > 0)) {
    mode = 'C';
    values.push(START_C);
  } else {
    mode = 'B';
    values.push(START_B);
  }

  while (position < input.length) {
    if (mode === 'C') {
      const run = digitRun(position);
      if (run >= 2) {
        const pairs = Math.floor(run / 2);
        for (let i = 0; i < pairs; i++) {
          values.push(parseInt(input.substr(position, 2), 10));
          position += 2;
        }
        continue;
      }
      // Fewer than two digits left in this run - switch back to code set B.
      values.push(CODE_B);
      mode = 'B';
      continue;
    }

    // Code set B: switch to C when a long digit run appears.
    const run = digitRun(position);
    if (run >= 6 || (run >= 4 && position + run === input.length && run % 2 === 0)) {
      values.push(CODE_C);
      mode = 'C';
      continue;
    }

    const value = valueB(input[position]);
    if (value === null) {
      throw new Error(`Character "${input[position]}" cannot be encoded in Code 128.`);
    }
    values.push(value);
    position++;
  }

  // Modulo-103 weighted checksum over the start character and the data.
  let checksum = values[0];
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % 103);
  values.push(STOP);

  return values;
}

/**
 * Render text as a Code 128 barcode in SVG.
 * @param {string} text payload (printable ASCII)
 * @param {{height?:number, moduleWidth?:number, quiet?:number, showText?:boolean,
 *          dark?:string, light?:string, fontSize?:number}} options
 * @returns {string} SVG markup
 */
export function code128Svg(text, options = {}) {
  const {
    height = 38,
    moduleWidth = 1,
    quiet = 10,
    showText = false,
    dark = '#000000',
    light = '#ffffff',
    fontSize = 7
  } = options;

  let values;
  try {
    values = encode(text);
  } catch (error) {
    console.error('[barcode] encoding failed:', error);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${height}" role="img" aria-label="Barcode unavailable">`
      + `<rect width="100" height="${height}" fill="${light}"/>`
      + `<text x="50" y="${height / 2 + 3}" font-size="7" text-anchor="middle" fill="#dc2626">barcode error</text></svg>`;
  }

  // Expand the symbol values into alternating bar/space widths.
  const widths = values.map((v) => PATTERNS[v]).join('');
  const barHeight = showText ? height - fontSize - 3 : height;

  let x = quiet;
  let bars = '';
  for (let i = 0; i < widths.length; i++) {
    const w = parseInt(widths[i], 10) * moduleWidth;
    // Even indexes within each 6-element group are bars; the running index
    // alternates because every pattern starts with a bar.
    if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${barHeight}" fill="${dark}"/>`;
    x += w;
  }

  const totalWidth = x + quiet;
  const label = showText
    ? `<text x="${totalWidth / 2}" y="${height - 1}" font-size="${fontSize}" text-anchor="middle"
         font-family="monospace" fill="${dark}">${String(text).replace(/[<>&]/g, '')}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" `
    + `preserveAspectRatio="none" shape-rendering="crispEdges" role="img" `
    + `aria-label="Barcode ${String(text).replace(/[<>&"]/g, '')}">`
    + `<rect width="${totalWidth}" height="${height}" fill="${light}"/>${bars}${label}</svg>`;
}

/** Expose the encoder for tests. */
export function code128Values(text) {
  return encode(text);
}

export default { code128Svg, code128Values };
