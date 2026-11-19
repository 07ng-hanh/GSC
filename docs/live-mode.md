# Live Mode & Firebase Realtime Database Integration Guide

This guide documents the architecture, data contracts, Firebase Realtime Database rules, ESP32 payload structures, and client ingestion flow for **ThermaStock** in Live Mode.

---

## 1. Architectural Overview

ThermaStock supports two runtime modes:
1. **Simulation Mode (`simulated`)**: Employs deterministic thermal models, diurnal cycles, scenario injections, and Plant models.
2. **Live Mode (`live`)**: Ingests real-time telemetry from ESP32 nodes installed throughout the broiler house via Google Firebase Realtime Database (RTDB).

When the application boots or switches to `Live Mode` without active credentials or telemetry, `FirebaseDataSource` / `LiveDataSource` safely signals an awaiting state (`NotConnectedError`), rendering the UI banner:
> **"Awaiting connection: Live ESP32 telemetry via Firebase Realtime Database is not connected yet. Switch back to Simulation Mode to continue."**

---

## 2. Firebase Realtime Database Hierarchy

```
farms/
  └── {farmId}/
        ├── nodes/
        │     └── {nodeId}/              # ESP32 device status & heartbeat
        │           ├── deviceId: string
        │           ├── zoneId: string
        │           ├── lastSeenTs: ISO8601 string
        │           ├── rssiDbm: number (-120..0)
        │           ├── batteryV: number (0..6.0)
        │           └── firmware: string
        │
        ├── telemetry/
        │     └── {zoneId}/
        │           └── {timestampMs}/   # Time-series telemetry samples
        │                 ├── ts: ISO8601 string
        │                 ├── deviceId: string
        │                 ├── tempC: number (-10..60)
        │                 ├── rhPct: number (0..100)
        │                 ├── thi: number | null
        │                 ├── seq: number
        │                 ├── batteryV?: number
        │                 └── rssiDbm?: number
        │
        ├── latest/
        │     └── {zoneId}/              # Cached latest reading per zone
        │           ├── ts: ISO8601 string
        │           ├── deviceId: string
        │           ├── tempC: number
        │           ├── rhPct: number
        │           └── thi: number
        │
        └── actuators/
              └── {zoneId}/              # Current actuator control state
                    ├── fan: boolean
                    ├── fanLevel?: number (0..100)
                    ├── mist: boolean
                    ├── mistDutyFactor?: number (0..1.0)
                    ├── curtain: boolean
                    ├── mode: "auto" | "manual"
                    └── updatedAtUtc: ISO8601 string
```

---

## 3. ESP32 Telemetry Firmware Contract

### Node Topography (Champion Layout)
- **Node 1 (`esp32-node-01`)**: Zone `zone-front` (Pad/Inlet end).
- **Node 2 (`esp32-node-02`)**: Zone `zone-center` (Mid-house flock core).
- **Node 3 (`esp32-node-03`)**: Zone `zone-rear` (Tunnel exhaust end, accumulates sensible heat).
- **Node 4 (`esp32-node-04`)**: Zone `zone-outdoor` (External shaded weather reference).

### HTTP REST / MQTT Push Payload
Every 60 seconds (or upon critical temperature threshold jump $> 1.0\,^\circ\text{C}$), nodes POST to Firebase RTDB:

```json
{
  "deviceId": "esp32-node-02",
  "zoneId": "zone-center",
  "ts": "2026-11-19T03:15:00.000Z",
  "tempC": 29.4,
  "rhPct": 64.2,
  "thi": 28.1,
  "seq": 14205,
  "batteryV": 4.12,
  "rssiDbm": -65,
  "firmware": "thermastock-esp32-v1.4.2"
}
```

---

## 4. Security Rules & Data Validation (`database.rules.json`)

The accompanying `database.rules.json` file applies stringent server-side schema constraints:
- **Authentication**: All read and write operations require valid Firebase Auth tokens (`auth != null`).
- **Range validation**:
  - `tempC`: Must be between $-10\,^\circ\text{C}$ and $60\,^\circ\text{C}$.
  - `rhPct`: Must be between $0\%$ and $100\%$.
  - `rssiDbm`: Must be between $-120$ and $0\,\text{dBm}$.
  - `lastSeenTs` / `ts`: Must conform strictly to ISO-8601 UTC timestamp format.
- **Actuator safety**: Enforces boolean state for fans/misting, `mistDutyFactor` bounded within $[0, 1.0]$, and mode restricted to `"auto"` or `"manual"`.

---

## 5. Client Integration (`FirebaseDataSource`)

### Architecture
`FirebaseDataSource` implements the ThermaStock `DataSource` interface:
```typescript
export class FirebaseDataSource implements DataSource {
  readonly mode = "live";
  getReadings(zoneIds, fromUtc, toUtc, resolution): Promise<Reading[]>;
  getLatest(atUtc?, options?): Promise<LatestSnapshot>;
  getDeviceStatus(atUtc?): Promise<DeviceStatus[]>;
}
```

### Fallback & Graceful Degradation
1. **Unconfigured Environment**: If Firebase environment variables (`NEXT_PUBLIC_FIREBASE_DATABASE_URL`, `NEXT_PUBLIC_FIREBASE_API_KEY`) are missing or unauthenticated, calls to `getReadings()`, `getLatest()`, or `getDeviceStatus()` throw `NotConnectedError`.
2. **Offline Node Detection**: If a node does not report within the configured timeout window (`quality.offlineMinutes`, default 10 minutes), it is marked `online: false` and emits an `offline` alert.
3. **Data Quality Pipeline**: Ingested live readings pass through the 5-rule broiler data quality pipeline:
   - Rule 1: Physical sensor range check ($-10\,^\circ\text{C} \le T \le 60\,^\circ\text{C}$, $0\% \le \text{RH} \le 100\%$).
   - Rule 2: Sudden jump check ($\Delta T \le 5\,^\circ\text{C} / 5\,\text{min}$).
   - Rule 3: Flatline detection ($> 60\,\text{min}$ identical readings).
   - Rule 4: Outdoor cross-check ($\Delta T \le 10\,^\circ\text{C}$ vs outdoor).
   - Rule 5: Offline heartbeat ($> 10\,\text{min}$ silence).

---

## 6. Deployment & Environment Setup

To connect a live farm instance:
1. Create a Firebase project with Realtime Database enabled in `asia-southeast1` (Singapore) for minimal latency in Vietnam.
2. Deploy `database.rules.json`:
   ```bash
   firebase deploy --only database
   ```
3. Add environment credentials to `.env.local`:
   ```ini
   NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://<your-project>-default-rtdb.asia-southeast1.firebasedatabase.app
   NEXT_PUBLIC_FIREBASE_API_KEY=<your-api-key>
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<your-project>.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=<your-project-id>
   NEXT_PUBLIC_FIREBASE_FARM_ID=farm-dong-anh-01
   ```
4. Flash the ESP32 nodes with their assigned `zoneId` (`zone-front`, `zone-center`, `zone-rear`, `zone-outdoor`) and WiFi credentials.
