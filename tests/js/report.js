// Print what the page gets for a log, as JSON: node tests/js/report.js LOG [FLIGHT]
// Used by tests/test_js_parity.py to compare with the Python version.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyseFile } from "../../app/core/index.js";

const [path, flight] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(path));
process.stdout.write(JSON.stringify(analyseFile(bytes, basename(path), flight ? Number(flight) : null)));
