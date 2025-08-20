import React, { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Group, Image as KonvaImage, Circle, Line, Rect, Text } from "react-konva";
import useImage from "use-image";
import axios from "axios";

// --------- CONFIG (no process.env here to avoid "process is not defined") ----------
const API_BASE = "https://7ca86f5c2227.ngrok-free.app";

// --------- UTILS ----------
function centroid(poly) {
  if (!poly?.length) return [0, 0];
  let sx = 0, sy = 0;
  for (const [x, y] of poly) { sx += x; sy += y; }
  return [sx / poly.length, sy / poly.length];
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// --------- APP ----------
export default function App() {
  // Session & image
  const [sessionId, setSessionId] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [imageObj] = useImage(imageUrl);

  // Modes
  const [mode, setMode] = useState(null); // 'points' | 'box' | 'draw' | 'edit' | null

  // Annotation state (image coordinates)
  const [points, setPoints] = useState([]);            // [[x,y], ...]
  const [box, setBox] = useState(null);                // {x1,y1,x2,y2}
  const [polygons, setPolygons] = useState([]);        // {id, points:[[x,y]], label, score?}
  const [currentPolygonPoints, setCurrentPolygonPoints] = useState([]);
  const [selectedPolygonId, setSelectedPolygonId] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);

  // Viewport (applied to a Group so image + annotations move/scale together)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Undo/Redo
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const saveState = () => {
    setUndoStack((st) => [
      ...st,
      {
        points: JSON.parse(JSON.stringify(points)),
        box: box ? { ...box } : null,
        polygons: JSON.parse(JSON.stringify(polygons)),
        currentPolygonPoints: JSON.parse(JSON.stringify(currentPolygonPoints)),
        selectedPolygonId,
        zoom,
        pan: { ...pan },
      },
    ]);
    setRedoStack([]);
  };

  // Messaging
  const [message, setMessage] = useState("");

  // Context menu
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0 });

  // Refs
  const stageRef = useRef(null);

  // Canvas dimensions (natural image size)
  const canvasSize = useMemo(
    () => ({ width: imageObj?.width || 1200, height: imageObj?.height || 800 }),
    [imageObj]
  );

  // ---------- Session / Upload ----------
  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);

    // show it immediately
    setImageUrl(URL.createObjectURL(file));

    // send to backend
    const formData = new FormData();
    formData.append("file", file);

    try {
      const { data } = await axios.post(`${API_BASE}/session/start`, formData);
      setSessionId(data.session_id);
      setMessage(`Session started (${data.image_size[0]}x${data.image_size[1]})`);

      // reset state
      setPoints([]); setBox(null); setPolygons([]); setCurrentPolygonPoints([]);
      setSelectedPolygonId(null); setZoom(1); setPan({ x: 0, y: 0 });
      setUndoStack([]); setRedoStack([]);
    } catch (err) {
      setMessage(`Error starting session: ${err?.response?.data?.detail || err.message}`);
    }
  };

  // ---------- Coordinate helpers with Group pan/zoom ----------
  // With Group transform, we can do simple conversions.
  const canvasToImage = (cx, cy) => {
    // reverse transform: (x',y') = scale*(x,y) + pan  =>  (x,y) = ((x'-pan)/scale)
    return [(cx - pan.x) / zoom, (cy - pan.y) / zoom];
  };

  // ---------- SAM call (single polygon, ask label) ----------
  const runSAM = async () => {
    if (!sessionId) return setMessage("Upload an image first");
    if (!points.length && !box) return setMessage("Add points or box first");

    const payload = {
      session_id: sessionId,
      points: points.length ? points : undefined,
      point_labels: points.length ? new Array(points.length).fill(1) : undefined,
      box: box ? [box.x1, box.y1, box.x2, box.y2] : undefined,
      multimask: false, // <<< only 1 mask from backend
    };

    try {
      const { data } = await axios.post(`${API_BASE}/segment`, payload);

      // choose best mask (there will be 1, but keep safe)
      let best = null;
      for (const m of data.masks) {
        if (!best || m.score > best.score) best = m;
      }

      if (!best || !best.polygons?.length) {
        setMessage("SAM returned no polygons. Try adding more clicks or a box.");
        return;
      }

      // Merge multiple contours into one by taking the largest polygon
      const polys = best.polygons.slice().sort((a, b) => area(b) - area(a));
      const chosen = polys[0];

      // Ask for label
      const label = window.prompt("Enter label for this polygon:", "Object");
      const newPoly = {
        id: `sam_${Date.now()}`,
        points: chosen,
        label: label || "Object",
        score: best.score,
      };

      saveState();
      setPolygons((prev) => [...prev, newPoly]);
      setPoints([]);
      setBox(null);
      setMessage(`Added 1 polygon (score ${best.score.toFixed(3)})`);
    } catch (err) {
      setMessage(`Error: ${err?.response?.data?.detail || err.message}`);
    }
  };

  function area(pts) {
    // polygon area (shoelace)
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s / 2);
  }

  // ---------- Interaction ----------
  const onStageMouseDown = (e) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    // pan when no mode is selected
    if (!mode) {
      setIsPanning(true);
      setPanStart({ x: pos.x, y: pos.y });
      return;
    }

    // click actions
    const [ix, iy] = canvasToImage(pos.x, pos.y);

    if (mode === "points") {
      saveState();
      setPoints((prev) => [...prev, [ix, iy]]);
    } else if (mode === "box") {
      saveState();
      if (!box) setBox({ x1: ix, y1: iy, x2: ix, y2: iy });
      else setBox((b) => ({ ...b, x2: ix, y2: iy }));
    } else if (mode === "draw") {
      saveState();
      setCurrentPolygonPoints((prev) => [...prev, [ix, iy]]);
    } else if (mode === "edit") {
      // select polygon
      const hit = polygons.find((p) => pointInPoly(ix, iy, p.points));
      setSelectedPolygonId(hit ? hit.id : null);
    }
  };

  const onStageMouseMove = (e) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    if (isPanning) {
      const dx = pos.x - panStart.x;
      const dy = pos.y - panStart.y;
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      setPanStart({ x: pos.x, y: pos.y });
      return;
    }
  };

  const onStageMouseUp = () => setIsPanning(false);

  const onDblClick = () => {
    if (mode === "draw" && currentPolygonPoints.length >= 3) {
      saveState();
      const label = window.prompt("Enter label for this polygon:", "Manual");
      setPolygons((prev) => [
        ...prev,
        { id: `manual_${Date.now()}`, points: currentPolygonPoints, label: label || "Manual" },
      ]);
      setCurrentPolygonPoints([]);
      setMode(null);
    }
  };

  const onWheel = (e) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.1;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const oldScale = zoom;
    const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;

    // keep pointer position stable
    const mousePointTo = {
      x: (pointer.x - pan.x) / oldScale,
      y: (pointer.y - pan.y) / oldScale,
    };
    setZoom(newScale);
    setPan({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  };

  // Context menu
  const onContextMenu = (e) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (pos) setCtxMenu({ visible: true, x: pos.x, y: pos.y });
  };
  useEffect(() => {
    const hide = () => setCtxMenu({ visible: false, x: 0, y: 0 });
    window.addEventListener("click", hide);
    return () => window.removeEventListener("click", hide);
  }, []);

  const deleteSelected = () => {
    if (!selectedPolygonId) return;
    saveState();
    setPolygons((prev) => prev.filter((p) => p.id !== selectedPolygonId));
    setSelectedPolygonId(null);
    setCtxMenu({ visible: false, x: 0, y: 0 });
  };

  const relabelSelected = () => {
    if (!selectedPolygonId) return;
    const label = window.prompt("New label:");
    if (!label) return;
    saveState();
    setPolygons((prev) => prev.map((p) => (p.id === selectedPolygonId ? { ...p, label } : p)));
    setCtxMenu({ visible: false, x: 0, y: 0 });
  };

  // Undo / Redo / Clear
  const undo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((st) => [
      ...st,
      { points, box, polygons, currentPolygonPoints, selectedPolygonId, zoom, pan },
    ]);
    setPoints(prev.points);
    setBox(prev.box);
    setPolygons(prev.polygons);
    setCurrentPolygonPoints(prev.currentPolygonPoints);
    setSelectedPolygonId(prev.selectedPolygonId);
    setZoom(prev.zoom);
    setPan(prev.pan);
    setUndoStack((st) => st.slice(0, -1));
  };
  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((st) => [
      ...st,
      { points, box, polygons, currentPolygonPoints, selectedPolygonId, zoom, pan },
    ]);
    setPoints(next.points);
    setBox(next.box);
    setPolygons(next.polygons);
    setCurrentPolygonPoints(next.currentPolygonPoints);
    setSelectedPolygonId(next.selectedPolygonId);
    setZoom(next.zoom);
    setPan(next.pan);
    setRedoStack((st) => st.slice(0, -1));
  };
  const clearAll = () => {
    saveState();
    setPoints([]); setBox(null); setPolygons([]); setCurrentPolygonPoints([]); setSelectedPolygonId(null);
  };

  // Export / Import
  const exportJSON = () => {
    if (!imageFile) return;
    const data = {
      image: imageFile.name,
      width: imageObj?.width || 0,
      height: imageObj?.height || 0,
      polygons: polygons.map((p) => p.points),
      labels: polygons.map((p) => p.label || "Object"),
      scores: polygons.map((p) => p.score ?? null),
    };
    download(`${imageFile.name}_annotations.json`, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  };
  const exportCOCO = () => {
    if (!imageFile) return;
    const width = imageObj?.width || 0;
    const height = imageObj?.height || 0;
    const anns = polygons.map((p, i) => {
      const xs = p.points.map((q) => q[0]);
      const ys = p.points.map((q) => q[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      return {
        id: i + 1, image_id: 1, category_id: i + 1,
        segmentation: [p.points.flat()],
        area: (maxX - minX) * (maxY - minY),
        bbox: [minX, minY, maxX - minX, maxY - minY],
        iscrowd: 0,
      };
    });
    const coco = {
      info: { description: `Annotations for ${imageFile.name}`, version: "1.0" },
      images: [{ id: 1, file_name: imageFile.name, width, height }],
      annotations: anns,
      categories: polygons.map((p, i) => ({ id: i + 1, name: p.label || "object", supercategory: "object" })),
    };
    download(`${imageFile.name}_coco.json`, new Blob([JSON.stringify(coco, null, 2)], { type: "application/json" }));
  };
  const importJSON = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!data.polygons) throw new Error("Invalid file");
      saveState();
      setPolygons(
        data.polygons.map((pts, i) => ({ id: `imp_${i}_${Date.now()}`, points: pts, label: data.labels?.[i] || `Obj_${i + 1}` }))
      );
      setMessage(`Loaded ${data.polygons.length} polygons from JSON`);
    } catch (err) {
      setMessage(`Import error: ${err.message}`);
    }
  };

  // ---------- RENDER ----------
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="px-6 py-4 border-b bg-white sticky top-0 z-10 flex items-center gap-3">
        <h1 className="text-xl font-semibold">SAM Annotation Tool</h1>
        <input type="file" accept="image/*" onChange={handleImageUpload} className="ml-4" />
        <div className="flex-1" />
        <div className="flex gap-2">
          <button className={`px-3 py-1 rounded ${mode === "points" ? "bg-blue-600 text-white" : "bg-slate-200"}`} onClick={() => setMode(mode === "points" ? null : "points")}>Point</button>
          <button className={`px-3 py-1 rounded ${mode === "box" ? "bg-blue-600 text-white" : "bg-slate-200"}`} onClick={() => setMode(mode === "box" ? null : "box")}>Box</button>
          <button className={`px-3 py-1 rounded ${mode === "draw" ? "bg-blue-600 text-white" : "bg-slate-200"}`} onClick={() => setMode(mode === "draw" ? null : "draw")}>Draw</button>
          <button className={`px-3 py-1 rounded ${mode === "edit" ? "bg-blue-600 text-white" : "bg-slate-200"}`} onClick={() => setMode(mode === "edit" ? null : "edit")}>Edit</button>
          <button className="px-3 py-1 rounded bg-emerald-600 text-white" onClick={runSAM}>Run SAM</button>
          <button className="px-3 py-1 rounded bg-slate-200" onClick={undo} disabled={!undoStack.length}>Undo</button>
          <button className="px-3 py-1 rounded bg-slate-200" onClick={redo} disabled={!redoStack.length}>Redo</button>
          <button className="px-3 py-1 rounded bg-slate-200" onClick={clearAll}>Clear</button>
          <button className="px-3 py-1 rounded bg-slate-200" onClick={exportJSON} disabled={!polygons.length}>Save JSON</button>
          <button className="px-3 py-1 rounded bg-slate-200" onClick={exportCOCO} disabled={!polygons.length}>Save COCO</button>
          <label className="px-3 py-1 rounded bg-slate-200 cursor-pointer">
            Load JSON
            <input type="file" accept=".json" className="hidden" onChange={importJSON} />
          </label>
        </div>
      </header>

      <main className="p-4">
        {message && (
          <div className="mb-3 inline-block px-3 py-2 rounded bg-amber-100 text-amber-900 border border-amber-200">{message}</div>
        )}

        <div className="relative inline-block">
          <Stage
            ref={stageRef}
            width={canvasSize.width}
            height={canvasSize.height}
            onMouseDown={onStageMouseDown}
            onMouseMove={onStageMouseMove}
            onMouseUp={onStageMouseUp}
            onDblClick={onDblClick}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
            className="bg-white shadow rounded border"
          >
            <Layer>
              {/* Apply pan & zoom to a Group so IMAGE + ALL ANNOTATIONS move together */}
              <Group x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom}>
                {/* Image in image coordinates */}
                {imageObj && <KonvaImage image={imageObj} x={0} y={0} />}

                {/* Points (image coords) */}
                {points.map(([x, y], i) => (
                  <Circle key={`pt_${i}`} x={x} y={y} radius={5 / zoom} fill="red" />
                ))}

                {/* Box (image coords) */}
                {box && (
                  <Rect
                    x={box.x1}
                    y={box.y1}
                    width={box.x2 - box.x1}
                    height={box.y2 - box.y1}
                    stroke="royalblue"
                    strokeWidth={2 / zoom}
                  />
                )}

                {/* Working polygon */}
                {currentPolygonPoints.length >= 2 && (
                  <Line
                    points={currentPolygonPoints.flat()}
                    stroke="crimson"
                    strokeWidth={2 / zoom}
                    closed={false}
                  />
                )}

                {/* Final polygons */}
                {polygons.map((poly) => {
                  const isSel = poly.id === selectedPolygonId;
                  const flat = poly.points.flat();
                  const [cx, cy] = centroid(poly.points);
                  return (
                    <React.Fragment key={poly.id}>
                      <Line
                        points={flat}
                        closed
                        stroke={isSel ? "#ef4444" : "#10b981"}
                        strokeWidth={isSel ? 3 / zoom : 2 / zoom}
                        fill={isSel ? "rgba(239,68,68,0.25)" : "rgba(16,185,129,0.2)"}
                      />
                      <Text x={cx} y={cy} text={poly.label || "Object"} fontSize={14 / zoom} fill="#111827" />
                      {mode === "edit" && isSel &&
                        poly.points.map(([x, y], i) => (
                          <Circle
                            key={`h_${poly.id}_${i}`}
                            x={x}
                            y={y}
                            radius={5 / zoom}
                            fill="#fbbf24"
                            draggable
                            onDragStart={() => setDragIdx(i)}
                            onDragMove={(e) => {
                              const ix = e.target.x();
                              const iy = e.target.y();
                              setPolygons((prev) =>
                                prev.map((p) => {
                                  if (p.id !== poly.id) return p;
                                  const pts = p.points.map((pt, idx) => (idx === i ? [ix, iy] : pt));
                                  return { ...p, points: pts };
                                })
                              );
                            }}
                            onDragEnd={() => setDragIdx(null)}
                          />
                        ))}
                    </React.Fragment>
                  );
                })}
              </Group>
            </Layer>
          </Stage>

          {/* Context Menu */}
          {ctxMenu.visible && selectedPolygonId && (
            <div
              className="absolute bg-slate-900 text-white text-sm rounded shadow-md"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <button className="block px-3 py-2 hover:bg-slate-800 w-full text-left" onClick={relabelSelected}>
                Change label
              </button>
              <button className="block px-3 py-2 hover:bg-slate-800 w-full text-left" onClick={deleteSelected}>
                Delete polygon
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="p-4 text-center text-xs text-slate-500">Backend: {API_BASE}</footer>
    </div>
  );
}