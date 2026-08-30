import asyncio
import io
import os
import secrets
import sys
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict, List, Optional

import cv2
import numpy as np
import torch
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from PIL import Image
from pydantic import BaseModel

from dotenv import load_dotenv
from segment_anything import SamPredictor, sam_model_registry
from ultralytics import YOLO

# Loads backend/.env if present. Doesn't override a var already set in the
# real environment (e.g. by `export` or a process manager) -- .env is a
# convenience default, not an authority over an explicit shell export.
load_dotenv()


def _log(msg: str) -> None:
    # stdout is block-buffered when redirected to a file/log; flush so
    # startup warnings are actually visible instead of sitting in a buffer.
    print(msg, flush=True)


# -------------------------
# Auth
# -------------------------
AUTH_PASSWORD = os.environ.get("ANNOTATE_PASSWORD")
SESSION_TTL_SECONDS = int(os.environ.get("ANNOTATE_SESSION_TTL", "1800"))  # 30 min
AUTH_RATE_LIMIT = 10          # max attempts
AUTH_RATE_WINDOW = 60         # per this many seconds, per client IP

if not AUTH_PASSWORD:
    sys.exit(
        "ANNOTATE_PASSWORD is not set. Refusing to start.\n"
        "Generate one:  export ANNOTATE_PASSWORD=$(openssl rand -base64 24)"
    )

_valid_tokens: set = set()
_auth_attempts: Dict[str, Deque[float]] = defaultdict(deque)

bearer_scheme = HTTPBearer(auto_error=False)


def _check_rate_limit(client_ip: str) -> None:
    now = time.time()
    attempts = _auth_attempts[client_ip]
    while attempts and now - attempts[0] > AUTH_RATE_WINDOW:
        attempts.popleft()
    if len(attempts) >= AUTH_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    attempts.append(now)


def require_auth(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)) -> None:
    if not creds or creds.credentials not in _valid_tokens:
        raise HTTPException(status_code=401, detail="Missing or invalid auth token")


