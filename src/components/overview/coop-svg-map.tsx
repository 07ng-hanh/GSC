import React from "react";
import { STRESS_BAND_VISUALS } from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CoolingState,
  Reading,
  StressLevel,
  ZoneConfig,
} from "@/lib/domain/types";

export interface CoopSvgMapProps {
  zones: readonly ZoneConfig[];
  readingsByZone: Record<string, Reading>;
  coolingByZone: Record<string, CoolingState>;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
}

const ZONE_TINT_HEX: Record<StressLevel, string> = {
  comfort: "#ecfdf5",
  heat_stress: "#fffbeb",
  severe_heat_stress: "#fef2f2",
};

export function CoopSvgMap({
  zones,
  readingsByZone,
  coolingByZone,
  selectedZoneId,
  onSelectZone,
}: CoopSvgMapProps) {
  const indoorZones = zones.filter((z) => !z.isOutdoorReference);
  const outdoorZones = zones.filter((z) => z.isOutdoorReference);

  // Coop 2D Floorplan geometry
  const coopX = 56;
  const coopY = 44;
  const coopW = 688;
  const coopH = 196;
  const zoneCount = Math.max(1, indoorZones.length);
  const zoneW = coopW / zoneCount;

  // Side window X positions along top and bottom coop walls
  const windowPositions = [115, 225, 360, 495, 625];

  const renderSensorDot = (params: {
    zone: ZoneConfig;
    cx: number;
    cy: number;
  }) => {
    const { zone, cx, cy } = params;
    const reading = readingsByZone[zone.id];
    const isSelected = selectedZoneId === zone.id;

    const isValid =
      reading !== undefined &&
      reading.qualityStatus === "valid" &&
      reading.stressLevel !== null;

    const dotHex =
      isValid && reading.stressLevel
        ? STRESS_BAND_VISUALS[reading.stressLevel].dotColorHex
        : "#64748b";

    const thiText =
      reading && reading.thi !== null ? reading.thi.toFixed(1) : "--";

    const statusShort = !reading
      ? "No data"
      : reading.qualityFlags.includes("OFFLINE")
        ? "Offline"
        : reading.qualityStatus !== "valid"
          ? reading.qualityFlags[0] ?? "Suspect"
          : reading.stressLevel
            ? MESSAGES_EN.stressLevels[reading.stressLevel]
            : "OK";

    return (
      <g
        key={`dot-${zone.id}`}
        role="button"
        tabIndex={0}
        aria-label={`${zone.name} sensor node: THI ${thiText}, ${statusShort}`}
        aria-pressed={isSelected}
        onClick={() => onSelectZone(zone.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectZone(zone.id);
          }
        }}
        className="cursor-pointer focus:outline-none"
      >
        {/* Selection outer ring */}
        {isSelected && (
          <circle
            cx={cx}
            cy={cy}
            r={26}
            fill={dotHex}
            fillOpacity={0.18}
            stroke="#0f172a"
            strokeWidth={2.5}
          />
        )}

        {/* Click target halo */}
        <circle
          cx={cx}
          cy={cy}
          r={20}
          fill="#ffffff"
          stroke={dotHex}
          strokeWidth={isSelected ? 3.5 : 2.5}
        />

        {/* Core circular sensor dot */}
        <circle cx={cx} cy={cy} r={12} fill={dotHex} />

        {/* Compact THI + text status pill below the dot */}
        <rect
          x={cx - 64}
          y={cy + 27}
          width={128}
          height={22}
          rx={11}
          fill="#ffffff"
          stroke={isSelected ? "#0f172a" : "#cbd5e1"}
          strokeWidth={isSelected ? 1.8 : 1}
        />
        <text
          x={cx}
          y={cy + 41.5}
          textAnchor="middle"
          fill="#0f172a"
          fontSize="10.2"
          fontWeight="700"
        >
          {thiText} · {statusShort}
        </text>
      </g>
    );
  };

  return (
    <Card className="h-full flex flex-col justify-between">
      <CardHeader className="p-4 pb-2 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">
            {MESSAGES_EN.overview.coopMapTitle}
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {MESSAGES_EN.overview.coopMapHint}
          </p>
        </div>

        {/* Minimal Architectural Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-4 rounded-sm border border-sky-500 bg-sky-100" />
            {MESSAGES_EN.overview.mapLegendWindow}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-3 border-b-2 border-amber-700" />
            {MESSAGES_EN.overview.mapLegendDoor}
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-1">
        <div className="w-full overflow-x-auto">
          <svg
            viewBox="0 0 800 330"
            className="w-full min-w-[540px] h-auto select-none"
            role="group"
            aria-label="2D Broiler Coop Floorplan with sensor dots"
          >
            {/* 1. Indoor Zone Regions (2D Top-Down Floorplan) */}
            {indoorZones.map((zone, idx) => {
              const zx = coopX + idx * zoneW;
              const reading = readingsByZone[zone.id];
              const cooling = coolingByZone[zone.id];
              const isSelected = selectedZoneId === zone.id;
              const tint =
                reading?.qualityStatus === "valid" && reading.stressLevel
                  ? ZONE_TINT_HEX[reading.stressLevel]
                  : "#f8fafc";

              return (
                <g
                  key={`region-${zone.id}`}
                  onClick={() => onSelectZone(zone.id)}
                  className="cursor-pointer"
                >
                  <rect
                    x={zx}
                    y={coopY}
                    width={zoneW}
                    height={coopH}
                    fill={tint}
                    stroke="#cbd5e1"
                    strokeWidth="1"
                    strokeDasharray={idx > 0 ? "5 4" : undefined}
                  />
                  {isSelected && (
                    <rect
                      x={zx + 2}
                      y={coopY + 2}
                      width={zoneW - 4}
                      height={coopH - 4}
                      fill="none"
                      stroke="#0f172a"
                      strokeWidth="1.5"
                      strokeOpacity="0.25"
                    />
                  )}
                  <text
                    x={zx + zoneW / 2}
                    y={coopY + 24}
                    textAnchor="middle"
                    fill="#334155"
                    fontSize="12"
                    fontWeight="700"
                  >
                    {zone.shortLabel}
                  </text>

                  {/* Compact Equipment Status Chips inside the Zone */}
                  {cooling && (
                    <g transform={`translate(${zx + zoneW / 2 - 68}, ${coopY + coopH - 26})`}>
                      {/* Fan chip */}
                      <rect
                        x={0}
                        y={0}
                        width={42}
                        height={16}
                        rx={4}
                        fill={cooling.fan ? "#0284c7" : "#e2e8f0"}
                      />
                      <text
                        x={21}
                        y={11.5}
                        textAnchor="middle"
                        fill={cooling.fan ? "#ffffff" : "#64748b"}
                        fontSize="9"
                        fontWeight="700"
                      >
                        {cooling.fan
                          ? cooling.fanLevel !== undefined && cooling.fanLevel < 1
                            ? `Fan ${Math.round(cooling.fanLevel * 100)}%`
                            : "Fan ON"
                          : "Fan OFF"}
                      </text>

                      {/* Mist chip */}
                      <rect
                        x={46}
                        y={0}
                        width={44}
                        height={16}
                        rx={4}
                        fill={
                          cooling.mist && cooling.mistLockedByHumidity
                            ? "#dc2626"
                            : cooling.mistLockedByHumidity
                              ? "#fef3c7"
                              : cooling.mist
                                ? "#0d9488"
                                : "#e2e8f0"
                        }
                      />
                      <text
                        x={68}
                        y={11.5}
                        textAnchor="middle"
                        fill={
                          cooling.mist && cooling.mistLockedByHumidity
                            ? "#ffffff"
                            : cooling.mistLockedByHumidity
                              ? "#92400e"
                              : cooling.mist
                                ? "#ffffff"
                                : "#64748b"
                        }
                        fontSize="9"
                        fontWeight="700"
                      >
                        {cooling.mist && cooling.mistLockedByHumidity
                          ? "Mist RISK"
                          : `Mist ${cooling.mist ? "ON" : "OFF"}`}
                      </text>

                      {/* Curtain chip */}
                      <rect
                        x={94}
                        y={0}
                        width={42}
                        height={16}
                        rx={4}
                        fill={cooling.curtain ? "#7c3aed" : "#e2e8f0"}
                      />
                      <text
                        x={115}
                        y={11.5}
                        textAnchor="middle"
                        fill={cooling.curtain ? "#ffffff" : "#64748b"}
                        fontSize="9"
                        fontWeight="700"
                      >
                        Curt {cooling.curtain ? "ON" : "OFF"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {/* 2. Coop Structural Perimeter Wall */}
            <rect
              x={coopX}
              y={coopY}
              width={coopW}
              height={coopH}
              fill="none"
              stroke="#334155"
              strokeWidth="4"
              rx="4"
            />

            {/* 3. Left Cooling Pad Inlet Wall */}
            <rect
              x={coopX - 18}
              y={coopY + 22}
              width={16}
              height={coopH - 44}
              rx="3"
              fill="#bae6fd"
              stroke="#0284c7"
              strokeWidth="1.5"
            />
            <text
              x={24}
              y={coopY + coopH / 2}
              textAnchor="middle"
              fill="#0369a1"
              fontSize="10"
              fontWeight="700"
              transform={`rotate(-90 24 ${coopY + coopH / 2})`}
            >
              {MESSAGES_EN.overview.mapLegendInlet}
            </text>

            {/* 4. Right Exhaust Fan Bank Wall */}
            {[coopY + 34, coopY + 90, coopY + 146].map((fy, i) => (
              <g key={i}>
                <rect
                  x={coopX + coopW + 2}
                  y={fy}
                  width={16}
                  height={34}
                  rx="3"
                  fill="#fecaca"
                  stroke="#dc2626"
                  strokeWidth="1.5"
                />
                <line
                  x1={coopX + coopW + 6}
                  y1={fy + 8}
                  x2={coopX + coopW + 14}
                  y2={fy + 26}
                  stroke="#991b1b"
                  strokeWidth="1.5"
                />
                <line
                  x1={coopX + coopW + 14}
                  y1={fy + 8}
                  x2={coopX + coopW + 6}
                  y2={fy + 26}
                  stroke="#991b1b"
                  strokeWidth="1.5"
                />
              </g>
            ))}
            <text
              x={782}
              y={coopY + coopH / 2}
              textAnchor="middle"
              fill="#991b1b"
              fontSize="10"
              fontWeight="700"
              transform={`rotate(90 782 ${coopY + coopH / 2})`}
            >
              {MESSAGES_EN.overview.mapLegendExhaust}
            </text>

            {/* 5. Side Window System (Top & Bottom Walls) */}
            {windowPositions.map((wx) => (
              <g key={`win-${wx}`}>
                {/* North / Top wall window */}
                <rect
                  x={wx}
                  y={coopY - 4}
                  width={54}
                  height={8}
                  fill="#e0f2fe"
                  stroke="#0284c7"
                  strokeWidth="1.5"
                />
                <line
                  x1={wx}
                  y1={coopY}
                  x2={wx + 54}
                  y2={coopY}
                  stroke="#0284c7"
                  strokeWidth="1"
                />

                {/* South / Bottom wall window (skip slot occupied by entry door) */}
                {wx !== 115 && (
                  <>
                    <rect
                      x={wx}
                      y={coopY + coopH - 4}
                      width={54}
                      height={8}
                      fill="#e0f2fe"
                      stroke="#0284c7"
                      strokeWidth="1.5"
                    />
                    <line
                      x1={wx}
                      y1={coopY + coopH}
                      x2={wx + 54}
                      y2={coopY + coopH}
                      stroke="#0284c7"
                      strokeWidth="1"
                    />
                  </>
                )}
              </g>
            ))}

            {/* 6. Architectural Main Entry Door (Bottom-Left Wall) */}
            <g aria-label="Main coop entry door">
              <rect
                x={108}
                y={coopY + coopH - 4}
                width={38}
                height={8}
                fill="#ffffff"
              />
              <line
                x1={108}
                y1={coopY + coopH}
                x2={108}
                y2={coopY + coopH + 34}
                stroke="#b45309"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                d={`M 108 ${coopY + coopH + 34} A 34 34 0 0 0 142 ${coopY + coopH}`}
                fill="none"
                stroke="#b45309"
                strokeWidth="1.3"
                strokeDasharray="3 3"
              />
              <text
                x={126}
                y={coopY + coopH + 46}
                textAnchor="middle"
                fill="#92400e"
                fontSize="10"
                fontWeight="700"
              >
                {MESSAGES_EN.overview.mapLegendDoor}
              </text>
            </g>

            {/* Subtle airflow direction arrows */}
            {[1, 2].map((sepIdx) => {
              const ax = coopX + sepIdx * zoneW;
              return (
                <path
                  key={`arrow-${sepIdx}`}
                  d={`M ${ax - 12} ${coopY + 90} L ${ax + 10} ${coopY + 90} M ${ax + 5} ${coopY + 85} L ${ax + 11} ${coopY + 90} L ${ax + 5} ${coopY + 95}`}
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}

            {/* 7. Circular Sensor Dots Inside Each Coop Zone */}
            {indoorZones.map((zone, idx) =>
              renderSensorDot({
                zone,
                cx: coopX + idx * zoneW + zoneW / 2,
                cy: coopY + 88,
              })
            )}

            {/* 8. Outdoor Reference Zone & Circular Sensor Dot */}
            {outdoorZones.map((zone, idx) => {
              const ox = 560 - idx * 240;
              const oy = 258;
              return (
                <g key={`outdoor-${zone.id}`}>
                  <rect
                    x={ox - 92}
                    y={oy - 12}
                    width={260}
                    height={68}
                    rx={10}
                    fill="#f8fafc"
                    stroke="#cbd5e1"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                  />
                  <text
                    x={ox - 78}
                    y={oy + 14}
                    fill="#334155"
                    fontSize="11.5"
                    fontWeight="700"
                  >
                    {MESSAGES_EN.overview.outdoorZoneTag}
                  </text>
                  <text x={ox - 78} y={oy + 31} fill="#64748b" fontSize="10">
                    Outside coop wall
                  </text>
                  {renderSensorDot({
                    zone,
                    cx: ox + 98,
                    cy: oy + 12,
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
