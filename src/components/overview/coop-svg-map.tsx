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

  // Coop 2D Floorplan geometry - compact with minimal vertical whitespace
  const coopX = 48;
  const coopY = 12;
  const coopW = 704;
  const coopH = 136;
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
            r={22}
            fill={dotHex}
            fillOpacity={0.18}
            stroke="#0f172a"
            strokeWidth={2}
          />
        )}

        {/* Click target halo */}
        <circle
          cx={cx}
          cy={cy}
          r={16}
          fill="#ffffff"
          stroke={dotHex}
          strokeWidth={isSelected ? 3 : 2}
        />

        {/* Core circular sensor dot */}
        <circle cx={cx} cy={cy} r={9} fill={dotHex} />

        {/* Compact THI + text status pill below the dot */}
        <rect
          x={cx - 54}
          y={cy + 17}
          width={108}
          height={18}
          rx={9}
          fill="#ffffff"
          stroke={isSelected ? "#0f172a" : "#cbd5e1"}
          strokeWidth={isSelected ? 1.5 : 1}
        />
        <text
          x={cx}
          y={cy + 29.5}
          textAnchor="middle"
          fill="#0f172a"
          fontSize="9.5"
          fontWeight="700"
        >
          {thiText} · {statusShort}
        </text>
      </g>
    );
  };

  return (
    <Card>
      <CardHeader className="p-3 pb-1 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-sm font-bold">
            {MESSAGES_EN.overview.coopMapTitle}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {MESSAGES_EN.overview.coopMapHint}
          </p>
        </div>

        {/* Minimal Architectural Legend */}
        <div className="flex flex-wrap items-center gap-2.5 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3.5 rounded-xs border border-sky-500 bg-sky-100" />
            {MESSAGES_EN.overview.mapLegendWindow}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2.5 border-b-2 border-amber-700" />
            {MESSAGES_EN.overview.mapLegendDoor}
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-0">
        <div className="w-full overflow-x-auto">
          <svg
            viewBox="0 0 800 210"
            className="w-full min-w-[500px] h-auto select-none"
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
                    y={coopY + 18}
                    textAnchor="middle"
                    fill="#334155"
                    fontSize="11"
                    fontWeight="700"
                  >
                    {zone.shortLabel}
                  </text>

                  {/* Compact Equipment Status Chips inside the Zone */}
                  {cooling && (
                    <g transform={`translate(${zx + zoneW / 2 - 64}, ${coopY + coopH - 22})`}>
                      {/* Fan chip */}
                      <rect
                        x={0}
                        y={0}
                        width={40}
                        height={15}
                        rx={3.5}
                        fill={cooling.fan ? "#0284c7" : "#e2e8f0"}
                      />
                      <text
                        x={20}
                        y={11}
                        textAnchor="middle"
                        fill={cooling.fan ? "#ffffff" : "#64748b"}
                        fontSize="8.5"
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
                        x={44}
                        y={0}
                        width={42}
                        height={15}
                        rx={3.5}
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
                        x={65}
                        y={11}
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
                        fontSize="8.5"
                        fontWeight="700"
                      >
                        {cooling.mist && cooling.mistLockedByHumidity
                          ? "Mist RISK"
                          : `Mist ${cooling.mist ? "ON" : "OFF"}`}
                      </text>

                      {/* Curtain chip */}
                      <rect
                        x={90}
                        y={0}
                        width={38}
                        height={15}
                        rx={3.5}
                        fill={cooling.curtain ? "#7c3aed" : "#e2e8f0"}
                      />
                      <text
                        x={109}
                        y={11}
                        textAnchor="middle"
                        fill={cooling.curtain ? "#ffffff" : "#64748b"}
                        fontSize="8.5"
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
              strokeWidth="3.5"
              rx="4"
            />

            {/* 3. Left Cooling Pad Inlet Wall */}
            <rect
              x={coopX - 16}
              y={coopY + 16}
              width={14}
              height={coopH - 32}
              rx="2.5"
              fill="#bae6fd"
              stroke="#0284c7"
              strokeWidth="1.5"
            />
            <text
              x={18}
              y={coopY + coopH / 2}
              textAnchor="middle"
              fill="#0369a1"
              fontSize="9.5"
              fontWeight="700"
              transform={`rotate(-90 18 ${coopY + coopH / 2})`}
            >
              {MESSAGES_EN.overview.mapLegendInlet}
            </text>

            {/* 4. Right Exhaust Fan Bank Wall */}
            {[coopY + 14, coopY + 54, coopY + 94].map((fy, i) => (
              <g key={i}>
                <rect
                  x={coopX + coopW + 2}
                  y={fy}
                  width={14}
                  height={28}
                  rx="2.5"
                  fill="#fecaca"
                  stroke="#dc2626"
                  strokeWidth="1.5"
                />
                <line
                  x1={coopX + coopW + 5}
                  y1={fy + 6}
                  x2={coopX + coopW + 13}
                  y2={fy + 22}
                  stroke="#991b1b"
                  strokeWidth="1.3"
                />
                <line
                  x1={coopX + coopW + 13}
                  y1={fy + 6}
                  x2={coopX + coopW + 5}
                  y2={fy + 22}
                  stroke="#991b1b"
                  strokeWidth="1.3"
                />
              </g>
            ))}
            <text
              x={780}
              y={coopY + coopH / 2}
              textAnchor="middle"
              fill="#991b1b"
              fontSize="9.5"
              fontWeight="700"
              transform={`rotate(90 780 ${coopY + coopH / 2})`}
            >
              {MESSAGES_EN.overview.mapLegendExhaust}
            </text>

            {/* 5. Side Window System (Top & Bottom Walls) */}
            {windowPositions.map((wx) => (
              <g key={`win-${wx}`}>
                {/* North / Top wall window */}
                <rect
                  x={wx}
                  y={coopY - 3.5}
                  width={52}
                  height={7}
                  fill="#e0f2fe"
                  stroke="#0284c7"
                  strokeWidth="1.3"
                />
                <line
                  x1={wx}
                  y1={coopY}
                  x2={wx + 52}
                  y2={coopY}
                  stroke="#0284c7"
                  strokeWidth="1"
                />

                {/* South / Bottom wall window (skip slot occupied by entry door) */}
                {wx !== 115 && (
                  <>
                    <rect
                      x={wx}
                      y={coopY + coopH - 3.5}
                      width={52}
                      height={7}
                      fill="#e0f2fe"
                      stroke="#0284c7"
                      strokeWidth="1.3"
                    />
                    <line
                      x1={wx}
                      y1={coopY + coopH}
                      x2={wx + 52}
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
                x={100}
                y={coopY + coopH - 3.5}
                width={34}
                height={7}
                fill="#ffffff"
              />
              <line
                x1={100}
                y1={coopY + coopH}
                x2={100}
                y2={coopY + coopH + 26}
                stroke="#b45309"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
              <path
                d={`M 100 ${coopY + coopH + 26} A 26 26 0 0 0 126 ${coopY + coopH}`}
                fill="none"
                stroke="#b45309"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <text
                x={116}
                y={coopY + coopH + 36}
                textAnchor="middle"
                fill="#92400e"
                fontSize="9"
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
                  d={`M ${ax - 10} ${coopY + 54} L ${ax + 10} ${coopY + 54} M ${ax + 5} ${coopY + 50} L ${ax + 10} ${coopY + 54} L ${ax + 5} ${coopY + 58}`}
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth="1.6"
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
                cy: coopY + 54,
              })
            )}

            {/* 8. Outdoor Reference Zone & Circular Sensor Dot */}
            {outdoorZones.map((zone) => {
              const ox = 440;
              const oy = coopY + coopH + 10;
              return (
                <g key={`outdoor-${zone.id}`}>
                  <rect
                    x={ox}
                    y={oy}
                    width={290}
                    height={46}
                    rx={8}
                    fill="#f8fafc"
                    stroke="#cbd5e1"
                    strokeWidth="1.3"
                    strokeDasharray="4 3"
                  />
                  <text
                    x={ox + 14}
                    y={oy + 20}
                    fill="#334155"
                    fontSize="10.5"
                    fontWeight="700"
                  >
                    {MESSAGES_EN.overview.outdoorZoneTag}
                  </text>
                  <text x={ox + 14} y={oy + 34} fill="#64748b" fontSize="9">
                    Outside coop wall
                  </text>
                  {renderSensorDot({
                    zone,
                    cx: ox + 220,
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
