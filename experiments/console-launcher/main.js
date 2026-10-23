var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/qrcode/lib/can-promise.js
var require_can_promise = __commonJS({
  "node_modules/qrcode/lib/can-promise.js"(exports, module) {
    module.exports = function() {
      return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
    };
  }
});

// node_modules/qrcode/lib/core/utils.js
var require_utils = __commonJS({
  "node_modules/qrcode/lib/core/utils.js"(exports) {
    var toSJISFunction;
    var CODEWORDS_COUNT = [
      0,
      // Not used
      26,
      44,
      70,
      100,
      134,
      172,
      196,
      242,
      292,
      346,
      404,
      466,
      532,
      581,
      655,
      733,
      815,
      901,
      991,
      1085,
      1156,
      1258,
      1364,
      1474,
      1588,
      1706,
      1828,
      1921,
      2051,
      2185,
      2323,
      2465,
      2611,
      2761,
      2876,
      3034,
      3196,
      3362,
      3532,
      3706
    ];
    exports.getSymbolSize = function getSymbolSize(version) {
      if (!version) throw new Error('"version" cannot be null or undefined');
      if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
      return version * 4 + 17;
    };
    exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
      return CODEWORDS_COUNT[version];
    };
    exports.getBCHDigit = function(data) {
      let digit = 0;
      while (data !== 0) {
        digit++;
        data >>>= 1;
      }
      return digit;
    };
    exports.setToSJISFunction = function setToSJISFunction(f) {
      if (typeof f !== "function") {
        throw new Error('"toSJISFunc" is not a valid function.');
      }
      toSJISFunction = f;
    };
    exports.isKanjiModeEnabled = function() {
      return typeof toSJISFunction !== "undefined";
    };
    exports.toSJIS = function toSJIS(kanji) {
      return toSJISFunction(kanji);
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-level.js
var require_error_correction_level = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-level.js"(exports) {
    exports.L = { bit: 1 };
    exports.M = { bit: 0 };
    exports.Q = { bit: 3 };
    exports.H = { bit: 2 };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "l":
        case "low":
          return exports.L;
        case "m":
        case "medium":
          return exports.M;
        case "q":
        case "quartile":
          return exports.Q;
        case "h":
        case "high":
          return exports.H;
        default:
          throw new Error("Unknown EC Level: " + string);
      }
    }
    exports.isValid = function isValid(level) {
      return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
    };
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/bit-buffer.js
var require_bit_buffer = __commonJS({
  "node_modules/qrcode/lib/core/bit-buffer.js"(exports, module) {
    function BitBuffer() {
      this.buffer = [];
      this.length = 0;
    }
    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        for (let i = 0; i < length; i++) {
          this.putBit((num >>> length - i - 1 & 1) === 1);
        }
      },
      getLengthInBits: function() {
        return this.length;
      },
      putBit: function(bit) {
        const bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) {
          this.buffer.push(0);
        }
        if (bit) {
          this.buffer[bufIndex] |= 128 >>> this.length % 8;
        }
        this.length++;
      }
    };
    module.exports = BitBuffer;
  }
});

// node_modules/qrcode/lib/core/bit-matrix.js
var require_bit_matrix = __commonJS({
  "node_modules/qrcode/lib/core/bit-matrix.js"(exports, module) {
    function BitMatrix(size) {
      if (!size || size < 1) {
        throw new Error("BitMatrix size must be defined and greater than 0");
      }
      this.size = size;
      this.data = new Uint8Array(size * size);
      this.reservedBit = new Uint8Array(size * size);
    }
    BitMatrix.prototype.set = function(row, col, value, reserved) {
      const index = row * this.size + col;
      this.data[index] = value;
      if (reserved) this.reservedBit[index] = true;
    };
    BitMatrix.prototype.get = function(row, col) {
      return this.data[row * this.size + col];
    };
    BitMatrix.prototype.xor = function(row, col, value) {
      this.data[row * this.size + col] ^= value;
    };
    BitMatrix.prototype.isReserved = function(row, col) {
      return this.reservedBit[row * this.size + col];
    };
    module.exports = BitMatrix;
  }
});

// node_modules/qrcode/lib/core/alignment-pattern.js
var require_alignment_pattern = __commonJS({
  "node_modules/qrcode/lib/core/alignment-pattern.js"(exports) {
    var getSymbolSize = require_utils().getSymbolSize;
    exports.getRowColCoords = function getRowColCoords(version) {
      if (version === 1) return [];
      const posCount = Math.floor(version / 7) + 2;
      const size = getSymbolSize(version);
      const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
      const positions = [size - 7];
      for (let i = 1; i < posCount - 1; i++) {
        positions[i] = positions[i - 1] - intervals;
      }
      positions.push(6);
      return positions.reverse();
    };
    exports.getPositions = function getPositions(version) {
      const coords = [];
      const pos = exports.getRowColCoords(version);
      const posLength = pos.length;
      for (let i = 0; i < posLength; i++) {
        for (let j = 0; j < posLength; j++) {
          if (i === 0 && j === 0 || // top-left
          i === 0 && j === posLength - 1 || // bottom-left
          i === posLength - 1 && j === 0) {
            continue;
          }
          coords.push([pos[i], pos[j]]);
        }
      }
      return coords;
    };
  }
});

// node_modules/qrcode/lib/core/finder-pattern.js
var require_finder_pattern = __commonJS({
  "node_modules/qrcode/lib/core/finder-pattern.js"(exports) {
    var getSymbolSize = require_utils().getSymbolSize;
    var FINDER_PATTERN_SIZE = 7;
    exports.getPositions = function getPositions(version) {
      const size = getSymbolSize(version);
      return [
        // top-left
        [0, 0],
        // top-right
        [size - FINDER_PATTERN_SIZE, 0],
        // bottom-left
        [0, size - FINDER_PATTERN_SIZE]
      ];
    };
  }
});

// node_modules/qrcode/lib/core/mask-pattern.js
var require_mask_pattern = __commonJS({
  "node_modules/qrcode/lib/core/mask-pattern.js"(exports) {
    exports.Patterns = {
      PATTERN000: 0,
      PATTERN001: 1,
      PATTERN010: 2,
      PATTERN011: 3,
      PATTERN100: 4,
      PATTERN101: 5,
      PATTERN110: 6,
      PATTERN111: 7
    };
    var PenaltyScores = {
      N1: 3,
      N2: 3,
      N3: 40,
      N4: 10
    };
    exports.isValid = function isValid(mask) {
      return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
    };
    exports.from = function from(value) {
      return exports.isValid(value) ? parseInt(value, 10) : void 0;
    };
    exports.getPenaltyN1 = function getPenaltyN1(data) {
      const size = data.size;
      let points = 0;
      let sameCountCol = 0;
      let sameCountRow = 0;
      let lastCol = null;
      let lastRow = null;
      for (let row = 0; row < size; row++) {
        sameCountCol = sameCountRow = 0;
        lastCol = lastRow = null;
        for (let col = 0; col < size; col++) {
          let module2 = data.get(row, col);
          if (module2 === lastCol) {
            sameCountCol++;
          } else {
            if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
            lastCol = module2;
            sameCountCol = 1;
          }
          module2 = data.get(col, row);
          if (module2 === lastRow) {
            sameCountRow++;
          } else {
            if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
            lastRow = module2;
            sameCountRow = 1;
          }
        }
        if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
        if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
      }
      return points;
    };
    exports.getPenaltyN2 = function getPenaltyN2(data) {
      const size = data.size;
      let points = 0;
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
          if (last === 4 || last === 0) points++;
        }
      }
      return points * PenaltyScores.N2;
    };
    exports.getPenaltyN3 = function getPenaltyN3(data) {
      const size = data.size;
      let points = 0;
      let bitsCol = 0;
      let bitsRow = 0;
      for (let row = 0; row < size; row++) {
        bitsCol = bitsRow = 0;
        for (let col = 0; col < size; col++) {
          bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
          if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
          bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
          if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
        }
      }
      return points * PenaltyScores.N3;
    };
    exports.getPenaltyN4 = function getPenaltyN4(data) {
      let darkCount = 0;
      const modulesCount = data.data.length;
      for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
      const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
      return k * PenaltyScores.N4;
    };
    function getMaskAt(maskPattern, i, j) {
      switch (maskPattern) {
        case exports.Patterns.PATTERN000:
          return (i + j) % 2 === 0;
        case exports.Patterns.PATTERN001:
          return i % 2 === 0;
        case exports.Patterns.PATTERN010:
          return j % 3 === 0;
        case exports.Patterns.PATTERN011:
          return (i + j) % 3 === 0;
        case exports.Patterns.PATTERN100:
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
        case exports.Patterns.PATTERN101:
          return i * j % 2 + i * j % 3 === 0;
        case exports.Patterns.PATTERN110:
          return (i * j % 2 + i * j % 3) % 2 === 0;
        case exports.Patterns.PATTERN111:
          return (i * j % 3 + (i + j) % 2) % 2 === 0;
        default:
          throw new Error("bad maskPattern:" + maskPattern);
      }
    }
    exports.applyMask = function applyMask(pattern, data) {
      const size = data.size;
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size; row++) {
          if (data.isReserved(row, col)) continue;
          data.xor(row, col, getMaskAt(pattern, row, col));
        }
      }
    };
    exports.getBestMask = function getBestMask(data, setupFormatFunc) {
      const numPatterns = Object.keys(exports.Patterns).length;
      let bestPattern = 0;
      let lowerPenalty = Infinity;
      for (let p = 0; p < numPatterns; p++) {
        setupFormatFunc(p);
        exports.applyMask(p, data);
        const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
        exports.applyMask(p, data);
        if (penalty < lowerPenalty) {
          lowerPenalty = penalty;
          bestPattern = p;
        }
      }
      return bestPattern;
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-code.js
var require_error_correction_code = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-code.js"(exports) {
    var ECLevel = require_error_correction_level();
    var EC_BLOCKS_TABLE = [
      // L  M  Q  H
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      1,
      2,
      2,
      4,
      1,
      2,
      4,
      4,
      2,
      4,
      4,
      4,
      2,
      4,
      6,
      5,
      2,
      4,
      6,
      6,
      2,
      5,
      8,
      8,
      4,
      5,
      8,
      8,
      4,
      5,
      8,
      11,
      4,
      8,
      10,
      11,
      4,
      9,
      12,
      16,
      4,
      9,
      16,
      16,
      6,
      10,
      12,
      18,
      6,
      10,
      17,
      16,
      6,
      11,
      16,
      19,
      6,
      13,
      18,
      21,
      7,
      14,
      21,
      25,
      8,
      16,
      20,
      25,
      8,
      17,
      23,
      25,
      9,
      17,
      23,
      34,
      9,
      18,
      25,
      30,
      10,
      20,
      27,
      32,
      12,
      21,
      29,
      35,
      12,
      23,
      34,
      37,
      12,
      25,
      34,
      40,
      13,
      26,
      35,
      42,
      14,
      28,
      38,
      45,
      15,
      29,
      40,
      48,
      16,
      31,
      43,
      51,
      17,
      33,
      45,
      54,
      18,
      35,
      48,
      57,
      19,
      37,
      51,
      60,
      19,
      38,
      53,
      63,
      20,
      40,
      56,
      66,
      21,
      43,
      59,
      70,
      22,
      45,
      62,
      74,
      24,
      47,
      65,
      77,
      25,
      49,
      68,
      81
    ];
    var EC_CODEWORDS_TABLE = [
      // L  M  Q  H
      7,
      10,
      13,
      17,
      10,
      16,
      22,
      28,
      15,
      26,
      36,
      44,
      20,
      36,
      52,
      64,
      26,
      48,
      72,
      88,
      36,
      64,
      96,
      112,
      40,
      72,
      108,
      130,
      48,
      88,
      132,
      156,
      60,
      110,
      160,
      192,
      72,
      130,
      192,
      224,
      80,
      150,
      224,
      264,
      96,
      176,
      260,
      308,
      104,
      198,
      288,
      352,
      120,
      216,
      320,
      384,
      132,
      240,
      360,
      432,
      144,
      280,
      408,
      480,
      168,
      308,
      448,
      532,
      180,
      338,
      504,
      588,
      196,
      364,
      546,
      650,
      224,
      416,
      600,
      700,
      224,
      442,
      644,
      750,
      252,
      476,
      690,
      816,
      270,
      504,
      750,
      900,
      300,
      560,
      810,
      960,
      312,
      588,
      870,
      1050,
      336,
      644,
      952,
      1110,
      360,
      700,
      1020,
      1200,
      390,
      728,
      1050,
      1260,
      420,
      784,
      1140,
      1350,
      450,
      812,
      1200,
      1440,
      480,
      868,
      1290,
      1530,
      510,
      924,
      1350,
      1620,
      540,
      980,
      1440,
      1710,
      570,
      1036,
      1530,
      1800,
      570,
      1064,
      1590,
      1890,
      600,
      1120,
      1680,
      1980,
      630,
      1204,
      1770,
      2100,
      660,
      1260,
      1860,
      2220,
      720,
      1316,
      1950,
      2310,
      750,
      1372,
      2040,
      2430
    ];
    exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
    exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
  }
});

