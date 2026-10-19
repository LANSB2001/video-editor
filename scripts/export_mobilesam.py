# Exports MobileSAM (Apache-2.0) to two ONNX files for One Platform Studio.
#   encoder: float32[1,3,1024,1024] (normalised, padded) -> embeddings [1,256,64,64]
#   decoder: standard SAM ONNX decoder interface
import sys, warnings, torch
warnings.filterwarnings("ignore")
from mobile_sam import sam_model_registry
from mobile_sam.utils.onnx import SamOnnxModel

ckpt, out = sys.argv[1], sys.argv[2]
sam = sam_model_registry["vit_t"](checkpoint=ckpt).eval()

class Encoder(torch.nn.Module):
    def __init__(self, sam):
        super().__init__(); self.enc = sam.image_encoder
    def forward(self, x):
        return self.enc(x)

with torch.no_grad():
    torch.onnx.export(Encoder(sam), torch.randn(1, 3, 1024, 1024), f"{out}/mobilesam_encoder.onnx",
                      input_names=["image"], output_names=["image_embeddings"], opset_version=17, dynamo=False)
    dec = SamOnnxModel(sam, return_single_mask=True)
    dummy = {
        "image_embeddings": torch.randn(1, 256, 64, 64),
        "point_coords": torch.randint(0, 1024, (1, 5, 2), dtype=torch.float),
        "point_labels": torch.randint(0, 4, (1, 5), dtype=torch.float),
        "mask_input": torch.randn(1, 1, 256, 256),
        "has_mask_input": torch.tensor([1], dtype=torch.float),
        "orig_im_size": torch.tensor([720, 1280], dtype=torch.float),
    }
    torch.onnx.export(dec, tuple(dummy.values()), f"{out}/mobilesam_decoder.onnx",
                      input_names=list(dummy.keys()), output_names=["masks", "iou_predictions", "low_res_masks"],
                      dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
                      opset_version=17, dynamo=False)
print("exported")
