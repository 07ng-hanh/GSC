# Vercel Deployment & Production Guide

This document provides step-by-step instructions for deploying **ThermaStock** to [Vercel](https://vercel.com), configuring server caching, and setting up environment variables.

---

## 1. Prerequisites

- A [Vercel](https://vercel.com) account.
- A GitHub, GitLab, or Bitbucket repository containing the ThermaStock source code.
- Node.js v20.x or higher installed locally (if deploying via the Vercel CLI).

---

## 2. Deploying via Vercel Dashboard (Zero-Config)

1. **Import Project**:
   - Go to [vercel.com/new](https://vercel.com/new).
   - Select your Git repository (`thermastock`).

2. **Configure Project Settings**:
   - **Framework Preset**: `Next.js` (detected automatically).
   - **Root Directory**: `./` (default).
   - **Build Command**: `npm run build` (or `next build`).
   - **Output Directory**: `.next` (default).
   - **Install Command**: `npm install`.

3. **Environment Variables** (Optional, for Live Mode):
   Under **Settings $\to$ Environment Variables**, configure:
   ```ini
   NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://<your-project>-default-rtdb.asia-southeast1.firebasedatabase.app
   NEXT_PUBLIC_FIREBASE_API_KEY=<your-api-key>
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<your-project>.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=<your-project-id>
   NEXT_PUBLIC_FIREBASE_FARM_ID=farm-01
   ```
   > *Note*: If environment variables are omitted, ThermaStock boots smoothly in **Simulation Mode** with full functionality across all 6 scenarios.

4. **Deploy**:
   - Click **Deploy**.
   - Vercel automatically builds all 13 static and dynamic routes (`/`, `/cooling-plan`, `/compare`, `/feeding`, `/trends`, `/alerts`, `/resources`, `/insurance`, `/settings`, `/api/forecast`).

---

## 3. Deploying via Vercel CLI

```bash
# 1. Install Vercel CLI globally
npm install -g vercel

# 2. Authenticate
vercel login

# 3. Deploy preview build
vercel

# 4. Deploy directly to production
vercel --prod
```

---

## 4. Serverless Edge & Route Optimizations

### 1. `/api/forecast` Caching
The `/api/forecast` route handles Open-Meteo weather lookups with server-side caching:
- **Cache-Control Header**: `s-maxage=2700, stale-while-revalidate=900` (45-minute server edge cache, 15-minute background revalidation).
- **Graceful Fallback**: If Open-Meteo returns rate limits ($> 10,000$ calls/day) or network timeouts, the route falls back to stale cache entries marked `stale: true`, ensuring zero frontend outages.

### 2. Web Worker Offloading (`/compare`)
The comparison suite (evaluating 11 Pareto points across 4 controllers on the 2-state Plant model) runs entirely inside a dedicated client Web Worker (`src/workers/comparison.worker.ts`), keeping the main UI thread at 60 FPS.

### 3. Responsive Mobile Viewports
All navigation items, 2D house diagrams, tables, Recharts visualizations, and modal dialogues support responsive fluid layouts down to $320\text{ px}$ mobile screens.

---

## 5. Post-Deployment Verification Checklist

After deployment succeeds on your `*.vercel.app` URL:
- [ ] **Overview Page (`/`)**: Verify the 2D chicken coop rendering and real-time sensor cards.
- [ ] **Cooling Plan (`/cooling-plan`)**: Check the 4-hour forward DP lookahead and Open-Meteo attribution footer (`[S10]`).
- [ ] **Compare Page (`/compare`)**: Click **Run Benchmark Suite**; verify the Pareto frontier and B1/B2/B3 baseline chart render.
- [ ] **Feeding Page (`/feeding`)**: Toggle between `normal`, `hot_day`, and `heatwave` scenarios to verify the diurnal feeder pause window.
- [ ] **Trends Page (`/trends`)**: Test the flock age target curve toggle and download a 672-row CSV export.
- [ ] **Alerts Page (`/alerts`)**: Test alert acknowledgment and verify sensor fault diagnostics.
- [ ] **Energy & Water (`/resources`)**: Check the zone energy consumption chart and utility savings calculations in VND.
- [ ] **Insurance Page (`/insurance`)**: Check the 3-day consecutive streak tracker and log a sample mortality entry.
- [ ] **Simulation Speed**: Verify speed toggling ($1\times, 60\times, 600\times$) and pause/play controls.