// node_modules/qrcode/lib/core/galois-field.js
var require_galois_field = __commonJS({
  "node_modules/qrcode/lib/core/galois-field.js"(exports) {
    var EXP_TABLE = new Uint8Array(512);
    var LOG_TABLE = new Uint8Array(256);
    (function initTables() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        EXP_TABLE[i] = x;
        LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 256) {
          x ^= 285;
        }
      }
      for (let i = 255; i < 512; i++) {
        EXP_TABLE[i] = EXP_TABLE[i - 255];
      }
    })();
    exports.log = function log(n) {
      if (n < 1) throw new Error("log(" + n + ")");
      return LOG_TABLE[n];
    };
    exports.exp = function exp(n) {
      return EXP_TABLE[n];
    };
    exports.mul = function mul(x, y) {
      if (x === 0 || y === 0) return 0;
      return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
    };
  }
});

// node_modules/qrcode/lib/core/polynomial.js
var require_polynomial = __commonJS({
  "node_modules/qrcode/lib/core/polynomial.js"(exports) {
    var GF = require_galois_field();
    exports.mul = function mul(p1, p2) {
      const coeff = new Uint8Array(p1.length + p2.length - 1);
      for (let i = 0; i < p1.length; i++) {
        for (let j = 0; j < p2.length; j++) {
          coeff[i + j] ^= GF.mul(p1[i], p2[j]);
        }
      }
      return coeff;
    };
    exports.mod = function mod(divident, divisor) {
      let result = new Uint8Array(divident);
      while (result.length - divisor.length >= 0) {
        const coeff = result[0];
        for (let i = 0; i < divisor.length; i++) {
          result[i] ^= GF.mul(divisor[i], coeff);
        }
        let offset = 0;
        while (offset < result.length && result[offset] === 0) offset++;
        result = result.slice(offset);
      }
      return result;
    };
    exports.generateECPolynomial = function generateECPolynomial(degree) {
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      return poly;
    };
  }
});

// node_modules/qrcode/lib/core/reed-solomon-encoder.js
var require_reed_solomon_encoder = __commonJS({
  "node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports, module) {
    var Polynomial = require_polynomial();
    function ReedSolomonEncoder(degree) {
      this.genPoly = void 0;
      this.degree = degree;
      if (this.degree) this.initialize(this.degree);
    }
    ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
      this.degree = degree;
      this.genPoly = Polynomial.generateECPolynomial(this.degree);
    };
    ReedSolomonEncoder.prototype.encode = function encode(data) {
      if (!this.genPoly) {
        throw new Error("Encoder not initialized");
      }
      const paddedData = new Uint8Array(data.length + this.degree);
      paddedData.set(data);
      const remainder = Polynomial.mod(paddedData, this.genPoly);
      const start = this.degree - remainder.length;
      if (start > 0) {
        const buff = new Uint8Array(this.degree);
        buff.set(remainder, start);
        return buff;
      }
      return remainder;
    };
    module.exports = ReedSolomonEncoder;
  }
});

// node_modules/qrcode/lib/core/version-check.js
var require_version_check = __commonJS({
  "node_modules/qrcode/lib/core/version-check.js"(exports) {
    exports.isValid = function isValid(version) {
      return !isNaN(version) && version >= 1 && version <= 40;
    };
  }
});

// node_modules/qrcode/lib/core/regex.js
var require_regex = __commonJS({
  "node_modules/qrcode/lib/core/regex.js"(exports) {
    var numeric = "[0-9]+";
    var alphanumeric = "[A-Z $%*+\\-./:]+";
    var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
    kanji = kanji.replace(/u/g, "\\u");
    var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
    exports.KANJI = new RegExp(kanji, "g");
    exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
    exports.BYTE = new RegExp(byte, "g");
    exports.NUMERIC = new RegExp(numeric, "g");
    exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
    var TEST_KANJI = new RegExp("^" + kanji + "$");
    var TEST_NUMERIC = new RegExp("^" + numeric + "$");
    var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
    exports.testKanji = function testKanji(str) {
      return TEST_KANJI.test(str);
    };
    exports.testNumeric = function testNumeric(str) {
      return TEST_NUMERIC.test(str);
    };
    exports.testAlphanumeric = function testAlphanumeric(str) {
      return TEST_ALPHANUMERIC.test(str);
    };
  }
});

// node_modules/qrcode/lib/core/mode.js
var require_mode = __commonJS({
  "node_modules/qrcode/lib/core/mode.js"(exports) {
    var VersionCheck = require_version_check();
    var Regex = require_regex();
    exports.NUMERIC = {
      id: "Numeric",
      bit: 1 << 0,
      ccBits: [10, 12, 14]
    };
    exports.ALPHANUMERIC = {
      id: "Alphanumeric",
      bit: 1 << 1,
      ccBits: [9, 11, 13]
    };
    exports.BYTE = {
      id: "Byte",
      bit: 1 << 2,
      ccBits: [8, 16, 16]
    };
    exports.KANJI = {
      id: "Kanji",
      bit: 1 << 3,
      ccBits: [8, 10, 12]
    };
    exports.MIXED = {
      bit: -1
    };
    exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
      if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid version: " + version);
      }
      if (version >= 1 && version < 10) return mode.ccBits[0];
      else if (version < 27) return mode.ccBits[1];
      return mode.ccBits[2];
    };
    exports.getBestModeForData = function getBestModeForData(dataStr) {
      if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
      else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
      else if (Regex.testKanji(dataStr)) return exports.KANJI;
      else return exports.BYTE;
    };
    exports.toString = function toString(mode) {
      if (mode && mode.id) return mode.id;
      throw new Error("Invalid mode");
    };
    exports.isValid = function isValid(mode) {
      return mode && mode.bit && mode.ccBits;
    };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "numeric":
          return exports.NUMERIC;
        case "alphanumeric":
          return exports.ALPHANUMERIC;
        case "kanji":
          return exports.KANJI;
        case "byte":
          return exports.BYTE;
        default:
          throw new Error("Unknown mode: " + string);
      }
    }
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/version.js
var require_version = __commonJS({
  "node_modules/qrcode/lib/core/version.js"(exports) {
    var Utils = require_utils();
    var ECCode = require_error_correction_code();
    var ECLevel = require_error_correction_level();
    var Mode = require_mode();
    var VersionCheck = require_version_check();
    var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    var G18_BCH = Utils.getBCHDigit(G18);
    function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    function getReservedBitsCount(mode, version) {
      return Mode.getCharCountIndicator(mode, version) + 4;
    }
    function getTotalBitsFromDataArray(segments, version) {
      let totalBits = 0;
      segments.forEach(function(data) {
        const reservedBits = getReservedBitsCount(data.mode, version);
        totalBits += reservedBits + data.getBitsLength();
      });
      return totalBits;
    }
    function getBestVersionForMixedData(segments, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        const length = getTotalBitsFromDataArray(segments, currentVersion);
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    exports.from = function from(value, defaultValue) {
      if (VersionCheck.isValid(value)) {
        return parseInt(value, 10);
      }
      return defaultValue;
    };
    exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid QR Code version");
      }
      if (typeof mode === "undefined") mode = Mode.BYTE;
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (mode === Mode.MIXED) return dataTotalCodewordsBits;
      const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
      switch (mode) {
        case Mode.NUMERIC:
          return Math.floor(usableBits / 10 * 3);
        case Mode.ALPHANUMERIC:
          return Math.floor(usableBits / 11 * 2);
        case Mode.KANJI:
          return Math.floor(usableBits / 13);
        case Mode.BYTE:
        default:
          return Math.floor(usableBits / 8);
      }
    };
    exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
      let seg;
      const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
      if (Array.isArray(data)) {
        if (data.length > 1) {
          return getBestVersionForMixedData(data, ecl);
        }
        if (data.length === 0) {
          return 1;
        }
        seg = data[0];
      } else {
        seg = data;
      }
      return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
    };
    exports.getEncodedBits = function getEncodedBits(version) {
      if (!VersionCheck.isValid(version) || version < 7) {
        throw new Error("Invalid QR Code version");
      }
      let d = version << 12;
      while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
        d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
      }
      return version << 12 | d;
    };
  }
});

// node_modules/qrcode/lib/core/format-info.js
var require_format_info = __commonJS({
  "node_modules/qrcode/lib/core/format-info.js"(exports) {
    var Utils = require_utils();
    var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    var G15_BCH = Utils.getBCHDigit(G15);
    exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
      const data = errorCorrectionLevel.bit << 3 | mask;
      let d = data << 10;
      while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
        d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
      }
      return (data << 10 | d) ^ G15_MASK;
    };
  }
});

// node_modules/qrcode/lib/core/numeric-data.js
var require_numeric_data = __commonJS({
  "node_modules/qrcode/lib/core/numeric-data.js"(exports, module) {
    var Mode = require_mode();
    function NumericData(data) {
      this.mode = Mode.NUMERIC;
      this.data = data.toString();
    }
    NumericData.getBitsLength = function getBitsLength(length) {
      return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
    };
    NumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    NumericData.prototype.getBitsLength = function getBitsLength() {
      return NumericData.getBitsLength(this.data.length);
    };
    NumericData.prototype.write = function write(bitBuffer) {
      let i, group, value;
      for (i = 0; i + 3 <= this.data.length; i += 3) {
        group = this.data.substr(i, 3);
        value = parseInt(group, 10);
        bitBuffer.put(value, 10);
      }
      const remainingNum = this.data.length - i;
      if (remainingNum > 0) {
        group = this.data.substr(i);
        value = parseInt(group, 10);
        bitBuffer.put(value, remainingNum * 3 + 1);
      }
    };
    module.exports = NumericData;
  }
});

// node_modules/qrcode/lib/core/alphanumeric-data.js
var require_alphanumeric_data = __commonJS({
  "node_modules/qrcode/lib/core/alphanumeric-data.js"(exports, module) {
    var Mode = require_mode();
    var ALPHA_NUM_CHARS = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z",
      " ",
      "$",
      "%",
      "*",
      "+",
      "-",
      ".",
      "/",
      ":"
    ];
    function AlphanumericData(data) {
      this.mode = Mode.ALPHANUMERIC;
      this.data = data;
    }
    AlphanumericData.getBitsLength = function getBitsLength(length) {
      return 11 * Math.floor(length / 2) + 6 * (length % 2);
    };
    AlphanumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    AlphanumericData.prototype.getBitsLength = function getBitsLength() {
      return AlphanumericData.getBitsLength(this.data.length);
    };
    AlphanumericData.prototype.write = function write(bitBuffer) {
      let i;
      for (i = 0; i + 2 <= this.data.length; i += 2) {
        let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
        value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
        bitBuffer.put(value, 11);
      }
      if (this.data.length % 2) {
        bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
      }
    };
    module.exports = AlphanumericData;
  }
});

// node_modules/qrcode/lib/core/byte-data.js
var require_byte_data = __commonJS({
  "node_modules/qrcode/lib/core/byte-data.js"(exports, module) {
    var Mode = require_mode();
    function ByteData(data) {
      this.mode = Mode.BYTE;
      if (typeof data === "string") {
        this.data = new TextEncoder().encode(data);
      } else {
        this.data = new Uint8Array(data);
      }
    }
    ByteData.getBitsLength = function getBitsLength(length) {
      return length * 8;
    };
    ByteData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    ByteData.prototype.getBitsLength = function getBitsLength() {
      return ByteData.getBitsLength(this.data.length);
    };
    ByteData.prototype.write = function(bitBuffer) {
      for (let i = 0, l = this.data.length; i < l; i++) {
        bitBuffer.put(this.data[i], 8);
      }
    };
    module.exports = ByteData;
  }
});

// node_modules/qrcode/lib/core/kanji-data.js
var require_kanji_data = __commonJS({
  "node_modules/qrcode/lib/core/kanji-data.js"(exports, module) {
    var Mode = require_mode();
    var Utils = require_utils();
    function KanjiData(data) {
      this.mode = Mode.KANJI;
      this.data = data;
    }
    KanjiData.getBitsLength = function getBitsLength(length) {
      return length * 13;
    };
    KanjiData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    KanjiData.prototype.getBitsLength = function getBitsLength() {
      return KanjiData.getBitsLength(this.data.length);
    };
    KanjiData.prototype.write = function(bitBuffer) {
      let i;
      for (i = 0; i < this.data.length; i++) {
        let value = Utils.toSJIS(this.data[i]);
        if (value >= 33088 && value <= 40956) {
          value -= 33088;
        } else if (value >= 57408 && value <= 60351) {
          value -= 49472;
        } else {
          throw new Error(
            "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
          );
        }
        value = (value >>> 8 & 255) * 192 + (value & 255);
        bitBuffer.put(value, 13);
      }
    };
    module.exports = KanjiData;
  }
});

