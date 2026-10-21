// Decoder of the blackbox binary format, for one flight of a file.
//
// It follows the parser of Betaflight's Blackbox Explorer (github.com/betaflight/blackbox-log-viewer,
// src/flightlog_parser.js and src/decoders.js, GPL-3.0): same encodings, predictors, frame
// validation and resynchronisation after a corrupt frame, so a log decodes here as it does there.
// Only what tuning needs is kept: main frames (I and P) are decoded into columns, the other frame
// types are read just to skip them, and events only matter for the end of the log and logging
// resumes.

const EOF = -1;
const MAX_FRAME_LENGTH = 256;
// Even in the worst logging conditions, no 10 s gap or 5000 loop iterations between frames.
const MAX_TIME_JUMP = 10 * 1000000;
const MAX_ITERATION_JUMP = 500 * 10;
const FIELD_ITERATION = 0;
const FIELD_TIME = 1;

const PREDICT_0 = 0;
const PREDICT_PREVIOUS = 1;
const PREDICT_STRAIGHT_LINE = 2;
const PREDICT_AVERAGE_2 = 3;
const PREDICT_MINTHROTTLE = 4;
const PREDICT_MOTOR_0 = 5;
const PREDICT_INC = 6;
const PREDICT_HOME_COORD = 7;
const PREDICT_1500 = 8;
const PREDICT_VBATREF = 9;
const PREDICT_LAST_MAIN_FRAME_TIME = 10;
const PREDICT_MINMOTOR = 11;

const ENCODING_SIGNED_VB = 0;
const ENCODING_UNSIGNED_VB = 1;
const ENCODING_NEG_14BIT = 3;
const ENCODING_TAG8_8SVB = 6;
const ENCODING_TAG2_3S32 = 7;
const ENCODING_TAG8_4S16 = 8;
const ENCODING_NULL = 9;
const ENCODING_TAG2_3SVARIABLE = 10;

const EVENT_SYNC_BEEP = 0;
const EVENT_AUTOTUNE_CYCLE_START = 10;
const EVENT_AUTOTUNE_CYCLE_RESULT = 11;
const EVENT_AUTOTUNE_TARGETS = 12;
const EVENT_INFLIGHT_ADJUSTMENT = 13;
const EVENT_LOGGING_RESUME = 14;
const EVENT_DISARM = 15;
const EVENT_GTUNE_CYCLE_RESULT = 20;
const EVENT_FLIGHT_MODE = 30;
const EVENT_TWITCH_TEST = 40;
const EVENT_LOG_END = 255;
const END_OF_LOG = "End of log\0";

const FRAME_TYPES = new Set(["I", "P", "G", "H", "S", "E"]);
const NEWLINE = 10;
const COLON = 58;

export class DecodeError extends Error {}

const signExtend = (value, bits) => {
  const shift = 32 - bits;
  return (value << shift) >> shift;
};

/** Byte reader over `bytes[pos..end)`: past the end, reads return EOF and set `eof`. */
class Stream {
  constructor(bytes, start, end) {
    this.data = bytes;
    this.pos = start;
    this.end = end;
    this.eof = false;
  }

  byte() {
    if (this.pos < this.end) return this.data[this.pos++];
    this.eof = true;
    return EOF;
  }

  unsignedVB() {
    let result = 0;
    for (let i = 0, shift = 0; i < 5; i++, shift += 7) {
      const b = this.byte();
      if (b === EOF) return 0;
      result |= (b & 0x7f) << shift;
      if (b < 128) return result >>> 0;
    }
    return 0; // longer than 32 bits: invalid
  }

  signedVB() {
    const unsigned = this.unsignedVB();
    return (unsigned >>> 1) ^ -(unsigned & 1); // zigzag
  }

  s16() {
    return signExtend(this.byte() | (this.byte() << 8), 16);
  }

