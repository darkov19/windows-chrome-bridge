'use strict';
// The offscreen document that turns tab frames into an MP4 file (H.264). background.js sends it
// JPEG frames from Page.startScreencast. The encoder (WebCodecs VideoEncoder) is not available in a
// service worker, so the encoding happens here. Nothing here can reach a tab or the disk.
const recordings = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY_EVERY = 2; // seconds between key frames, so a player can seek

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function bitmap(jpeg) {
  const blob = await (await fetch('data:image/jpeg;base64,' + jpeg)).blob();
  return createImageBitmap(blob);
}

async function setup(r, w, h) {
  const scale = Math.min(1, r.maxSize / Math.max(w, h));
  // H.264 needs an even width and height.
  r.width = Math.max(2, Math.floor((w * scale) / 2) * 2);
  r.height = Math.max(2, Math.floor((h * scale) / 2) * 2);
  r.codec = QaMp4.codecFor(r.width, r.height);
  const config = {
    codec: r.codec,
    width: r.width,
    height: r.height,
    bitrate: r.bitrate,
    framerate: r.fps,
    avc: { format: 'avc' },
    latencyMode: 'quality'
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw Error(`This Chrome cannot encode H.264 video (${r.codec}, ${r.width}x${r.height})`);
  r.canvas = new OffscreenCanvas(r.width, r.height);
  r.ctx = r.canvas.getContext('2d');
  r.encoder = new VideoEncoder({
    output(chunk, meta) {
      if (meta && meta.decoderConfig && meta.decoderConfig.description)
        r.avcC = new Uint8Array(ArrayBuffer.isView(meta.decoderConfig.description)
          ? meta.decoderConfig.description.buffer.slice(0)
          : meta.decoderConfig.description.slice(0));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      r.chunks.push({ data, key: chunk.type === 'key', us: chunk.timestamp });
      r.bytes += data.length;
    },
    error(e) {
      r.error = e;
    }
  });
  r.encoder.configure(config);
}

async function encode(r, t) {
  if (r.error) throw r.error;
  // Timestamps must grow.
  if (r.lastT !== undefined && t <= r.lastT) t = r.lastT + 0.001;
  r.lastT = t;
  const keyFrame = r.lastKey === undefined || t - r.lastKey >= KEY_EVERY;
  if (keyFrame) r.lastKey = t;
  const frame = new VideoFrame(r.canvas, { timestamp: Math.round(t * 1e6) });
  try {
    r.encoder.encode(frame, { keyFrame });
  } finally {
    frame.close();
  }
  r.frames++;
  while (r.encoder.encodeQueueSize > 4) await sleep(5);
}

async function frame(r, m) {
  const image = await bitmap(m.data);
  try {
    if (!r.encoder) await setup(r, image.width, image.height);
    const { ctx, width: W, height: H } = r;
    const s = Math.min(W / image.width, H / image.height);
    const w = Math.round(image.width * s),
      h = Math.round(image.height * s);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(image, Math.floor((W - w) / 2), Math.floor((H - h) / 2), w, h);
  } finally {
    image.close();
  }
  await encode(r, m.t);
}

// A grey frame with a note, for the time a page could not be recorded (site policy).
async function blank(r, m) {
  if (!r.encoder) await setup(r, r.maxSize, Math.round((r.maxSize * 9) / 16));
  const { ctx, width: W, height: H } = r;
  ctx.fillStyle = '#444';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = Math.max(14, Math.round(H / 24)) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(m.text, W / 2, H / 2);
  await encode(r, m.t);
}

async function stop(r, m) {
  recordings.delete(r.id);
  if (!r.encoder) throw Error('No frames were recorded');
  await r.encoder.flush();
  r.encoder.close();
  if (r.error) throw r.error;
  if (!r.chunks.length) throw Error('No frames were recorded');
  if (!r.avcC) throw Error('The encoder gave no H.264 configuration');
  const end = Math.max(m.t, r.lastT + 0.04) * 1e6;
  const samples = r.chunks.map((c, i) => ({
    data: c.data,
    key: c.key,
    ms: ((i + 1 < r.chunks.length ? r.chunks[i + 1].us : end) - c.us) / 1000
  }));
  const file = QaMp4.write(samples, { width: r.width, height: r.height, avcC: r.avcC });
  return {
    data: base64(file),
    bytes: file.length,
    frames: samples.length,
    width: r.width,
    height: r.height,
    codec: r.codec,
    seconds: Math.round((end - r.chunks[0].us) / 1e4) / 100
  };
}

async function run(m) {
  if (m.op === 'start') {
    recordings.set(m.id, {
      id: m.id,
      maxSize: m.maxSize,
      fps: m.fps,
      bitrate: m.bitrate,
      chunks: [],
      bytes: 0,
      frames: 0,
      queue: Promise.resolve()
    });
    return {};
  }
  const r = recordings.get(m.id);
  if (!r) throw Error('No such recording');
  const job = r.queue.then(() => (m.op === 'frame' ? frame(r, m) : m.op === 'blank' ? blank(r, m) : stop(r, m)));
  r.queue = job.catch(() => {});
  const result = await job;
  return m.op === 'stop' ? result : { bytes: r.bytes, frames: r.frames };
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.target !== 'recorder' || sender.id !== chrome.runtime.id) return;
  run(m).then(
    v => reply({ ok: true, ...v }),
    e => reply({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});