// node_modules/dijkstrajs/dijkstra.js
var require_dijkstra = __commonJS({
  "node_modules/dijkstrajs/dijkstra.js"(exports, module) {
    "use strict";
    var dijkstra = {
      single_source_shortest_paths: function(graph, s, d) {
        var predecessors = {};
        var costs = {};
        costs[s] = 0;
        var open = dijkstra.PriorityQueue.make();
        open.push(s, 0);
        var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
        while (!open.empty()) {
          closest = open.pop();
          u = closest.value;
          cost_of_s_to_u = closest.cost;
          adjacent_nodes = graph[u] || {};
          for (v in adjacent_nodes) {
            if (adjacent_nodes.hasOwnProperty(v)) {
              cost_of_e = adjacent_nodes[v];
              cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
              cost_of_s_to_v = costs[v];
              first_visit = typeof costs[v] === "undefined";
              if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                costs[v] = cost_of_s_to_u_plus_cost_of_e;
                open.push(v, cost_of_s_to_u_plus_cost_of_e);
                predecessors[v] = u;
              }
            }
          }
        }
        if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
          var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
          throw new Error(msg);
        }
        return predecessors;
      },
      extract_shortest_path_from_predecessor_list: function(predecessors, d) {
        var nodes = [];
        var u = d;
        var predecessor;
        while (u) {
          nodes.push(u);
          predecessor = predecessors[u];
          u = predecessors[u];
        }
        nodes.reverse();
        return nodes;
      },
      find_path: function(graph, s, d) {
        var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
        return dijkstra.extract_shortest_path_from_predecessor_list(
          predecessors,
          d
        );
      },
      /**
       * A very naive priority queue implementation.
       */
      PriorityQueue: {
        make: function(opts) {
          var T = dijkstra.PriorityQueue, t = {}, key;
          opts = opts || {};
          for (key in T) {
            if (T.hasOwnProperty(key)) {
              t[key] = T[key];
            }
          }
          t.queue = [];
          t.sorter = opts.sorter || T.default_sorter;
          return t;
        },
        default_sorter: function(a, b) {
          return a.cost - b.cost;
        },
        /**
         * Add a new item to the queue and ensure the highest priority element
         * is at the front of the queue.
         */
        push: function(value, cost) {
          var item = { value, cost };
          this.queue.push(item);
          this.queue.sort(this.sorter);
        },
        /**
         * Return the highest priority element in the queue.
         */
        pop: function() {
          return this.queue.shift();
        },
        empty: function() {
          return this.queue.length === 0;
        }
      }
    };
    if (typeof module !== "undefined") {
      module.exports = dijkstra;
    }
  }
});

// node_modules/qrcode/lib/core/segments.js
var require_segments = __commonJS({
  "node_modules/qrcode/lib/core/segments.js"(exports) {
    var Mode = require_mode();
    var NumericData = require_numeric_data();
    var AlphanumericData = require_alphanumeric_data();
    var ByteData = require_byte_data();
    var KanjiData = require_kanji_data();
    var Regex = require_regex();
    var Utils = require_utils();
    var dijkstra = require_dijkstra();
    function getStringByteLength(str) {
      return unescape(encodeURIComponent(str)).length;
    }
    function getSegments(regex, mode, str) {
      const segments = [];
      let result;
      while ((result = regex.exec(str)) !== null) {
        segments.push({
          data: result[0],
          index: result.index,
          mode,
          length: result[0].length
        });
      }
      return segments;
    }
    function getSegmentsFromString(dataStr) {
      const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
      const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
      let byteSegs;
      let kanjiSegs;
      if (Utils.isKanjiModeEnabled()) {
        byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
        kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
      } else {
        byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
        kanjiSegs = [];
      }
      const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
      return segs.sort(function(s1, s2) {
        return s1.index - s2.index;
      }).map(function(obj) {
        return {
          data: obj.data,
          mode: obj.mode,
          length: obj.length
        };
      });
    }
    function getSegmentBitsLength(length, mode) {
      switch (mode) {
        case Mode.NUMERIC:
          return NumericData.getBitsLength(length);
        case Mode.ALPHANUMERIC:
          return AlphanumericData.getBitsLength(length);
        case Mode.KANJI:
          return KanjiData.getBitsLength(length);
        case Mode.BYTE:
          return ByteData.getBitsLength(length);
      }
    }
    function mergeSegments(segs) {
      return segs.reduce(function(acc, curr) {
        const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
        if (prevSeg && prevSeg.mode === curr.mode) {
          acc[acc.length - 1].data += curr.data;
          return acc;
        }
        acc.push(curr);
        return acc;
      }, []);
    }
    function buildNodes(segs) {
      const nodes = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        switch (seg.mode) {
          case Mode.NUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.ALPHANUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.KANJI:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
            break;
          case Mode.BYTE:
            nodes.push([
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
        }
      }
      return nodes;
    }
    function buildGraph(nodes, version) {
      const table = {};
      const graph = { start: {} };
      let prevNodeIds = ["start"];
      for (let i = 0; i < nodes.length; i++) {
        const nodeGroup = nodes[i];
        const currentNodeIds = [];
        for (let j = 0; j < nodeGroup.length; j++) {
          const node = nodeGroup[j];
          const key = "" + i + j;
          currentNodeIds.push(key);
          table[key] = { node, lastCount: 0 };
          graph[key] = {};
          for (let n = 0; n < prevNodeIds.length; n++) {
            const prevNodeId = prevNodeIds[n];
            if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
              graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
              table[prevNodeId].lastCount += node.length;
            } else {
              if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
              graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
            }
          }
        }
        prevNodeIds = currentNodeIds;
      }
      for (let n = 0; n < prevNodeIds.length; n++) {
        graph[prevNodeIds[n]].end = 0;
      }
      return { map: graph, table };
    }
    function buildSingleSegment(data, modesHint) {
      let mode;
      const bestMode = Mode.getBestModeForData(data);
      mode = Mode.from(modesHint, bestMode);
      if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
        throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
      }
      if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
        mode = Mode.BYTE;
      }
      switch (mode) {
        case Mode.NUMERIC:
          return new NumericData(data);
        case Mode.ALPHANUMERIC:
          return new AlphanumericData(data);
        case Mode.KANJI:
          return new KanjiData(data);
        case Mode.BYTE:
          return new ByteData(data);
      }
    }
    exports.fromArray = function fromArray(array) {
      return array.reduce(function(acc, seg) {
        if (typeof seg === "string") {
          acc.push(buildSingleSegment(seg, null));
        } else if (seg.data) {
          acc.push(buildSingleSegment(seg.data, seg.mode));
        }
        return acc;
      }, []);
    };
    exports.fromString = function fromString(data, version) {
      const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
      const nodes = buildNodes(segs);
      const graph = buildGraph(nodes, version);
      const path = dijkstra.find_path(graph.map, "start", "end");
      const optimizedSegs = [];
      for (let i = 1; i < path.length - 1; i++) {
        optimizedSegs.push(graph.table[path[i]].node);
      }
      return exports.fromArray(mergeSegments(optimizedSegs));
    };
    exports.rawSplit = function rawSplit(data) {
      return exports.fromArray(
        getSegmentsFromString(data, Utils.isKanjiModeEnabled())
      );
    };
  }
});

// node_modules/qrcode/lib/core/qrcode.js
var require_qrcode = __commonJS({
  "node_modules/qrcode/lib/core/qrcode.js"(exports) {
    var Utils = require_utils();
    var ECLevel = require_error_correction_level();
    var BitBuffer = require_bit_buffer();
    var BitMatrix = require_bit_matrix();
    var AlignmentPattern = require_alignment_pattern();
    var FinderPattern = require_finder_pattern();
    var MaskPattern = require_mask_pattern();
    var ECCode = require_error_correction_code();
    var ReedSolomonEncoder = require_reed_solomon_encoder();
    var Version = require_version();
    var FormatInfo = require_format_info();
    var Mode = require_mode();
    var Segments = require_segments();
    function setupFinderPattern(matrix, version) {
      const size = matrix.size;
      const pos = FinderPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -1; r <= 7; r++) {
          if (row + r <= -1 || size <= row + r) continue;
          for (let c = -1; c <= 7; c++) {
            if (col + c <= -1 || size <= col + c) continue;
            if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupTimingPattern(matrix) {
      const size = matrix.size;
      for (let r = 8; r < size - 8; r++) {
        const value = r % 2 === 0;
        matrix.set(r, 6, value, true);
        matrix.set(6, r, value, true);
      }
    }
    function setupAlignmentPattern(matrix, version) {
      const pos = AlignmentPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupVersionInfo(matrix, version) {
      const size = matrix.size;
      const bits = Version.getEncodedBits(version);
      let row, col, mod;
      for (let i = 0; i < 18; i++) {
        row = Math.floor(i / 3);
        col = i % 3 + size - 8 - 3;
        mod = (bits >> i & 1) === 1;
        matrix.set(row, col, mod, true);
        matrix.set(col, row, mod, true);
      }
    }
    function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
      const size = matrix.size;
      const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
      let i, mod;
      for (i = 0; i < 15; i++) {
        mod = (bits >> i & 1) === 1;
        if (i < 6) {
          matrix.set(i, 8, mod, true);
        } else if (i < 8) {
          matrix.set(i + 1, 8, mod, true);
        } else {
          matrix.set(size - 15 + i, 8, mod, true);
        }
        if (i < 8) {
          matrix.set(8, size - i - 1, mod, true);
        } else if (i < 9) {
          matrix.set(8, 15 - i - 1 + 1, mod, true);
        } else {
          matrix.set(8, 15 - i - 1, mod, true);
        }
      }
      matrix.set(size - 8, 8, 1, true);
    }
    function setupData(matrix, data) {
      const size = matrix.size;
      let inc = -1;
      let row = size - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (let c = 0; c < 2; c++) {
            if (!matrix.isReserved(row, col - c)) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) === 1;
              }
              matrix.set(row, col - c, dark);
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || size <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
    function createData(version, errorCorrectionLevel, segments) {
      const buffer = new BitBuffer();
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 !== 0) {
        buffer.putBit(0);
      }
      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      for (let i = 0; i < remainingByte; i++) {
        buffer.put(i % 2 ? 17 : 236, 8);
      }
      return createCodewords(buffer, version, errorCorrectionLevel);
    }
    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewords = totalCodewords - ecTotalCodewords;
      const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
      const blocksInGroup2 = totalCodewords % ecTotalBlocks;
      const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
      const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
      const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
      const rs = new ReedSolomonEncoder(ecCount);
      let offset = 0;
      const dcData = new Array(ecTotalBlocks);
      const ecData = new Array(ecTotalBlocks);
      let maxDataSize = 0;
      const buffer = new Uint8Array(bitBuffer.buffer);
      for (let b = 0; b < ecTotalBlocks; b++) {
        const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
        dcData[b] = buffer.slice(offset, offset + dataSize);
        ecData[b] = rs.encode(dcData[b]);
        offset += dataSize;
        maxDataSize = Math.max(maxDataSize, dataSize);
      }
      const data = new Uint8Array(totalCodewords);
      let index = 0;
      let i, r;
      for (i = 0; i < maxDataSize; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          if (i < dcData[r].length) {
            data[index++] = dcData[r][i];
          }
        }
      }
      for (i = 0; i < ecCount; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          data[index++] = ecData[r][i];
        }
      }
      return data;
    }
    function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
      let segments;
      if (Array.isArray(data)) {
        segments = Segments.fromArray(data);
      } else if (typeof data === "string") {
        let estimatedVersion = version;
        if (!estimatedVersion) {
          const rawSegments = Segments.rawSplit(data);
          estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
        }
        segments = Segments.fromString(data, estimatedVersion || 40);
      } else {
        throw new Error("Invalid data");
      }
      const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
      if (!bestVersion) {
        throw new Error("The amount of data is too big to be stored in a QR Code");
      }
      if (!version) {
        version = bestVersion;
      } else if (version < bestVersion) {
        throw new Error(
          "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
        );
      }
      const dataBits = createData(version, errorCorrectionLevel, segments);
      const moduleCount = Utils.getSymbolSize(version);
      const modules = new BitMatrix(moduleCount);
      setupFinderPattern(modules, version);
      setupTimingPattern(modules);
      setupAlignmentPattern(modules, version);
      setupFormatInfo(modules, errorCorrectionLevel, 0);
      if (version >= 7) {
        setupVersionInfo(modules, version);
      }
      setupData(modules, dataBits);
      if (isNaN(maskPattern)) {
        maskPattern = MaskPattern.getBestMask(
          modules,
          setupFormatInfo.bind(null, modules, errorCorrectionLevel)
        );
      }
      MaskPattern.applyMask(maskPattern, modules);
      setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
      return {
        modules,
        version,
        errorCorrectionLevel,
        maskPattern,
        segments
      };
    }
    exports.create = function create(data, options) {
      if (typeof data === "undefined" || data === "") {
        throw new Error("No input text");
      }
      let errorCorrectionLevel = ECLevel.M;
      let version;
      let mask;
      if (typeof options !== "undefined") {
        errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
        version = Version.from(options.version);
        mask = MaskPattern.from(options.maskPattern);
        if (options.toSJISFunc) {
          Utils.setToSJISFunction(options.toSJISFunc);
        }
      }
      return createSymbol(data, version, errorCorrectionLevel, mask);
    };
  }
});