  u32() {
    return this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24);
  }

  /** One value of 8, 16, 24 or 32 bits, as chosen by a 2-bit selector. */
  sizedValue(selector) {
    switch (selector & 0x03) {
      case 0:
        return signExtend(this.byte(), 8);
      case 1:
        return signExtend(this.byte() | (this.byte() << 8), 16);
      case 2:
        return signExtend(this.byte() | (this.byte() << 8) | (this.byte() << 16), 24);
      default:
        return this.u32() | 0;
    }
  }

  tag2_3S32(values) {
    let lead = this.byte();
    switch (lead >> 6) {
      case 0:
        values[0] = signExtend((lead >> 4) & 0x03, 2);
        values[1] = signExtend((lead >> 2) & 0x03, 2);
        values[2] = signExtend(lead & 0x03, 2);
        break;
      case 1: {
        values[0] = signExtend(lead & 0x0f, 4);
        const next = this.byte();
        values[1] = signExtend(next >> 4, 4);
        values[2] = signExtend(next & 0x0f, 4);
        break;
      }
      case 2:
        values[0] = signExtend(lead & 0x3f, 6);
        values[1] = signExtend(this.byte() & 0x3f, 6);
        values[2] = signExtend(this.byte() & 0x3f, 6);
        break;
      default:
        for (let i = 0; i < 3; i++, lead >>= 2) values[i] = this.sizedValue(lead);
    }
  }

  // Bit layouts as written by the firmware (blackboxWriteTag2_3SVariable). Blackbox Explorer
  // misreads the 5-5-4 and 8-7-7 layouts; they are decoded here as the firmware writes them.
  tag2_3SVariable(values) {
    let lead = this.byte();
    switch (lead >> 6) {
      case 0:
        values[0] = signExtend((lead >> 4) & 0x03, 2);
        values[1] = signExtend((lead >> 2) & 0x03, 2);
        values[2] = signExtend(lead & 0x03, 2);
        break;
      case 1: {
        // ss11 1112 2222 3333
        const second = this.byte();
        values[0] = signExtend((lead & 0x3e) >> 1, 5);
        values[1] = signExtend(((lead & 0x01) << 4) | (second >> 4), 5);
        values[2] = signExtend(second & 0x0f, 4);
        break;
      }
      case 2: {
        // ss11 1111 1122 2222 2333 3333
        const second = this.byte();
        const third = this.byte();
        values[0] = signExtend(((lead & 0x3f) << 2) | (second >> 6), 8);
        values[1] = signExtend(((second & 0x3f) << 1) | (third >> 7), 7);
        values[2] = signExtend(third & 0x7f, 7);
        break;
      }
      default:
        for (let i = 0; i < 3; i++, lead >>= 2) values[i] = this.sizedValue(lead);
    }
  }

  tag8_4S16v1(values) {
    let selector = this.byte();
    for (let i = 0; i < 4; i++, selector >>= 2) {
      switch (selector & 0x03) {
        case 0:
          values[i] = 0;
          break;
        case 1: {
          // two 4-bit fields in one byte
          const both = this.byte();
          values[i] = signExtend(both & 0x0f, 4);
          i++;
          selector >>= 2;
          values[i] = signExtend(both >> 4, 4);
          break;
        }
        case 2:
          values[i] = signExtend(this.byte(), 8);
          break;
        default:
          values[i] = signExtend(this.byte() | (this.byte() << 8), 16);
      }
    }
  }

  tag8_4S16v2(values) {
    let selector = this.byte();
    let buffer = 0;
    let halfByte = false; // the low nibble of `buffer` is still unread
    for (let i = 0; i < 4; i++, selector >>= 2) {
      switch (selector & 0x03) {
        case 0:
          values[i] = 0;
          break;
        case 1:
          if (!halfByte) {
            buffer = this.byte();
            values[i] = signExtend(buffer >> 4, 4);
          } else {
            values[i] = signExtend(buffer & 0x0f, 4);
          }
          halfByte = !halfByte;
          break;
        case 2:
          if (!halfByte) {
            values[i] = signExtend(this.byte(), 8);
          } else {
            const high = (buffer & 0x0f) << 4;
            buffer = this.byte();
            values[i] = signExtend(high | (buffer >> 4), 8);
          }
          break;
        default:
          if (!halfByte) {
            const first = this.byte();
            values[i] = signExtend((first << 8) | this.byte(), 16);
          } else {
            const first = this.byte();
            const second = this.byte();
            values[i] = signExtend(((buffer & 0x0f) << 12) | (first << 4) | (second >> 4), 16);
            buffer = second;
          }
      }
    }
  }

  tag8_8SVB(values, count) {
    if (count === 1) {
      values[0] = this.signedVB();
      return;
    }
    let header = this.byte();
    for (let i = 0; i < 8; i++, header >>= 1) values[i] = header & 0x01 ? this.signedVB() : 0;
  }
}

