/**
 * Minimal FLAC encoder (fixed predictors, partitioned Rice coding, stereo decorrelation).
 * Lossless for integer PCM; output frames are meant to be muxed into MP4 ('fLaC' sample entry).
 */

export const FLAC_BLOCK_SIZE = 4096;

class BitWriter {
  private buf: Uint8Array;
  private pos = 0; // bytes written
  private acc = 0; // pending bits (< 8)
  private nacc = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  private ensure(extraBytes: number) {
    if (this.pos + extraBytes + 8 <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extraBytes + 1024));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Writes the low `n` bits of `value` (n <= 32, value treated as unsigned). */
  bits(value: number, n: number) {
    this.ensure(5);
    while (n > 0) {
      const take = Math.min(n, 8 - this.nacc);
      const shift = n - take;
      const chunk = Math.floor(value / 2 ** shift) & ((1 << take) - 1);
      this.acc = (this.acc << take) | chunk;
      this.nacc += take;
      n -= take;
      if (this.nacc === 8) {
        this.buf[this.pos++] = this.acc;
        this.acc = 0;
        this.nacc = 0;
      }
    }
  }

  signed(value: number, n: number) {
    this.bits(value < 0 ? value + 2 ** n : value, n);
  }

  unary(zeros: number) {
    // `zeros` 0-bits followed by a 1-bit
    while (zeros >= 8 - this.nacc && this.nacc > 0) {
      zeros -= 8 - this.nacc;
      this.bits(0, 8 - this.nacc);
    }
    if (this.nacc === 0 && zeros >= 8) {
      const full = zeros >> 3;
      this.ensure(full);
      this.buf.fill(0, this.pos, this.pos + full);
      this.pos += full;
      zeros &= 7;
    }
    this.bits(1, zeros + 1);
  }

  alignToByte() {
    if (this.nacc > 0) this.bits(0, 8 - this.nacc);
  }

  mark() {
    return { pos: this.pos, acc: this.acc, nacc: this.nacc };
  }

  restore(m: { pos: number; acc: number; nacc: number }) {
    this.pos = m.pos;
    this.acc = m.acc;
    this.nacc = m.nacc;
  }

  get byteLength() {
    return this.pos;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}
const crc8 = (d: Uint8Array) => d.reduce((c, b) => CRC8[c ^ b], 0);
const crc16 = (d: Uint8Array) => d.reduce((c, b) => ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b], 0);

const SAMPLE_RATE_CODES: Record<number, number> = {
  88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11,
};

const zigzag = (r: number) => (r >= 0 ? 2 * r : -2 * r - 1);

/** Residual of fixed predictor `order` written into `out` (length n - order). */
function fixedResidual(x: Int32Array, order: number, out: Float64Array): void {
  const n = x.length;
  for (let i = order; i < n; i++) {
    let r: number;
    switch (order) {
      case 0: r = x[i]; break;
      case 1: r = x[i] - x[i - 1]; break;
      case 2: r = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    out[i - order] = r;
  }
}

function sumAbsResidual(x: Int32Array, order: number): number {
  let s = 0;
  for (let i = order; i < x.length; i++) {
    switch (order) {
      case 0: s += Math.abs(x[i]); break;
      case 1: s += Math.abs(x[i] - x[i - 1]); break;
      case 2: s += Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]); break;
      case 3: s += Math.abs(x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]); break;
      default: s += Math.abs(x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]);
    }
  }
  return s;
}

function bestFixedOrder(x: Int32Array): { order: number; cost: number } {
  let best = { order: 0, cost: Infinity };
  for (let order = 0; order <= Math.min(4, x.length - 1); order++) {
    const cost = sumAbsResidual(x, order);
    if (cost < best.cost) best = { order, cost };
  }
  return best;
}

const riceParam = (sum: number, n: number) => {
  if (n === 0 || sum <= n) return 0;
  return Math.min(30, Math.max(0, Math.floor(Math.log2(sum / n))));
};

/** Estimated bits for `n` zigzag values summing to `sum` with Rice parameter k. */
const riceCost = (sum: number, n: number, k: number) => n * (k + 1) + sum / 2 ** k;

