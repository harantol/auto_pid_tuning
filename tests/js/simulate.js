// Synthetic flights with a known closed-loop response, to test the analysis against.

/** Seeded uniform generator in [0, 1) (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded normal generator (Box-Muller). */
export function normal(seed) {
  const uniform = random(seed);
  return (sigma = 1) => sigma * Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** Second-order low-pass wn^2 / (s^2 + 2 zeta wn s + wn^2), discretised (Tustin) and applied. */
export function secondOrder(values, fs, naturalHz, damping) {
  const wn = 2 * Math.PI * naturalHz;
  const k = 2 * fs;
  const a0 = k * k + 2 * damping * wn * k + wn * wn;
  const b = [(wn * wn) / a0, (2 * wn * wn) / a0, (wn * wn) / a0];
  const a1 = (2 * wn * wn - 2 * k * k) / a0;
  const a2 = (k * k - 2 * damping * wn * k + wn * wn) / a0;
  const out = new Float64Array(values.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** The closed-loop response of an axis: second order plus a delay. */
export function respond(values, fs, naturalHz, damping, delayS = 0.008) {
  const delay = Math.round(delayS * fs);
  const response = secondOrder(values, fs, naturalHz, damping);
  const out = new Float64Array(values.length);
  out.set(response.subarray(0, values.length - delay), delay);
  return out;
}

/** Setpoint of a pilot alternating between holds and moves, smoothed like RC input. */
export function sticks(fs, duration, { amplitude = 400, stickHz = 8, seed = 0 } = {}) {
  const uniform = random(seed + 100);
  const n = Math.floor(duration * fs);
  const setpoint = new Float64Array(n);
  for (let i = 0; i < n;) {
    const hold = Math.floor((0.15 + uniform() * 1.05) * fs);
    const value = uniform() < 1 / 3 ? (uniform() * 2 - 1) * amplitude : 0;
    setpoint.fill(value, i, Math.min(n, i + hold));
    i += hold;
  }
  return secondOrder(setpoint, fs, stickHz, Math.SQRT1_2);
}

/**
 * One simulated axis: {setpoint, gyro, truth}, `truth` being the step response over 0.5 s.
 * `disturbance` adds wind-like motion the sticks did not ask for.
 */
export function axisFlight({
  fs = 1000, duration = 120, naturalHz = 12, damping = 0.7, noise = 1.5, disturbance = 0,
  stickHz = 8, amplitude = 400, seed = 0,
} = {}) {
  const gauss = normal(seed + 1);
  const setpoint = sticks(fs, duration, { amplitude, stickHz, seed });
  const gyro = respond(setpoint, fs, naturalHz, damping);
  if (disturbance) {
    const wind = Float64Array.from(setpoint, () => gauss());
    const slow = secondOrder(wind, fs, 20, 0.5);
    for (let i = 0; i < gyro.length; i++) gyro[i] += slow[i] * disturbance;
  }
  for (let i = 0; i < gyro.length; i++) gyro[i] += gauss(noise);
  const truth = respond(new Float64Array(Math.floor(0.5 * fs)).fill(1), fs, naturalHz, damping);
  return { setpoint, gyro, truth };
}