// node_modules/qrcode/lib/renderer/utils.js
var require_utils2 = __commonJS({
  "node_modules/qrcode/lib/renderer/utils.js"(exports) {
    function hex2rgba(hex) {
      if (typeof hex === "number") {
        hex = hex.toString();
      }
      if (typeof hex !== "string") {
        throw new Error("Color should be defined as hex string");
      }
      let hexCode = hex.slice().replace("#", "").split("");
      if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
        throw new Error("Invalid hex color: " + hex);
      }
      if (hexCode.length === 3 || hexCode.length === 4) {
        hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
          return [c, c];
        }));
      }
      if (hexCode.length === 6) hexCode.push("F", "F");
      const hexValue = parseInt(hexCode.join(""), 16);
      return {
        r: hexValue >> 24 & 255,
        g: hexValue >> 16 & 255,
        b: hexValue >> 8 & 255,
        a: hexValue & 255,
        hex: "#" + hexCode.slice(0, 6).join("")
      };
    }
    exports.getOptions = function getOptions(options) {
      if (!options) options = {};
      if (!options.color) options.color = {};
      const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
      const width = options.width && options.width >= 21 ? options.width : void 0;
      const scale = options.scale || 4;
      return {
        width,
        scale: width ? 4 : scale,
        margin,
        color: {
          dark: hex2rgba(options.color.dark || "#000000ff"),
          light: hex2rgba(options.color.light || "#ffffffff")
        },
        type: options.type,
        rendererOpts: options.rendererOpts || {}
      };
    };
    exports.getScale = function getScale(qrSize, opts) {
      return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
    };
    exports.getImageWidth = function getImageWidth(qrSize, opts) {
      const scale = exports.getScale(qrSize, opts);
      return Math.floor((qrSize + opts.margin * 2) * scale);
    };
    exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
      const size = qr.modules.size;
      const data = qr.modules.data;
      const scale = exports.getScale(size, opts);
      const symbolSize = Math.floor((size + opts.margin * 2) * scale);
      const scaledMargin = opts.margin * scale;
      const palette = [opts.color.light, opts.color.dark];
      for (let i = 0; i < symbolSize; i++) {
        for (let j = 0; j < symbolSize; j++) {
          let posDst = (i * symbolSize + j) * 4;
          let pxColor = opts.color.light;
          if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
            const iSrc = Math.floor((i - scaledMargin) / scale);
            const jSrc = Math.floor((j - scaledMargin) / scale);
            pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
          }
          imgData[posDst++] = pxColor.r;
          imgData[posDst++] = pxColor.g;
          imgData[posDst++] = pxColor.b;
          imgData[posDst] = pxColor.a;
        }
      }
    };
  }
});

// node_modules/qrcode/lib/renderer/canvas.js
var require_canvas = __commonJS({
  "node_modules/qrcode/lib/renderer/canvas.js"(exports) {
    var Utils = require_utils2();
    function clearCanvas(ctx, canvas, size) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!canvas.style) canvas.style = {};
      canvas.height = size;
      canvas.width = size;
      canvas.style.height = size + "px";
      canvas.style.width = size + "px";
    }
    function getCanvasElement() {
      try {
        return document.createElement("canvas");
      } catch (e) {
        throw new Error("You need to specify a canvas element");
      }
    }
    exports.render = function render(qrData, canvas, options) {
      let opts = options;
      let canvasEl = canvas;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!canvas) {
        canvasEl = getCanvasElement();
      }
      opts = Utils.getOptions(opts);
      const size = Utils.getImageWidth(qrData.modules.size, opts);
      const ctx = canvasEl.getContext("2d");
      const image = ctx.createImageData(size, size);
      Utils.qrToImageData(image.data, qrData, opts);
      clearCanvas(ctx, canvasEl, size);
      ctx.putImageData(image, 0, 0);
      return canvasEl;
    };
    exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
      let opts = options;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!opts) opts = {};
      const canvasEl = exports.render(qrData, canvas, opts);
      const type = opts.type || "image/png";
      const rendererOpts = opts.rendererOpts || {};
      return canvasEl.toDataURL(type, rendererOpts.quality);
    };
  }
});

// node_modules/qrcode/lib/renderer/svg-tag.js
var require_svg_tag = __commonJS({
  "node_modules/qrcode/lib/renderer/svg-tag.js"(exports) {
    var Utils = require_utils2();
    function getColorAttrib(color, attrib) {
      const alpha = color.a / 255;
      const str = attrib + '="' + color.hex + '"';
      return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
    }
    function svgCmd(cmd, x, y) {
      let str = cmd + x;
      if (typeof y !== "undefined") str += " " + y;
      return str;
    }
    function qrToPath(data, size, margin) {
      let path = "";
      let moveBy = 0;
      let newRow = false;
      let lineLength = 0;
      for (let i = 0; i < data.length; i++) {
        const col = Math.floor(i % size);
        const row = Math.floor(i / size);
        if (!col && !newRow) newRow = true;
        if (data[i]) {
          lineLength++;
          if (!(i > 0 && col > 0 && data[i - 1])) {
            path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
            moveBy = 0;
            newRow = false;
          }
          if (!(col + 1 < size && data[i + 1])) {
            path += svgCmd("h", lineLength);
            lineLength = 0;
          }
        } else {
          moveBy++;
        }
      }
      return path;
    }
    exports.render = function render(qrData, options, cb) {
      const opts = Utils.getOptions(options);
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const qrcodesize = size + opts.margin * 2;
      const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
      const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
      const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
      const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
      const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
      if (typeof cb === "function") {
        cb(null, svgTag);
      }
      return svgTag;
    };
  }
});

// node_modules/qrcode/lib/browser.js
var require_browser = __commonJS({
  "node_modules/qrcode/lib/browser.js"(exports) {
    var canPromise = require_can_promise();
    var QRCode2 = require_qrcode();
    var CanvasRenderer = require_canvas();
    var SvgRenderer = require_svg_tag();
    function renderCanvas(renderFunc, canvas, text, opts, cb) {
      const args = [].slice.call(arguments, 1);
      const argsNum = args.length;
      const isLastArgCb = typeof args[argsNum - 1] === "function";
      if (!isLastArgCb && !canPromise()) {
        throw new Error("Callback required as last argument");
      }
      if (isLastArgCb) {
        if (argsNum < 2) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 2) {
          cb = text;
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 3) {
          if (canvas.getContext && typeof cb === "undefined") {
            cb = opts;
            opts = void 0;
          } else {
            cb = opts;
            opts = text;
            text = canvas;
            canvas = void 0;
          }
        }
      } else {
        if (argsNum < 1) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 1) {
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 2 && !canvas.getContext) {
          opts = text;
          text = canvas;
          canvas = void 0;
        }
        return new Promise(function(resolve, reject) {
          try {
            const data = QRCode2.create(text, opts);
            resolve(renderFunc(data, canvas, opts));
          } catch (e) {
            reject(e);
          }
        });
      }
      try {
        const data = QRCode2.create(text, opts);
        cb(null, renderFunc(data, canvas, opts));
      } catch (e) {
        cb(e);
      }
    }
    exports.create = QRCode2.create;
    exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
    exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
    exports.toString = renderCanvas.bind(null, function(data, _, opts) {
      return SvgRenderer.render(data, opts);
    });
  }
});

// experiments/console-launcher/main.ts
var import_qrcode = __toESM(require_browser(), 1);

// packages/runtime/src/ui/console/backdrop.ts
var ConsoleBackdrop = class {
  element;
  layers;
  tier;
  activeLayer = 0;
  currentTheme = null;
  pendingTheme = null;
  pausedFlag = false;
  constructor(doc, options = {}) {
    this.tier = options.tier ?? "full";
    const root = doc.createElement("div");
    root.className = "console-backdrop";
    root.setAttribute("aria-hidden", "true");
    root.dataset["motion"] = this.tier;
    const first = this.createLayer(doc);
    const second = this.createLayer(doc);
    root.append(first, second);
    this.element = root;
    this.layers = [first, second];
  }
  get tierName() {
    return this.tier;
  }
  get paused() {
    return this.pausedFlag;
  }
  /** Crossfades to `theme`; while paused the latest theme is held. */
  show(theme) {
    this.currentTheme = theme;
    if (this.pausedFlag) {
      this.pendingTheme = theme;
      return;
    }
    this.apply(theme);
  }
  /** The theme currently painted, or null before the first `show`. */
  get theme() {
    return this.currentTheme;
  }
  /** Stops applying theme changes while a game runs (ER-25-07). */
  pause() {
    if (this.pausedFlag) return;
    this.pausedFlag = true;
    this.element.dataset["paused"] = "true";
    this.pendingTheme = this.currentTheme;
  }
  /** Applies the newest held theme immediately and resumes updates. */
  resume() {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    this.element.dataset["paused"] = "false";
    const pending = this.pendingTheme;
    this.pendingTheme = null;
    if (pending !== null) this.apply(pending);
  }
  destroy() {
    this.currentTheme = null;
    this.pendingTheme = null;
    this.element.remove();
  }
  createLayer(doc) {
    const layer = doc.createElement("div");
    layer.className = "console-backdrop__layer";
    layer.dataset["visible"] = "false";
    return layer;
  }
  apply(theme) {
    const nextIndex = this.activeLayer === 0 ? 1 : 0;
    const next = this.layers[nextIndex];
    const current = this.layers[this.activeLayer];
    if (next === void 0 || current === void 0) return;
    next.style.setProperty("background", theme.gradient);
    next.style.setProperty("--backdrop-accent", theme.accent);
    next.dataset["visible"] = "true";
    current.dataset["visible"] = "false";
    this.activeLayer = nextIndex;
    this.element.dataset["accent"] = theme.accent;
  }
};

// packages/runtime/src/ui/Launcher.ts
function playerRangeLabel(minPlayers, maxPlayers) {
  if (!Number.isFinite(minPlayers) || !Number.isFinite(maxPlayers)) {
    return "Players";
  }
  const min = Math.min(8, Math.max(1, Math.trunc(minPlayers)));
  const max = Math.min(8, Math.max(min, Math.trunc(maxPlayers)));
  if (min === max) return `${min} player${min === 1 ? "" : "s"}`;
  return `${min}\u2013${max} players`;
}