# -------------------------
# FastAPI app & CORS
# -------------------------
app = FastAPI(title="SAM Segmentation Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Model load
# -------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_TYPE = os.environ.get("ANNOTATE_MODEL_TYPE", "vit_h")
CHECKPOINT_PATH = os.environ.get(
    "ANNOTATE_CHECKPOINT",
    os.path.join(BASE_DIR, "..", "checkpoints", "sam_vit_h_4b8939.pth"),
)


def _select_device(preferred: str) -> str:
    """
    torch.cuda.is_available() only checks that a CUDA driver/device is present,
    not that this PyTorch build ships kernels for the device's compute capability
    (e.g. a too-new GPU with an older torch CUDA wheel). Actually run a tiny op
    to confirm the device works before committing to it, so a mismatch degrades
    to CPU instead of crashing every request with a raw CUDA error.
    """
    if preferred == "cpu":
        return "cpu"
    if not torch.cuda.is_available():
        if preferred == "cuda":
            _log("[WARN] ANNOTATE_DEVICE=cuda requested but no CUDA device is visible; using CPU.")
        return "cpu"
    try:
        probe = torch.nn.Conv2d(3, 3, 3).to("cuda")
        probe(torch.zeros(1, 3, 8, 8, device="cuda"))
        return "cuda"
    except RuntimeError as e:
        _log(
            f"[WARN] CUDA device detected but unusable with this PyTorch build ({e}). "
            "Falling back to CPU. Install a PyTorch build matching your GPU/CUDA driver "
            "from https://pytorch.org/get-started/locally/, or set ANNOTATE_DEVICE=cpu "
            "to silence this check."
        )
        return "cpu"


DEVICE = _select_device(os.environ.get("ANNOTATE_DEVICE", "auto"))

torch.set_grad_enabled(False)

try:
    sam = sam_model_registry[MODEL_TYPE](checkpoint=CHECKPOINT_PATH)
    sam.to(device=DEVICE)
except Exception as e:
    raise RuntimeError(f"Failed to load SAM model from {CHECKPOINT_PATH}: {e}")

# -------------------------
# Base detector ("base run"): an optional first pass that proposes objects
# before the user annotates by hand. Swappable via env var -- defaults to a
# small pretrained YOLO (auto-downloaded by ultralytics) so the feature works
# out of the box; point ANNOTATE_BASE_MODEL at your own trained .pt weights
# to use a domain-specific detector instead. Soft-fails (feature just becomes
# unavailable) rather than blocking startup, since SAM's manual annotation
# flow is the core feature and shouldn't depend on this loading successfully.
# -------------------------
BASE_MODEL_PATH = os.environ.get("ANNOTATE_BASE_MODEL", os.path.join(BASE_DIR, "yolov8n.pt"))
BASE_MODEL_CONF = float(os.environ.get("ANNOTATE_BASE_MODEL_CONF", "0.25"))
BASE_MODEL_MAX_DETECTIONS = int(os.environ.get("ANNOTATE_BASE_MODEL_MAX_DETECTIONS", "50"))

try:
    base_model = YOLO(BASE_MODEL_PATH)
    _log(f"[INFO] Base detector loaded: {BASE_MODEL_PATH}")
except Exception as e:
    base_model = None
    _log(f"[WARN] Base detector failed to load ({e}). /base_run will return 503 until this is fixed.")


def _yolo_boxes_refined_by_sam(img_np: np.ndarray, predictor: "SamPredictor") -> List[Dict[str, Any]]:
    """Run the base detector, then refine each box into a pixel-accurate
    polygon by feeding it to SAM as a box prompt (reuses the predictor's
    already-computed image embedding -- no extra SAM image preprocessing)."""
    results = base_model.predict(img_np, conf=BASE_MODEL_CONF, device=DEVICE, verbose=False)[0]
    boxes = results.boxes
    if boxes is None or len(boxes) == 0:
        return []

    order = boxes.conf.argsort(descending=True)[:BASE_MODEL_MAX_DETECTIONS]

    detections: List[Dict[str, Any]] = []
    for i in order.tolist():
        xyxy = boxes.xyxy[i].tolist()
        conf = float(boxes.conf[i])
        cls_id = int(boxes.cls[i])
        label = base_model.names.get(cls_id, str(cls_id))

        box_np = np.array(xyxy, dtype=np.float32).reshape(1, 4)
        try:
            masks, scores, _ = predictor.predict(box=box_np, multimask_output=False)
        except Exception:
            continue
        polys = _mask_to_polygons(masks[0])
        if not polys:
            continue
        detections.append({"label": label, "score": conf, "polygon": polys[0]})

    return detections


# -------------------------
# Session cache (in-memory, evicted after SESSION_TTL_SECONDS of inactivity)
# -------------------------
_sessions: Dict[str, Dict[str, Any]] = {}


def _touch_session(session_id: str) -> None:
    _sessions[session_id]["last_used"] = time.time()


async def _evict_expired_sessions() -> None:
    while True:
        await asyncio.sleep(60)
        now = time.time()
        expired = [sid for sid, s in _sessions.items() if now - s["last_used"] > SESSION_TTL_SECONDS]
        for sid in expired:
            del _sessions[sid]
        if expired:
            _log(f"[INFO] Evicted {len(expired)} expired session(s)")


@app.on_event("startup")
async def _start_background_tasks() -> None:
    asyncio.create_task(_evict_expired_sessions())


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


class AuthRequest(BaseModel):
    password: str


class EndSessionRequest(BaseModel):
    session_id: str


class BaseRunRequest(BaseModel):
    session_id: str


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


@app.post("/auth")
async def auth(data: AuthRequest, request: Request):
    _check_rate_limit(request.client.host if request.client else "unknown")
    if not secrets.compare_digest(data.password, AUTH_PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid password")
    token = secrets.token_urlsafe(32)
    _valid_tokens.add(token)
    return {"ok": True, "token": token}


@app.post("/session/start", dependencies=[Depends(require_auth)])
async def start_session(file: UploadFile = File(...)):
    """Upload an image, cache its embedding, return session_id."""
    try:
        contents = await file.read()
        img_np = _to_np_image(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    predictor = SamPredictor(sam)
    predictor.set_image(img_np)

    session_id = str(secrets.token_hex(16))
    _sessions[session_id] = {
        "predictor": predictor,
        "image_np": img_np,
        "image_size": [int(img_np.shape[1]), int(img_np.shape[0])],
        "last_used": time.time(),
    }

    return {
        "session_id": session_id,
        "image_size": _sessions[session_id]["image_size"],
    }


@app.post("/segment", dependencies=[Depends(require_auth)])
async def segment(req: SegmentRequest):
    """Predict polygons from clicks/box for a cached session image."""
    sess = _sessions.get(req.session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Invalid session_id. Please start a session first.")
    _touch_session(req.session_id)

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


@app.post("/base_run", dependencies=[Depends(require_auth)])
async def base_run(req: BaseRunRequest):
    """Run the base detector on the session's image and refine each detected
    box into a polygon via SAM, so the user starts from proposals instead of
    a blank canvas."""
    if base_model is None:
        raise HTTPException(status_code=503, detail="Base detector is not loaded on this server.")

    sess = _sessions.get(req.session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Invalid session_id. Please start a session first.")
    _touch_session(req.session_id)

    try:
        detections = _yolo_boxes_refined_by_sam(sess["image_np"], sess["predictor"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Base run failed: {e}")

    return {
        "image_size": sess["image_size"],
        "detections": detections,
    }


@app.post("/session/end", dependencies=[Depends(require_auth)])
async def end_session(req: EndSessionRequest):
    if req.session_id in _sessions:
        del _sessions[req.session_id]
        return {"status": "ended"}
    raise HTTPException(status_code=404, detail="Invalid session_id")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
