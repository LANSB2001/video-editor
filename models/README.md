# Models

| File | What | Licence |
|---|---|---|
| `mobilesam_encoder.onnx` | MobileSAM image encoder (TinyViT): frame → embedding | Apache-2.0 |
| `mobilesam_decoder.onnx` | SAM mask decoder: clicks/box + embedding → mask | Apache-2.0 |

MobileSAM: https://github.com/ChaoningZhang/MobileSAM (Apache-2.0), built on
Segment Anything by Meta AI (Apache-2.0).

Regenerate with:

```bash
pip install torch onnx timm "git+https://github.com/ChaoningZhang/MobileSAM.git"
curl -LO https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt
python scripts/export_mobilesam.py mobile_sam.pt models
```

The app runs them on the CPU with ONNX Runtime. No GPU or internet connection is needed.
