import os
import io
import uuid
import tempfile
from typing import List, Optional, Dict, Any

import torch
import numpy as np
import cv2
from PIL import Image
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from segment_anything import sam_model_registry, SamPredictor

# -------------------------
# Passwords
# -------------------------
PASSWORDS = ["pass1", "pass2", "pass3", "pass4"]  # rotate list
current_index = 0


# -------------------------
# FastAPI app & CORS
# -------------------------
app = FastAPI(title="SAM Segmentation Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Temp folder for images
# -------------------------
UPLOAD_DIR = tempfile.mkdtemp(prefix="sam_uploads_")
print(f"[INFO] Upload directory: {UPLOAD_DIR}")

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# -------------------------
# Model load
# -------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CHECKPOINT_PATH = os.path.join(BASE_DIR, "../checkpoints", "sam_vit_h_4b8939.pth")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

torch.set_grad_enabled(False)

try:
    sam = sam_model_registry["vit_h"](checkpoint=CHECKPOINT_PATH)
    sam.to(device=DEVICE)
except Exception as e:
    raise RuntimeError(f"Failed to load SAM model from {CHECKPOINT_PATH}: {e}")

# -------------------------
# Session cache
# -------------------------
_sessions: Dict[str, Dict[str, Any]] = {}


def _to_np_image(file_bytes: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    return np.array(img)


def _mask_to_polygons(mask: np.ndarray, simplify_eps: float = 1.5, min_area_px: int = 150) -> List[List[List[float]]]:
    """
    Convert a boolean mask to polygons. Apply light morphology and area filter.
    Returns list of polygons [[[x,y], ...], ...].
    """
    mask_u8 = (mask.astype(np.uint8) * 255)

    # morphology (clean small speckles)
    kernel = np.ones((3, 3), np.uint8)
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys: List[List[List[float]]] = []
    for cnt in contours:
        if cv2.contourArea(cnt) < min_area_px:
            continue
        if simplify_eps > 0:
            cnt = cv2.approxPolyDP(cnt, epsilon=simplify_eps, closed=True)
        pts = cnt.reshape(-1, 2).astype(float).tolist()
        if len(pts) >= 3:
            polys.append(pts)

    # Sort by area descending (largest first)
    polys.sort(key=lambda poly: cv2.contourArea(np.array(poly, dtype=np.float32)), reverse=True)
    return polys


# -------------------------
# Pydantic models
# -------------------------
class SegmentRequest(BaseModel):
    session_id: str
    points: Optional[List[List[float]]] = None
    point_labels: Optional[List[int]] = None
    box: Optional[List[float]] = None
    multimask: bool = True


# -------------------------
# API endpoints
# -------------------------
@app.get("/health")
async def health():
    info = {"status": "ok", "device": DEVICE}
    if DEVICE == "cuda":
        try:
            info["cuda_device_name"] = torch.cuda.get_device_name(0)
        except Exception:
            pass
    return info

from fastapi import Request

@app.post("/auth")
async def auth(data: Dict[str, str]):
    global current_index
    password = data.get("password")
    if password == PASSWORDS[current_index]:
        # Rotate password (next one in list)
        current_index = (current_index + 1) % len(PASSWORDS)
        return {"ok": True}
    raise HTTPException(status_code=401, detail="Invalid password")


@app.post("/session/start")
async def start_session(file: UploadFile = File(...)):
    """Upload an image, cache its embedding, return session_id & image URL."""
    try:
        contents = await file.read()
        img_np = _to_np_image(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    # Save image to debug folder
    ext = os.path.splitext(file.filename)[1] or ".jpg"
    img_filename = f"{uuid.uuid4().hex}{ext}"
    img_path = os.path.join(UPLOAD_DIR, img_filename)
    with open(img_path, "wb") as f:
        f.write(contents)

    # Create predictor
    predictor = SamPredictor(sam)
    predictor.set_image(img_np)

    session_id = str(uuid.uuid4())
    _sessions[session_id] = {
        "predictor": predictor,
        "image_size": [int(img_np.shape[1]), int(img_np.shape[0])],
        "image_url": f"/uploads/{img_filename}"
    }

    return {
        "session_id": session_id,
        "image_size": _sessions[session_id]["image_size"],
        "image_url": _sessions[session_id]["image_url"]
    }


@app.post("/segment")
async def segment(req: SegmentRequest):
    """Predict polygons from clicks/box for a cached session image."""
    sess = _sessions.get(req.session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Invalid session_id. Please start a session first.")

    predictor: SamPredictor = sess["predictor"]

    point_coords = None
    point_labels = None
    if req.points:
        point_coords = np.array(req.points, dtype=np.float32)
        if req.point_labels and len(req.point_labels) == len(req.points):
            point_labels = np.array(req.point_labels, dtype=np.int32)
        else:
            point_labels = np.ones((len(req.points),), dtype=np.int32)

    box_np = None
    if req.box:
        if len(req.box) != 4:
            raise HTTPException(status_code=400, detail="box must be [x1,y1,x2,y2]")
        box_np = np.array(req.box, dtype=np.float32).reshape(1, 4)

    try:
        masks, scores, _ = predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box_np,
            multimask_output=req.multimask,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SAM prediction failed: {e}")

    out = []
    for m, s in zip(masks, scores):
        polys = _mask_to_polygons(m)
        out.append({
            "score": float(s),
            "polygons": polys
        })

    return {
        "image_size": sess["image_size"],
        "num_masks": len(out),
        "masks": out
    }


@app.post("/session/end")
async def end_session(session_id: str = Body(..., embed=True)):
    if session_id in _sessions:
        del _sessions[session_id]
        return {"status": "ended"}
    raise HTTPException(status_code=404, detail="Invalid session_id")