// packages/runtime/src/ui/console/presentation.ts
var PLAYER_COLORS = [
  "#4cb3f0",
  "#ff9f45",
  "#c58cff",
  "#4fd1a1",
  "#ff7aa8",
  "#f2d05c",
  "#8fb8ff",
  "#ff6b6b"
];
var PLAYER_SHAPES = [
  "circle",
  "triangle",
  "square",
  "diamond"
];
var PLAYER_LABELS = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8"
];
var FALLBACK_ACCENTS = PLAYER_COLORS;
var HEX_COLOR = /^#[0-9a-f]{6}$/i;
var INPUT_BADGE_LABELS = {
  stick: "Stick",
  dpad: "D-pad",
  buttons: "Buttons",
  triggers: "Triggers",
  gyro: "Gyro",
  haptics: "Haptics",
  text: "Text entry",
  canvas: "Canvas",
  choice: "Choice"
};
function monogramFor(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function fallbackAccent(game) {
  const seed = game.slug.length > 0 ? game.slug : game.name;
  const index = hashText(seed) % FALLBACK_ACCENTS.length;
  return FALLBACK_ACCENTS[index] ?? "#4cb3f0";
}
function presentationAccent(game) {
  const accent = game.presentation?.accent;
  if (accent !== void 0 && HEX_COLOR.test(accent)) {
    return accent.toLowerCase();
  }
  return fallbackAccent(game);
}
function presentationGradient(game) {
  const accent = presentationAccent(game);
  return `radial-gradient(120% 120% at 18% 0%, ${accent}73 0%, ${accent}26 42%, #050505 78%)`;
}
function presentationTagline(game) {
  const tagline = game.presentation?.tagline?.trim();
  return tagline !== void 0 && tagline.length > 0 ? tagline : null;
}
function presentationBadges(game) {
  const badges = game.presentation?.inputBadges ?? [];
  return badges.filter(
    (badge) => INPUT_BADGE_LABELS[badge] !== void 0
  );
}
function inputBadgeLabel(badge) {
  return INPUT_BADGE_LABELS[badge] ?? "Input";
}
function sortConsoleGames(games) {
  const featured = (game) => game.presentation?.featured === true ? 0 : 1;
  return [...games].sort((a, b) => {
    const byFeatured = featured(a) - featured(b);
    if (byFeatured !== 0) return byFeatured;
    const aName = a.name.trim().toLowerCase();
    const bName = b.name.trim().toLowerCase();
    if (aName < bName) return -1;
    if (aName > bName) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}
function visibleConsoleGames(games, debug) {
  return games.filter((game) => game.debugOnly !== true || debug);
}
function slotColor(slot) {
  const safe = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  return PLAYER_COLORS[safe - 1] ?? PLAYER_COLORS[0] ?? "#4cb3f0";
}
function slotLabel(slot) {
  const safe = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  return PLAYER_LABELS[safe - 1] ?? "P1";
}
function slotShape(slot) {
  const safe = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  return PLAYER_SHAPES[(safe - 1) % PLAYER_SHAPES.length] ?? "circle";
}
function resolvePlayers(inputs) {
  const seen = /* @__PURE__ */ new Set();
  const players = [];
  for (const input of inputs) {
    if (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > 8) {
      continue;
    }
    if (seen.has(input.slot)) continue;
    seen.add(input.slot);
    const state = input.state ?? "connected";
    players.push({
      slot: input.slot,
      label: input.label?.trim() || slotLabel(input.slot),
      color: input.color?.trim() || slotColor(input.slot),
      shape: input.shape ?? slotShape(input.slot),
      state
    });
  }
  return players.sort((a, b) => a.slot - b.slot);
}
function connectedPlayers(players) {
  return players.filter((player) => player.state === "connected");
}

// packages/runtime/src/ui/console/gameRow.ts
var ROW_HEADING = "Games";
var EMPTY_ROW_TITLE = "No games installed";
var EMPTY_ROW_HINT = "Add a game folder, then reload the host.";
var PLAY_LABEL = "Play";
var MAX_PARALLAX_PX = 8;
var SAFE_THUMBNAIL = /^(?:\/[A-Za-z0-9/._~%:@+=-]*|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)$/;
var ConsoleGameRow = class {
  element;
  track;
  emptyState;
  doc;
  motion;
  games;
  onActivate;
  onFocusChange;
  tiles = [];
  activeIndex = 0;
  parallaxX = 0;
  parallaxY = 0;
  destroyed = false;
  constructor(doc, options) {
    this.doc = doc;
    this.motion = options.motion ?? "full";
    this.onActivate = options.onActivate;
    this.onFocusChange = options.onFocusChange;
    this.games = sortConsoleGames(options.games);
    const root = doc.createElement("section");
    root.className = "console-row";
    root.dataset["motion"] = this.motion;
    root.setAttribute("aria-labelledby", "console-row-title");
    const head = doc.createElement("div");
    head.className = "console-row__head";
    const heading = doc.createElement("h2");
    heading.id = "console-row-title";
    heading.className = "console-row__title";
    heading.textContent = ROW_HEADING;
    const count = doc.createElement("p");
    count.className = "console-row__count";
    count.textContent = this.games.length === 1 ? "1 game" : `${this.games.length} games`;
    head.append(heading, count);
    this.track = doc.createElement("ul");
    this.track.className = "console-row__track";
    this.track.setAttribute("aria-label", ROW_HEADING);
    for (const game of this.games) {
      this.track.append(this.createTile(game).slot);
    }
    this.emptyState = doc.createElement("div");
    this.emptyState.className = "console-row__empty";
    this.emptyState.hidden = this.games.length > 0;
    const emptyTitle = doc.createElement("h3");
    emptyTitle.className = "console-row__empty-title";
    emptyTitle.textContent = EMPTY_ROW_TITLE;
    const emptyHint = doc.createElement("p");
    emptyHint.className = "console-row__empty-hint";
    emptyHint.textContent = EMPTY_ROW_HINT;
    this.emptyState.append(emptyTitle, emptyHint);
    this.track.hidden = this.games.length === 0;
    root.append(head, this.track, this.emptyState);
    this.element = root;
    if (this.games.length > 0) this.applyActive(0, false);
  }
  /** Sorted games in display order. */
  get gameList() {
    return this.games;
  }
  get focusedGame() {
    return this.games[this.activeIndex] ?? null;
  }
  get focusedIndex() {
    return this.games.length === 0 ? -1 : this.activeIndex;
  }
  /** Focuses the active tile, or the shelf when no games exist. */
  focus() {
    if (this.destroyed) return;
    const tile = this.tiles[this.activeIndex];
    if (tile !== void 0) {
      tile.element.focus();
      return;
    }
    if (this.element.tabIndex < 0) this.element.tabIndex = -1;
    this.element.focus();
  }
  /** Moves by `delta` with wrap-around at both ends. */
  move(delta) {
    if (this.destroyed || this.games.length === 0 || delta === 0) return;
    const next = ((this.activeIndex + delta) % this.games.length + this.games.length) % this.games.length;
    this.focusIndex(next);
  }
  focusFirst() {
    if (this.games.length > 0) this.focusIndex(0);
  }
  focusLast() {
    if (this.games.length > 0) this.focusIndex(this.games.length - 1);
  }
  /** Activates and focuses index `index` (the roving tab stop moves with it). */
  focusIndex(index) {
    if (this.destroyed || this.games.length === 0) return false;
    if (!Number.isInteger(index) || index < 0 || index >= this.games.length) {
      return false;
    }
    this.applyActive(index, true);
    this.tiles[index]?.element.focus();
    return true;
  }
  /** Restores the tile that was focused before a launch. */
  focusSlug(slug) {
    if (slug === null) return false;
    const index = this.games.findIndex((game) => game.slug === slug);
    if (index < 0) return false;
    return this.focusIndex(index);
  }
  /** Launches the focused game; false when the shelf is empty. */
  activateActive() {
    const game = this.focusedGame;
    if (this.destroyed || game === null) return false;
    this.onActivate?.(game);
    return true;
  }
  /**
   * Pointer parallax for the focused tile, capped at 8px. The reduced tier
   * ignores it entirely; input handling never reads this value.
   */
  setParallax(x, y) {
    if (this.destroyed) return;
    const tile = this.tiles[this.activeIndex];
    if (tile === void 0) return;
    if (this.motion === "reduced") {
      this.parallaxX = 0;
      this.parallaxY = 0;
      tile.element.style.setProperty("--parallax-x", "0px");
      tile.element.style.setProperty("--parallax-y", "0px");
      return;
    }
    this.parallaxX = clampParallax(x);
    this.parallaxY = clampParallax(y);
    tile.element.style.setProperty("--parallax-x", `${this.parallaxX}px`);
    tile.element.style.setProperty("--parallax-y", `${this.parallaxY}px`);
  }
  /** Current parallax offsets; tests use this to prove the cap. */
  get parallax() {
    return { x: this.parallaxX, y: this.parallaxY };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const tile of this.tiles) {
      tile.element.removeEventListener("click", tile.handleClick);
      tile.element.removeEventListener("focus", tile.handleFocus);
    }
    this.tiles.length = 0;
    this.element.remove();
  }
  createTile(game) {
    const doc = this.doc;
    const accent = presentationAccent(game);
    const slot = doc.createElement("li");
    slot.className = "console-tile-slot";
    const element = doc.createElement("button");
    element.setAttribute("type", "button");
    element.className = "console-tile";
    element.dataset["slug"] = game.slug;
    element.dataset["consoleTile"] = "true";
    element.dataset["active"] = "false";
    element.tabIndex = -1;
    element.style.setProperty("--tile-accent", accent);
    const art = doc.createElement("span");
    art.className = "console-tile__art";
    art.setAttribute("aria-hidden", "true");
    art.dataset["art"] = "generated";
    art.style.setProperty("background", presentationGradient(game));
    const thumbnail = game.presentation?.thumbnail;
    if (thumbnail !== void 0 && SAFE_THUMBNAIL.test(thumbnail)) {
      const image = doc.createElement("span");
      image.className = "console-tile__image";
      image.style.setProperty("background-image", `url("${thumbnail}")`);
      art.append(image);
      art.dataset["art"] = "image";
    }
    const monogram = doc.createElement("span");
    monogram.className = "console-tile__monogram";
    monogram.textContent = monogramFor(game.name);
    art.append(monogram);
    const body = doc.createElement("span");
    body.className = "console-tile__body";
    const title = doc.createElement("span");
    title.className = "console-tile__title";
    title.textContent = game.name;
    const details = doc.createElement("span");
    details.className = "console-tile__details";
    details.hidden = true;
    const tagline = presentationTagline(game);
    if (tagline !== null) {
      const taglineEl = doc.createElement("span");
      taglineEl.className = "console-tile__tagline";
      taglineEl.textContent = tagline;
      details.append(taglineEl);
    }
    const range = doc.createElement("span");
    range.className = "console-tile__range";
    range.textContent = playerRangeLabel(game.minPlayers, game.maxPlayers);
    details.append(range);
    const badges = presentationBadges(game);
    if (badges.length > 0) {
      const badgeList = doc.createElement("span");
      badgeList.className = "console-tile__badges";
      for (const badge of badges) {
        const badgeEl = doc.createElement("span");
        badgeEl.className = "console-badge";
        badgeEl.textContent = inputBadgeLabel(badge);
        badgeList.append(badgeEl);
      }
      details.append(badgeList);
    }
    const play = doc.createElement("span");
    play.className = "console-tile__play";
    play.setAttribute("aria-hidden", "true");
    play.textContent = PLAY_LABEL;
    details.append(play);
    body.append(title, details);
    element.append(art, body);
    const parts = [game.name, playerRangeLabel(game.minPlayers, game.maxPlayers)];
    if (tagline !== null) parts.push(tagline);
    element.setAttribute("aria-label", parts.join(", "));
    const binding = {
      game,
      slot,
      element,
      art,
      details,
      handleClick: () => {
        if (this.destroyed) return;
        this.onActivate?.(game);
      },
      handleFocus: () => {
        if (this.destroyed) return;
        const index = this.tiles.indexOf(binding);
        if (index >= 0 && index !== this.activeIndex) {
          this.applyActive(index, true);
        }
      }
    };
    element.addEventListener("click", binding.handleClick);
    element.addEventListener("focus", binding.handleFocus);
    this.tiles.push(binding);
    slot.append(element);
    return binding;
  }
  applyActive(index, notify) {
    const previous = this.tiles[this.activeIndex];
    if (previous !== void 0) {
      previous.element.dataset["active"] = "false";
      previous.element.tabIndex = -1;
      previous.details.hidden = true;
      previous.element.style.setProperty("--parallax-x", "0px");
      previous.element.style.setProperty("--parallax-y", "0px");
    }
    this.activeIndex = index;
    const next = this.tiles[index];
    if (next === void 0) return;
    next.element.dataset["active"] = "true";
    next.element.tabIndex = 0;
    next.details.hidden = false;
    next.element.style.setProperty("--parallax-x", `${this.parallaxX}px`);
    next.element.style.setProperty("--parallax-y", `${this.parallaxY}px`);
    if (notify) this.onFocusChange?.(next.game);
  }
};
function clampParallax(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_PARALLAX_PX, Math.min(MAX_PARALLAX_PX, value));
}

// packages/runtime/src/ui/console/hintBar.ts
var HINT_KEYBOARD = "Arrow keys move \xB7 Enter plays \xB7 Tab reaches the room controls";
var HINT_GAMEPAD = "D-pad or stick moves \xB7 A plays \xB7 B goes back";
var HINT_REMOTE = "D-pad moves \xB7 OK plays \xB7 Back goes back";
var HINTS = {
  keyboard: HINT_KEYBOARD,
  gamepad: HINT_GAMEPAD,
  remote: HINT_REMOTE
};
var ConsoleHintBar = class {
  element;
  textEl;
  mode = "keyboard";
  constructor(doc, initial = "keyboard") {
    const root = doc.createElement("aside");
    root.className = "console-hints";
    root.setAttribute("role", "note");
    root.setAttribute("aria-label", "Controls");
    this.textEl = doc.createElement("p");
    this.textEl.className = "console-hints__text";
    root.append(this.textEl);
    this.element = root;
    this.setMode(initial);
  }
  get inputMode() {
    return this.mode;
  }
  setMode(mode) {
    this.mode = mode;
    this.textEl.textContent = HINTS[mode];
  }
  destroy() {
    this.element.remove();
  }
};

// packages/runtime/src/ui/console/input.ts
var GAMEPAD_DEADZONE = 0.5;
var GAMEPAD_REARM = 0.35;
var GAMEPAD_BUTTONS = {
  confirm: 0,
  back: 1,
  up: 12,
  down: 13,
  left: 14,
  right: 15
};
var REMOTE_ACTIONS = {
  up: "prev",
  left: "prev",
  down: "next",
  right: "next",
  ok: "confirm",
  confirm: "confirm",
  back: "back",
  cancel: "back"
};
function remoteButtonToAction(button) {
  const key = button.trim().toLowerCase().replace(/[-_\s]+/g, "");
  return REMOTE_ACTIONS[key] ?? null;
}
var KEYCODE_ACTIONS = {
  13: "confirm",
  27: "back",
  32: "confirm",
  37: "prev",
  38: "prev",
  39: "next",
  40: "next",
  35: "last",
  36: "first"
};
function keyToAction(key, keyCode = 0) {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return "prev";
    case "ArrowRight":
    case "ArrowDown":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
    case " ":
    case "Spacebar":
      return "confirm";
    case "Escape":
    case "Esc":
      return "back";
    default:
      return key.length === 0 ? KEYCODE_ACTIONS[keyCode] ?? null : null;
  }
}
function isTextEntry(target) {
  if (target === null) return false;
  const el = target;
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}
function isNativeActivationControl(target) {
  if (target === null) return false;
  const el = target;
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "a") return true;
  if (tag !== "button") return false;
  return el.dataset?.["consoleTile"] !== "true";
}
var ConsoleInput = class {
  target;
  onAction;
  onModeChange;
  readGamepads;
  padEdges = /* @__PURE__ */ new Map();
  mode = "keyboard";
  attachedFlag = false;
  destroyed = false;
  constructor(doc, options) {
    this.target = options.target !== void 0 ? options.target : doc.defaultView;
    this.onAction = options.onAction;
    this.onModeChange = options.onModeChange;
    this.readGamepads = options.gamepads;
  }
  get currentMode() {
    return this.mode;
  }
  get attached() {
    return this.attachedFlag;
  }
  attach() {
    if (this.destroyed || this.attachedFlag || this.target === null) return;
    this.target.addEventListener("keydown", this.handleKeyDown);
    this.attachedFlag = true;
  }
  detach() {
    if (this.target !== null) {
      this.target.removeEventListener(
        "keydown",
        this.handleKeyDown
      );
    }
    this.attachedFlag = false;
  }
  /**
   * Maps one keyboard event. Returns true when an action was emitted (and the
   * browser default was prevented). Repeats are allowed for movement and
   * suppressed for `confirm`, so holding Enter launches once.
   */
  handleKey(event) {
    if (this.destroyed) return false;
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
      return false;
    }
    const action = keyToAction(event.key, event.keyCode);
    if (action === null) return false;
    if (isTextEntry(event.target)) return false;
    if (action === "confirm" && isNativeActivationControl(event.target)) {
      return false;
    }
    if (action === "confirm" && event.repeat === true) return false;
    if (typeof event.preventDefault === "function") event.preventDefault();
    this.emit(action, "keyboard");
    return true;
  }
  /** Maps a phone-remote button id; unknown ids are ignored. */
  handleRemote(button) {
    if (this.destroyed) return false;
    const action = remoteButtonToAction(button);
    if (action === null) return false;
    this.emit(action, "remote");
    return true;
  }
  /**
   * Reads every connected pad once and emits at most one action. Returns the
   * actions emitted, which lets tests and the host observe edges.
   */
  pollGamepad() {
    if (this.destroyed) return [];
    const pads = this.readPads();
    if (pads.length === 0) {
      this.padEdges.clear();
      return [];
    }
    const emitted = [];
    const seen = /* @__PURE__ */ new Set();
    for (let index = 0; index < pads.length; index += 1) {
      const pad = pads[index];
      if (pad === null || pad === void 0) continue;
      seen.add(index);
      let edge = this.padEdges.get(index);
      if (edge === void 0) {
        edge = { armedX: true, armedY: true, pressed: [] };
        this.padEdges.set(index, edge);
      }
      const action = this.pollPad(pad, edge);
      if (action !== null) emitted.push(action);
    }
    for (const index of this.padEdges.keys()) {
      if (!seen.has(index)) this.padEdges.delete(index);
    }
    const first = emitted[0];
    if (first !== void 0) this.emit(first, "gamepad");
    return emitted;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detach();
    this.padEdges.clear();
  }
  emit(action, mode) {
    if (this.mode !== mode) {
      this.mode = mode;
      this.onModeChange?.(mode);
    }
    this.onAction(action, mode);
  }
  readPads() {
    if (this.readGamepads !== void 0) return this.readGamepads();
    const nav = globalThis.navigator;
    return nav?.getGamepads?.() ?? [];
  }
  pollPad(pad, edge) {
    const buttons = pad.buttons ?? [];
    let action = null;
    const buttonAction = (index, mapped) => {
      const pressed = buttons[index]?.pressed === true;
      if (pressed && edge.pressed[index] !== true && action === null) {
        action = mapped;
      }
      edge.pressed[index] = pressed;
    };
    buttonAction(GAMEPAD_BUTTONS.confirm, "confirm");
    buttonAction(GAMEPAD_BUTTONS.back, "back");
    buttonAction(GAMEPAD_BUTTONS.up, "prev");
    buttonAction(GAMEPAD_BUTTONS.down, "next");
    buttonAction(GAMEPAD_BUTTONS.left, "prev");
    buttonAction(GAMEPAD_BUTTONS.right, "next");
    const axisX = pad.axes[0] ?? 0;
    const axisY = pad.axes[1] ?? 0;
    if (action === null) {
      if (axisX >= GAMEPAD_DEADZONE && edge.armedX) {
        action = "next";
        edge.armedX = false;
      } else if (axisX <= -GAMEPAD_DEADZONE && edge.armedX) {
        action = "prev";
        edge.armedX = false;
      } else if (Math.abs(axisX) <= GAMEPAD_REARM) {
        edge.armedX = true;
      }
    }
    if (action === null) {
      if (axisY >= GAMEPAD_DEADZONE && edge.armedY) {
        action = "next";
        edge.armedY = false;
      } else if (axisY <= -GAMEPAD_DEADZONE && edge.armedY) {
        action = "prev";
        edge.armedY = false;
      } else if (Math.abs(axisY) <= GAMEPAD_REARM) {
        edge.armedY = true;
      }
    }
    return action;
  }
  handleKeyDown = (event) => {
    this.handleKey(event);
  };
};

