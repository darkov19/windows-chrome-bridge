'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../extension/mp4.js');

// The boxes at one level: [{type, start, size}].
function boxes(b, from = 0, to = b.length) {
  const out = [];
  const v = new DataView(b.buffer, b.byteOffset);
  for (let at = from; at < to; ) {
    const size = v.getUint32(at);
    if (size < 8) throw Error("bad box size " + size + " at " + at);
    out.push({ type: String.fromCharCode(...b.subarray(at + 4, at + 8)), start: at, size });
    at += size;
  }
  return out;
}
const find = (b, path) => {
  let level = boxes(b);
  let box;
  for (const [i, type] of path.entries()) {
    box = level.find(x => x.type === type);
    assert.ok(box, 'no ' + type);
    if (i === path.length - 1) break;
    // Full boxes (with version and flags) that hold other boxes start 4 bytes later.
    const skip = { stsd: 8, dref: 8 }[type] || 0;
    level = boxes(b, box.start + 8 + skip, box.start + box.size);
  }
  return box;
};

test('mp4: moov comes first, the sample table points at the frames, and the duration is the sum', () => {
  const frame = n => new Uint8Array([0, 0, 0, 2, n, n]);
  const samples = [
    { data: frame(1), key: true, ms: 100 },
    { data: frame(2), key: false, ms: 100 },
    { data: frame(3), key: false, ms: 2500 },
    { data: frame(4), key: true, ms: 40 }
  ];
  const file = M.write(samples, { width: 640, height: 360, avcC: new Uint8Array([1, 66, 224, 30, 255]) });
  const v = new DataView(file.buffer);
  assert.deepStrictEqual(boxes(file).map(b => b.type), ['ftyp', 'moov', 'mdat']);
  const mvhd = find(file, ['moov', 'mvhd']);
  assert.strictEqual(v.getUint32(mvhd.start + 20), 1000); // time scale
  assert.strictEqual(v.getUint32(mvhd.start + 24), 2740); // duration in ms
  const stco = find(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
  const offset = v.getUint32(stco.start + 16);
  assert.deepStrictEqual([...file.subarray(offset, offset + 6)], [...frame(1)]);
  assert.strictEqual(file.length, offset + 24);
  const stss = find(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss']);
  assert.deepStrictEqual([v.getUint32(stss.start + 12), v.getUint32(stss.start + 16), v.getUint32(stss.start + 20)], [2, 1, 4]);
  const avc1 = find(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1']);
  assert.deepStrictEqual([v.getUint16(avc1.start + 32), v.getUint16(avc1.start + 34)], [640, 360]);
  assert.throws(() => M.write([{ data: frame(1), key: false, ms: 1 }], { width: 2, height: 2, avcC: new Uint8Array(1) }), /key frame/);
});

test('mp4: the H.264 level fits the frame size', () => {
  assert.strictEqual(M.codecFor(1280, 720), 'avc1.42E01F');
  assert.strictEqual(M.codecFor(1264, 904), 'avc1.42E020');
  assert.strictEqual(M.codecFor(1920, 1080), 'avc1.42E028');
  assert.strictEqual(M.codecFor(1920, 1200), 'avc1.42E032');
});
