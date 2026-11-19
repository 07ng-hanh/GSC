"use client";

import React, { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  Calculator,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  FileCode,
  FileJson,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Thermometer,
  Trash2,
  Upload,
  Wind,
} from "lucide-react";
import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { ProvenanceBadge } from "@/components/shared/provenance-badge";
import { StressBadge } from "@/components/shared/stress-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppState } from "@/context/app-state";
import {
  calculateThi,
  classifyStressLevel,
  parseSpeciesProfileJson,
  serializeSpeciesProfile,
  validateSpeciesProfile,
  type CustomParamDefinition,
  type HeatIndexFormulaId,
  type SpeciesProfile,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

export function SpeciesView() {
  const { isHydrated, config, updateConfig } = useAppState();

  // Working draft of the profile
  const [draft, setDraft] = useState<SpeciesProfile>(config.speciesProfile);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [importJsonText, setImportJsonText] = useState<string>("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false);
  const [jsonCopyNotice, setJsonCopyNotice] = useState<boolean>(false);

  // Live Formula Test Calculator inputs
  const [testTempC, setTestTempC] = useState<number>(32);
  const [testRhPct, setTestRhPct] = useState<number>(65);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync draft when hydrated or reset
  const isDefaultBroiler = useMemo(() => {
    return draft.id === "broiler" && draft.isBuiltIn && !draft.isUnverifiedCustomProfile;
  }, [draft]);

  // Live calculated THI using the draft's formula configuration
  const testCalculatedThi = useMemo(() => {
    try {
      return Number(calculateThi(testTempC, testRhPct, draft.heatIndex).toFixed(2));
    } catch {
      return null;
    }
  }, [testTempC, testRhPct, draft.heatIndex]);

  const testStressLevel = useMemo(() => {
    if (testCalculatedThi === null) return null;
    return classifyStressLevel(testCalculatedThi, draft.classes);
  }, [testCalculatedThi, draft.classes]);

  const handleSaveDraft = () => {
    const val = validateSpeciesProfile(draft);
    if (!val.valid) {
      alert(`Validation failed:\n${val.errors.join("\n")}`);
      return;
    }
    const finalProfile: SpeciesProfile = {
      ...draft,
      isUnverifiedCustomProfile: draft.id !== "broiler" || !draft.isBuiltIn,
    };
    updateConfig((prev) => ({
      ...prev,
      speciesProfile: finalProfile,
    }));
    setDraft(finalProfile);
    setSaveNotice("Species profile saved and active across all controllers!");
    setTimeout(() => setSaveNotice(null), 4000);
  };

  const handleResetToBroiler = () => {
    if (
      window.confirm(
        "Reset species profile to the standard Ross 308 Broiler Chicken profile (Marai 2001 formula, Georgia UGA S3 age curve)?"
      )
    ) {
      updateConfig((prev) => ({
        ...prev,
        speciesProfile: BROILER_SPECIES_PROFILE,
      }));
      setDraft(BROILER_SPECIES_PROFILE);
      setSaveNotice("Reset to built-in Broiler Chicken profile.");
      setTimeout(() => setSaveNotice(null), 4000);
    }
  };

  const handleExportJson = () => {
    const jsonStr = serializeSpeciesProfile(draft);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `species-profile-${draft.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleOpenFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileUploaded = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setImportJsonText(text);
      setIsImportModalOpen(true);
      // Reset input value so same file can be chosen again if needed
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  const handleApplyImportedJson = () => {
    const res = parseSpeciesProfileJson(importJsonText);
    if (!res.valid || !res.profile) {
      setImportErrors(res.errors);
      return;
    }
    setImportErrors([]);
    const imported = res.profile;
    setDraft(imported);
    updateConfig((prev) => ({
      ...prev,
      speciesProfile: imported,
    }));
    setIsImportModalOpen(false);
    setSaveNotice(`Imported profile '${imported.name}' (${imported.id}) successfully applied!`);
    setTimeout(() => setSaveNotice(null), 4000);
  };

  // Add new Custom Param
  const handleAddCustomParam = () => {
    const newKey = `param_${Date.now().toString().slice(-4)}`;
    const newParam: CustomParamDefinition = {
      key: newKey,
      label: "New Parameter",
      unit: "",
      type: "number",
      defaultValue: 0,
      value: 0,
      showOnOverview: true,
      description: "Custom species or flock parameter.",
      source: "user",
    };
    setDraft((prev) => ({
      ...prev,
      customParams: [...prev.customParams, newParam],
    }));
  };

  const handleRemoveCustomParam = (idx: number) => {
    setDraft((prev) => ({
      ...prev,
      customParams: prev.customParams.filter((_, i) => i !== idx),
    }));
  };

  if (!isHydrated) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
        <div className="h-96 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  const ctrl = draft.controller;

  return (
    <div className="space-y-5">
      {/* Hidden File Input for JSON Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleFileUploaded}
      />

      {/* Top Banner & Profile Overview */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight">
                  Species Profile Manager (M16)
                </h1>
                {draft.isUnverifiedCustomProfile ? (
                  <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-900">
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-700" />
                    Custom Unverified Profile
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-900">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />
                    Built-in Broiler (Validated [S1–S6])
                  </span>
                )}
                <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-semibold">
                  ID: {draft.id}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground max-w-3xl">
                Configure species-specific thermal indices (Marai 2001, DB-WB, NRC 1971), dynamic programming controller parameters, age curve milestones, and custom livestock variables.
              </p>
            </div>

            {/* Quick Action Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOpenFilePicker}
                className="h-8 gap-1.5 text-xs"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>Import JSON</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleExportJson}
                className="h-8 gap-1.5 text-xs"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export JSON</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetToBroiler}
                disabled={isDefaultBroiler}
                className="h-8 gap-1.5 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset Built-in</span>
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveDraft}
                className="h-8 gap-1.5 text-xs bg-emerald-700 hover:bg-emerald-800 text-white font-semibold"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Save &amp; Apply</span>
              </Button>
            </div>
          </div>

          {saveNotice && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
              <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
              <span>{saveNotice}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-12">
        {/* Left Column: Heat Index Formula & Live Calculator (col-5) */}
        <div className="space-y-5 lg:col-span-5">
          {/* 1. Heat Index Formula Selection */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center justify-between">
                <span>Thermal Index Formula</span>
                <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-900 uppercase">
                  {draft.heatIndex.formulaId}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-muted-foreground">
                  Formula Model:
                </label>
                <select
                  aria-label="Heat Index Formula Model"
                  value={draft.heatIndex.formulaId}
                  onChange={(e) => {
                    const fid = e.target.value as HeatIndexFormulaId;
                    setDraft((prev) => ({
                      ...prev,
                      heatIndex: {
                        ...prev.heatIndex,
                        formulaId: fid,
                        params:
                          fid === "dbwb"
                            ? { w: 0.85, b: 0.15 }
                            : fid === "marai2001"
                              ? { a: 0.6, b: 0.4 }
                              : {},
                      },
                    }));
                  }}
                  className="w-full rounded border bg-background px-2.5 py-1.5 font-semibold text-foreground focus:outline-none"
                >
                  <option value="marai2001">
                    Marai et al. (2001) Poultry THI (°C) [S1 - Standard Broiler]
                  </option>
                  <option value="dbwb">
                    Dry-Bulb / Wet-Bulb Stull (2011) Combination [S1, S2]
                  </option>
                  <option value="nrc1971">
                    NRC (1971) Livestock Temperature-Humidity Index
                  </option>
                </select>
              </div>

              {/* Formula Explanation */}
              <div className="rounded-md border bg-muted/30 p-2.5 space-y-1 text-[11px]">
                {draft.heatIndex.formulaId === "marai2001" && (
                  <>
                    <div className="font-mono font-bold text-foreground">
                      THI = T - (0.31 - 0.31 × RH) × (T - 14.4)
                    </div>
                    <div className="text-muted-foreground">
                      Standard tropical broiler heat-stress equation (Duduyemi &amp; Oseni 2012, Marai 2001). Values: &lt;26 Comfort, 26–29 Stress, &gt;29 Severe.
                    </div>
                  </>
                )}
                {draft.heatIndex.formulaId === "dbwb" && (
                  <>
                    <div className="font-mono font-bold text-foreground">
                      THI = w × T_db + (1 - w) × T_wb (°C)
                    </div>
                    <div className="text-muted-foreground">
                      Linear combination of dry-bulb and wet-bulb temperature (Twb computed using Stull 2011 atan polynomial, ±0.3°C accuracy).
                    </div>
                    <div className="pt-1.5 flex items-center gap-2">
                      <span className="font-medium">Dry-bulb weight (w):</span>
                      <input
                        type="number"
                        min={0.1}
                        max={0.99}
                        step={0.05}
                        value={draft.heatIndex.params.w ?? 0.85}
                        onChange={(e) => {
                          const w = Number(e.target.value);
                          setDraft((prev) => ({
                            ...prev,
                            heatIndex: {
                              ...prev.heatIndex,
                              params: { w, b: Number((1 - w).toFixed(2)) },
                            },
                          }));
                        }}
                        className="w-20 rounded border bg-background px-2 py-0.5 font-mono text-center font-bold"
                      />
                    </div>
                  </>
                )}
                {draft.heatIndex.formulaId === "nrc1971" && (
                  <>
                    <div className="font-mono font-bold text-foreground">
                      THI = (1.8T+32) - (0.55 - 0.0055×RH) × (1.8T-26)
                    </div>
                    <div className="text-muted-foreground">
                      National Research Council (1971) general livestock equation on Fahrenheit scale.
                    </div>
                  </>
                )}
              </div>

              {/* Stress Classification Thresholds */}
              <div className="space-y-1.5 pt-1">
                <span className="font-semibold text-muted-foreground">
                  Stress Class Thresholds:
                </span>
                <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div className="rounded border border-emerald-300 bg-emerald-50/60 p-2 text-emerald-950 font-bold">
                    Comfort
                    <span className="block font-mono text-xs font-normal">
                      &lt; {draft.heatStressThreshold.value}
                    </span>
                  </div>
                  <div className="rounded border border-amber-300 bg-amber-50/60 p-2 text-amber-950 font-bold">
                    Heat Stress
                    <span className="block font-mono text-xs font-normal">
                      {draft.heatStressThreshold.value} – 29
                    </span>
                  </div>
                  <div className="rounded border border-red-300 bg-red-50/60 p-2 text-red-950 font-bold">
                    Severe
                    <span className="block font-mono text-xs font-normal">
                      &gt; 29
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Live Formula Test Calculator */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                <Calculator className="h-4 w-4 text-primary" />
                <span>Live Formula Calculator</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="font-medium text-muted-foreground">
                    Ambient Temp (°C):
                  </span>
                  <input
                    type="number"
                    min={10}
                    max={50}
                    step={0.5}
                    value={testTempC}
                    onChange={(e) => setTestTempC(Number(e.target.value))}
                    className="w-full rounded border bg-background px-2.5 py-1 font-mono font-bold"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium text-muted-foreground">
                    Relative Humidity (%):
                  </span>
                  <input
                    type="number"
                    min={10}
                    max={100}
                    step={1}
                    value={testRhPct}
                    onChange={(e) => setTestRhPct(Number(e.target.value))}
                    className="w-full rounded border bg-background px-2.5 py-1 font-mono font-bold"
                  />
                </label>
              </div>

              {/* Result Preview */}
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
                <div>
                  <div className="text-[11px] text-muted-foreground">
                    Calculated THI:
                  </div>
                  <div className="text-2xl font-extrabold font-mono text-foreground">
                    {testCalculatedThi !== null ? testCalculatedThi : "—"}
                  </div>
                </div>
                <div className="text-right space-y-1">
                  <div className="text-[11px] text-muted-foreground">
                    Class:
                  </div>
                  <StressBadge level={testStressLevel} size="md" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 3. Custom Species Parameters (customParams) */}
          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                <Sliders className="h-4 w-4 text-indigo-600" />
                <span>Custom Parameters ({draft.customParams.length})</span>
              </CardTitle>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddCustomParam}
                className="h-7 text-xs gap-1"
              >
                <Plus className="h-3 w-3" />
                Add Param
              </Button>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs">
              {draft.customParams.length === 0 ? (
                <div className="py-4 text-center text-muted-foreground">
                  No custom parameters defined. Click &ldquo;Add Param&rdquo; to create one.
                </div>
              ) : (
                draft.customParams.map((cp, idx) => (
                  <div
                    key={cp.key || idx}
                    className="rounded-lg border bg-card p-2.5 space-y-2 shadow-2xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-foreground text-xs flex items-center gap-1.5">
                        <input
                          type="text"
                          value={cp.label}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              customParams: prev.customParams.map((p, i) =>
                                i === idx ? { ...p, label: val } : p
                              ),
                            }));
                          }}
                          className="rounded border bg-background px-1.5 py-0.5 font-semibold text-xs w-36"
                        />
                        <span className="font-mono text-[10px] text-muted-foreground">
                          ({cp.key})
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveCustomParam(idx)}
                        className="text-muted-foreground hover:text-red-600 p-1"
                        title="Delete parameter"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <label className="space-y-0.5">
                        <span className="text-muted-foreground">Value:</span>
                        <input
                          type="number"
                          value={Number(cp.value)}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setDraft((prev) => ({
                              ...prev,
                              customParams: prev.customParams.map((p, i) =>
                                i === idx ? { ...p, value: val } : p
                              ),
                            }));
                          }}
                          className="w-full rounded border bg-background px-1.5 py-0.5 font-mono"
                        />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-muted-foreground">Unit:</span>
                        <input
                          type="text"
                          value={cp.unit ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              customParams: prev.customParams.map((p, i) =>
                                i === idx ? { ...p, unit: val } : p
                              ),
                            }));
                          }}
                          className="w-full rounded border bg-background px-1.5 py-0.5 font-mono"
                        />
                      </label>
                      <label className="flex items-center gap-1.5 pt-3">
                        <input
                          type="checkbox"
                          checked={cp.showOnOverview ?? false}
                          onChange={(e) => {
                            const chk = e.target.checked;
                            setDraft((prev) => ({
                              ...prev,
                              customParams: prev.customParams.map((p, i) =>
                                i === idx ? { ...p, showOnOverview: chk } : p
                              ),
                            }));
                          }}
                          className="rounded"
                        />
                        <span className="text-[10px] text-muted-foreground">
                          Show on Overview
                        </span>
                      </label>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Controller Parameters Editing (col-7) */}
        <div className="space-y-5 lg:col-span-7">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Cpu className="h-4 w-4 text-emerald-600" />
                  <span>Controller Physics &amp; Dynamic Programming Parameters</span>
                </span>
                <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-mono font-semibold">
                  Section 9 Spec
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              {/* Timing & Planning Horizon */}
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  1. Planning Horizon &amp; Resolution
                </span>
                <div className="grid grid-cols-3 gap-2.5">
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Horizon Hours (H):
                    </span>
                    <input
                      type="number"
                      min={2}
                      max={8}
                      value={ctrl.horizonHours.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            horizonHours: { ...prev.controller.horizonHours, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Step Interval (min):
                    </span>
                    <input
                      type="number"
                      min={5}
                      max={30}
                      step={5}
                      value={ctrl.stepMin.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            stepMin: { ...prev.controller.stepMin, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Replan Interval (min):
                    </span>
                    <input
                      type="number"
                      min={5}
                      max={60}
                      step={5}
                      value={ctrl.replanMin.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            replanMin: { ...prev.controller.replanMin, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                </div>
              </div>

              {/* Physical Gains & Thermal Inertia */}
              <div className="space-y-2 border-t pt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  2. House Thermal Physics &amp; Airflow Gains
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Thermal τ (min):
                    </span>
                    <input
                      type="number"
                      min={5}
                      max={60}
                      value={ctrl.tauMin.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            tauMin: { ...prev.controller.tauMin, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Vent Gain (°C):
                    </span>
                    <input
                      type="number"
                      step={0.1}
                      value={ctrl.gVent.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            gVent: { ...prev.controller.gVent, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Mist Drop (°C):
                    </span>
                    <input
                      type="number"
                      step={0.1}
                      value={ctrl.gMist.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            gMist: { ...prev.controller.gMist, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Curtain Drop (°C):
                    </span>
                    <input
                      type="number"
                      step={0.1}
                      value={ctrl.gCurtain.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            gCurtain: { ...prev.controller.gCurtain, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                </div>
              </div>

              {/* Wind-Chill & Tunnel Fan Velocity */}
              <div className="space-y-2 border-t pt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  3. Wind-Chill &amp; Misting Constraints [S7]
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Wind Chill (THI/m/s):
                    </span>
                    <input
                      type="number"
                      step={0.05}
                      value={ctrl.kWindChillPerMps.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            kWindChillPerMps: { ...prev.controller.kWindChillPerMps, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Full Speed v (m/s) [S7]:
                    </span>
                    <input
                      type="number"
                      step={0.1}
                      value={ctrl.vFullMps.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            vFullMps: { ...prev.controller.vFullMps, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Mist Min Speed (m/s):
                    </span>
                    <input
                      type="number"
                      step={0.1}
                      value={ctrl.mistMinAirSpeedMps.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            mistMinAirSpeedMps: { ...prev.controller.mistMinAirSpeedMps, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Mist Max RH% [S7]:
                    </span>
                    <input
                      type="number"
                      min={50}
                      max={95}
                      value={ctrl.mistMaxAmbientRH.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            mistMaxAmbientRH: { ...prev.controller.mistMaxAmbientRH, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                </div>
              </div>

              {/* Fan Levels Array */}
              <div className="space-y-2 border-t pt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  4. Fan Staging Levels (0.0 to 1.0)
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={ctrl.fanLevels.value.join(", ")}
                    onChange={(e) => {
                      const nums = e.target.value
                        .split(",")
                        .map((s) => Number(s.trim()))
                        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
                      if (nums.length >= 2) {
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            fanLevels: { ...prev.controller.fanLevels, value: nums },
                          },
                        }));
                      }
                    }}
                    className="w-full rounded border bg-background px-2.5 py-1.5 font-mono text-xs font-semibold"
                  />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Separate with commas (e.g. <code>0, 0.4, 0.6, 0.8, 1.0</code>).
                </div>
              </div>

              {/* Age Heat Load Adjustments */}
              <div className="space-y-2 border-t pt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  5. Age Heat Load Increment (Delta THI by Flock Age)
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {ctrl.deltaLoadByAge.value.map((load, i) => (
                    <div
                      key={load.ageDays}
                      className="rounded border bg-muted/20 p-2 text-center text-xs"
                    >
                      <div className="font-semibold text-muted-foreground">
                        Day {load.ageDays}:
                      </div>
                      <div className="mt-1 font-mono font-bold text-foreground">
                        +{load.deltaThi.toFixed(1)} THI
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* DP Optimization Penalties */}
              <div className="space-y-2 border-t pt-3">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  6. DP Switch Penalties &amp; Affinity Law Exponent
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Fan Switch Weight:
                    </span>
                    <input
                      type="number"
                      step={0.005}
                      value={ctrl.switchWeights.value.fan}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            switchWeights: {
                              ...prev.controller.switchWeights,
                              value: { ...prev.controller.switchWeights.value, fan: val },
                            },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Mist Switch Weight:
                    </span>
                    <input
                      type="number"
                      step={0.005}
                      value={ctrl.switchWeights.value.mist}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            switchWeights: {
                              ...prev.controller.switchWeights,
                              value: { ...prev.controller.switchWeights.value, mist: val },
                            },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Water Penalty:
                    </span>
                    <input
                      type="number"
                      step={0.005}
                      value={ctrl.waterWeight.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            waterWeight: { ...prev.controller.waterWeight, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Fan Law Exponent (κ):
                    </span>
                    <input
                      type="number"
                      step={0.5}
                      value={ctrl.kappa.value}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDraft((prev) => ({
                          ...prev,
                          controller: {
                            ...prev.controller,
                            kappa: { ...prev.controller.kappa, value: val },
                          },
                        }));
                      }}
                      className="w-full rounded border bg-background px-2 py-1 font-mono font-bold"
                    />
                  </label>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* JSON Import / Raw Editor Modal */}
      {isImportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col">
            <CardHeader className="p-4 pb-2 border-b">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Import / Inspect SpeciesProfile JSON</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsImportModalOpen(false)}
                  className="h-7 w-7 p-0"
                >
                  ✕
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3 flex-1 overflow-y-auto">
              <textarea
                value={importJsonText}
                onChange={(e) => {
                  setImportJsonText(e.target.value);
                  setImportErrors([]);
                }}
                placeholder="Paste valid SpeciesProfile JSON here..."
                rows={14}
                className="w-full rounded-md border bg-muted/30 p-2.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />

              {importErrors.length > 0 && (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900 space-y-1">
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4 text-red-600" />
                    Validation Errors ({importErrors.length}):
                  </div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {importErrors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
            <div className="p-4 border-t flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsImportModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleApplyImportedJson}
                className="bg-emerald-700 hover:bg-emerald-800 text-white"
              >
                Validate &amp; Apply Profile
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
