'use strict';
// A small MP4 writer for one H.264 video track. No browser calls, so it can be unit tested.
// The moov box comes before the media data ("fast start"), so a browser can play the file
// while it downloads it, for example on GitHub.
(function (root) {
  const ascii = s => [...s].map(c => c.charCodeAt(0));
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = n => [(n >>> 8) & 255, n & 255];
  const zeros = n => new Array(n).fill(0);

  // A box: 4-byte size, 4-byte type, then the parts (arrays of bytes or Uint8Arrays).
  function box(type, ...parts) {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    out.set([...u32(size), ...ascii(type)]);
    let at = 8;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  const full = (type, version, flags, ...parts) => box(type, [version, ...u32(flags).slice(1)], ...parts);
  const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

  // Run-length list of sample durations for stts.
  function runs(durations) {
    const out = [];
    for (const d of durations) {
      const last = out[out.length - 1];
      if (last && last[1] === d) last[0]++;
      else out.push([1, d]);
    }
    return out;
  }

  // samples: [{data: Uint8Array (length-prefixed NAL units), key: bool, ms: duration in ms}]
  // config: {width, height, avcC: Uint8Array (the AVCDecoderConfigurationRecord)}
  // Returns the whole file as a Uint8Array. The time scale is 1000 (milliseconds).
  function write(samples, config) {
    if (!samples.length) throw Error('No video frames to write');
    if (!samples[0].key) throw Error('The first frame must be a key frame');
    const durations = samples.map(s => Math.max(1, Math.round(s.ms)));
    const total = durations.reduce((a, b) => a + b, 0);
    const { width, height } = config;
    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
    const moov = offset => {
      const stts = runs(durations);
      const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
      const avc1 = box(
        'avc1',
        zeros(6), u16(1), zeros(16), u16(width), u16(height),
        u32(0x480000), u32(0x480000), zeros(4), u16(1), zeros(32), u16(0x18), u16(0xffff),
        box('avcC', config.avcC)
      );
      const stbl = box(
        'stbl',
        full('stsd', 0, 0, u32(1), avc1),
        full('stts', 0, 0, u32(stts.length), stts.flatMap(([n, d]) => [...u32(n), ...u32(d)])),
        full('stss', 0, 0, u32(keys.length), keys.flatMap(u32)),
        full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
        full('stsz', 0, 0, u32(0), u32(samples.length), samples.flatMap(s => u32(s.data.length))),
        full('stco', 0, 0, u32(1), u32(offset))
      );
      const minf = box(
        'minf',
        full('vmhd', 0, 1, zeros(8)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        stbl
      );
      const mdia = box(
        'mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(1000), u32(total), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), [0]),
        minf
      );
      const tkhd = full(
        'tkhd', 0, 3,
        u32(0), u32(0), u32(1), u32(0), u32(total), zeros(8), u16(0), u16(0), u16(0), u16(0),
        MATRIX, u32(width * 0x10000), u32(height * 0x10000)
      );
      const mvhd = full(
        'mvhd', 0, 0,
        u32(0), u32(0), u32(1000), u32(total), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)
      );
      return box('moov', mvhd, box('trak', tkhd, mdia));
    };
    // The moov size does not depend on the offset, so measure it once.
    const offset = ftyp.length + moov(0).length + 8;
    const dataSize = samples.reduce((n, s) => n + s.data.length, 0);
    const out = new Uint8Array(offset + dataSize);
    out.set(ftyp);
    out.set(moov(offset), ftyp.length);
    out.set([...u32(8 + dataSize), ...ascii('mdat')], offset - 8);
    let at = offset;
    for (const s of samples) {
      out.set(s.data, at);
      at += s.data.length;
    }
    return out;
  }

  // The H.264 codec string for a frame size: Constrained Baseline, with the lowest level that fits.
  function codecFor(width, height) {
    const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    const level = blocks <= 3600 ? 0x1f : blocks <= 5120 ? 0x20 : blocks <= 8192 ? 0x28 : 0x32;
    return 'avc1.42E0' + level.toString(16).toUpperCase();
  }

  const QaMp4 = { write, codecFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = QaMp4;
  else root.QaMp4 = QaMp4;
})(typeof self !== 'undefined' ? self : globalThis);
