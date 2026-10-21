// Runs the analysis off the page's thread, so the page stays responsive while a log decodes.

import { analyseFile, errorMessage } from "./core/index.js";

self.onmessage = ({ data: { bytes, name, logIndex } }) => {
  try {
    self.postMessage({ result: analyseFile(new Uint8Array(bytes), name, logIndex) });
  } catch (error) {
    self.postMessage({ error: errorMessage(error) });
  }
};