// packages/runtime/src/ui/console/lobbyPanel.ts
var LOBBY_HEADING = "Players";
var LOBBY_EMPTY_TITLE = "Scan to join";
var LOBBY_EMPTY_HINT = "No phones yet. Scan the QR in the top bar, or enter the room code.";
var LOBBY_QR_LABEL = "Show join QR";
var LOBBY_SLOT_COUNT = 8;
var STATE_LABELS = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  open: "Open"
};
var ConsoleLobbyPanel = class {
  element;
  emptyState;
  emptyHint;
  list;
  countEl;
  qrButton;
  doc;
  onScanRequest;
  rows = [];
  room;
  playerInputs;
  connected = 0;
  constructor(doc, options = {}) {
    this.doc = doc;
    this.onScanRequest = options.onScanRequest;
    this.room = options.room ?? { code: null, pin: null };
    this.playerInputs = options.players ?? [];
    const root = doc.createElement("section");
    root.className = "console-lobby";
    root.setAttribute("aria-labelledby", "console-lobby-title");
    const head = doc.createElement("div");
    head.className = "console-lobby__head";
    const heading = doc.createElement("h2");
    heading.id = "console-lobby-title";
    heading.className = "console-lobby__title";
    heading.textContent = LOBBY_HEADING;
    this.countEl = doc.createElement("p");
    this.countEl.className = "console-lobby__count";
    head.append(heading, this.countEl);
    this.emptyState = doc.createElement("div");
    this.emptyState.className = "console-lobby__empty";
    const emptyTitle = doc.createElement("h3");
    emptyTitle.className = "console-lobby__empty-title";
    emptyTitle.textContent = LOBBY_EMPTY_TITLE;
    this.emptyHint = doc.createElement("p");
    this.emptyHint.className = "console-lobby__empty-hint";
    this.qrButton = doc.createElement("button");
    this.qrButton.setAttribute("type", "button");
    this.qrButton.className = "console-lobby__qr";
    this.qrButton.textContent = LOBBY_QR_LABEL;
    this.qrButton.addEventListener("click", this.handleScanRequest);
    this.emptyState.append(emptyTitle, this.emptyHint, this.qrButton);
    this.list = doc.createElement("ul");
    this.list.className = "console-lobby__list";
    this.list.setAttribute("aria-label", "Player slots");
    for (let slot = 1; slot <= LOBBY_SLOT_COUNT; slot += 1) {
      this.list.append(this.createRow(slot).element);
    }
    root.append(head, this.emptyState, this.list);
    this.element = root;
    this.render();
  }
  get connectedCount() {
    return this.connected;
  }
  setPlayers(inputs) {
    this.playerInputs = inputs;
    this.render();
  }
  setRoom(room2) {
    this.room = room2;
    this.render();
  }
  destroy() {
    this.qrButton.removeEventListener("click", this.handleScanRequest);
    this.rows.length = 0;
    this.element.remove();
  }
  createRow(slot) {
    const doc = this.doc;
    const element = doc.createElement("li");
    element.className = "console-lobby__row";
    element.dataset["slot"] = String(slot);
    element.dataset["state"] = "open";
    const shape = doc.createElement("span");
    shape.className = "console-lobby__shape";
    shape.dataset["shape"] = slotShape(slot);
    shape.setAttribute("aria-hidden", "true");
    const label = doc.createElement("span");
    label.className = "console-lobby__label";
    label.textContent = slotLabel(slot);
    const state = doc.createElement("span");
    state.className = "console-lobby__state";
    state.textContent = STATE_LABELS.open;
    element.append(shape, label, state);
    const binding = { slot, element, shape, label, state };
    this.rows.push(binding);
    return binding;
  }
  render() {
    const players = resolvePlayers(this.playerInputs);
    const bySlot = new Map(players.map((player) => [player.slot, player]));
    this.connected = players.filter(
      (player) => player.state === "connected"
    ).length;
    for (const row of this.rows) {
      const player = bySlot.get(row.slot);
      const state = player?.state ?? "open";
      const label = player?.label ?? slotLabel(row.slot);
      const color = player?.color ?? slotColor(row.slot);
      const shape = player?.shape ?? slotShape(row.slot);
      row.element.dataset["state"] = state;
      row.element.setAttribute(
        "aria-label",
        `${label}, ${STATE_LABELS[state]}`
      );
      row.shape.dataset["shape"] = shape;
      row.element.style.setProperty("--player-color", color);
      row.label.textContent = label;
      row.state.textContent = STATE_LABELS[state];
    }
    const code = this.room.code?.trim() ?? "";
    this.emptyHint.textContent = code.length > 0 ? `No phones yet. Scan the QR in the top bar, or enter room ${code}.` : LOBBY_EMPTY_HINT;
    this.emptyState.hidden = this.connected > 0;
    this.list.hidden = this.connected === 0;
    this.countEl.textContent = `${this.connected} of ${LOBBY_SLOT_COUNT}`;
  }
  handleScanRequest = () => {
    this.onScanRequest?.();
  };
};

// packages/runtime/src/ui/console/loadingScreen.ts
var LOADING_EYEBROW = "Loading";
var LOADING_UNKNOWN_TOTAL = "Preparing game\u2026";
var nextTitleId = 0;
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
var ConsoleLoadingScreen = class {
  element;
  titleEl;
  bar;
  fill;
  bytesEl;
  percentEl;
  titleId;
  fraction = 0;
  constructor(doc, options = {}) {
    this.titleId = `console-loading-title-${nextTitleId++}`;
    const root = doc.createElement("section");
    root.className = "console-loading";
    root.dataset["motion"] = options.motion ?? "full";
    root.setAttribute("role", "region");
    root.setAttribute("aria-labelledby", this.titleId);
    root.hidden = true;
    const inner = doc.createElement("div");
    inner.className = "console-loading__inner";
    const eyebrow = doc.createElement("p");
    eyebrow.className = "console-loading__eyebrow";
    eyebrow.textContent = LOADING_EYEBROW;
    this.titleEl = doc.createElement("h1");
    this.titleEl.id = this.titleId;
    this.titleEl.className = "console-loading__title";
    this.titleEl.tabIndex = -1;
    this.bar = doc.createElement("div");
    this.bar.className = "console-loading__bar";
    this.bar.setAttribute("role", "progressbar");
    this.bar.setAttribute("aria-labelledby", this.titleId);
    this.bar.setAttribute("aria-valuemin", "0");
    this.bar.setAttribute("aria-valuemax", "100");
    this.bar.setAttribute("aria-valuenow", "0");
    this.fill = doc.createElement("span");
    this.fill.className = "console-loading__fill";
    this.fill.style.setProperty("transform", "scaleX(0)");
    this.bar.append(this.fill);
    const meta = doc.createElement("p");
    meta.className = "console-loading__meta";
    this.bytesEl = doc.createElement("span");
    this.bytesEl.className = "console-loading__bytes";
    this.bytesEl.textContent = LOADING_UNKNOWN_TOTAL;
    this.percentEl = doc.createElement("span");
    this.percentEl.className = "console-loading__percent";
    this.percentEl.textContent = "0%";
    meta.append(this.bytesEl, this.percentEl);
    inner.append(eyebrow, this.titleEl, this.bar, meta);
    root.append(inner);
    this.element = root;
  }
  get isVisible() {
    return !this.element.hidden;
  }
  /** Reveals the screen for `title` and resets the bar to zero. */
  show(title) {
    this.titleEl.textContent = title;
    this.element.hidden = false;
    this.setProgress({ fraction: 0, loadedBytes: 0, totalBytes: 0 });
  }
  hide() {
    this.element.hidden = true;
  }
  /** Moves the bar; a null/unknown fraction renders indeterminate. */
  update(progress) {
    this.setProgress(progress);
  }
  /** Moves focus to the game title so screen readers announce the screen. */
  focus() {
    if (this.element.hidden) return;
    this.titleEl.focus();
  }
  destroy() {
    this.element.remove();
  }
  setProgress(progress) {
    const fraction = progress.fraction;
    const determinate = typeof fraction === "number" && Number.isFinite(fraction);
    const clamped = determinate ? Math.max(0, Math.min(1, fraction)) : 0;
    this.fraction = clamped;
    this.element.dataset["determinate"] = determinate ? "true" : "false";
    if (determinate) {
      this.bar.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
      this.fill.style.setProperty("transform", `scaleX(${clamped})`);
      this.percentEl.textContent = `${Math.round(clamped * 100)}%`;
    } else {
      this.bar.removeAttribute("aria-valuenow");
      this.fill.style.setProperty("transform", "scaleX(0.15)");
      this.percentEl.textContent = "";
    }
    const loaded = formatBytes(progress.loadedBytes);
    if (!determinate || progress.totalBytes <= 0) {
      this.bytesEl.textContent = progress.loadedBytes > 0 ? `${loaded} fetched` : LOADING_UNKNOWN_TOTAL;
      return;
    }
    this.bytesEl.textContent = `${loaded} of ${formatBytes(progress.totalBytes)}`;
  }
};

