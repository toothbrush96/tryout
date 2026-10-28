// Minimal readers for the activity download: a ZIP container holding the
// original .fit file. Only "record" messages (per-second samples) are decoded.

import { inflateRawSync } from 'node:zlib';

export function extractFirstFit(zip) {
  // End of central directory record: scan backwards for its signature.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    if (isFit(zip, 0)) return zip; // some downloads may be a bare FIT file
    throw new Error('Download ist weder ZIP noch FIT.');
  }
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.fit$/i.test(name)) continue;
    const lNameLen = zip.readUInt16LE(localOffset + 26);
    const lExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = zip.subarray(start, start + compSize);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error(`Nicht unterstützte ZIP-Kompression (${method}).`);
  }
  throw new Error('Keine .fit-Datei im Download gefunden.');
}

function isFit(buf, offset) {
  return buf.length > offset + 12 && buf.toString('ascii', offset + 8, offset + 12) === '.FIT';
}

const FIT_EPOCH = Date.UTC(1989, 11, 31);
const RECORD = 20;
// field number -> [name, scale, offset]
const RECORD_FIELDS = {
  253: ['timestamp', 1, 0],
  3: ['hr', 1, 0],
  6: ['speed', 1000, 0],
  73: ['speed', 1000, 0],
  5: ['distance', 100, 0],
  7: ['power', 1, 0],
  4: ['cadence', 1, 0],
  2: ['altitude', 5, 500],
  78: ['altitude', 5, 500],
};
const BASE_SIZES = { 0x00: 1, 0x01: 1, 0x02: 1, 0x0a: 1, 0x83: 2, 0x84: 2, 0x8b: 2, 0x85: 4, 0x86: 4, 0x8c: 4, 0x88: 4, 0x89: 8, 0x8e: 8, 0x8f: 8, 0x90: 8 };

function readValue(buf, pos, size, baseType, little) {
  const invalid = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
  let v;
  if (size === 1) v = buf.readUInt8(pos);
  else if (size === 2) v = little ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos);
  else if (size === 4) v = little ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
  else return null;
  if (BASE_SIZES[baseType] === undefined) return null;
  if (v === invalid[size]) return null;
  return v;
}

export function parseFitRecords(buf) {
  if (!isFit(buf, 0)) throw new Error('Keine gültige FIT-Datei.');
  const headerSize = buf.readUInt8(0);
  const dataSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, headerSize + dataSize);
  const defs = new Map();
  const records = [];
  let pos = headerSize;
  let lastTimestamp = null;
  while (pos < end) {
    const header = buf.readUInt8(pos++);
    let local;
    let timeOffset = null;
    if (header & 0x80) {
      local = (header >> 5) & 0x03;
      timeOffset = header & 0x1f;
    } else {
      local = header & 0x0f;
      if (header & 0x40) {
        const little = buf.readUInt8(pos + 1) === 0;
        const global = little ? buf.readUInt16LE(pos + 2) : buf.readUInt16BE(pos + 2);
        const count = buf.readUInt8(pos + 4);
        const fields = [];
        let q = pos + 5;
        for (let i = 0; i < count; i++, q += 3) {
          fields.push({ num: buf.readUInt8(q), size: buf.readUInt8(q + 1), type: buf.readUInt8(q + 2) });
        }
        let devSize = 0;
        if (header & 0x20) {
          const devCount = buf.readUInt8(q++);
          for (let i = 0; i < devCount; i++, q += 3) devSize += buf.readUInt8(q + 1);
        }
        defs.set(local, { little, global, fields, devSize });
        pos = q;
        continue;
      }
    }
    const def = defs.get(local);
    if (!def) throw new Error('FIT-Datei beschädigt (fehlende Definition).');
    const rec = {};
    for (const f of def.fields) {
      if (def.global === RECORD && RECORD_FIELDS[f.num]) {
        const v = readValue(buf, pos, f.size, f.type, def.little);
        if (v !== null) {
          const [name, scale, offset] = RECORD_FIELDS[f.num];
          rec[name] = v / scale - offset;
        }
      } else if (f.num === 253 && f.size === 4) {
        const v = readValue(buf, pos, 4, f.type, def.little);
        if (v !== null) lastTimestamp = v;
      }
      pos += f.size;
    }
    pos += def.devSize;
    if (def.global !== RECORD) continue;
    if (rec.timestamp !== undefined) lastTimestamp = rec.timestamp;
    else if (timeOffset !== null && lastTimestamp !== null) {
      let t = (lastTimestamp & ~0x1f) + timeOffset;
      if (timeOffset < (lastTimestamp & 0x1f)) t += 0x20;
      rec.timestamp = lastTimestamp = t;
    }
    if (rec.timestamp === undefined) continue;
    rec.time = FIT_EPOCH + rec.timestamp * 1000;
    delete rec.timestamp;
    records.push(rec);
  }
  return records;
}

// Reduces a stream to at most maxPoints by averaging consecutive samples.
export function downsample(records, maxPoints = 600) {
  if (records.length <= maxPoints) return records;
  const step = records.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const chunk = records.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    const avg = { time: chunk[0].time };
    for (const key of ['hr', 'speed', 'power', 'cadence', 'altitude']) {
      const vals = chunk.map((r) => r[key]).filter((v) => v !== undefined);
      if (vals.length) avg[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const last = chunk[chunk.length - 1];
    if (last.distance !== undefined) avg.distance = last.distance;
    out.push(avg);
  }
  return out;
}
