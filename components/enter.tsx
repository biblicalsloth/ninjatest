"use client";

import { useRef, type ReactNode } from "react";
import { useGSAP, enterUp, prefersReduced } from "@/lib/motion";

/** Staggers its direct children in on mount — the shared page-enter
 * transition. Wrap RSC content in this instead of converting the page to a
 * client component. Renders a plain div; motion-only. */
export function Enter({ children, className }: { children: ReactNode; className?: string }) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (prefersReduced() || !scope.current) return;
      enterUp(scope.current.children);
    },
    { scope }
  );
  return (
    <div ref={scope} className={className}>
      {children}
    </div>
  );
}
