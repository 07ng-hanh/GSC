# ThermaStock 🐔🌡️

**AI-Driven Broiler Heat-Stress Management & Predictive Cooling System**

[![Next.js](https://img.shields.io/badge/Next.js-15.2.4-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.0.0-blue?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.4-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

ThermaStock is an intelligent microclimate control and decision-support platform engineered specifically for **commercial broiler poultry farming** (*Gallus gallus domesticus*). By combining finite-horizon dynamic programming (DP), multi-source weather forecasts, temporal feed shifting, data quality guardrails, and parametric heat-stress insurance, ThermaStock protects heavy meat birds from heat prostration while slashing electrical and water utility costs.

---

## 🌟 Core System Capabilities

### 1. Broiler-Specific Thermal Stress Classification
- Evaluates flock microclimate using the validated **Marai 2001** Temperature-Humidity Index formula (`[S1]`).
- Three physiological stress bands:
  - **Comfort**: $\text{THI} < 26.0$
  - **Heat Stress**: $26.0 \le \text{THI} \le 29.0$
  - **Severe Heat Stress**: $\text{THI} > 29.0$
- **Dynamic Age Target Curve**: Automatically adjusts thermal comfort baselines according to flock age from chick placement ($32\,^\circ\text{C}$ at day 0 down to $24\,^\circ\text{C}$ at market age, `[S3]`).
- **Brooding Phase Gate**: Automatically locks out evaporative misting and tunnel fans when chicks are under 21 days old (`ageDays < 21`), preventing fatal hypothermia.

### 2. Predictive DP Cooling Planner
- Solves a finite-horizon dynamic programming optimization problem ($H = 4\text{ hours}$, $\Delta = 15\text{ minutes}$) balancing bird thermal comfort ($\text{eTHI}$) against electricity costs ($\lambda$).
- **Effective THI ($\text{eTHI}$)**: Accounts for convective wind-chill velocity across bird feathers ($v_{\text{full}} = 3.0\text{ m/s}$, `[S7, S8]`).
- **Cubic Fan Affinity Law**: Incorporates $P_{\text{fan}} \propto f^3$ variable frequency drive (VFD) power scaling (`[S9]`).
- **Hard Evaporative Safety Gates**: Enforces misting lockout whenever ambient $\text{RH}_{\text{out}} \ge 75\%$ or in-house air velocity $v < 1.5\text{ m/s}$ (`[S7]`), preventing wet litter and ammonia spikes.
- **Robust Fallback Engine**: Transitions automatically to trend-based OLS lookahead rules if weather forecasts become stale ($> 3\text{ hours}$) or missing.

### 3. Temporal Feed Shifting (B3 Nutrition Strategy)
- Mitigates metabolic heat production during peak diurnal heat by shifting feeder accessibility (`[S4, S5]`).
- Implements 3-hour lead and lag windows around forecast heat peaks with an 8-hour maximum withdrawal cap and 16-hour minimum feeding window.
- Surfaces 5 expert nutritional advisory cards (`R1`–`R5`, `[S4, S6]`): dietary energy density, crude protein and synthetic amino acids, fiber and non-starch polysaccharides, electrolyte cation-anion balance, and pellet durability.

### 4. Advanced Sensor Quality & Diagnostics
- Continuous telemetry validation via a 5-rule pipeline:
  - Range boundaries ($-10\,^\circ\text{C} \le T \le 60\,^\circ\text{C}$, $0\% \le \text{RH} \le 100\%$)
  - Rate-of-change jump detection ($> 5\,^\circ\text{C} / 5\text{ min}$)
  - Flatline sensor detection ($> 60\text{ min}$ static values)
  - Outdoor cross-drift validation ($> 10\,^\circ\text{C}$ divergence)
  - Hardware silence / offline watchdog ($> 10\text{ min}$)
- Corrupted or suspect readings are excluded from the farm median THI, preventing actuators from reacting to faulty sensor nodes.

### 5. Energy & Water Resource Benchmarking
- Tracks real-time and multi-day electricity (kWh) and water (Liters) consumption across the **Champion tunnel ventilation layout** (Front: 1x 0.37 kW; Center: 2x 0.55 kW; Rear: 3x 0.75 kW).
- Direct benchmark against 3 standard baselines:
  - **B1**: 08:00–20:00 Fixed Timer
  - **B2**: Air-Temperature Thermostat ($28\,^\circ\text{C}$)
  - **B3**: Reactive THI Threshold ($26 / 28 / 29$)
- Calculates monetary savings in Vietnamese Đồng (EVN tariff: 2,000 VND/kWh; water: 15,000 VND/$\text{m}^3$) and avoided $\text{CO}_2$ emissions.

### 6. Parametric Heat Insurance & Broiler Mortality Diary
- **Parametric Trigger**: Automatically tracks 3-consecutive-day streaks where peak hourly farm THI strictly exceeds $29.0$ (`[S1]`), triggering instant claim verification without loss adjustment delays.
- **Manual Broiler Mortality Diary**: Digital coop walkthrough log allowing farmers to record dead and culled broilers, primary causes (*heat prostration, smothering pile at exhaust fans, sudden death syndrome, respiratory distress*), bird weights, and veterinary remarks.
- One-click RFC-4180 CSV export for insurance audit trails.

### 7. Dual-Mode Operation
- **Simulation Mode (`simulated`)**: Runs a deterministic 6-scenario physics engine (`normal`, `hot_day`, `heatwave`, `humid_monsoon`, `sensor_faults`, `network_outage`) with adjustable speed ($1\times, 60\times, 600\times$).
- **Live Mode (`live`)**: Ingests real-time ESP32 sensor telemetry from Google Firebase Realtime Database with graceful degradation when awaiting connection.

---

## 🗺️ Application Sitemap & Navigation

| Route | View Name | Description |
| --- | --- | --- |
| `/` | **Overview** | Live 2D coop diagram, zone telemetry, top predictive action strip, and manual override controls. |
| `/cooling-plan` | **Cooling Plan** | 4-hour forward DP schedule, continuous fan levels, mist duty cycles, and fallback audit. |
| `/compare` | **Compare** | Interactive 11-point Pareto trade-off curve and benchmark comparison (B1/B2/B3/Smart) executed in a Web Worker. |
| `/feeding` | **Feeding** | 24-hour diurnal feeder status schedule, heat peak window, and expert advisory cards `R1`–`R5`. |
| `/trends` | **Trends** | Multi-day historical telemetry charts (6h to 30d), dynamic flock age curve, and RFC-4180 CSV export. |
| `/alerts` | **Alerts** | Hardware health matrix, data quality flags, diagnostic remediation steps, and alert acknowledgments. |
| `/resources` | **Energy & Water** | Detailed kWh and water consumption by zone, cost savings in VND, and avoided $\text{CO}_2$ emissions. |
| `/insurance` | **Insurance** | 3-day consecutive parametric trigger tracker, payout audit, and manual flock mortality inspection log. |
| `/settings` | **Settings** | Optimizer comfort vs energy weight ($\lambda$), weather provider coordinates, and safety thresholds. |

---

## 🚀 Quick Start & Local Development

### Prerequisites
- [Node.js](https://nodejs.org/) v20.x or higher
- `npm` v10.x or higher

### Installation
```bash
# Clone the repository
git clone https://github.com/your-org/thermastock.git
cd thermastock

# Install dependencies
npm install
```

### Running Locally
```bash
# Start Next.js development server
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Quality Assurance & Testing
```bash
# Run TypeScript static analysis
npm run typecheck

# Run domain logic and algorithmic verification tests (M1 - M14)
npm test

# Build optimized production bundle
npm run build
```

---

## ☁️ Deployment to Vercel

ThermaStock is pre-configured for seamless zero-configuration deployment to [Vercel](https://vercel.com).

### Option 1: Vercel CLI (Recommended)
```bash
npm install -g vercel
vercel login
vercel
```

### Option 2: Git Integration
1. Push your repository to GitHub, GitLab, or Bitbucket.
2. Import the project in the [Vercel Dashboard](https://vercel.com/new).
3. Framework Preset: **Next.js**.
4. Configure Environment Variables (optional, for Live Mode):
   - `NEXT_PUBLIC_FIREBASE_DATABASE_URL`: `https://<your-project>.firebasedatabase.app`
   - `NEXT_PUBLIC_FIREBASE_API_KEY`: `<your-api-key>`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`: `<your-project-id>`
   - `NEXT_PUBLIC_FIREBASE_FARM_ID`: `<your-farm-id>`
5. Click **Deploy**.

For detailed architecture and setup guides, refer to:
- [Vercel Deployment Guide](./docs/vercel-deployment.md)
- [Live Mode & Firebase RTDB Guide](./docs/live-mode.md)

---

## 📚 Scientific Citations & Literature

- **`[S1]` Omomowo & Falayi (2021)**: *Temperature-Humidity Index and heat stress classification for broiler chickens* (citing Marai et al. 2001 & Duduyemi & Oseni 2012). CIGR Journal.
- **`[S2]` Gates et al. (1995)**: *Regional variation in temperature humidity index for poultry housing*. Transactions of the ASAE.
- **`[S3]` UGA Extension (Bulletin B 1287)**: *Broiler Production & Management*. University of Georgia.
- **`[S4]` Frontiers in Physiology (2022)**: *A review of heat stress in chickens. Part II: Nutritional and feeding strategies*.
- **`[S5]` Farming Portal (2020)**: *The effect of heat stress on broiler performance and mitigation strategies*.
- **`[S6]` Zootecnica International**: *Broiler management and feed formulation approaches in hot environments*.
- **`[S7]` Aviagen**: *Key Factors for Managing Tunnel Ventilation in Broilers*.
- **`[S8]` Furlan et al. (2000)**: *Air velocity and exposure time affect body surface and rectal temperature of broiler chickens*. JAPR.
- **`[S9]` Fabrico**: *VFD Energy Savings & Fan Affinity Laws*.
- **`[S10]` Open-Meteo**: *Open-Source Weather Forecast API* (Licensed under CC BY 4.0).

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
Weather forecast data provided by [Open-Meteo.com](https://open-meteo.com/) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
#   G S C  
 