function writeResidual(w: BitWriter, res: Float64Array, len: number, order: number, blockSize: number) {
  const u = new Float64Array(len);
  for (let i = 0; i < len; i++) u[i] = zigzag(res[i]);

  // Choose partition order: partitions must divide the block and hold more samples than the predictor order.
  let maxPo = 0;
  while (maxPo < 8 && blockSize % (1 << (maxPo + 1)) === 0 && blockSize >> (maxPo + 1) > order) maxPo++;
  let best = { po: 0, cost: Infinity, params: [0] as number[] };
  for (let po = 0; po <= maxPo; po++) {
    const parts = 1 << po;
    const params: number[] = [];
    let cost = 0;
    let idx = 0;
    for (let p = 0; p < parts; p++) {
      const n = (blockSize >> po) - (p === 0 ? order : 0);
      let s = 0;
      for (let i = 0; i < n; i++) s += u[idx + i];
      idx += n;
      const k = riceParam(s, n);
      params.push(k);
      cost += 5 + riceCost(s, n, k);
    }
    if (cost < best.cost) best = { po, cost, params };
  }

  const useRice2 = best.params.some((k) => k >= 15);
  w.bits(useRice2 ? 1 : 0, 2);
  w.bits(best.po, 4);
  let idx = 0;
  for (let p = 0; p < best.params.length; p++) {
    const n = (blockSize >> best.po) - (p === 0 ? order : 0);
    const k = best.params[p];
    w.bits(k, useRice2 ? 5 : 4);
    const div = 2 ** k;
    for (let i = 0; i < n; i++) {
      const v = u[idx + i];
      const q = Math.floor(v / div);
      w.unary(q);
      if (k) w.bits(v - q * div, k);
    }
    idx += n;
  }
}

function writeSubframe(w: BitWriter, x: Int32Array, bps: number, scratch: Float64Array) {
  const n = x.length;
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) {
    w.bits(0b00000000, 8);
    w.signed(x[0], bps);
    return;
  }
  const { order } = bestFixedOrder(x);
  const start = w.byteLength;
  // Verbatim cost is known exactly; fall back to it if the predicted subframe would be bigger.
  const verbatimBytes = (8 + n * bps) / 8;
  w.bits(0b00010000 | (order << 1), 8); // type 001xxx = fixed predictor, no wasted bits
  for (let i = 0; i < order; i++) w.signed(x[i], bps);
  fixedResidual(x, order, scratch);
  writeResidual(w, scratch, n - order, order, n);
  if (w.byteLength - start > verbatimBytes + 8) {
    throw new VerbatimFallback();
  }
}

class VerbatimFallback extends Error {}

function writeVerbatim(w: BitWriter, x: Int32Array, bps: number) {
  w.bits(0b00000010, 8);
  for (let i = 0; i < x.length; i++) w.signed(x[i], bps);
}

function utf8Number(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let len = 2;
  while (n >= 2 ** (5 * len + 1)) len++;
  for (let i = len - 1; i > 0; i--) {
    bytes.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
  }
  bytes.unshift(((0xff00 >> len) & 0xff) | n);
  return bytes;
}

export interface FlacStream {
  /** 'fLaC' + STREAMINFO block — the decoder description for MP4/WebCodecs. */
  description: Uint8Array;
  frames: { data: Uint8Array; timestamp: number; duration: number }[];
}

/**
 * Encodes planar integer PCM (values in the signed `bps`-bit range) to FLAC frames.
 * `onProgress` receives 0..1; the encoder yields to the event loop periodically.
 */
