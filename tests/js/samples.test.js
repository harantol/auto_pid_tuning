// Real logs from samples/ (git-ignored), when present: each one must analyse cleanly.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { analyseFile } from "../../app/core/index.js";

const SAMPLES = fileURLToPath(new URL("../../samples", import.meta.url));
const logs = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((name) => /\.(bbl|bfl)$/i.test(name)) : [];

test("sample logs", { skip: logs.length ? false : "no sample logs" }, async (t) => {
  for (const name of logs) {
    await t.test(name, () => {
      const report = analyseFile(new Uint8Array(readFileSync(join(SAMPLES, name))), name);
      assert.ok(report.duration > 10, `${report.duration} s`);
      assert.ok(report.sample_rate > 200 && report.sample_rate < 10000, `${report.sample_rate} Hz`);
      assert.ok(report.motor_saturation >= 0 && report.motor_saturation <= 1);
      assert.deepEqual(Object.keys(report.tunes), ["freestyle", "racing", "cinematic", "long_range"]);
      for (const tune of Object.values(report.tunes)) {
        assert.equal(tune.cli.length ? tune.cli.at(-1) : "save", "save");
      }
    });
  }
});
