"use client";

import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import { Eraser } from "lucide-react";

export type SignaturePadHandle = {
  clear: () => void;
  isEmpty: () => boolean;
  getDataUrl: () => string;
};

type Props = {
  height?: number;
  strokeColor?: string;
  background?: string;
  baselineColor?: string;
  onChange?: (empty: boolean) => void;
};

const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad(
  {
    height = 180,
    strokeColor = "#0a0b0e",
    background = "#ffffff",
    baselineColor = "rgba(10, 11, 14, 0.18)",
    onChange,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const dprRef = useRef(1);
  const [empty, setEmpty] = useState(true);

  function setEmptyAndNotify(value: boolean) {
    setEmpty(value);
    onChange?.(value);
  }

  function paintBackground() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function setupCanvas() {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    const rect = container.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
    }
    paintBackground();
  }

  useEffect(() => {
    setupCanvas();
    function onResize() {
      setupCanvas();
      // After resize the canvas is cleared; treat as empty
      setEmptyAndNotify(true);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function localPoint(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = localPoint(e);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const last = lastPointRef.current;
    const cur = localPoint(e);
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.stroke();
    }
    lastPointRef.current = cur;
    if (empty) setEmptyAndNotify(false);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    lastPointRef.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        paintBackground();
      }
      setEmptyAndNotify(true);
    },
    isEmpty: () => empty,
    getDataUrl: () => canvasRef.current?.toDataURL("image/png") ?? "",
  }), [empty]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="relative w-full rounded-xl overflow-hidden border"
        style={{ borderColor: "rgba(0,0,0,0.15)", background }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="block touch-none cursor-crosshair"
          style={{ width: "100%", height }}
          aria-label="Signature canvas"
        />
        <div
          className="pointer-events-none absolute left-4 right-4"
          style={{ bottom: 28, height: 1, background: baselineColor }}
        />
        {empty && (
          <p
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-xs uppercase tracking-wider"
            style={{ bottom: 12, color: "rgba(0,0,0,0.4)" }}
          >
            Sign here
          </p>
        )}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
          {empty ? "Draw your signature above" : "Tap Clear to redraw"}
        </p>
        <button
          type="button"
          onClick={() => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            if (canvas && ctx) {
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.restore();
              paintBackground();
            }
            setEmptyAndNotify(true);
          }}
          disabled={empty}
          className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            color: empty ? "rgba(255,255,255,0.4)" : "#ef4444",
            borderColor: empty ? "rgba(255,255,255,0.12)" : "rgba(239,68,68,0.4)",
            background: empty ? "rgba(255,255,255,0.02)" : "rgba(239,68,68,0.08)",
          }}
          aria-label="Clear signature"
        >
          <Eraser className="w-3.5 h-3.5" />
          Clear
        </button>
      </div>
    </div>
  );
});

export default SignaturePad;
