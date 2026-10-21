// Numerical helpers: the few numpy / scipy functions the analysis relies on, with the same
// conventions (windows, scaling, padding, rounding), so results match the reference.

export const clip = (value, low, high) => Math.min(Math.max(value, low), high);

export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total;
}

export const mean = (values) => sum(values) / values.length;

/** Index of the first maximum. */
export function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

export function min(values) {
  let best = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < best) best = values[i];
  return best;
}

export function max(values) {
  let best = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > best) best = values[i];
  return best;
}

const sorted = (values) => Float64Array.from(values).sort();

export function median(values) {
  const s = sorted(values);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** numpy.percentile with linear interpolation, for several percentiles of the same data. */
export function percentiles(values, ps) {
  const s = sorted(values);
  const n = s.length;
  return ps.map((p) => {
    const index = (p / 100) * (n - 1);
    const below = Math.floor(index);
    const above = Math.min(below + 1, n - 1);
    const t = index - below;
    const a = s[below];
    const b = s[above];
    const diff = b - a;
    return t >= 0.5 ? b - diff * (1 - t) : a + diff * t; // numpy's _lerp
  });
}

/** Python's round(): halfway cases go to the even neighbour. */
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

// Number of halvings that make |x| an integer: a tie at `digits` decimals needs exactly digits + 1.
function binaryDecimals(x) {
  let y = Math.abs(x);
  let count = 0;
  while (y !== Math.floor(y) && count < 1100) {
    y *= 2;
    count++;
  }
  return count;
}

/** Python's f"{x:.{digits}f}": like toFixed, but exact ties round to even. */
export function pyFixed(x, digits) {
  const text = x.toFixed(digits);
  if (!Number.isFinite(x) || binaryDecimals(x) !== digits + 1) return text;
  // An exact tie: toFixed went away from zero, Python goes to the even neighbour.
  const sign = text.startsWith("-") ? "-" : "";
  const plain = text.replace("-", "").replace(".", "");
  if (Number(plain[plain.length - 1]) % 2 === 0) return text;
  const lowered = (BigInt(plain) - 1n).toString().padStart(plain.length, "0");
  const whole = digits ? `${lowered.slice(0, -digits) || "0"}.${lowered.slice(-digits)}` : lowered;
  return sign + whole;
}

/** Python's f"{x:+.{digits}f}". */
export const pySigned = (x, digits) => {
  const text = pyFixed(x, digits);
  return text.startsWith("-") ? text : `+${text}`;
};

/** Python's f"{x:.{digits}%}". */
export const pyPercent = (x, digits = 0) => `${pyFixed(x * 100, digits)}%`;

// ---- FFT ----------------------------------------------------------------------------------

const plans = new Map();

function radix2Plan(n) {
  const levels = Math.log2(n);
  const reverse = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, v = i; b < levels; b++, v >>= 1) r = (r << 1) | (v & 1);
    reverse[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return { n, reverse, cos, sin };
}

// In-place FFT of a power-of-two length, forward (e^-i) or inverse (e^+i, unscaled).
function radix2(plan, re, im, inverse) {
  const { n, reverse, cos, sin } = plan;
  for (let i = 0; i < n; i++) {
    const j = reverse[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// Any length: Bluestein's algorithm on top of a power-of-two FFT.
function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if ((n & (n - 1)) === 0) {
    p = { kind: "radix2", inner: radix2Plan(n) };
  } else {
    let m = 1;
    while (m < 2 * n - 1) m *= 2;
    const inner = radix2Plan(m);
    const chirpRe = new Float64Array(n);
    const chirpIm = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const angle = (Math.PI * ((k * k) % (2 * n))) / n;
      chirpRe[k] = Math.cos(angle);
      chirpIm[k] = -Math.sin(angle);
    }
    const bRe = new Float64Array(m);
    const bIm = new Float64Array(m);
    bRe[0] = chirpRe[0];
    bIm[0] = -chirpIm[0];
    for (let k = 1; k < n; k++) {
      bRe[k] = bRe[m - k] = chirpRe[k];
      bIm[k] = bIm[m - k] = -chirpIm[k];
    }
    radix2(inner, bRe, bIm, false);
    p = { kind: "bluestein", n, m, inner, chirpRe, chirpIm, bRe, bIm };
  }
  plans.set(n, p);
  return p;
}

/** Complex DFT of (re, im), returned as new arrays; `inverse` is unscaled. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const p = plan(n);
  if (p.kind === "radix2") {
    const outRe = Float64Array.from(re);
    const outIm = Float64Array.from(im);
    radix2(p.inner, outRe, outIm, inverse);
    return [outRe, outIm];
  }
  // The inverse DFT is the conjugate of the forward DFT of the conjugate.
  const s = inverse ? -1 : 1;
  const { m, inner, chirpRe, chirpIm, bRe, bIm } = p;
  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    const xr = re[k];
    const xi = s * im[k];
    aRe[k] = xr * chirpRe[k] - xi * chirpIm[k];
    aIm[k] = xr * chirpIm[k] + xi * chirpRe[k];
  }
  radix2(inner, aRe, aIm, false);
  for (let k = 0; k < m; k++) {
    const xr = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    aIm[k] = aRe[k] * bIm[k] + aIm[k] * bRe[k];
    aRe[k] = xr;
  }
  radix2(inner, aRe, aIm, true);
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const yr = aRe[k] / m;
    const yi = aIm[k] / m;
    outRe[k] = yr * chirpRe[k] - yi * chirpIm[k];
    outIm[k] = s * (yr * chirpIm[k] + yi * chirpRe[k]);
  }
  return [outRe, outIm];
}

/** numpy.fft.rfft: the n // 2 + 1 first bins of the DFT of a real signal. */
export function rfft(values) {
  const n = values.length;
  const [re, im] = fft(values, new Float64Array(n));
  const bins = Math.floor(n / 2) + 1;
  return [re.slice(0, bins), im.slice(0, bins)];
}

/** numpy.fft.irfft: real signal of length n from its n // 2 + 1 first bins. */
export function irfft(re, im, n) {
  const fullRe = new Float64Array(n);
  const fullIm = new Float64Array(n);
  const bins = Math.floor(n / 2) + 1;
  for (let k = 0; k < bins && k < re.length; k++) {
    fullRe[k] = re[k];
    fullIm[k] = im[k];
  }
  fullIm[0] = 0;
  if (n % 2 === 0) fullIm[n / 2] = 0;
  for (let k = 1; k < n - k; k++) {
    fullRe[n - k] = fullRe[k];
    fullIm[n - k] = -fullIm[k];
  }
  const [out] = fft(fullRe, fullIm, true);
  for (let i = 0; i < n; i++) out[i] /= n;
  return out;
}

/** numpy.fft.rfftfreq. */
export function rfftfreq(n, d) {
  const val = 1 / (n * d);
  return Float64Array.from({ length: Math.floor(n / 2) + 1 }, (_, k) => k * val);
}

/** numpy.hanning: symmetric Hann window. */
export function hanning(n) {
  if (n === 1) return Float64Array.of(1);
  return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
}

/** scipy.signal.get_window("hann", n): periodic Hann window. */
function periodicHann(n) {
  return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
}

/**
 * scipy.signal.welch(values, fs, nperseg, detrend="linear"): power spectral density by
 * averaging half-overlapping, Hann-windowed segments.
 */
export function welch(values, fs, nperseg) {
  const window = periodicHann(nperseg);
  const step = nperseg - Math.floor(nperseg / 2);
  const segments = Math.floor((values.length - Math.floor(nperseg / 2)) / step);
  const bins = Math.floor(nperseg / 2) + 1;
  const psd = new Float64Array(bins);
  let windowPower = 0;
  for (const w of window) windowPower += w * w;
  const scale = 1 / (fs * windowPower);

  // Least-squares line over t = 0..n-1, removed from each segment.
  const tMean = (nperseg - 1) / 2;
  let tVar = 0;
  for (let t = 0; t < nperseg; t++) tVar += (t - tMean) ** 2;
  const segment = new Float64Array(nperseg);
  for (let s = 0; s < segments; s++) {
    const offset = s * step;
    let xMean = 0;
    for (let t = 0; t < nperseg; t++) xMean += values[offset + t];
    xMean /= nperseg;
    let cov = 0;
    for (let t = 0; t < nperseg; t++) cov += (t - tMean) * (values[offset + t] - xMean);
    const slope = cov / tVar;
    for (let t = 0; t < nperseg; t++) {
      segment[t] = (values[offset + t] - xMean - slope * (t - tMean)) * window[t];
    }
    const [re, im] = rfft(segment);
    for (let k = 0; k < bins; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  const last = nperseg % 2 === 0 ? bins - 1 : bins;
  for (let k = 0; k < bins; k++) {
    psd[k] *= scale / segments;
    if (k > 0 && k < last) psd[k] *= 2; // one-sided: fold the negative frequencies in
  }
  return [rfftfreq(nperseg, 1 / fs), psd];
}

/** numpy.trapezoid. */
export function trapezoid(y, x) {
  let total = 0;
  for (let i = 1; i < y.length; i++) total += ((x[i] - x[i - 1]) * (y[i] + y[i - 1])) / 2;
  return total;
}

/** numpy.convolve(values, ones(span) / span, mode="same"): centred moving average, zero padded. */
export function movingAverageSame(values, span) {
  const n = values.length;
  const out = new Float64Array(n);
  const left = Math.floor(span / 2);
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (let j = Math.max(0, i - left); j <= Math.min(n - 1, i - left + span - 1); j++) total += values[j];
    out[i] = total / span;
  }
  return out;
}

/**
 * Minimum of values[i .. i + size - 1] for each i whose window fits in the array
 * (scipy.ndimage.minimum_filter1d with origin -(size // 2), trimmed to full windows).
 */
export function forwardMin(values, size) {
  const n = values.length - size + 1;
  const out = new Float64Array(Math.max(0, n));
  const deque = new Int32Array(values.length);
  let head = 0;
  let tail = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    while (tail > head && values[deque[tail - 1]] >= values[i]) tail--;
    deque[tail++] = i;
    while (deque[head] > i + size - 1) head++;
    if (i < n) out[i] = values[deque[head]];
  }
  return out;
}

/** Mean of values[i .. i + size - 1] for each i whose window fits in the array. */
export function forwardMean(values, size) {
  const n = values.length - size + 1;
  const out = new Float64Array(Math.max(0, n));
  let total = 0;
  for (let i = 0; i < size && i < values.length; i++) total += values[i];
  for (let i = 0; i < n; i++) {
    out[i] = total / size;
    if (i + size < values.length) total += values[i + size] - values[i];
  }
  return out;
}

// ---- Butterworth high-pass, applied forward and backward ------------------------------------

/**
 * scipy.signal.butter(order, cutoff, "highpass", fs=fs, output="sos") for an even order:
 * second-order sections, the gain in the first one, poles nearest the unit circle last.
 */
export function butterHighpass(order, cutoff, fs) {
  const warped = 4 * Math.tan((Math.PI * (2 * cutoff / fs)) / 2); // pre-warped, fs = 2
  // Analog low-pass prototype poles in the left half-plane, mapped to high-pass and z-plane.
  const poles = [];
  for (let k = -order + 1; k < order; k += 2) {
    const angle = (Math.PI * k) / (2 * order);
    const pr = -Math.cos(angle);
    const pi = -Math.sin(angle);
    // high-pass: p -> warped / p
    const d = pr * pr + pi * pi;
    const hr = (warped * pr) / d;
    const hi = (-warped * pi) / d;
    // bilinear: z = (4 + p) / (4 - p)
    const nr = 4 + hr;
    const ni = hi;
    const dr = 4 - hr;
    const di = -hi;
    const dd = dr * dr + di * di;
    poles.push([(nr * dr + ni * di) / dd, (ni * dr - nr * di) / dd]);
  }
  // Gain: 1 at Nyquist (z = -1), where the zeros (all at z = 1) give prod(-1 - 1) = 2^order.
  let gainRe = 1;
  let gainIm = 0;
  for (const [pr, pi] of poles) {
    const ar = -1 - pr;
    const ai = -pi;
    const r = gainRe * ar - gainIm * ai;
    gainIm = gainRe * ai + gainIm * ar;
    gainRe = r;
  }
  const gain = Math.hypot(gainRe, gainIm) / 2 ** order;
  // One section per conjugate pair, farthest pair from the unit circle first.
  const pairs = poles.filter(([, pi]) => pi > 0).sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  return pairs.map(([pr, pi], index) => {
    const g = index === 0 ? gain : 1;
    return [g, -2 * g, g, 1, -2 * pr, pr * pr + pi * pi];
  });
}

function sosFilter(sos, values, zi) {
  const n = values.length;
  const out = Float64Array.from(values);
  sos.forEach(([b0, b1, b2, , a1, a2], s) => {
    let z0 = zi[s][0];
    let z1 = zi[s][1];
    for (let i = 0; i < n; i++) {
      const x = out[i];
      const y = b0 * x + z0;
      z0 = b1 * x - a1 * y + z1;
      z1 = b2 * x - a2 * y;
      out[i] = y;
    }
  });
  return out;
}

// scipy.signal.sosfilt_zi: section states for a step response in steady state.
function sosFilterZi(sos) {
  let scale = 1;
  return sos.map(([b0, b1, b2, a0, a1, a2]) => {
    // lfilter_zi for a 2nd order section: solve (I - companion(a).T) zi = b[1:] - a[1:] * b[0]
    const r0 = b1 - a1 * b0;
    const r1 = b2 - a2 * b0;
    // [[1 + a1, -1], [a2, 1]] zi = [r0, r1]
    const det = 1 + a1 + a2;
    const zi = [(r0 + r1) / det, ((1 + a1) * r1 - a2 * r0) / det];
    const result = [scale * zi[0], scale * zi[1]];
    scale *= (b0 + b1 + b2) / (a0 + a1 + a2);
    return result;
  });
}

/** scipy.signal.sosfiltfilt with its default odd padding: zero-phase filtering. */
export function sosFiltFilt(sos, values) {
  const n = values.length;
  const zeros = Math.min(sos.filter((s) => s[2] === 0).length, sos.filter((s) => s[5] === 0).length);
  const pad = 3 * (2 * sos.length + 1 - zeros);
  const extended = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) extended[i] = 2 * values[0] - values[pad - i];
  extended.set(values, pad);
  for (let i = 0; i < pad; i++) extended[pad + n + i] = 2 * values[n - 1] - values[n - 2 - i];
  const zi = sosFilterZi(sos);
  const scaled = (x) => zi.map(([a, b]) => [a * x, b * x]);
  const forward = sosFilter(sos, extended, scaled(extended[0]));
  forward.reverse();
  const backward = sosFilter(sos, forward, scaled(forward[0]));
  backward.reverse();
  return backward.slice(pad, pad + n);
}
