"use client";

// Top-3 celebration confetti — hand-rolled on a <canvas>, no external
// dependency (a confetti lib that touches `window` at import time breaks the
// leaderboard's server render). It is deliberately timeboxed: a burst fires
// once on mount, runs for a few seconds, then the animation stops and the
// canvas is cleared. The board's real signal is always the static rank +
// movement arrows underneath — the confetti is pure garnish and its absence
// (reduced-motion, no canvas, SSR) costs nothing.

import { useEffect, useRef } from "react";

const DURATION_MS = 4500;
const GRAVITY = 0.045;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vrot: number;
  colour: string;
};

export default function LeaderboardConfetti({ accent }: { accent: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Honour reduced-motion: no burst at all.
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // The tenant accent leads; the rest are hue-rotations of it plus a light
    // fleck, all as hsl() strings so no hex literal lives in this file.
    const palette = [accent, "hsl(45 95% 60%)", "hsl(150 70% 55%)", "hsl(0 0% 100%)"];
    const w = () => canvas.clientWidth;
    const count = Math.min(160, Math.max(70, Math.round(w() / 8)));
    const particles: Particle[] = Array.from({ length: count }, () => ({
      x: Math.random() * w(),
      y: -20 - Math.random() * canvas.clientHeight * 0.4,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 1 + Math.random() * 2.5,
      size: 5 + Math.random() * 7,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.25,
      colour: palette[Math.floor(Math.random() * palette.length)],
    }));

    const start = performance.now();
    let raf = 0;

    const frame = (t: number) => {
      const elapsed = t - start;
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      const fade = elapsed > DURATION_MS - 900 ? Math.max(0, (DURATION_MS - elapsed) / 900) : 1;

      for (const p of particles) {
        p.vy += GRAVITY;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }

      if (elapsed < DURATION_MS) {
        raf = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [accent]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 h-full w-full"
    />
  );
}