// packages/runtime/src/ui/console/motion.ts
var REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function resolveMotionTier(preferences = {}) {
  return preferences.prefersReducedMotion === true || preferences.lowTier === true ? "reduced" : "full";
}
function readPrefersReducedMotion(doc) {
  try {
    const view = doc.defaultView;
    if (view === null || typeof view.matchMedia !== "function") return false;
    return view.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

// packages/runtime/src/ui/console/startGate.ts
var START_GATE_PROMPT = "Press any key, button or tap to start";
var START_GATE_HINT = "This also turns sound on.";
var MODIFIER_KEYS = /* @__PURE__ */ new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "AltGraph",
  "Dead",
  "Unidentified"
]);
var ConsoleStartGate = class {
  element;
  primaryButton;
  onStart;
  unlockAudio;
  target;
  startedFlag = false;
  destroyed = false;
  activation = null;
  constructor(doc, options) {
    this.onStart = options.onStart;
    this.unlockAudio = options.unlockAudio;
    this.target = options.target !== void 0 ? options.target : doc.defaultView;
    const root = doc.createElement("section");
    root.className = "console-gate";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Start");
    const title = doc.createElement("h1");
    title.className = "console-gate__title";
    title.textContent = options.title ?? "PocketPad";
    const prompt = doc.createElement("p");
    prompt.className = "console-gate__prompt";
    prompt.textContent = START_GATE_PROMPT;
    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.className = "console-gate__button";
    button.textContent = "Start";
    button.addEventListener("click", this.handleClick);
    this.primaryButton = button;
    const hint = doc.createElement("p");
    hint.className = "console-gate__hint";
    hint.textContent = START_GATE_HINT;
    root.append(title, button, prompt, hint);
    root.addEventListener("pointerdown", this.handlePointerDown);
    this.element = root;
    if (this.target !== null) {
      this.target.addEventListener(
        "keydown",
        this.handleKeyDown
      );
    }
  }
  get started() {
    return this.startedFlag;
  }
  /** Moves focus to the single action (switch/keyboard parity). */
  focus() {
    if (this.destroyed) return;
    this.primaryButton.focus();
  }
  /**
   * Runs the gesture path exactly once. `source` is informational; every
   * source is an accepted start gesture. Never rejects.
   */
  async activate(source = "pointer") {
    void source;
    if (this.destroyed || this.startedFlag) {
      return this.activation ?? Promise.resolve();
    }
    this.startedFlag = true;
    const attempt = this.performStart();
    this.activation = attempt;
    try {
      await attempt;
    } finally {
      if (this.activation === attempt) this.activation = null;
    }
  }
  /**
   * Any keyboard key is a start gesture, except modifier-only keys and Tab
   * (Tab must stay available to reach the button without unlocking audio).
   * Returns true when the key was consumed.
   */
  handleKey(event) {
    if (this.destroyed || this.startedFlag) return false;
    if (event.repeat === true) return false;
    const key = event.key;
    if (key === "Tab" || key === "Escape" || MODIFIER_KEYS.has(key)) {
      return false;
    }
    if (typeof event.preventDefault === "function") event.preventDefault();
    void this.activate("keyboard");
    return true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.target !== null) {
      this.target.removeEventListener(
        "keydown",
        this.handleKeyDown
      );
    }
    this.primaryButton.removeEventListener("click", this.handleClick);
    this.element.removeEventListener("pointerdown", this.handlePointerDown);
    this.element.remove();
  }
  async performStart() {
    if (this.unlockAudio !== void 0) {
      try {
        await this.unlockAudio();
      } catch {
      }
    }
    if (this.destroyed) return;
    this.onStart();
  }
  handleClick = () => {
    void this.activate("pointer");
  };
  handlePointerDown = () => {
    void this.activate("pointer");
  };
  handleKeyDown = (event) => {
    this.handleKey(event);
  };
};

