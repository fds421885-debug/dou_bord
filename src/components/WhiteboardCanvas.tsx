import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eraser,
  Hand,
  PenTool,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react';
import type { Stroke } from '../types';
import { DuoLockShield } from './DuoIcons';

export const BOARD_WIDTH = 1200;
export const BOARD_HEIGHT = 700;

export const PEN_COLORS = [
  { id: 'black', label: 'أسود', hex: '#1F2937', ring: 'ring-[#1F2937]' },
  { id: 'red', label: 'أحمر', hex: '#EA2B2B', ring: 'ring-[#EA2B2B]' },
  { id: 'green', label: 'أخضر', hex: '#58CC02', ring: 'ring-[#58CC02]' },
] as const;

const PEN_SIZES = [
  { label: 'رفيع', size: 4 },
  { label: 'متوسط', size: 8 },
  { label: 'عريض', size: 15 },
];

export function renderStrokesToCanvas(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  width: number,
  height: number
) {
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  const scaleX = width / BOARD_WIDTH;
  const scaleY = height / BOARD_HEIGHT;
  ctx.scale(scaleX, scaleY);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    const pts = stroke.pts;
    if (!pts || pts.length < 2) continue;

    ctx.beginPath();
    ctx.strokeStyle = stroke.isEraser ? '#FFFFFF' : stroke.color;
    ctx.lineWidth = stroke.isEraser ? Math.max(stroke.width * 2.4, 24) : stroke.width;

    ctx.moveTo(pts[0], pts[1]);
    if (pts.length === 2) {
      ctx.lineTo(pts[0] + 0.1, pts[1] + 0.1);
    } else {
      for (let i = 2; i < pts.length; i += 2) {
        const prevX = pts[i - 2];
        const prevY = pts[i - 1];
        const currX = pts[i];
        const currY = pts[i + 1];
        const midX = (prevX + currX) / 2;
        const midY = (prevY + currY) / 2;
        ctx.quadraticCurveTo(prevX, prevY, midX, midY);
      }
      ctx.lineTo(pts[pts.length - 2], pts[pts.length - 1]);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export const WhiteboardPreview: React.FC<{
  strokes: Stroke[];
  className?: string;
  emptyText?: string;
}> = ({ strokes, className = 'w-full aspect-[12/7]', emptyText = 'لم يكتب بعد' }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderStrokesToCanvas(ctx, strokes, canvas.width, canvas.height);
  }, [strokes]);

  return (
    <div className={`relative rounded-xl overflow-hidden bg-white border-2 border-[#E5E5E5] ${className}`}>
      <canvas
        ref={canvasRef}
        width={600}
        height={350}
        className="w-full h-full block object-contain"
      />
      {strokes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-xs font-bold text-[#AFAFAF]">{emptyText}</span>
        </div>
      )}
    </div>
  );
};

interface WhiteboardCanvasProps {
  strokes: Stroke[];
  onStrokesChange: (next: Stroke[]) => void;
  disabled?: boolean;
  lockTitle?: string;
  lockSubtitle?: string;
  heightClass?: string;
}