export async function encodeFlac(
  channels: Int32Array[],
  sampleRate: number,
  bps: 16 | 24,
  onProgress: (p: number) => void = () => {},
): Promise<FlacStream> {
  const numCh = channels.length;
  const total = channels[0].length;
  const frames: FlacStream['frames'] = [];
  const scratch = new Float64Array(FLAC_BLOCK_SIZE);
  const rateCode = SAMPLE_RATE_CODES[sampleRate] ?? (sampleRate % 10 === 0 && sampleRate / 10 < 65536 ? 14 : sampleRate < 65536 ? 13 : 0);
  let minFrame = Infinity;
  let maxFrame = 0;

  for (let start = 0, frameNo = 0; start < total; start += FLAC_BLOCK_SIZE, frameNo++) {
    const n = Math.min(FLAC_BLOCK_SIZE, total - start);
    const w = new BitWriter(n * numCh * 4 + 64);

    // Header
    w.bits(0xfff8, 16); // sync + fixed-blocksize
    const bsCode = n === FLAC_BLOCK_SIZE ? 12 : n <= 256 ? 6 : 7;
    w.bits(bsCode, 4);
    w.bits(rateCode, 4);

    const blocks = channels.map((c) => c.subarray(start, start + n));
    let assignment = numCh - 1;
    let subframes: { data: Int32Array; bps: number }[] = blocks.map((data) => ({ data, bps }));
    if (numCh === 2) {
      const [l, r] = blocks;
      const side = new Int32Array(n);
      const mid = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        side[i] = l[i] - r[i];
        mid[i] = (l[i] + r[i]) >> 1;
      }
      const cl = bestFixedOrder(l).cost, cr = bestFixedOrder(r).cost;
      const cm = bestFixedOrder(mid).cost, cs = bestFixedOrder(side).cost;
      const options = [
        { cost: cl + cr, a: 1, sf: [{ data: l, bps }, { data: r, bps }] },
        { cost: cl + cs, a: 8, sf: [{ data: l, bps }, { data: side, bps: bps + 1 }] },
        { cost: cs + cr, a: 9, sf: [{ data: side, bps: bps + 1 }, { data: r, bps }] },
        { cost: cm + cs, a: 10, sf: [{ data: mid, bps }, { data: side, bps: bps + 1 }] },
      ].sort((a, b) => a.cost - b.cost);
      assignment = options[0].a;
      subframes = options[0].sf;
    }
    w.bits(assignment, 4);
    w.bits(bps === 16 ? 0b100 : 0b110, 3);
    w.bits(0, 1);
    for (const b of utf8Number(frameNo)) w.bits(b, 8);
    if (bsCode === 6) w.bits(n - 1, 8);
    if (bsCode === 7) w.bits(n - 1, 16);
    if (rateCode === 13) w.bits(sampleRate, 16);
    if (rateCode === 14) w.bits(sampleRate / 10, 16);
    w.bits(crc8(w.bytes()), 8);

    for (const sf of subframes) {
      const before = w.mark();
      try {
        writeSubframe(w, sf.data, sf.bps, scratch);
      } catch (e) {
        if (!(e instanceof VerbatimFallback)) throw e;
        w.restore(before);
        writeVerbatim(w, sf.data, sf.bps);
      }
    }
    w.alignToByte();
    w.bits(crc16(w.bytes()), 16);

    const data = w.bytes().slice();
    minFrame = Math.min(minFrame, data.length);
    maxFrame = Math.max(maxFrame, data.length);
    frames.push({ data, timestamp: start / sampleRate, duration: n / sampleRate });

    if (frameNo % 64 === 63) {
      onProgress(start / total);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  onProgress(1);

  // STREAMINFO (34 bytes) preceded by 'fLaC' and the metadata block header (last block, type 0).
  const si = new BitWriter(64);
  si.bits(0x664c6143, 32); // 'fLaC'
  si.bits(0x80, 8);
  si.bits(34, 24);
  si.bits(FLAC_BLOCK_SIZE, 16);
  si.bits(FLAC_BLOCK_SIZE, 16);
  si.bits(frames.length ? minFrame : 0, 24);
  si.bits(maxFrame, 24);
  si.bits(sampleRate, 20);
  si.bits(numCh - 1, 3);
  si.bits(bps - 1, 5);
  si.bits(Math.floor(total / 2 ** 32), 4);
  si.bits(total >>> 0, 32);
  for (let i = 0; i < 4; i++) si.bits(0, 32); // MD5 unknown
  return { description: si.bytes().slice(), frames };
}
