// MobileSAM (Apache-2.0) via ONNX Runtime on the CPU: click an object, get its
// outline. Runs on ordinary laptops (~0.3–1 s per frame for the encoder).
//
// The encoder turns a frame into an embedding once; the decoder is cheap and
// turns clicks/boxes + embedding into a mask, so refining a selection is instant.

import * as ort from 'onnxruntime-node';
import path from 'node:path';

export const SAM_SIZE = 1024;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

export interface Point {
  x: number;
  y: number;
  /** 1 = part of the object, 0 = not part of it. */
  label: 0 | 1;
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface Frame {
  /** RGB, 3 bytes per pixel. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Embedding {
  tensor: ort.Tensor;
  width: number;
  height: number;
  /** frame px → model px */
  scale: number;
}

export interface MaskResult {
  /** 1 byte per frame pixel, 255 = object. */
  mask: Uint8Array;
  width: number;
  height: number;
  score: number;
  /** Feeds the next decode for temporal consistency. */
  lowRes: ort.Tensor;
  area: number;
}

export class Sam {
  private constructor(private encoder: ort.InferenceSession, private decoder: ort.InferenceSession) {}

  static async load(dir: string, threads = 0): Promise<Sam> {
    const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads };
    const [enc, dec] = await Promise.all([
      ort.InferenceSession.create(path.join(dir, 'mobilesam_encoder.onnx'), opts),
      ort.InferenceSession.create(path.join(dir, 'mobilesam_decoder.onnx'), opts),
    ]);
    return new Sam(enc, dec);
  }

  async encode(f: Frame): Promise<Embedding> {
    const scale = SAM_SIZE / Math.max(f.width, f.height);
    const w = Math.round(f.width * scale), h = Math.round(f.height * scale);
    const input = new Float32Array(3 * SAM_SIZE * SAM_SIZE); // zero padding after normalisation
    const plane = SAM_SIZE * SAM_SIZE;
    // Bilinear resize + normalise into CHW.
    for (let y = 0; y < h; y++) {
      const sy = Math.min(f.height - 1, (y + 0.5) / scale - 0.5);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(f.height - 1, y0 + 1), fy = Math.max(0, sy - y0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(f.width - 1, (x + 0.5) / scale - 0.5);
        const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(f.width - 1, x0 + 1), fx = Math.max(0, sx - x0);
        const i00 = (y0 * f.width + x0) * 3, i01 = (y0 * f.width + x1) * 3, i10 = (y1 * f.width + x0) * 3, i11 = (y1 * f.width + x1) * 3;
        const o = y * SAM_SIZE + x;
        for (let c = 0; c < 3; c++) {
          const v = (f.data[i00 + c] * (1 - fx) + f.data[i01 + c] * fx) * (1 - fy) + (f.data[i10 + c] * (1 - fx) + f.data[i11 + c] * fx) * fy;
          input[c * plane + o] = (v - MEAN[c]) / STD[c];
        }
      }
    }
    const out = await this.encoder.run({ image: new ort.Tensor('float32', input, [1, 3, SAM_SIZE, SAM_SIZE]) });
    return { tensor: out.image_embeddings, width: f.width, height: f.height, scale };
  }

  async decode(e: Embedding, points: Point[], box?: Box, prev?: ort.Tensor): Promise<MaskResult> {
    const coords: number[] = [];
    const labels: number[] = [];
    for (const p of points) { coords.push(p.x * e.scale, p.y * e.scale); labels.push(p.label); }
    if (box) {
      coords.push(box.x0 * e.scale, box.y0 * e.scale, box.x1 * e.scale, box.y1 * e.scale);
      labels.push(2, 3);
    } else {
      coords.push(0, 0); // padding point required when there is no box
      labels.push(-1);
    }
    const n = labels.length;
    const out = await this.decoder.run({
      image_embeddings: e.tensor,
      point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, n, 2]),
      point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, n]),
      mask_input: prev ?? new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', Float32Array.of(prev ? 1 : 0), [1]),
      orig_im_size: new ort.Tensor('float32', Float32Array.of(e.height, e.width), [2]),
    });
    const logits = out.masks.data as Float32Array;
    const mask = new Uint8Array(e.width * e.height);
    let area = 0;
    for (let i = 0; i < mask.length; i++) if (logits[i] > 0) { mask[i] = 255; area++; }
    return { mask, width: e.width, height: e.height, score: (out.iou_predictions.data as Float32Array)[0], lowRes: out.low_res_masks, area };
  }
}
