"use client";

import { useRef, useState, type CSSProperties, type TouchEvent as ReactTouchEvent } from "react";

interface SwipeToDismissResult {
  handleProps: {
    onTouchStart: (e: ReactTouchEvent) => void;
    onTouchMove: (e: ReactTouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
    style: CSSProperties;
  };
  sheetStyle: CSSProperties;
}

export function useSwipeToDismiss(onClose: () => void, threshold = 80): SwipeToDismissResult {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef<number | null>(null);
  const dragYRef = useRef(0);

  const reset = () => {
    dragYRef.current = 0;
    setDragY(0);
    setDragging(false);
    startYRef.current = null;
  };

  const handleProps = {
    onTouchStart: (e: ReactTouchEvent) => {
      startYRef.current = e.touches[0].clientY;
      setDragging(true);
    },
    onTouchMove: (e: ReactTouchEvent) => {
      if (startYRef.current === null) return;
      const dy = Math.max(0, e.touches[0].clientY - startYRef.current);
      dragYRef.current = dy;
      setDragY(dy);
    },
    onTouchEnd: () => {
      if (dragYRef.current > threshold) onClose();
      reset();
    },
    onTouchCancel: reset,
    style: { touchAction: "none" as const },
  };

  const sheetStyle: CSSProperties = {
    transform: `translateY(${dragY}px)`,
    transition: dragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
    willChange: "transform",
  };

  return { handleProps, sheetStyle };
}