function numbers(text) {
  return text.split(",").map((part) => Number.parseInt(part, 10));
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

/**
 * Header of the flight starting at `start`: its `H name:value` lines in order, and the offset
 * of its first data frame. Bytes that are neither a header line nor a frame are skipped.
 */
export function readHeader(bytes, start, end) {
  const lines = [];
  let pos = start;
  while (pos < end) {
    const command = String.fromCharCode(bytes[pos]);
    if (command !== "H") {
      if (FRAME_TYPES.has(command)) break;
      pos++;
      continue;
    }
    pos++;
    if (pos >= end || bytes[pos] !== 32) continue; // "H" not followed by a space
    pos++;
    const lineStart = pos;
    let separator = -1;
    for (; pos < lineStart + 1024 && pos < end; pos++) {
      if (separator === -1 && bytes[pos] === COLON) separator = pos;
      if (bytes[pos] === NEWLINE || bytes[pos] === 0) break;
    }
    if (bytes[pos] !== NEWLINE || separator === -1) continue;
    const text = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    lines.push([text(lineStart, separator), text(separator + 1, pos)]);
    pos++;
  }
  return { lines, dataStart: pos };
}

/** Frame definitions and the header values the predictors need. */
function decoderConfig(lines) {
  const config = {
    frameDefs: {},
    intervalI: 32,
    intervalPNum: 1,
    intervalPDenom: 1,
    dataVersion: undefined,
    minthrottle: 1150,
    minMotor: 0,
    vbatref: 4095,
  };
  for (const [name, value] of lines) {
    const field = /^Field (.) (.+)$/.exec(name);
    if (field) {
      if (!config.frameDefs[field[1]]) config.frameDefs[field[1]] = { name: [], predictor: [], encoding: [] };
      const def = config.frameDefs[field[1]];
      if (field[2] === "name") {
        def.name = value.split(",").map((n) => n.replace(/^gyroData(.+)$/, "gyroADC$1"));
      } else if (field[2] === "predictor" || field[2] === "encoding") {
        def[field[2]] = numbers(value);
      }
      continue;
    }
    switch (name) {
      case "I interval":
        config.intervalI = positiveInt(Number.parseInt(value, 10), 1);
        break;
      case "P interval": {
        const [num, denom] = value.includes("/") ? numbers(value.replace("/", ",")) : [1, Number.parseInt(value, 10)];
        config.intervalPNum = positiveInt(num, 1);
        config.intervalPDenom = positiveInt(denom, 1);
        break;
      }
      case "Data version":
        config.dataVersion = Number.parseInt(value, 10);
        break;
      case "minthrottle":
        config.minthrottle = Number.parseInt(value, 10);
        config.minMotor = config.minthrottle;
        break;
      case "motorOutput":
        config.minMotor = Math.trunc(numbers(value)[0]) || 0;
        break;
      case "vbatref":
        config.vbatref = Number.parseInt(value, 10);
        break;
    }
  }
  const { I, P } = config.frameDefs;
  const complete = (def) => def.name.length > 0 && def.encoding.length === def.name.length
    && def.predictor.length === def.name.length;
  if (!I || !complete(I)) throw new DecodeError("the I frame definitions are missing or incomplete");
  if (!P) throw new DecodeError("the P frame definitions are missing");
  P.name = I.name; // P frames carry the same fields as I frames
  if (!complete(P)) throw new DecodeError("the P frame definitions are incomplete");
  for (const def of Object.values(config.frameDefs)) {
    if (def !== I && def !== P && def.name.length === 0) def.name = new Array(def.encoding.length);
  }
  return config;
}

/** Growable column of float64 values. */
class Column {
  constructor(capacity) {
    this.values = new Float64Array(Math.max(16, capacity));
    this.length = 0;
  }

  push(value) {
    if (this.length === this.values.length) {
      const bigger = new Float64Array(this.values.length * 2);
      bigger.set(this.values);
      this.values = bigger;
    }
    this.values[this.length++] = value;
  }

  done() {
    return this.values.slice(0, this.length);
  }
}

/**
 * Decode the main frames of one flight.
 *
 * `fields` names the main-frame fields to keep. Returns `{fieldNames, columns, frames, corrupt}`:
 * `columns[name]` holds the value of each valid main frame, in log order.
 */
export function decodeFlight(bytes, start, end, fields) {
  const header = readHeader(bytes, start, end);
  const config = decoderConfig(header.lines);
  const { frameDefs } = config;
  const I = frameDefs.I;
  const count = I.name.length;
  const motor0 = I.name.indexOf("motor[0]");

  const kept = fields.map((name) => I.name.indexOf(name)).filter((index) => index >= 0);
  const capacity = Math.ceil((end - header.dataStart) / 16);
  const columns = kept.map(() => new Column(capacity));

  const stream = new Stream(bytes, header.dataStart, end);
  const values = new Array(8);
  const ring = [new Array(count).fill(0), new Array(count).fill(0), new Array(count).fill(0)];
  const history = [ring[0], null, null]; // current frame, previous, previous of previous
  let mainValid = false;
  let lastIteration = -1;
  let lastTime = -1;
  let lastSkipped = 0;
  let lastEvent = null;
  let corrupt = 0;
  let frames = 0;

  const invalidate = () => {
    mainValid = false;
    history[0] = ring[0];
    history[1] = null;
    history[2] = null;
  };
  const advance = () => {
    history[0] = history[0] === ring[0] ? ring[1] : history[0] === ring[1] ? ring[2] : ring[0];
  };
  const shouldHaveFrame = (index) =>
    ((index % config.intervalI) + config.intervalPNum - 1) % config.intervalPDenom < config.intervalPNum;
  const skippedFrames = () => {
    if (lastIteration === -1) return 0;
    let skipped = 0;
    for (let index = lastIteration + 1; !shouldHaveFrame(index); index++) skipped++;
    return skipped;
  };

  const predict = (index, predictor, value, current, previous, previous2) => {
    switch (predictor) {
      case PREDICT_0:
        return value;
      case PREDICT_PREVIOUS:
        return previous ? value + previous[index] : value;
      case PREDICT_STRAIGHT_LINE:
        return previous ? value + 2 * previous[index] - previous2[index] : value;
      case PREDICT_AVERAGE_2:
        return previous ? value + ~~((previous[index] + previous2[index]) / 2) : value;
      case PREDICT_MINTHROTTLE:
        return Math.trunc(value) + config.minthrottle;
      case PREDICT_MINMOTOR:
        return Math.trunc(value) + config.minMotor;
      case PREDICT_MOTOR_0:
        if (motor0 < 0) throw new DecodeError("a field is predicted from motor[0], which is not logged");
        return value + current[motor0];
      case PREDICT_1500:
        return value + 1500;
      case PREDICT_VBATREF:
        return value + config.vbatref;
      case PREDICT_LAST_MAIN_FRAME_TIME:
        return history[1] ? value + history[1][FIELD_TIME] : value;
      case PREDICT_HOME_COORD:
        return value; // GPS frames are only skipped
      default:
        throw new DecodeError(`unsupported field predictor ${predictor}`);
    }
  };

  // Decode one frame into `current`. Without `predict` (frames other than I and P) values are
  // only read past.
  const parseFrame = (def, current, previous, previous2, skipped, withPrediction) => {
    const { predictor, encoding } = def;
    const n = encoding.length;
    const store = (i, value) => {
      current[i] = withPrediction ? predict(i, predictor[i], value, current, previous, previous2) : value;
    };
    let i = 0;
    while (i < n) {
      if (predictor[i] === PREDICT_INC) {
        current[i] = skipped + 1 + (previous ? previous[i] : 0);
        i++;
        continue;
      }
      switch (encoding[i]) {
        case ENCODING_SIGNED_VB:
          store(i, stream.signedVB());
          i++;
          break;
        case ENCODING_UNSIGNED_VB:
          store(i, stream.unsignedVB());
          i++;
          break;
        case ENCODING_NEG_14BIT:
          store(i, -signExtend(stream.unsignedVB(), 14));
          i++;
          break;
        case ENCODING_NULL:
          store(i, 0);
          i++;
          break;
        case ENCODING_TAG8_4S16:
          if (config.dataVersion < 2) stream.tag8_4S16v1(values);
          else stream.tag8_4S16v2(values);
          for (let j = 0; j < 4; j++, i++) store(i, values[j]);
          break;
        case ENCODING_TAG2_3S32:
          stream.tag2_3S32(values);
          for (let j = 0; j < 3; j++, i++) store(i, values[j]);
          break;
        case ENCODING_TAG2_3SVARIABLE:
          stream.tag2_3SVariable(values);
          for (let j = 0; j < 3; j++, i++) store(i, values[j]);
          break;
        case ENCODING_TAG8_8SVB: {
          let j = i + 1;
          while (j < i + 8 && j < n && encoding[j] === ENCODING_TAG8_8SVB) j++;
          const group = j - i;
          stream.tag8_8SVB(values, group);
          for (let k = 0; k < group; k++, i++) store(i, values[k]);
          break;
        }
        default:
          throw new DecodeError(`unsupported field encoding ${encoding[i]}`);
      }
    }
  };

  const emit = () => {
    const frame = history[0];
    for (let k = 0; k < kept.length; k++) columns[k].push(frame[kept[k]]);
    frames++;
  };

  const completeIntra = () => {
    const frame = history[0];
    let accept = true;
    if (lastIteration !== -1) {
      accept = frame[FIELD_ITERATION] >= lastIteration
        && frame[FIELD_ITERATION] < lastIteration + MAX_ITERATION_JUMP
        && frame[FIELD_TIME] >= lastTime
        && frame[FIELD_TIME] < lastTime + MAX_TIME_JUMP;
    }
    if (accept) {
      lastIteration = frame[FIELD_ITERATION];
      lastTime = frame[FIELD_TIME];
      mainValid = true;
      emit();
    } else {
      invalidate();
    }
    // Previous and previous-previous both become the I frame: nothing older can be predicted from.
    history[1] = history[0];
    history[2] = history[0];
    advance();
    return mainValid;
  };

  const completeInter = () => {
    const frame = history[0];
    if (mainValid && (frame[FIELD_TIME] > lastTime + MAX_TIME_JUMP
      || frame[FIELD_ITERATION] > lastIteration + MAX_ITERATION_JUMP)) {
      mainValid = false;
    }
    // A P frame cannot resynchronise the stream: only an I frame makes it valid again.
    if (mainValid) {
      lastIteration = frame[FIELD_ITERATION];
      lastTime = frame[FIELD_TIME];
      emit();
      history[2] = history[1];
      history[1] = history[0];
      advance();
    }
    return mainValid;
  };

  const parseEvent = () => {
    const type = stream.byte();
    lastEvent = { type };
    switch (type) {
      case EVENT_SYNC_BEEP:
      case EVENT_DISARM:
        stream.unsignedVB();
        break;
      case EVENT_FLIGHT_MODE:
        stream.unsignedVB();
        stream.unsignedVB();
        break;
      case EVENT_AUTOTUNE_CYCLE_START:
        for (let k = 0; k < 5; k++) stream.byte();
        break;
      case EVENT_AUTOTUNE_CYCLE_RESULT:
        for (let k = 0; k < 4; k++) stream.byte();
        break;
      case EVENT_AUTOTUNE_TARGETS:
        for (let k = 0; k < 8; k++) stream.byte();
        break;
      case EVENT_GTUNE_CYCLE_RESULT:
        stream.byte();
        stream.signedVB();
        stream.s16();
        break;
      case EVENT_INFLIGHT_ADJUSTMENT:
        if (stream.byte() < 128) stream.signedVB();
        else stream.u32();
        break;
      case EVENT_TWITCH_TEST:
        stream.byte();
        stream.u32();
        break;
      case EVENT_LOGGING_RESUME:
        lastEvent.iteration = stream.unsignedVB();
        lastEvent.time = stream.unsignedVB();
        break;
      case EVENT_LOG_END: {
        let text = "";
        for (let k = 0; k < END_OF_LOG.length; k++) text += String.fromCharCode(stream.byte());
        if (text === END_OF_LOG) stream.end = stream.pos; // this flight is over
        else lastEvent = null; // bytes that only looked like an event
        break;
      }
      default:
        lastEvent = null;
    }
  };

  const completeEvent = () => {
    if (!lastEvent) return false;
    if (lastEvent.type === EVENT_LOGGING_RESUME) {
      // Accept the jump in time and iteration that follows the pause.
      lastIteration = lastEvent.iteration;
      lastTime = lastEvent.time;
    }
    return true;
  };

  const parse = {
    I: () => parseFrame(I, history[0], history[1], null, 0, true),
    P: () => {
      lastSkipped = skippedFrames();
      parseFrame(frameDefs.P, history[0], history[1], history[2], lastSkipped, true);
    },
    G: () => parseFrame(frameDefs.G, [], null, null, 0, false),
    H: () => parseFrame(frameDefs.H, [], null, null, 0, false),
    S: () => parseFrame(frameDefs.S, [], null, null, 0, false),
    E: parseEvent,
  };
  const complete = { I: completeIntra, P: completeInter, E: completeEvent };

  invalidate();
  let frameStart = 0;
  let lastType = null;
  let prematureEof = false;
  for (;;) {
    const byte = stream.byte();
    const command = byte === EOF ? EOF : String.fromCharCode(byte);
    if (lastType) {
      const size = stream.pos - frameStart;
      // The next frame starting right here means the previous one was read to its end.
      const looksComplete = FRAME_TYPES.has(command) || (!prematureEof && command === EOF);
      if (size <= MAX_FRAME_LENGTH && looksComplete) {
        complete[lastType]?.();
      } else {
        // Corrupt: resynchronise from the byte after the start of that frame.
        mainValid = false;
        corrupt++;
        stream.pos = frameStart + 1;
        lastType = null;
        prematureEof = false;
        stream.eof = false;
        continue;
      }
    }
    if (command === EOF) break;
    frameStart = stream.pos - 1;
    if (FRAME_TYPES.has(command) && (command === "E" || frameDefs[command])) {
      lastType = command;
      parse[command]();
      if (stream.eof) prematureEof = true; // the frame ran past the end: truncated
    } else {
      mainValid = false;
      lastType = null;
    }
  }

  const named = {};
  kept.forEach((index, k) => {
    named[I.name[index]] = columns[k].done();
  });
  return { headerLines: header.lines, fieldNames: I.name, columns: named, frames, corrupt };
}
