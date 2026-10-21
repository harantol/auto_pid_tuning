// Betaflight rate curves: what the logged rate settings mean in deg/s.

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const RATES_BETAFLIGHT = 0;
export const RATES_ACTUAL = 3;

const ratesType = (headers) => (has(headers, "rates_type") ? headers.rates_type : RATES_BETAFLIGHT);

function floats(value) {
  if (!Array.isArray(value)) return null;
  const out = value.map((v) => (typeof v === "number" ? v : Number.parseFloat(v)));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * Rates of the three axes as flown, or null for rate types that are not modelled. Each axis is
 * {centerSensitivity (deg/s per full stick around the centre), maxRate (deg/s at full stick),
 * expo (0..1, only meaningful for Actual rates, else null)}.
 */
export function currentRates(headers) {
  const type = ratesType(headers);
  const rcRates = floats(headers.rc_rates);
  const rates = floats(headers.rates);
  const expos = floats(headers.rc_expo)?.map((v) => v / 100);
  if (!rcRates || !rates || !expos || rcRates.length !== 3 || rates.length !== 3 || expos.length !== 3) {
    return null;
  }
  if (type === RATES_ACTUAL) {
    return rcRates.map((center, i) => ({
      centerSensitivity: center * 10,
      maxRate: Math.max(rates[i], center) * 10,
      expo: expos[i],
    }));
  }
  if (type === RATES_BETAFLIGHT) {
    return rcRates.map((rcRate, i) => ({
      centerSensitivity: 200 * betaflightRcRate(rcRate) * (1 - expos[i]),
      maxRate: betaflightRate(1, rcRate, rates[i], expos[i]),
      expo: null,
    }));
  }
  return null;
}

/** Commanded deg/s of axis `index` at each stick deflection, with the rates as flown. */
export function rateCurve(headers, index, sticks) {
  if (currentRates(headers) === null) return null;
  const rcRate = Number(headers.rc_rates[index]);
  const top = Number(headers.rates[index]);
  const expo = Number(headers.rc_expo[index]) / 100;
  if (ratesType(headers) === RATES_ACTUAL) {
    return sticks.map((x) => actualRate(x, rcRate * 10, Math.max(top, rcRate) * 10, expo));
  }
  return sticks.map((x) => betaflightRate(x, rcRate, top, expo));
}

function betaflightRcRate(rcRate) {
  let rate = rcRate / 100;
  if (rate > 2) rate += 14.54 * (rate - 2);
  return rate;
}

/** Commanded deg/s for a stick deflection (-1..1) with Betaflight-type rates. */
export function betaflightRate(stick, rcRate, superRate, expo) {
  const magnitude = Math.abs(stick);
  if (expo) stick = stick * magnitude ** 3 * expo + stick * (1 - expo);
  let rate = 200 * betaflightRcRate(rcRate) * stick;
  if (superRate) rate /= Math.min(Math.max(1 - (magnitude * superRate) / 100, 0.01), 1);
  return rate;
}

/** Commanded deg/s for a stick deflection (-1..1) with Actual-type rates. */
export function actualRate(stick, centerSensitivity, maxRate, expo) {
  const magnitude = Math.abs(stick);
  const curve = magnitude * (stick ** 5 * expo + stick * (1 - expo));
  return stick * centerSensitivity + Math.max(0, maxRate - centerSensitivity) * curve;
}
