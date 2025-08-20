import React, { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Group, Image as KonvaImage, Circle, Line, Rect, Text } from "react-konva";
import useImage from "use-image";
import axios from "axios";
import frontImage from "./assets/front_image.jpeg";

// --------- CONFIG (no process.env here to avoid "process is not defined") ----------
const API_BASE = (window && window.API_BASE) || "http://localhost:8000";

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

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [password, setPassword] = useState("");

   const [images, setImages] = useState([]);
  const [annotations, setAnnotations] = useState([]);
  const canvasRef = useRef();

  
    // Session & image
  const [sessionId, setSessionId] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [imageObj] = useImage(imageUrl);

  // Modes
  const [mode, setMode] = useState(null); // 'points' | 'edit' | null (removed 'box' and 'draw')

  // Annotation state (image coordinates)
  const [points, setPoints] = useState([]);            // [[x,y], ...]
  const [polygons, setPolygons] = useState([]);        // {id, points:[[x,y]], label, score?}
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
        polygons: JSON.parse(JSON.stringify(polygons)),
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
  const containerRef = useRef(null);

  // Dynamic stage size for responsiveness
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const resize = () => {
      if (containerRef.current) {
        setStageSize({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    window.addEventListener("resize", resize);
    resize();
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Auto-fit image on load or stage resize
  useEffect(() => {
    if (imageObj) {
      const scale = Math.min(stageSize.width / imageObj.width, stageSize.height / imageObj.height, 1); // max 1x
      setZoom(scale);
      setPan({
        x: (stageSize.width - imageObj.width * scale) / 2,
        y: (stageSize.height - imageObj.height * scale) / 2,
      });
    }
  }, [imageObj, stageSize]);

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
      setPoints([]); setPolygons([]); 
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
    if (!points.length) return setMessage("Add points first");

    const payload = {
      session_id: sessionId,
      points: points.length ? points : undefined,
      point_labels: points.length ? new Array(points.length).fill(1) : undefined,
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
        setMessage("SAM returned no polygons. Try adding more clicks.");
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
      { points, polygons, selectedPolygonId, zoom, pan },
    ]);
    setPoints(prev.points);
    setPolygons(prev.polygons);
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
      { points, polygons, selectedPolygonId, zoom, pan },
    ]);
    setPoints(next.points);
    setPolygons(next.polygons);
    setSelectedPolygonId(next.selectedPolygonId);
    setZoom(next.zoom);
    setPan(next.pan);
    setRedoStack((st) => st.slice(0, -1));
  };
  const clearAll = () => {
    saveState();
    setPoints([]); setPolygons([]); setSelectedPolygonId(null);
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

  // Example effect (runs always, no matter login state)
  useEffect(() => {
    console.log("App mounted");
  }, []);

  // 🔹 Login handler
  const handleLogin = async () => {
    try {
      const res = await axios.post(`${API_BASE}/auth`, { password });
      if (res.data.ok) {
        setIsLoggedIn(true);
      } else {
        alert("Wrong password!");
      }
    } catch {
      alert("Login error");
    }
  };

  // 🔹 Logout
  const handleLogout = () => {
    setIsLoggedIn(false);
    setPassword("");
  };
  // ---------- RENDER ----------
  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 flex flex-col font-sans">
      {!isLoggedIn ? (
        // ------------------- LOGIN SCREEN -------------------
        <div className="flex items-center justify-center h-screen bg-gray-100">
          <div className="p-6 bg-white rounded-2xl shadow-md w-80">
            <h2 className="text-xl mb-4 font-bold">🔑 Login</h2>
            <input
              type="password"
              id="password-input" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="border p-2 rounded w-full mb-3"
            />
            <button
  onClick={handleLogin}
  className="w-full bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 transition-colors"
>
  Login
</button>
          </div>
        </div>
      ) : (
        <>
      <header className="px-6 py-4 border-b bg-white shadow-sm sticky top-0 z-10 flex items-center justify-center">
        {!imageUrl && (
          <label className="w-64 h-32 flex flex-col items-center justify-center border-2 border-dashed border-gray-400 rounded-lg cursor-pointer hover:border-blue-500 transition-colors">
            <span className="text-gray-600">📂 Upload Image</span>
            <span className="text-xs text-gray-400">(click to select)</span>
            <input type="file" id="image-upload-header" accept="image/*" onChange={handleImageUpload} className="hidden" />
          </label>
        )}
      </header> 
        <main
          className="flex-1 flex flex-col bg-cover bg-center"
          // style={{ backgroundImage: !imageUrl ? "url('/front_image.png')" : "none" }}
          style={{ backgroundImage: !imageUrl ? `url(${frontImage})` : "none" }}
        >
        {imageUrl && (
          <>
            <div className="bg-white shadow-sm p-2 flex justify-center gap-2 flex-wrap">
              <label className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 cursor-pointer text-sm text-gray-700 transition-colors">
                <span>Upload New Image</span>
                <input type="file" id="image-upload-toolbar" accept="image/*" onChange={handleImageUpload} className="hidden" />
              </label>
              <button
                className={`flex items-center justify-center px-3 py-1 rounded text-sm transition-colors ${mode === "points" ? "bg-cyan-500 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}
                onClick={() => setMode(mode === "points" ? null : "points")}
              >
                <span className="mr-2">📍</span> Select the Object
              </button>
              <button
                className={`flex items-center justify-center px-3 py-1 rounded text-sm transition-colors ${mode === "edit" ? "bg-cyan-500 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}
                onClick={() => setMode(mode === "edit" ? null : "edit")}
              >
                <span className="mr-2">🖌️</span> Edit
              </button>
              <button className="flex items-center justify-center px-3 py-1 rounded bg-emerald-600 text-white text-sm hover:bg-emerald-700 transition-colors" onClick={runSAM}>
                <span className="mr-2">🔍</span> Detect Polygon
              </button>
              <button className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm hover:bg-gray-300 transition-colors" onClick={undo} disabled={!undoStack.length}>
                <span className="mr-2">↩️</span> Undo
              </button>
              <button className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm hover:bg-gray-300 transition-colors" onClick={redo} disabled={!redoStack.length}>
                <span className="mr-2">↪️</span> Redo
              </button>
              <button className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm hover:bg-gray-300 transition-colors" onClick={clearAll}>
                <span className="mr-2">🗑️</span> Clear
              </button>
              <button className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm hover:bg-gray-300 transition-colors" onClick={exportJSON} disabled={!polygons.length}>
                <span className="mr-2">💾</span> Save JSON
              </button>
              <button className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm hover:bg-gray-300 transition-colors" onClick={exportCOCO} disabled={!polygons.length}>
                <span className="mr-2">💾</span> Save COCO
              </button>
              <label className="flex items-center justify-center px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 cursor-pointer text-sm text-gray-700 transition-colors">
                <span>Load JSON</span>
                <input type="file" accept=".json" className="hidden" onChange={importJSON} />
              </label>
            </div>
            <div ref={containerRef} className="flex-1 relative bg-white overflow-hidden stage-container">
              <Stage
                ref={stageRef}
                width={stageSize.width}
                height={stageSize.height}
                onMouseDown={onStageMouseDown}
                onMouseMove={onStageMouseMove}
                onMouseUp={onStageMouseUp}
                onWheel={onWheel}
                onContextMenu={onContextMenu}
                className="touch-action-manipulation"
              >
                <Layer>
                  <Group x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom}>
                    {imageObj && <KonvaImage image={imageObj} x={0} y={0} />}
                    {/* Points */}
                    {points.map((pt, i) => (
                      <Circle key={i} x={pt[0]} y={pt[1]} radius={5 / zoom} fill="red" />
                    ))}
                    {/* Polygons */}
                    {polygons.map((poly) => {
                      const isSelected = poly.id === selectedPolygonId;
                      const flatPoints = poly.points.flat();
                      const [cx, cy] = centroid(poly.points);
                      return (
                        <Group key={poly.id}>
                          <Line
                            points={flatPoints}
                            closed
                            fill="rgba(0,255,0,0.2)"
                            stroke={isSelected ? "blue" : "green"}
                            strokeWidth={2 / zoom}
                          />
                          {isSelected &&
                            poly.points.map((pt, idx) => (
                              <Circle
                                key={idx}
                                x={pt[0]}
                                y={pt[1]}
                                radius={5 / zoom}
                                fill="blue"
                                draggable
                                onDragStart={() => setDragIdx(idx)}
                                onDragMove={(e) => {
                                  const newPoints = [...poly.points];
                                  newPoints[idx] = [e.target.x(), e.target.y()];
                                  setPolygons((prev) =>
                                    prev.map((p) => (p.id === poly.id ? { ...p, points: newPoints } : p))
                                  );
                                }}
                                onDragEnd={saveState}
                              />
                            ))}
                          <Text
                            x={cx}
                            y={cy}
                            text={poly.label || "Obj"}
                            fontSize={16 / zoom}
                            fill="black"
                          />
                        </Group>
                      );
                    })}
                  </Group>
                </Layer>
              </Stage>

              {ctxMenu.visible && selectedPolygonId && (
                <div
                  className="absolute bg-gray-900 text-white text-sm rounded shadow-lg"
                  style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                  <button className="block px-3 py-2 hover:bg-gray-800 w-full text-left" onClick={relabelSelected}>
                    Change label
                  </button>
                  <button className="block px-3 py-2 hover:bg-gray-800 w-full text-left" onClick={deleteSelected}>
                    Delete polygon
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      <footer className="p-4 text-center text-sm text-gray-500 bg-white border-t">
        
      </footer>
      </>
      )}
    </div>
  );
}