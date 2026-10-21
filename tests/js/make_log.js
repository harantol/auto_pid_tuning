// Write a simulated flight as a blackbox log: node tests/js/make_log.js OUT.bbl '{"damping": 0.5}'
// Options are those of simulatedLog() in writer.js. Used by tests/test_js_parity.py.

import { writeFileSync } from "node:fs";
import { HEADERS_4_3, simulatedLog } from "./writer.js";

const [out, json = "{}"] = process.argv.slice(2);
const options = JSON.parse(json);
options.headers = { ...HEADERS_4_3, ...(options.headers ?? {}) };
writeFileSync(out, simulatedLog(options));