// packages/runtime/src/ui/console/topBar.ts
var QR_UNAVAILABLE = "Join QR unavailable";
var QR_CAPTION = "Scan to join";
var nextQrPanelId = 0;
function formatClock(now) {
  if (Number.isNaN(now.getTime())) return "--:--";
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
var ConsoleTopBar = class {
  element;
  qrToggle;
  qrPanel;
  qrStatus;
  clockEl;
  connectionEl;
  chipsEl;
  codeEl;
  pinEl;
  doc;
  renderQr;
  panelId;
  room;
  qrCanvas = null;
  qrOpen = false;
  chipSignature = "";
  renderGeneration = 0;
  destroyed = false;
  constructor(doc, options = {}) {
    this.doc = doc;
    this.renderQr = options.renderQr;
    this.room = options.room ?? { code: null, pin: null };
    this.panelId = `console-qr-${nextQrPanelId++}`;
    const root = doc.createElement("header");
    root.className = "console-top";
    const left = doc.createElement("div");
    left.className = "console-top__left";
    this.codeEl = doc.createElement("span");
    this.codeEl.className = "console-top__code";
    this.codeEl.dataset["role"] = "room-code";
    this.pinEl = doc.createElement("span");
    this.pinEl.className = "console-top__pin";
    this.qrToggle = doc.createElement("button");
    this.qrToggle.setAttribute("type", "button");
    this.qrToggle.className = "console-top__qr-toggle";
    this.qrToggle.setAttribute("aria-expanded", "false");
    this.qrToggle.setAttribute("aria-controls", this.panelId);
    this.qrToggle.textContent = "QR";
    this.qrToggle.addEventListener("click", this.handleQrToggle);
    left.append(this.codeEl, this.pinEl, this.qrToggle);
    this.qrPanel = doc.createElement("div");
    this.qrPanel.className = "console-qr";
    this.qrPanel.id = this.panelId;
    this.qrPanel.hidden = true;
    this.qrStatus = doc.createElement("p");
    this.qrStatus.className = "console-qr__status";
    this.qrStatus.setAttribute("role", "status");
    this.qrStatus.setAttribute("aria-live", "polite");
    this.qrPanel.append(this.qrStatus);
    const right = doc.createElement("div");
    right.className = "console-top__right";
    this.connectionEl = doc.createElement("span");
    this.connectionEl.className = "console-status";
    const connectionDot = doc.createElement("span");
    connectionDot.className = "console-status__dot";
    connectionDot.setAttribute("aria-hidden", "true");
    const connectionText = doc.createElement("span");
    connectionText.className = "console-status__text";
    this.connectionEl.append(connectionDot, connectionText);
    this.clockEl = doc.createElement("time");
    this.clockEl.className = "console-top__clock";
    this.chipsEl = doc.createElement("div");
    this.chipsEl.className = "console-top__players";
    this.chipsEl.setAttribute("role", "list");
    this.chipsEl.setAttribute("aria-label", "Connected players");
    right.append(this.connectionEl, this.clockEl, this.chipsEl);
    root.append(left, this.qrPanel, right);
    this.element = root;
    this.renderRoom();
    this.setConnection(options.connection ?? { text: "Room live", tone: "ok" });
    this.setClock(/* @__PURE__ */ new Date());
    this.setPlayers(options.players ?? []);
  }
  get roomInfo() {
    return this.room;
  }
  get isQrOpen() {
    return this.qrOpen;
  }
  setRoom(room2) {
    this.room = room2;
    this.renderRoom();
    if (this.qrOpen) this.renderQrPanel();
  }
  setConnection(connection) {
    const text = this.connectionEl.children[1];
    if (text !== void 0) text.textContent = connection.text;
    this.connectionEl.dataset["tone"] = connection.tone;
    this.connectionEl.setAttribute(
      "aria-label",
      `Connection: ${connection.text}`
    );
  }
  setClock(now) {
    this.clockEl.textContent = formatClock(now);
    this.clockEl.setAttribute("datetime", now.toISOString());
  }
  /** Rebuilds chips only when the resolved player list changed. */
  setPlayers(inputs) {
    const players = connectedPlayers(resolvePlayers(inputs));
    const signature = players.map(
      (player) => `${player.slot}:${player.color}:${player.shape}:${player.label}`
    ).join("|");
    if (signature === this.chipSignature) return;
    this.chipSignature = signature;
    const chips = [];
    for (const player of players) chips.push(this.createChip(player));
    this.chipsEl.replaceChildren(...chips);
    this.chipsEl.hidden = chips.length === 0;
  }
  setQrOpen(open) {
    if (this.destroyed || this.qrOpen === open) return;
    this.qrOpen = open;
    this.qrPanel.hidden = !open;
    this.qrToggle.setAttribute("aria-expanded", open ? "true" : "false");
    this.qrToggle.textContent = open ? "Hide QR" : "QR";
    if (open) this.renderQrPanel();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderGeneration += 1;
    this.qrToggle.removeEventListener("click", this.handleQrToggle);
    this.element.remove();
  }
  createChip(player) {
    const chip = this.doc.createElement("span");
    chip.className = "console-chip";
    chip.setAttribute("role", "listitem");
    chip.dataset["slot"] = String(player.slot);
    chip.dataset["shape"] = player.shape;
    chip.style.setProperty("--chip-color", player.color);
    const shape = this.doc.createElement("span");
    shape.className = "console-chip__shape";
    shape.dataset["shape"] = player.shape;
    shape.setAttribute("aria-hidden", "true");
    const label = this.doc.createElement("span");
    label.className = "console-chip__label";
    label.textContent = player.label;
    const state = this.doc.createElement("span");
    state.className = "visually-hidden";
    state.textContent = "connected";
    chip.append(shape, label, state);
    return chip;
  }
  renderRoom() {
    const code = this.room.code?.trim() ?? "";
    this.codeEl.textContent = code.length > 0 ? code : "----";
    const pin = this.room.pin?.trim() ?? "";
    this.pinEl.textContent = pin.length > 0 ? `PIN ${pin}` : "PIN ----";
  }
  renderQrPanel() {
    const generation = ++this.renderGeneration;
    const joinUrl = this.room.joinUrl ?? null;
    if (joinUrl === null || this.renderQr === void 0) {
      this.qrStatus.textContent = QR_UNAVAILABLE;
      if (this.qrCanvas !== null) {
        this.qrCanvas.remove();
        this.qrCanvas = null;
      }
      return;
    }
    let canvas = this.qrCanvas;
    if (canvas === null) {
      canvas = this.doc.createElement("canvas");
      canvas.className = "console-qr__canvas";
      canvas.setAttribute("width", "384");
      canvas.setAttribute("height", "384");
      this.qrCanvas = canvas;
      this.qrPanel.append(canvas);
    }
    this.qrStatus.textContent = QR_CAPTION;
    void this.renderQr(canvas, joinUrl).catch(() => {
      if (this.destroyed || generation !== this.renderGeneration) return;
      this.qrStatus.textContent = QR_UNAVAILABLE;
    });
  }
  handleQrToggle = () => {
    this.setQrOpen(!this.qrOpen);
  };
};

// packages/runtime/src/ui/console/shell.ts
var DEFAULT_BACKDROP = "radial-gradient(120% 120% at 50% 0%, #1a1a1a 0%, #050505 72%)";
var CLOCK_INTERVAL_MS = 6e4;
var ConsoleShell = class {
  element;
  frame;
  backdrop;
  topBar;
  row;
  lobby;
  hints;
  loading;
  input;
  motion;
  startGate;
  options;
  now;
  phaseValue;
  currentGameValue = null;
  lastLaunchedSlug = null;
  clockHandle = null;
  clockRunning = false;
  mounted = false;
  destroyed = false;
  constructor(doc, options) {
    this.options = options;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.motion = resolveMotionTier({
      prefersReducedMotion: options.prefersReducedMotion !== void 0 ? options.prefersReducedMotion : readPrefersReducedMotion(doc),
      ...options.lowTier !== void 0 ? { lowTier: options.lowTier } : {}
    });
    const root = doc.createElement("div");
    root.className = "console-shell";
    root.dataset["motion"] = this.motion;
    this.element = root;
    this.backdrop = new ConsoleBackdrop(doc, { tier: this.motion });
    root.append(this.backdrop.element);
    const frame = doc.createElement("div");
    frame.className = "console-shell__frame";
    this.frame = frame;
    this.topBar = new ConsoleTopBar(doc, {
      ...options.room !== void 0 ? { room: options.room } : {},
      ...options.connection !== void 0 ? { connection: options.connection } : {},
      ...options.players !== void 0 ? { players: options.players } : {},
      ...options.renderQr !== void 0 ? { renderQr: options.renderQr } : {}
    });
    const games = visibleConsoleGames(options.games, options.debug === true);
    this.row = new ConsoleGameRow(doc, {
      games,
      motion: this.motion,
      onActivate: (game) => this.launch(game),
      onFocusChange: () => this.syncBackdrop()
    });
    this.lobby = new ConsoleLobbyPanel(doc, {
      ...options.players !== void 0 ? { players: options.players } : {},
      ...options.room !== void 0 ? { room: options.room } : {},
      onScanRequest: () => this.topBar.setQrOpen(true)
    });
    this.hints = new ConsoleHintBar(doc, "keyboard");
    this.loading = new ConsoleLoadingScreen(doc, { motion: this.motion });
    const main = doc.createElement("main");
    main.className = "console-shell__main";
    main.append(this.row.element, this.lobby.element);
    frame.append(this.topBar.element, main, this.hints.element);
    root.append(frame);
    this.phaseValue = options.skipStartGate === true ? "home" : "start";
    if (options.skipStartGate !== true) {
      this.startGate = new ConsoleStartGate(doc, {
        onStart: this.handleGateStart,
        ...options.unlockAudio !== void 0 ? { unlockAudio: options.unlockAudio } : {}
      });
      root.append(this.startGate.element);
    } else {
      this.startGate = null;
    }
    this.input = new ConsoleInput(doc, {
      onAction: (action) => this.handleAction(action),
      onModeChange: (mode) => this.hints.setMode(mode),
      ...options.gamepads !== void 0 ? { gamepads: options.gamepads } : {}
    });
    root.append(this.loading.element);
    this.setPhase(this.phaseValue);
    if (options.focusSlug !== void 0 && options.focusSlug !== null) {
      this.row.focusSlug(options.focusSlug);
    }
    this.syncBackdrop();
    this.row.element.addEventListener("pointermove", this.handlePointerMove);
  }
  get phase() {
    return this.phaseValue;
  }
  get currentGame() {
    return this.currentGameValue;
  }
  get launchedSlug() {
    return this.lastLaunchedSlug;
  }
  get isMounted() {
    return this.mounted;
  }
  /** Appends the shell and starts the clock; focus is a separate call. */
  mount(parent) {
    if (this.destroyed) return;
    parent.append(this.element);
    this.mounted = true;
    if (this.phaseValue === "home") this.input.attach();
    this.startClock();
    if (this.phaseValue === "home") this.focus();
  }
  focus() {
    if (this.destroyed) return;
    if (this.phaseValue === "start") {
      this.startGate?.focus();
      return;
    }
    if (this.phaseValue === "loading") {
      this.loading.focus();
      return;
    }
    this.row.focus();
  }
  /** Programmatic start gesture (tap, test, or a host-level "any button"). */
  async start(source = "pointer") {
    if (this.destroyed || this.phaseValue !== "start") return;
    await this.startGate?.activate(source);
  }
  /** Shows the loading screen and hands control to the host. */
  beginLaunch(game) {
    if (this.destroyed || this.phaseValue !== "home") return;
    this.currentGameValue = game;
    this.lastLaunchedSlug = game.slug;
    this.backdrop.pause();
    this.setPhase("loading");
    this.loading.show(game.name);
    this.loading.focus();
    this.options.onLaunch(game);
  }
  setLoadingProgress(progress) {
    if (this.phaseValue !== "loading") return;
    this.loading.update(progress);
  }
  /**
   * Back on the home screen after a game. `slug` defaults to the launch slug;
   * the tile is restored and focused, and the backdrop resumes immediately.
   */
  returnFromGame(slug) {
    if (this.destroyed) return;
    const target = slug !== void 0 ? slug : this.lastLaunchedSlug;
    this.currentGameValue = null;
    this.loading.hide();
    this.backdrop.resume();
    this.setPhase("home");
    if (target !== null && !this.row.focusSlug(target)) {
      this.row.focusFirst();
    }
    this.input.attach();
    this.row.focus();
  }
  updatePlayers(players) {
    this.topBar.setPlayers(players);
    this.lobby.setPlayers(players);
  }
  updateConnection(connection) {
    this.topBar.setConnection(connection);
  }
  updateRoom(room2) {
    this.topBar.setRoom(room2);
    this.lobby.setRoom(room2);
  }
  /** Host frame hook; no-op until a pad edge is seen. */
  pollGamepad() {
    return this.input.pollGamepad();
  }
  /** Phone remote (broker event translated to a button id by the host). */
  handleRemote(button) {
    return this.input.handleRemote(button);
  }
  handleAction(action) {
    if (this.destroyed) return;
    if (this.phaseValue === "start") {
      if (action === "confirm") void this.start("gamepad");
      return;
    }
    if (this.phaseValue === "loading") {
      if (action === "back") this.cancelLaunch();
      return;
    }
    switch (action) {
      case "prev":
        this.row.move(-1);
        break;
      case "next":
        this.row.move(1);
        break;
      case "first":
        this.row.focusFirst();
        break;
      case "last":
        this.row.focusLast();
        break;
      case "confirm":
        this.row.activateActive();
        break;
      case "back":
        if (this.topBar.isQrOpen) this.topBar.setQrOpen(false);
        break;
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopClock();
    this.input.destroy();
    this.startGate?.destroy();
    this.row.element.removeEventListener("pointermove", this.handlePointerMove);
    this.backdrop.destroy();
    this.topBar.destroy();
    this.row.destroy();
    this.lobby.destroy();
    this.hints.destroy();
    this.loading.destroy();
    this.element.remove();
    this.mounted = false;
  }
  launch(game) {
    this.beginLaunch(game);
  }
  cancelLaunch() {
    const game = this.currentGameValue;
    if (game === null) return;
    this.returnFromGame(game.slug);
    this.options.onCancelLaunch?.(game);
  }
  handleGateStart = () => {
    if (this.destroyed) return;
    this.startGate?.destroy();
    this.setPhase("home");
    this.input.attach();
    this.hints.setMode(this.input.currentMode);
    this.options.onStarted?.();
    this.row.focus();
  };
  setPhase(phase) {
    this.phaseValue = phase;
    this.element.dataset["phase"] = phase;
    this.frame.hidden = phase !== "home";
    if (phase === "home") this.topBar.setClock(this.now());
  }
  syncBackdrop() {
    const game = this.row.focusedGame;
    if (game === null) {
      this.backdrop.show({ accent: "#4cb3f0", gradient: DEFAULT_BACKDROP });
      return;
    }
    this.backdrop.show({
      accent: presentationAccent(game),
      gradient: presentationGradient(game)
    });
  }
  handlePointerMove = (event) => {
    if (this.motion === "reduced" || this.destroyed) return;
    const target = event.currentTarget;
    const rect = target?.getBoundingClientRect?.();
    if (rect === void 0 || rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 16;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 16;
    this.row.setParallax(x, y);
  };
  startClock() {
    if (this.clockRunning || this.destroyed) return;
    this.clockRunning = true;
    this.topBar.setClock(this.now());
    if (this.options.scheduleClock !== void 0) {
      this.clockHandle = this.options.scheduleClock(this.tickClock);
    } else if (typeof setInterval === "function") {
      this.clockHandle = setInterval(this.tickClock, CLOCK_INTERVAL_MS);
    }
  }
  stopClock() {
    if (!this.clockRunning) return;
    this.clockRunning = false;
    if (this.clockHandle === null) return;
    if (this.options.cancelClock !== void 0) {
      this.options.cancelClock(this.clockHandle);
    } else if (typeof clearInterval === "function") {
      clearInterval(this.clockHandle);
    }
    this.clockHandle = null;
  }
  tickClock = () => {
    if (!this.destroyed) this.topBar.setClock(this.now());
  };
};

// experiments/console-launcher/fixtures.ts
var FIXTURE_NOW = new Date(2026, 0, 2, 21, 47);
var FIXTURE_ROOM = { code: "7K4Q", pin: "2841" };
var FIXTURE_JOIN_URL = "http://127.0.0.1:8080/c/7K4Q#fixture-token-not-real";
var FIXTURE_CONNECTION = { text: "Room live", tone: "ok" };
var FOUR_GAMES = [
  {
    slug: "neon-circuit",
    name: "Neon Circuit",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Race the grid, own the night.",
      accent: "#4cb3f0",
      categories: ["racing", "action"],
      inputBadges: ["stick", "triggers"],
      featured: true
    }
  },
  {
    slug: "dune-racers",
    name: "Dune Racers",
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Four wheels, one dune.",
      accent: "#ff9f45",
      categories: ["racing"],
      inputBadges: ["stick", "buttons"]
    }
  },
  {
    slug: "orbit-clash",
    name: "Orbit Clash",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Hold the station, break the swarm.",
      accent: "#b388ff",
      categories: ["action", "co-op"],
      inputBadges: ["stick", "buttons", "gyro"]
    }
  },
  {
    slug: "tiny-kingdom",
    name: "Tiny Kingdom",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Build a realm in one sofa session.",
      accent: "#4fd1a1",
      categories: ["co-op"],
      inputBadges: ["dpad", "buttons"]
    }
  }
];
var THIRTEEN_GAMES = [
  ...FOUR_GAMES,
  {
    slug: "pulse-arena",
    name: "Pulse Arena",
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Last one standing, again.",
      accent: "#ff6b6b",
      categories: ["action"],
      inputBadges: ["stick", "buttons"]
    }
  },
  {
    slug: "skyline-drift",
    name: "Skyline Drift",
    minPlayers: 2,
    maxPlayers: 8,
    presentation: {
      tagline: "Trade paint above the city.",
      accent: "#ff8ad8",
      categories: ["racing", "action"],
      inputBadges: ["stick", "triggers"]
    }
  },
  {
    slug: "dungeon-dashers",
    name: "Dungeon Dashers",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Loot first, ask later.",
      accent: "#f2d05c",
      categories: ["co-op", "action"],
      inputBadges: ["dpad", "buttons"]
    }
  },
  {
    slug: "frostbite",
    name: "Frostbite",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Keep warm, keep moving.",
      accent: "#7ee0ff",
      categories: ["action"],
      inputBadges: ["stick", "gyro"]
    }
  },
  {
    slug: "mecha-mayhem",
    name: "Mecha Mayhem",
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Two pilots, one chassis.",
      accent: "#ff5d5d",
      categories: ["co-op", "action"],
      inputBadges: ["triggers", "haptics"]
    }
  },
  {
    slug: "star-chef",
    name: "Star Chef",
    minPlayers: 1,
    maxPlayers: 8,
    presentation: {
      tagline: "Dinner at the edge of the map.",
      accent: "#ffd166",
      categories: ["co-op"],
      inputBadges: ["dpad", "buttons"]
    }
  },
  {
    slug: "rally-riot",
    name: "Rally Riot",
    minPlayers: 2,
    maxPlayers: 8,
    presentation: {
      tagline: "Eight cars, no brakes.",
      accent: "#c77dff",
      categories: ["racing"],
      inputBadges: ["stick", "triggers", "haptics"]
    }
  },
  {
    slug: "lantern-keep",
    name: "Lantern Keep",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Guard the light through the night.",
      accent: "#90e0a8",
      categories: ["solo", "co-op"],
      inputBadges: ["stick", "buttons", "text"]
    }
  },
  {
    slug: "monogram-only",
    name: "Monogram Only",
    minPlayers: 1,
    maxPlayers: 2
  }
];
var PLAYER_COLORS2 = [
  "#ff5d5d",
  "#4cb3f0",
  "#4fd1a1",
  "#f2d05c",
  "#b388ff",
  "#ff8ad8",
  "#ff9f45",
  "#7ee0ff"
];
var PLAYER_SHAPES2 = ["circle", "triangle", "square", "diamond"];
var PLAYER_LABELS2 = ["Ada", "Rex", "Mira", "Jax", "Nia", "Kai", "Lux", "Vex"];
var EIGHT_PLAYERS = PLAYER_LABELS2.map(
  (label, index) => ({
    slot: index + 1,
    label,
    color: PLAYER_COLORS2[index % PLAYER_COLORS2.length] ?? "#4cb3f0",
    shape: PLAYER_SHAPES2[index % PLAYER_SHAPES2.length] ?? "circle",
    state: "connected"
  })
);

// experiments/console-launcher/main.ts
var SCENES = {
  start: {
    games: FOUR_GAMES,
    players: EIGHT_PLAYERS.slice(0, 2),
    startGate: true
  },
  four: {
    games: FOUR_GAMES,
    players: EIGHT_PLAYERS.slice(0, 2),
    startGate: false
  },
  thirteen: {
    games: THIRTEEN_GAMES,
    players: EIGHT_PLAYERS.slice(0, 3),
    startGate: false
  },
  empty: { games: [], players: [], startGate: false },
  lobby: { games: FOUR_GAMES, players: EIGHT_PLAYERS, startGate: false }
};
function readScene(value) {
  if (value === "start" || value === "four" || value === "thirteen" || value === "empty" || value === "lobby") {
    return value;
  }
  return "four";
}
var params = new URLSearchParams(window.location.search);
var sceneName = readScene(params.get("scene"));
var scene = SCENES[sceneName];
var reducedMotion = params.get("motion") === "reduced";
var openQr = params.get("qr") === "1";
var showToolbar = params.get("toolbar") === "1";
var app = document.querySelector("#app");
if (app === null) throw new Error("console-launcher evidence: #app is missing");
var room = {
  code: FIXTURE_ROOM.code,
  pin: FIXTURE_ROOM.pin,
  joinUrl: FIXTURE_JOIN_URL
};
var shell = new ConsoleShell(document, {
  games: scene.games,
  players: scene.players,
  room,
  connection: FIXTURE_CONNECTION,
  skipStartGate: !scene.startGate,
  prefersReducedMotion: reducedMotion,
  now: () => FIXTURE_NOW,
  scheduleClock: (tick) => window.setInterval(tick, 6e4),
  cancelClock: (handle) => window.clearInterval(handle),
  renderQr: (canvas, joinUrl) => import_qrcode.default.toCanvas(canvas, joinUrl, { width: 384, margin: 1 }),
  onLaunch: () => {
    shell.setLoadingProgress({
      loadedBytes: 124e5,
      totalBytes: 186e5,
      determinate: true,
      fraction: 124e5 / 186e5,
      loadedCount: 3,
      totalCount: 7,
      currentUrl: null,
      done: false
    });
  }
});
shell.mount(app);
document.body.dataset["scene"] = sceneName;
if (openQr) shell.topBar.setQrOpen(true);
var toolbar = document.querySelector("#toolbar");
if (toolbar !== null) toolbar.hidden = !showToolbar;
