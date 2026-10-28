// Per-activity analysis from full-resolution FIT samples.

const MOVING_SPEED = 0.5; // m/s; slower samples count as standing

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Aerobic decoupling (Pa:HR): how much the speed-per-heartbeat ratio drops
// from the first to the second half of the moving time. Below ~5 % is
// usually read as good aerobic durability for a steady session.
export function decoupling(records) {
  const moving = records.filter((r) => r.hr > 0 && r.speed > MOVING_SPEED);
  if (moving.length < 2) return null;
  const durationMin = (moving[moving.length - 1].time - moving[0].time) / 60000;
  if (durationMin < 20) return { durationMin, value: null, reason: 'Einheit kürzer als 20 Minuten' };
  const half = Math.floor(moving.length / 2);
  const ef = (rs) => mean(rs.map((r) => r.speed)) / mean(rs.map((r) => r.hr));
  const first = ef(moving.slice(0, half));
  const second = ef(moving.slice(half));
  return { durationMin, value: ((first - second) / first) * 100, efFirst: first * 60, efSecond: second * 60 };
}

export function splits(records, splitMeters) {
  const out = [];
  let startIdx = 0;
  let target = splitMeters;
  for (let i = 0; i < records.length; i++) {
    const d = records[i].distance;
    if (d === undefined || d < target) continue;
    out.push(summarize(records.slice(startIdx, i + 1), out.length + 1, splitMeters));
    startIdx = i;
    target += splitMeters;
  }
  const rest = records.slice(startIdx);
  const restDist = (rest.at(-1)?.distance ?? 0) - (rest[0]?.distance ?? 0);
  if (rest.length > 1 && restDist > splitMeters * 0.2) out.push(summarize(rest, out.length + 1, restDist));
  return out;
}

function summarize(rs, index, meters) {
  const seconds = (rs[rs.length - 1].time - rs[0].time) / 1000;
  const hrs = rs.map((r) => r.hr).filter((v) => v > 0);
  const pw = rs.map((r) => r.power).filter((v) => v !== undefined);
  const alt = rs.map((r) => r.altitude).filter((v) => v !== undefined);
  return {
    index,
    meters: Math.round(meters),
    seconds,
    avgHR: hrs.length ? Math.round(mean(hrs)) : null,
    avgPower: pw.length ? Math.round(mean(pw)) : null,
    elevationDelta: alt.length > 1 ? Math.round(alt[alt.length - 1] - alt[0]) : null,
  };
}