export const WhiteboardCanvas: React.FC<WhiteboardCanvasProps> = ({
  strokes,
  onStrokesChange,
  disabled = false,
  lockTitle = 'السبورة مقفلة حالياً',
  lockSubtitle = 'بانتظار المشرف لإدراج السؤال',
  heightClass = 'h-[430px] md:h-[520px]',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [tool, setTool] = useState<'pen' | 'eraser' | 'pan'>('pen');
  const [color, setColor] = useState<string>(PEN_COLORS[0].hex);
  const [penSize, setPenSize] = useState<number>(6);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const isDrawingRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; origX: number; origY: number }>({
    x: 0,
    y: 0,
    origX: 0,
    origY: 0,
  });
  const activeStrokeRef = useRef<Stroke | null>(null);
  const localStrokesRef = useRef<Stroke[]>(strokes);
  const lastSyncRef = useRef<number>(0);

  useEffect(() => {
    if (!isDrawingRef.current) {
      localStrokesRef.current = strokes;
    }
  }, [strokes]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const combined = activeStrokeRef.current
      ? [...localStrokesRef.current, activeStrokeRef.current]
      : localStrokesRef.current;
    renderStrokesToCanvas(ctx, combined, BOARD_WIDTH, BOARD_HEIGHT);
  }, []);

  useEffect(() => {
    redraw();
  }, [strokes, redraw]);

  const getBoardPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.round(((clientX - rect.left) / rect.width) * BOARD_WIDTH);
    const y = Math.round(((clientY - rect.top) / rect.height) * BOARD_HEIGHT);
    return {
      x: Math.max(0, Math.min(BOARD_WIDTH, x)),
      y: Math.max(0, Math.min(BOARD_HEIGHT, y)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled && tool !== 'pan') return;

    if (tool === 'pan' || e.button === 1) {
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        origX: pan.x,
        origY: pan.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (disabled) return;

    const pt = getBoardPoint(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    isDrawingRef.current = true;
    activeStrokeRef.current = {
      color,
      width: penSize,
      isEraser: tool === 'eraser',
      pts: [pt.x, pt.y],
    };
    redraw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setPan({
        x: panStartRef.current.origX + dx,
        y: panStartRef.current.origY + dy,
      });
      return;
    }

    if (!isDrawingRef.current || !activeStrokeRef.current || disabled) return;
    const pt = getBoardPoint(e.clientX, e.clientY);
    if (!pt) return;

    const pts = activeStrokeRef.current.pts;
    const lastX = pts[pts.length - 2];
    const lastY = pts[pts.length - 1];
    const dist = Math.hypot(pt.x - lastX, pt.y - lastY);
    if (dist < 3) return;

    // Cap per-stroke points so documents stay lightweight
    if (pts.length < 700) {
      pts.push(pt.x, pt.y);
      redraw();
    }

    const now = Date.now();
    if (now - lastSyncRef.current > 550) {
      lastSyncRef.current = now;
      const snapshot = [...localStrokesRef.current, { ...activeStrokeRef.current, pts: [...pts] }];
      onStrokesChange(snapshot.slice(-380));
    }
  };

  const finishStroke = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      return;
    }
    if (!isDrawingRef.current || !activeStrokeRef.current) return;
    isDrawingRef.current = false;
    const finished = activeStrokeRef.current;
    activeStrokeRef.current = null;
    const next = [...localStrokesRef.current, finished].slice(-380);
    localStrokesRef.current = next;
    redraw();
    onStrokesChange(next);
  };

  const handleUndo = () => {
    if (disabled || localStrokesRef.current.length === 0) return;
    const next = localStrokesRef.current.slice(0, -1);
    localStrokesRef.current = next;
    redraw();
    onStrokesChange(next);
  };

  const handleClear = () => {
    if (disabled || localStrokesRef.current.length === 0) return;
    localStrokesRef.current = [];
    redraw();
    onStrokesChange([]);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(2.6, Number((z + 0.25).toFixed(2))));
  const handleZoomOut = () => setZoom((z) => Math.max(0.6, Number((z - 0.25).toFixed(2))));
  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-2xl p-2.5">
        {/* Colors & Tools */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 3 Mandatory Colors: Black, Red, Green */}
          <div className="flex items-center gap-1.5 bg-white border-2 border-[#E5E5E5] rounded-xl px-2 py-1.5">
            {PEN_COLORS.map((c) => {
              const active = tool === 'pen' && color === c.hex;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setColor(c.hex);
                    setTool('pen');
                  }}
                  title={c.label}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-extrabold transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                    active
                      ? 'bg-[#E5F7FF] text-[#1899D6] ring-2 ring-[#1CB0F6]'
                      : 'text-[#3C3C3C] hover:bg-[#F7F7F7]'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full border-2 border-white shadow-sm shrink-0"
                    style={{ backgroundColor: c.hex }}
                  />
                  <span>{c.label}</span>
                </button>
              );
            })}
          </div>

          {/* Pen Sizes */}
          <div className="flex items-center gap-1 bg-white border-2 border-[#E5E5E5] rounded-xl px-2 py-1.5">
            {PEN_SIZES.map((p) => {
              const active = penSize === p.size && tool !== 'pan';
              return (
                <button
                  key={p.size}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setPenSize(p.size);
                    if (tool === 'pan') setTool('pen');
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                    active
                      ? 'bg-[#D7FFB8] text-[#46A302]'
                      : 'text-[#777777] hover:bg-[#F7F7F7]'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Pen / Eraser / Undo / Clear */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setTool('pen')}
              className={`duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-b-4 text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                tool === 'pen'
                  ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                  : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
              }`}
            >
              <PenTool className="w-4 h-4" />
              <span>قلم</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => setTool('eraser')}
              className={`duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-b-4 text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                tool === 'eraser'
                  ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                  : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
              }`}
            >
              <Eraser className="w-4 h-4" />
              <span>مسّاحة</span>
            </button>

            <button
              type="button"
              disabled={disabled || strokes.length === 0}
              onClick={handleUndo}
              title="تراجع"
              className="duo-btn flex items-center gap-1 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-extrabold text-[#3C3C3C] hover:bg-[#F7F7F7] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-4 h-4" />
              <span>تراجع</span>
            </button>

            <button
              type="button"
              disabled={disabled || strokes.length === 0}
              onClick={handleClear}
              title="مسح السبورة"
              className="duo-btn flex items-center gap-1 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-extrabold text-[#EA2B2B] hover:bg-[#FFDFE0] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />
              <span>مسح الكل</span>
            </button>
          </div>
        </div>

        {/* Zoom & Pan Controls */}
        <div className="flex items-center gap-1.5 bg-white border-2 border-[#E5E5E5] rounded-xl px-2 py-1.5">
          <button
            type="button"
            onClick={() => setTool(tool === 'pan' ? 'pen' : 'pan')}
            title="تحريك اللوحة"
            className={`p-1.5 rounded-lg text-xs font-extrabold flex items-center gap-1 cursor-pointer ${
              tool === 'pan'
                ? 'bg-[#DDF4FF] text-[#1899D6]'
                : 'text-[#777777] hover:bg-[#F7F7F7]'
            }`}
          >
            <Hand className="w-4 h-4" />
            <span className="hidden sm:inline">تحريك</span>
          </button>

          <button
            type="button"
            onClick={handleZoomOut}
            title="تصغير"
            className="p-1.5 rounded-lg text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>

          <span className="font-latin text-xs font-extrabold text-[#3C3C3C] min-w-[44px] text-center">
            {Math.round(zoom * 100)}%
          </span>

          <button
            type="button"
            onClick={handleZoomIn}
            title="تكبير"
            className="p-1.5 rounded-lg text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleResetView}
            title="إعادة الحجم الافتراضي"
            className="p-1.5 rounded-lg text-[#777777] hover:bg-[#F7F7F7] cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Whiteboard Viewport */}
      <div
        ref={viewportRef}
        className={`relative w-full ${heightClass} rounded-2xl border-2 border-[#E5E5E5] border-b-4 whiteboard-grid overflow-hidden flex items-center justify-center touch-none select-none`}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isPanningRef.current ? 'none' : 'transform 0.12s ease-out',
          }}
          className="w-full h-full flex items-center justify-center p-2"
        >
          <canvas
            ref={canvasRef}
            width={BOARD_WIDTH}
            height={BOARD_HEIGHT}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            className={`max-w-full max-h-full aspect-[12/7] bg-white rounded-xl border-2 border-[#E5E5E5] shadow-sm ${
              tool === 'pan'
                ? 'cursor-grab active:cursor-grabbing'
                : disabled
                ? 'cursor-not-allowed'
                : 'cursor-crosshair'
            }`}
          />
        </div>

        {/* Locked Overlay */}
        {disabled && (
          <div className="absolute inset-0 bg-white/75 backdrop-blur-[2px] flex flex-col items-center justify-center p-6 text-center z-10">
            <DuoLockShield className="w-14 h-14 mb-3" />
            <p className="text-lg font-black text-[#3C3C3C] mb-1">{lockTitle}</p>
            <p className="text-sm font-bold text-[#777777] max-w-md">{lockSubtitle}</p>
          </div>
        )}
      </div>
    </div>
  );
};
