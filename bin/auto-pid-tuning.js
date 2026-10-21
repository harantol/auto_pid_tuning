#!/usr/bin/env node
// Command line: node bin/auto-pid-tuning.js LOG [--style freestyle] [--log-index N] [--json] [-o FILE]

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { analyze } from "../app/core/analysis.js";
import { LogError, flightSizes, loadLog } from "../app/core/blackbox.js";
import { toDict, toText } from "../app/core/report.js";
import { STYLES, getStyle } from "../app/core/styles.js";
import { cliCommands, tune } from "../app/core/tuner.js";

const USAGE = `usage: auto-pid-tuning LOG [-s STYLE] [-i N] [--json] [-o FILE]

Suggest Betaflight PIDs, filters and rates from a blackbox log.

  LOG                 blackbox log file (.bbl / .bfl)
  -s, --style STYLE   flight style: ${Object.keys(STYLES).join(", ")} (default: freestyle)
  -i, --log-index N   flight to analyse when the file holds several (1-based, default: the longest one)
  --json              print the full result as JSON
  -o, --output FILE   write the CLI commands to this file`;

export function main(argv, out = process.stdout, err = process.stderr) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        style: { type: "string", short: "s", default: "freestyle" },
        "log-index": { type: "string", short: "i" },
        json: { type: "boolean", default: false },
        output: { type: "string", short: "o" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    err.write(`${USAGE}\nerror: ${error.message}\n`);
    return 2;
  }
  if (args.values.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (args.positionals.length !== 1) {
    err.write(`${USAGE}\nerror: one log file is needed\n`);
    return 2;
  }
  const [path] = args.positionals;

  let style;
  let log;
  let index;
  let count;
  try {
    style = getStyle(args.values.style);
    if (!existsSync(path) || !statSync(path).isFile()) throw new LogError(`Log file not found: ${path}`);
    const bytes = new Uint8Array(readFileSync(path));
    const name = basename(path);
    const sizes = flightSizes(bytes, name);
    count = sizes.length;
    index = args.values["log-index"] ? Number(args.values["log-index"]) : sizes.indexOf(Math.max(...sizes)) + 1;
    if (!(Number.isInteger(index) && index >= 1 && index <= count)) {
      throw new LogError(`--log-index must be between 1 and ${count} for this file.`);
    }
    log = loadLog(bytes, index, name);
  } catch (error) {
    if (!(error instanceof LogError) && !/Unknown flight style/.test(error.message)) throw error;
    err.write(`error: ${error.message}\n`);
    return 1;
  }

  const analysis = analyze(log);
  const result = tune(log.headers, analysis, style);
  if (args.values.json) {
    out.write(`${JSON.stringify(toDict(log.headers, analysis, result), null, 2)}\n`);
  } else {
    if (count > 1) out.write(`Flight ${index} of ${count} in ${basename(path)}\n\n`);
    out.write(`${toText(log.headers, analysis, result)}\n`);
  }
  if (args.values.output) writeFileSync(args.values.output, `${cliCommands(result).join("\n")}\n`, "utf8");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
