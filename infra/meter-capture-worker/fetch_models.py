"""Build-time download from official PaddlePaddle repositories at immutable revisions."""
from pathlib import Path
import hashlib
import urllib.request

MODELS = {
    "PP-OCRv5_mobile_det": "0d63e78e2b680928f6b1747d76a08db6e645efb7",
    "en_PP-OCRv5_mobile_rec": "267c36e24c331595590fe7bd72bde2436fd286f2",
}
WEIGHT_SHA256 = {
    "PP-OCRv5_mobile_det": "afa1820cb16c1fd0dad589d0f8b389139061c1ef6d68019685fd07be997dda5b",
    "en_PP-OCRv5_mobile_rec": "3ec8a97ed6cefe8568d3e2ee90bb193299b566a7661aa4fd52d224b96b59f66b",
}

if __name__ == "__main__":
    for model, revision in MODELS.items():
        directory = Path("/opt/models") / model
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("config.json", "inference.json", "inference.pdiparams", "inference.yml"):
            with urllib.request.urlopen(f"https://huggingface.co/PaddlePaddle/{model}/resolve/{revision}/{name}", timeout=120) as response:
                content = response.read(32 * 1024 * 1024 + 1)
                if len(content) > 32 * 1024 * 1024:
                    raise ValueError("Model artifact exceeds size limit")
                if name == "inference.pdiparams" and hashlib.sha256(content).hexdigest() != WEIGHT_SHA256[model]:
                    raise ValueError("Model weight digest mismatch")
                (directory / name).write_bytes(content)
