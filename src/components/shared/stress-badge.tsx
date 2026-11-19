import React from "react";
import { STRESS_BAND_VISUALS } from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import type { StressLevel } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export interface StressBadgeProps {
  level: StressLevel | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function StressBadge({
  level,
  size = "md",
  className,
}: StressBadgeProps) {
  if (!level) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700",
          className
        )}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full bg-slate-400"
        />
        N/A
      </span>
    );
  }

  const visual = STRESS_BAND_VISUALS[level];
  const sizeClasses =
    size === "lg"
      ? "px-3.5 py-1 text-sm font-semibold"
      : size === "sm"
        ? "px-2 py-0.5 text-[11px] font-medium"
        : "px-2.5 py-0.5 text-xs font-semibold";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border",
        visual.badgeClassName,
        sizeClasses,
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "rounded-full shrink-0",
          size === "lg" ? "h-2.5 w-2.5" : "h-2 w-2"
        )}
        style={{ backgroundColor: visual.dotColorHex }}
      />
      <span>{MESSAGES_EN.stressLevels[level]}</span>
    </span>
  );
}
