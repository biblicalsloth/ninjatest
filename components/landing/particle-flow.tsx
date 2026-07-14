"use client";

import { useEffect, useRef } from "react";

/**
 * Queue → Battle → Rank particle flow (landing only).
 * ~240 particles advected left→right through a noise field, converging on the
 * vertical center as they approach the right edge — many aspirants, one honest
 * rating. Early particles are ocean/lavender; converged particles turn mint.
 */
export function ParticleFlow({ height = 300 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    const COUNT = mobile ? 120 : 240;
    let W = 0, H = 0, raf = 0, running = false, t = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    type P = { x: number; y: number; v: number };
    let parts: P[] = [];

    function spawn(): P {
      return { x: -Math.random() * 0.2, y: Math.random(), v: 0.0016 + Math.random() * 0.0022 };
    }

    function resize() {
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      W = canvas.width; H = canvas.height;
      ctx.fillStyle = "#120F17";
      ctx.fillRect(0, 0, W, H);
      parts = Array.from({ length: COUNT }, () => {
        const p = spawn();
        p.x = Math.random(); // pre-seed across the field
        return p;
      });
    }

    function noise(x: number, y: number, time: number) {
      return (
        Math.sin(x * 7.3 + time * 0.9 + Math.sin(y * 5.1)) * 0.5 +
        Math.sin(x * 15.7 - y * 9.2 + time * 0.4) * 0.3 +
        Math.sin(y * 21.4 + time * 0.6) * 0.2
      );
    }

    function color(x: number): string {
      // ocean/lavender → mint as particles converge
      if (x < 0.45) return x % 0.1 < 0.05 ? "rgba(17,138,178,0.55)" : "rgba(159,132,189,0.45)";
      if (x < 0.75) return "rgba(6,214,160,0.4)";
      return "rgba(6,214,160,0.85)";
    }

    function frame() {
      if (!ctx) return;
      t += 0.016;
      // trail fade
      ctx.fillStyle = "rgba(18,15,23,0.08)";
      ctx.fillRect(0, 0, W, H);

      for (const p of parts) {
        const conv = Math.max(0, (p.x - 0.35) / 0.65); // 0 → free, 1 → converged
        const pull = (0.5 - p.y) * conv * 0.045;
        const drift = noise(p.x, p.y, t) * 0.004 * (1 - conv);
        p.y += drift + pull;
        p.x += p.v * (1 + conv * 0.8);
        if (p.x > 1.02) Object.assign(p, spawn());

        const px = p.x * W;
        const py = p.y * H;
        ctx.fillStyle = color(p.x);
        const s = (1 + conv * 1.5) * dpr;
        ctx.fillRect(px, py, s, s);
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (running || reduced) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    resize();
    if (reduced) {
      // static composition: draw settled trails once
      for (let k = 0; k < 220; k++) {
        t += 0.016;
        for (const p of parts) {
          const conv = Math.max(0, (p.x - 0.35) / 0.65);
          p.y += noise(p.x, p.y, t) * 0.004 * (1 - conv) + (0.5 - p.y) * conv * 0.045;
          p.x += p.v * (1 + conv * 0.8);
          if (p.x > 1.02) Object.assign(p, spawn());
          ctx.fillStyle = color(p.x);
          ctx.fillRect(p.x * W, p.y * H, dpr, dpr);
        }
      }
    }

    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);
    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="block w-full rounded-xl" style={{ height }} />;
}
