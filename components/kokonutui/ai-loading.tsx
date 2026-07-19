"use client";

/**
 * @author: @kokonutui
 * @description: AI Loading State
 * @version: 1.0.0
 * @date: 2025-06-26
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 */

import { useEffect, useRef, useState } from "react";

// Ninja-flavored sequences mirroring what the coach route actually does
// (tool calls over the caller's stats), in brand voice.
const TASK_SEQUENCES = [
  {
    status: "Reading your stats",
    lines: [
      "Pulling your rating curve...",
      "Checking section accuracy...",
      "Scanning recent matches...",
      "Measuring speed vs accuracy...",
      "Spotting weak areas...",
    ],
  },
  {
    status: "Crunching the numbers",
    lines: [
      "Comparing VARC / DILR / Quant...",
      "Weighing time per question...",
      "Reviewing recent mistakes...",
      "Ranking what to fix first...",
      "Drafting the answer...",
    ],
  },
];

const LoadingAnimation = ({ progress }: { progress: number }) => (
  <div className="relative h-6 w-6">
    <svg
      aria-label={`Loading progress: ${Math.round(progress)}%`}
      className="h-full w-full"
      fill="none"
      viewBox="0 0 240 240"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Loading Progress Indicator</title>

      <defs>
        <mask id="progress-mask">
          <rect fill="black" height="240" width="240" />
          <circle
            cx="120"
            cy="120"
            fill="white"
            r="120"
            strokeDasharray={`${(progress / 100) * 754}, 754`}
            transform="rotate(-90 120 120)"
          />
        </mask>
      </defs>

      <style>
        {`
                    @keyframes rotate-cw {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                    @keyframes rotate-ccw {
                        from { transform: rotate(360deg); }
                        to { transform: rotate(0deg); }
                    }
                    .g-spin circle {
                        transform-origin: 120px 120px;
                    }
                    .g-spin circle:nth-child(1) { animation: rotate-cw 8s linear infinite; }
                    .g-spin circle:nth-child(2) { animation: rotate-ccw 8s linear infinite; }
                    .g-spin circle:nth-child(3) { animation: rotate-cw 8s linear infinite; }
                    .g-spin circle:nth-child(4) { animation: rotate-ccw 8s linear infinite; }
                    .g-spin circle:nth-child(5) { animation: rotate-cw 8s linear infinite; }
                    .g-spin circle:nth-child(6) { animation: rotate-ccw 8s linear infinite; }

                    .g-spin circle:nth-child(2n) { animation-delay: 0.2s; }
                    .g-spin circle:nth-child(3n) { animation-delay: 0.3s; }
                `}
      </style>

      <g
        className="g-spin"
        mask="url(#progress-mask)"
        strokeDasharray="18% 40%"
        strokeWidth="16"
      >
        <circle cx="120" cy="120" opacity="0.95" r="150" stroke="#06d6a0" />
        <circle cx="120" cy="120" opacity="0.95" r="130" stroke="#ffd166" />
        <circle cx="120" cy="120" opacity="0.95" r="110" stroke="#7ab5cc" />
        <circle cx="120" cy="120" opacity="0.95" r="90" stroke="#ef476f" />
        <circle cx="120" cy="120" opacity="0.95" r="70" stroke="#06d6a0" />
        <circle cx="120" cy="120" opacity="0.95" r="50" stroke="#ffd166" />
      </g>
    </svg>
  </div>
);

export default function AILoadingState() {
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [visibleLines, setVisibleLines] = useState<
    Array<{ text: string; number: number }>
  >([]);
  const [scrollPosition, setScrollPosition] = useState(0);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const lineHeight = 28;

  const currentSequence = TASK_SEQUENCES[sequenceIndex];
  const totalLines = currentSequence.lines.length;

  useEffect(() => {
    const initialLines = [];
    for (let i = 0; i < Math.min(5, totalLines); i++) {
      initialLines.push({
        text: currentSequence.lines[i],
        number: i + 1,
      });
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibleLines(initialLines);
    setScrollPosition(0);
  }, [sequenceIndex, currentSequence.lines, totalLines]);

  // Handle line advancement
  useEffect(() => {
    const advanceTimer = setInterval(() => {
      // Get the current first visible line index
      const firstVisibleLineIndex = Math.floor(scrollPosition / lineHeight);
      const nextLineIndex = (firstVisibleLineIndex + 3) % totalLines;

      // If we're about to wrap around, move to next sequence
      if (nextLineIndex < firstVisibleLineIndex && nextLineIndex !== 0) {
        setSequenceIndex(
          (prevIndex) => (prevIndex + 1) % TASK_SEQUENCES.length
        );
        return;
      }

      // Add the next line if needed
      if (nextLineIndex >= visibleLines.length && nextLineIndex < totalLines) {
        setVisibleLines((prevLines) => [
          ...prevLines,
          {
            text: currentSequence.lines[nextLineIndex],
            number: nextLineIndex + 1,
          },
        ]);
      }

      // Scroll to the next line
      setScrollPosition((prevPosition) => prevPosition + lineHeight);
    }, 2000); // Slightly slower than the example for better readability

    return () => clearInterval(advanceTimer);
  }, [
    scrollPosition,
    visibleLines,
    totalLines,
    sequenceIndex,
    currentSequence.lines,
    lineHeight,
  ]);

  // Apply scroll position
  useEffect(() => {
    if (codeContainerRef.current) {
      codeContainerRef.current.scrollTop = scrollPosition;
    }
  }, [scrollPosition]);

  return (
    <div className="w-full max-w-md">
      <div className="w-auto space-y-3">
        <div className="flex items-center space-x-2 font-medium text-[#7ab5cc]">
          <LoadingAnimation
            progress={(sequenceIndex / TASK_SEQUENCES.length) * 100}
          />
          <span className="text-sm">{currentSequence.status}...</span>
        </div>

        <div className="relative">
          <div
            className="relative h-[84px] w-full overflow-hidden rounded-lg font-mono text-xs"
            ref={codeContainerRef}
            style={{ scrollBehavior: "smooth" }}
          >
            <div>
              {visibleLines.map((line) => (
                <div
                  className="flex h-[28px] items-center px-2"
                  key={`${line.number}-${line.text}`}
                >
                  <div className="w-6 select-none pr-3 text-right text-[#4a8fa8]">
                    {line.number}
                  </div>

                  <div className="ml-1 flex-1 text-[#c5e8f0]">
                    {line.text}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            className="pointer-events-none absolute top-0 right-0 bottom-0 left-0 rounded-lg"
            style={{
              background:
                "linear-gradient(to bottom, rgba(18,15,23,0.9) 0%, rgba(18,15,23,0.45) 30%, transparent 100%)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
