// The whole pipeline on one file: decode a flight, measure it, tune it for every style.

import { analyze } from "./analysis.js";
import { LogError, flightSizes, loadLog } from "./blackbox.js";
import { flightToDict, tuningToDict } from "./report.js";
import { STYLES } from "./styles.js";
import { tune } from "./tuner.js";

export { LogError };

/**
 * Analyse flight `logIndex` (1-based, default: the longest) of a blackbox file and tune it for
 * every style. Tuning is cheap next to decoding, so the page switches styles without decoding
 * again.
 */
export function analyseFile(bytes, name, logIndex = null) {
  const sizes = flightSizes(bytes, name);
  const count = sizes.length;
  const index = logIndex || sizes.indexOf(Math.max(...sizes)) + 1;
  if (!(index >= 1 && index <= count)) {
    throw new LogError(`This file holds ${count} flight(s); flight ${index} does not exist.`);
  }
  const log = loadLog(bytes, index, name);
  const analysis = analyze(log);
  const tunes = {};
  for (const style of Object.values(STYLES)) tunes[style.name] = tuningToDict(tune(log.headers, analysis, style));
  return {
    filename: name,
    log_index: index,
    log_count: count,
    flight_bytes: sizes,
    ...flightToDict(log.headers, analysis),
    tunes,
  };
}

/** What to tell the user when a file cannot be analysed. */
export function errorMessage(error) {
  if (error instanceof LogError) return error.message;
  return `Not a readable blackbox log: ${error?.message ?? error}`;
}
