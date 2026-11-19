import React from "react";
import { MESSAGES_EN } from "@/config/messages.en";
import type { ParameterSourceType, SourceCitationId } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export interface ProvenanceBadgeProps {
  source: ParameterSourceType;
  citationId?: SourceCitationId;
  note?: string;
  className?: string;
}

export function ProvenanceBadge({
  source,
  citationId,
  note,
  className,
}: ProvenanceBadgeProps) {
  const label =
    source === "literature"
      ? `${MESSAGES_EN.provenance.literaturePrefix}: ${citationId ?? "S1"}`
      : source === "user"
        ? MESSAGES_EN.provenance.user
        : MESSAGES_EN.provenance.assumption;

  const styleClass =
    source === "literature"
      ? "border-sky-300 bg-sky-50 text-sky-900"
      : source === "user"
        ? "border-violet-300 bg-violet-50 text-violet-900"
        : "border-slate-300 bg-slate-100 text-slate-700";

  return (
    <span
      title={note ?? label}
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.2 text-[10px] font-semibold leading-tight tracking-tight",
        styleClass,
        className
      )}
    >
      {label}
    </span>
  );
}
