"use client";

import { useEffect, useRef } from "react";

/**
 * Mint heat-field boundary strip (landing only).
 * A low-res heat sim: a noisy boundary line feeds heat into the field, the
 * field diffuses + cools each frame, and the cursor acts as a heat brush.
 * Heat maps through a LUT ramping #120F17 → deep teal → mint → pale cyan.
 * `flipped` puts the hot edge at the top (used under the hero).
 */
export function ThermalBoundary({ flipped = false, height = 220 }: { flipped?: boolean; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const SCALE = 4; // sim cell = 4 css px
    let W = 0, H = 0, heat = new Float32Array(0), next = new Float32Array(0);
    let img: ImageData | null = null;
    let raf = 0, running = false, t = 0;
    const cursor = { x: -1, y: -1, active: false };

    /* 256-entry LUT: bg → teal-deep → mint → pale cyan, alpha follows heat */
    const STOPS: [number, number[]][] = [
      [0.0, [18, 15, 23]],
      [0.35, [7, 59, 76]],
      [0.72, [6, 214, 160]],
      [1.0, [197, 232, 240]],
    ];
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let a = STOPS[0], b = STOPS[STOPS.length - 1];
      for (let s = 0; s < STOPS.length - 1; s++) {
        if (v >= STOPS[s][0] && v <= STOPS[s + 1][0]) { a = STOPS[s]; b = STOPS[s + 1]; break; }
      }
      const f = (v - a[0]) / (b[0] - a[0] || 1);
      lut[i * 4] = a[1][0] + (b[1][0] - a[1][0]) * f;
      lut[i * 4 + 1] = a[1][1] + (b[1][1] - a[1][1]) * f;
      lut[i * 4 + 2] = a[1][2] + (b[1][2] - a[1][2]) * f;
      lut[i * 4 + 3] = Math.min(255, i * 2.4);
    }

    function resize() {
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(2, Math.floor(rect.width / SCALE));
      canvas.height = Math.max(2, Math.floor(rect.height / SCALE));
      W = canvas.width; H = canvas.height;
      heat = new Float32Array(W * H);
      next = new Float32Array(W * H);
      img = ctx.createImageData(W, H);
    }

    /* cheap layered sine noise for the boundary line */
    function boundary(x: number, time: number) {
      return (
        Math.sin(x * 0.055 + time * 0.7) * 0.35 +
        Math.sin(x * 0.13 - time * 0.43) * 0.22 +
        Math.sin(x * 0.021 + time * 0.21) * 0.43
      );
    }

    function step() {
      t += 0.016;
      const bndBase = flipped ? H * 0.18 : H * 0.82;
      const amp = H * 0.14;

      // source: heat injected along the noisy boundary, hotter toward the solid edge
      for (let x = 0; x < W; x++) {
        const by = bndBase + boundary(x, t) * amp;
        for (let y = 0; y < H; y++) {
          const d = flipped ? by - y : y - by; // >0 = inside the solid side
          if (d > -3) {
            const i = y * W + x;
            const target = Math.min(1, 0.55 + d * 0.06);
            if (heat[i] < target) heat[i] += (target - heat[i]) * 0.25;
          }
        }
      }

      // cursor brush
      if (cursor.active) {
        const r = 9;
        const cx = cursor.x, cy = cursor.y;
        for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
          for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
            const dx = x - cx, dy = y - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 < r * r) heat[y * W + x] = Math.min(1, heat[y * W + x] + 0.5 * (1 - d2 / (r * r)));
          }
        }
      }

      // diffuse + cool
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const l = heat[y * W + Math.max(0, x - 1)];
          const rr = heat[y * W + Math.min(W - 1, x + 1)];
          const u = heat[Math.max(0, y - 1) * W + x];
          const dn = heat[Math.min(H - 1, y + 1) * W + x];
          next[i] = (heat[i] * 4 + l + rr + u + dn) * 0.125 * 0.985;
        }
      }
      [heat, next] = [next, heat];
    }

    function render() {
      if (!ctx || !img) return;
      const d = img.data;
      for (let i = 0; i < W * H; i++) {
        const v = Math.max(0, Math.min(255, (heat[i] * 255) | 0));
        d[i * 4] = lut[v * 4];
        d[i * 4 + 1] = lut[v * 4 + 1];
        d[i * 4 + 2] = lut[v * 4 + 2];
        d[i * 4 + 3] = lut[v * 4 + 3];
      }
      ctx.putImageData(img, 0, 0);
    }

    function loop() {
      step();
      render();
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (running || reduced) return;
      running = true;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    resize();
    if (reduced) {
      // static frame: settle the sim without animating
      for (let k = 0; k < 40; k++) step();
      render();
    }

    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursor.x = Math.floor((e.clientX - rect.left) / SCALE);
      cursor.y = Math.floor((e.clientY - rect.top) / SCALE);
      cursor.active = cursor.y >= 0 && cursor.y < H;
    };
    const onLeave = () => { cursor.active = false; };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [flipped]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="block w-full"
      style={{ height, imageRendering: "auto" }}
    />
  );
}
