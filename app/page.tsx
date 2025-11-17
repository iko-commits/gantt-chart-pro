// @ts-nocheck
"use client";

import React, { useMemo, useState, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Download, Upload, Search, Filter, AlertTriangle, CalendarDays, Timer, Play, PlusCircle, Trash2, RotateCcw } from "lucide-react";
import Image from "next/image";
import { motion } from "framer-motion";
import * as htmlToImage from "html-to-image";
import * as XLSX from "xlsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RtTooltip,
} from "recharts";

/**
 * RCP Gantt Pro Viewer
 * - Single-file Excel ingestion (tasks + predecessors)
 * - Gantt with independent LEFT/RIGHT labels (Name | ID | Start | Finish | None)
 * - Toggle logic links with colored FS/SS/FF/SF curves and lag badges
 * - Timescale zoom with smart axis (days -> weeks -> months -> quarters -> years)
 * - Float distribution chart + KPIs + search + threshold filter
 */

function parseDate(d) {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t.getTime()) ? null : t;
}

function fmt(d) {
  if (!d) return "-";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

const sampleData = [
  { ActivityID: 101, TaskName: "Start-up & Mobilise", ES: "2024-09-09", EF: "2024-09-20", LS: "2024-09-09", LF: "2024-09-20", DurDays: 9, TotalFloat_d: 0, FreeFloat_d: 0, Milestone: false },
  { ActivityID: 205, TaskName: "Possession of Site", ES: "2025-03-06", EF: "2025-03-06", LS: "2025-03-06", LF: "2025-03-06", DurDays: 0, TotalFloat_d: 0, FreeFloat_d: 0, Milestone: true },
  { ActivityID: 410, TaskName: "Pipe Jacking Section A", ES: "2025-03-10", EF: "2025-05-02", LS: "2025-03-10", LF: "2025-05-08", DurDays: 39, TotalFloat_d: 4, FreeFloat_d: 2, Milestone: false },
  { ActivityID: 420, TaskName: "Shaft Construction A", ES: "2025-02-10", EF: "2025-03-07", LS: "2025-01-31", LF: "2025-02-26", DurDays: 20, TotalFloat_d: 0, FreeFloat_d: 0, Milestone: false },
  { ActivityID: 700, TaskName: "Commissioning", ES: "2026-06-10", EF: "2026-07-15", LS: "2026-06-10", LF: "2026-07-15", DurDays: 25, TotalFloat_d: 0, FreeFloat_d: 0, Milestone: false },
];

const DAY_MS = 24 * 60 * 60 * 1000;

// Normalize numeric/boolean fields coming from Excel to ensure bars render
function normalizeRow(r) {
  const parseNumLike = (v) => {
    if (v === undefined || v === null || v === "") return NaN;
    if (typeof v === "number") return v;
    const s = String(v).trim();
    const m = s.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  };

  // Duration
  const dur = parseNumLike(r.DurDays ?? r.Duration ?? r["Duration"]);

  // Total & Free float (support many header variants + fuzzy match)
  let tfRaw =
    r.TotalFloat_d ??
    r.TotalFloat ??
    r.TotalFloatDays ??
    r["Total Float"] ??
    r["Total Float (days)"] ??
    r["TotalFloat(d)"] ??
    r.Float ??
    r["Float"];

  if (tfRaw === undefined || tfRaw === null || tfRaw === "") {
    const kTF = Object.keys(r).find(
      (k) => /total/i.test(k) && /float/i.test(k)
    );
    if (kTF) tfRaw = r[kTF];
  }

  let ffRaw =
    r.FreeFloat_d ??
    r.FreeFloat ??
    r.FreeFloatDays ??
    r["Free Float"] ??
    r["Free Float (days)"] ??
    r["FreeFloat(d)"];

  if (ffRaw === undefined || ffRaw === null || ffRaw === "") {
    const kFF = Object.keys(r).find(
      (k) => /free/i.test(k) && /float/i.test(k)
    );
    if (kFF) ffRaw = r[kFF];
  }

  const tf = parseNumLike(tfRaw);
  const ff = parseNumLike(ffRaw);

  // Percent complete
  let pctRaw =
    r.PctComplete ??
    r["Percent Complete"] ??
    r["Percent_Complete"] ??
    r["% Complete"];
  let pct = parseNumLike(pctRaw);
  if (!isNaN(pct) && pct <= 1) pct = pct * 100; // handle 0–1 range
  if (isNaN(pct)) pct = 0;

  // WBS / outline level
  let wbsRaw = r.WBSLevel ?? r["WBS Level"] ?? r.OutlineLevel ?? r["Outline Level"];
  let WBSLevel = parseNumLike(wbsRaw);

  const msVal =
    typeof r.Milestone === "string"
      ? r.Milestone.trim().toLowerCase()
      : r.Milestone;
  const ms = msVal === true || msVal === "true" || dur === 0;

  const coerceDate = (d) => {
    if (!d) return undefined;
    const t = d instanceof Date ? d : new Date(d);
    return isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
  };

  const ES =
    r.ES ??
    r.Start ??
    r.StartDate ??
    r["Start Date"] ??
    r["Start_Date"];
  const EF =
    r.EF ??
    r.Finish ??
    r.FinishDate ??
    r["Finish Date"] ??
    r["Finish_Date"];
  const LS = r.LS ?? r.LateStart ?? undefined;
  const LF = r.LF ?? r.LateFinish ?? undefined;

  return {
    ...r,
    ES: coerceDate(ES),
    EF: coerceDate(EF),
    LS: coerceDate(LS),
    LF: coerceDate(LF),
    DurDays: isNaN(dur) ? 0 : dur,
    TotalFloat_d: tf,
    FreeFloat_d: ff,
    PctComplete: pct,
    Milestone: ms,
    WBSLevel: isNaN(WBSLevel) ? undefined : WBSLevel,
    ActivityID:
      (r.ActivityID ??
        r.ID ??
        r.UniqueID ??
        r["Unique ID"] ??
        r["UniqueID"]) !== undefined
        ? Number(
            r.ActivityID ??
              r.ID ??
              r.UniqueID ??
              r["Unique ID"] ??
              r["UniqueID"]
          )
        : undefined,
    TaskName: r.TaskName ?? r.Name ?? r["Task Name"] ?? r["Task"],
  };
}

function deriveDurationDays(row) {
  const dur = Number(row.DurDays);
  if (Number.isFinite(dur) && dur >= 0) return dur;
  const es = parseDate(row.ES);
  const ef = parseDate(row.EF);
  if (es && ef) return Math.max(0, Math.round((ef.getTime() - es.getTime()) / DAY_MS));
  return 0;
}

function toISODate(ms) {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

function normalizeRelType(type) {
  const t = String(type || "FS").toUpperCase();
  return ["FS", "SS", "FF", "SF"].includes(t) ? t : "FS";
}

function simulateScenario(rows, rels, impact) {
  if (!rows?.length) return [];
  const tasks = rows.map((row, idx) => {
    const id = Number(row.ActivityID);
    return {
      row,
      id,
      idx,
      duration: deriveDurationDays(row),
      baseES: parseDate(row.ES)?.getTime(),
      baseEF: parseDate(row.EF)?.getTime(),
      baseLS: parseDate(row.LS)?.getTime(),
      baseLF: parseDate(row.LF)?.getTime(),
      ES: undefined,
      EF: undefined,
      LS: undefined,
      LF: undefined,
      TotalFloat_d: Number(row.TotalFloat_d ?? 0),
      FreeFloat_d: Number(row.FreeFloat_d ?? 0),
    };
  });
  const idMap = new Map();
  for (const task of tasks) {
    if (Number.isFinite(task.id)) idMap.set(task.id, task);
  }
  if (!idMap.size) return rows.slice();
  const defaultStart = (() => {
    let min = Infinity;
    idMap.forEach((task) => {
      if (Number.isFinite(task.baseES)) min = Math.min(min, task.baseES);
    });
    return Number.isFinite(min) ? min : Date.now();
  })();
  idMap.forEach((task) => {
    if (!Number.isFinite(task.baseES)) task.baseES = defaultStart;
    if (!Number.isFinite(task.duration)) task.duration = 0;
    if (!Number.isFinite(task.baseEF)) task.baseEF = task.baseES + task.duration * DAY_MS;
  });
  if (impact && Number.isFinite(Number(impact.activityId))) {
    const hit = idMap.get(Number(impact.activityId));
    if (hit) {
      const delta = Number(impact.deltaDays) || 0;
      hit.duration = Math.max(0, hit.duration + delta);
    }
  }
  const edges = rels
    .filter((rel) => idMap.has(rel.PredID) && idMap.has(rel.SuccID))
    .map((rel) => ({ ...rel, RelType: normalizeRelType(rel.RelType) }));
  const succMap = new Map();
  const indegree = new Map(Array.from(idMap.values()).map((task) => [task.id, 0]));
  const push = (map, key, value) => {
    const arr = map.get(key) || [];
    arr.push(value);
    map.set(key, arr);
  };
  edges.forEach((rel) => {
    push(succMap, rel.PredID, rel);
    indegree.set(rel.SuccID, (indegree.get(rel.SuccID) ?? 0) + 1);
  });
  const queue = Array.from(idMap.values())
    .filter((task) => (indegree.get(task.id) ?? 0) === 0)
    .sort((a, b) => (a.baseES ?? 0) - (b.baseES ?? 0));
  const pending = new Map();
  const topo = [];
  while (queue.length) {
    const current = queue.shift();
    topo.push(current.id);
    const startReq = pending.get(current.id);
    const start = Number.isFinite(startReq)
      ? Math.max(startReq, current.baseES ?? defaultStart)
      : current.baseES ?? defaultStart;
    current.ES = start;
    current.EF = current.ES + current.duration * DAY_MS;
    for (const rel of succMap.get(current.id) || []) {
      const succ = idMap.get(rel.SuccID);
      if (!succ) continue;
      const lagMs = (Number(rel.Lag_d) || 0) * DAY_MS;
      let needed = current.EF + lagMs;
      if (rel.RelType === "SS") {
        needed = current.ES + lagMs;
      } else if (rel.RelType === "FF") {
        needed = current.EF + lagMs - succ.duration * DAY_MS;
      } else if (rel.RelType === "SF") {
        needed = current.ES + lagMs - succ.duration * DAY_MS;
      }
      const prev = pending.get(succ.id);
      pending.set(succ.id, prev !== undefined ? Math.max(prev, needed) : needed);
      const deg = (indegree.get(succ.id) ?? 0) - 1;
      indegree.set(succ.id, deg);
      if (deg === 0) {
        queue.push(succ);
        queue.sort((a, b) => (a.baseES ?? 0) - (b.baseES ?? 0));
      }
    }
  }
  idMap.forEach((task) => {
    if (!Number.isFinite(task.ES)) {
      task.ES = task.baseES ?? defaultStart;
      task.EF = task.ES + task.duration * DAY_MS;
    }
  });
  const topoOrder = topo.slice();
  idMap.forEach((task) => {
    if (!topoOrder.includes(task.id)) topoOrder.push(task.id);
  });
  const projectFinish = topoOrder.reduce((max, id) => {
    const t = idMap.get(id);
    if (!t) return max;
    const ef = t.EF ?? t.baseEF ?? max;
    return Math.max(max, ef);
  }, defaultStart);
  const reverse = topoOrder.slice().reverse();
  for (const id of reverse) {
    const task = idMap.get(id);
    if (!task) continue;
    const outgoing = succMap.get(id) || [];
    let lfLimit = Infinity;
    let lsLimit = Infinity;
    for (const rel of outgoing) {
      const succ = idMap.get(rel.SuccID);
      if (!succ) continue;
      const lagMs = (Number(rel.Lag_d) || 0) * DAY_MS;
      if (rel.RelType === "FS") {
        lfLimit = Math.min(lfLimit, (succ.ES ?? succ.baseES ?? projectFinish) - lagMs);
      } else if (rel.RelType === "FF") {
        lfLimit = Math.min(lfLimit, (succ.EF ?? (succ.ES + succ.duration * DAY_MS)) - lagMs);
      } else if (rel.RelType === "SS") {
        lsLimit = Math.min(lsLimit, (succ.ES ?? succ.baseES ?? projectFinish) - lagMs);
      } else if (rel.RelType === "SF") {
        lsLimit = Math.min(lsLimit, (succ.EF ?? (succ.ES + succ.duration * DAY_MS)) - lagMs);
      }
    }
    let lf = Number.isFinite(lfLimit) ? lfLimit : Math.max(task.EF ?? (task.baseEF ?? projectFinish), projectFinish);
    let ls = lf - task.duration * DAY_MS;
    if (Number.isFinite(lsLimit)) {
      ls = Math.min(ls, lsLimit);
      lf = ls + task.duration * DAY_MS;
    }
    if (!Number.isFinite(lf)) lf = task.EF ?? (task.baseEF ?? projectFinish);
    if (!Number.isFinite(ls)) ls = lf - task.duration * DAY_MS;
    task.LF = lf;
    task.LS = ls;
  }
  idMap.forEach((task) => {
    const tfMs = (task.LS ?? task.ES ?? defaultStart) - (task.ES ?? defaultStart);
    task.TotalFloat_d = Math.round(tfMs / DAY_MS);
    const outgoing = succMap.get(task.id) || [];
    let minConstraint = Infinity;
    for (const rel of outgoing) {
      const succ = idMap.get(rel.SuccID);
      if (!succ) continue;
      const lagMs = (Number(rel.Lag_d) || 0) * DAY_MS;
      if (rel.RelType === "FS") {
        minConstraint = Math.min(minConstraint, (succ.ES ?? succ.baseES ?? projectFinish) - lagMs);
      } else if (rel.RelType === "FF") {
        minConstraint = Math.min(minConstraint, (succ.EF ?? (succ.ES + succ.duration * DAY_MS)) - lagMs);
      }
    }
    if (minConstraint < Infinity) {
      const ffMs = minConstraint - (task.EF ?? (task.ES + task.duration * DAY_MS));
      task.FreeFloat_d = Math.max(0, Math.round(ffMs / DAY_MS));
    } else {
      task.FreeFloat_d = Math.max(0, task.TotalFloat_d);
    }
  });
  return rows.map((row) => {
    const id = Number(row.ActivityID);
    const task = idMap.get(id);
    if (!task) return row;
    const ES = toISODate(task.ES);
    const EF = toISODate(task.EF);
    const LS = toISODate(task.LS ?? task.baseLS);
    const LF = toISODate(task.LF ?? task.baseLF);
    return {
      ...row,
      ES: ES ?? row.ES,
      EF: EF ?? row.EF,
      LS: LS ?? row.LS,
      LF: LF ?? row.LF,
      DurDays: Math.round(task.duration * 100) / 100,
      TotalFloat_d: task.TotalFloat_d ?? row.TotalFloat_d,
      FreeFloat_d: task.FreeFloat_d ?? row.FreeFloat_d,
    };
  });
}

// Pure helper for tests and hook
function computeDomain(items) {
  if (!items?.length) {
    const scaleX = () => 0;
    return { min: null, max: null, scaleX, days: 0 };
  }
  const min = new Date(Math.min(...items.map((d) => parseDate(d.ES)?.getTime() ?? Infinity)));
  const max = new Date(Math.max(...items.map((d) => parseDate(d.EF)?.getTime() ?? -Infinity)));
  const pad = 1000 * 60 * 60 * 24 * 7;
  const minP = new Date(min.getTime() - pad);
  const maxP = new Date(max.getTime() + pad);
  const totalMs = Math.max(1, maxP.getTime() - minP.getTime());
  const scaleX = (date, width) => {
    const t = parseDate(date)?.getTime() ?? minP.getTime();
    return ((t - minP.getTime()) / totalMs) * (width - 160) + 160;
  };
  const days = Math.round((maxP - minP) / (1000 * 60 * 60 * 24));
  return { min: minP, max: maxP, scaleX, days };
}

function useScale(items) {
  return useMemo(() => computeDomain(items), [items]);
}

// Relationship parsing helpers (no-regex to avoid editor escaping issues)
function parseLinkToken(token, succId) {
  if (token === undefined || token === null) return null;
  const t = String(token).trim();
  if (!t) return null;
  let i = 0;
  while (i < t.length && t[i] >= '0' && t[i] <= '9') i++;
  const idStr = t.slice(0, i);
  const id = Number(idStr);
  if (!Number.isFinite(id)) return null;
  let rest = t.slice(i).trim();
  let RelType = 'FS';
  const maybeType = rest.slice(0,2).toUpperCase();
  if (["FS","SS","FF","SF"].includes(maybeType)) {
    RelType = maybeType;
    rest = rest.slice(2).trim();
  }
  let Lag_d = 0;
  const plus = rest.indexOf('+');
  const minus = rest.indexOf('-');
  let pos = -1; let sign = 1;
  if (plus !== -1 && (minus === -1 || plus < minus)) { pos = plus; sign = 1; }
  else if (minus !== -1) { pos = minus; sign = -1; }
  if (pos !== -1) {
    let j = pos + 1;
    let numStr = '';
    while (j < rest.length && rest[j] === ' ') j++;
    while (j < rest.length && rest[j] >= '0' && rest[j] <= '9') { numStr += rest[j]; j++; }
    if (numStr) Lag_d = sign * Number(numStr);
  }
  return { PredID: id, SuccID: Number(succId), RelType, Lag_d };
}
function buildLinksFromPredecessors(rows) {
  const edges = [];
  for (const r of rows) {
    const succ = r.ActivityID ?? r.ID ?? r["Unique ID"] ?? r["UniqueID"];
    if (!Number.isFinite(Number(succ))) continue;
    // Try common predecessor headers, otherwise fall back to any column containing 'pred'
    let predStr = r.Predecessors ?? r["Predecessor"] ?? r["Predecessors"] ?? r["Links"] ?? r["Dependencies"];
    if (!predStr) {
      const k = Object.keys(r).find(k => typeof r[k] === 'string' && /pred/i.test(k));
      if (k) predStr = r[k];
    }
    if (!predStr) continue;
    const parts = String(predStr).split(/[,;]+/);
    for (const p of parts) {
      const edge = parseLinkToken(p, Number(succ));
      if (edge) edges.push(edge);
    }
  }
  return edges;
}


function readRelationshipSheet(wb) {
  const prefer = ["Relationships","Links","Logic","CPM_Relationships","Predecessor_Successor"];
  const hit = wb.SheetNames.find(n => prefer.includes(n));
  if (!hit) return [];
  const sheet = wb.Sheets[hit];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const edges = [];
  for (const e of raw) {
    const PredID = Number(e.PredID ?? e.Predecessor ?? e.Pred ?? e.From ?? e["Pred ID"]);
    const SuccID = Number(e.SuccID ?? e.Successor ?? e.Succ ?? e.To ?? e["Succ ID"]);
    const RelType = String(e.RelType ?? e.Type ?? 'FS').toUpperCase();
    const Lag_d = Number(e.Lag_d ?? e.Lag ?? 0);
    if (Number.isFinite(PredID) && Number.isFinite(SuccID)) edges.push({ PredID, SuccID, RelType, Lag_d });
  }
  return edges;
}

function LegendItem({ color, label }) {
  return (
    <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm" style={{ background: color }} />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

function KPI({ label, value, icon: Icon, tone = "" }) {
  return (
    <Card className={"shadow-sm rounded-2xl " + (tone || "") }>
      <CardContent className="p-4 flex items-center gap-3">
        <div className="p-2 rounded-xl bg-muted"><Icon className="w-5 h-5" /></div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function Gantt({ data, threshold, leftLabel = "name", rightLabel = "none", showLinks = false, rels = [], zoom = 1, labelWidth = 220 }) {
  const wrapperRef = useRef(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    if (wrapperRef.current) obs.observe(wrapperRef.current);
    return () => obs.disconnect();
  }, []);

  const { min, max } = useScale(data);
  const today = new Date();
  const showToday = min && max && today >= min && today <= max;
  const rowHeight = 28;
  const barRadius = 8;
  const axisHeight = 48;
  const chartTop = 16;
  const chartHeight = chartTop + (data.length + 1) * rowHeight + 20;
  const idColumnWidth = 60;
  const leftPadding = 12;
  const gapBetween = 12;
  const effectiveLabelWidth = Math.max(80, Math.min(400, labelWidth));
  const leftGutter = leftPadding + idColumnWidth + gapBetween + effectiveLabelWidth;
  const rightPadding = 80;
  const domainMin = min ? min.getTime() : Date.now();
  const domainMax = max ? max.getTime() : domainMin + 1;
  const totalMs = Math.max(1, domainMax - domainMin);
  const chartWidth = Math.max(200, width - leftGutter - rightPadding);
  const baseScale = (date) => {
    const t = parseDate(date)?.getTime();
    const clamped = Number.isFinite(t) ? t : domainMin;
    const ratio = (clamped - domainMin) / totalMs;
    return leftGutter + ratio * chartWidth;
  };
  const scaleXz = (date) => {
    const base = baseScale(date);
    return leftGutter + (base - leftGutter) * zoom;
  };

  const buildAxis = useMemo(() => {
    if (!min || !max) return { ticks: [], fmt: () => "" };
    let mode = 'month';
    if (zoom >= 3) mode = 'day';
    else if (zoom >= 2) mode = 'week';
    else if (zoom >= 1) mode = 'month';
    else if (zoom >= 0.8) mode = 'quarter';
    else mode = 'year';
    const ticks = [];
    const d = new Date(min);
    if (mode === 'day') {
      while (d <= max) { ticks.push(new Date(d)); d.setDate(d.getDate() + 1); }
    } else if (mode === 'week') {
      const day = d.getDay(); const delta = (day === 0 ? 6 : day - 1); d.setDate(d.getDate() - delta);
      while (d <= max) { ticks.push(new Date(d)); d.setDate(d.getDate() + 7); }
    } else if (mode === 'month') {
      d.setDate(1); while (d <= max) { ticks.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    } else if (mode === 'quarter') {
      d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1); while (d <= max) { ticks.push(new Date(d)); d.setMonth(d.getMonth() + 3); }
    } else {
      d.setMonth(0,1); while (d <= max) { ticks.push(new Date(d)); d.setFullYear(d.getFullYear() + 1); }
    }
    const fmtTick = (t) => {
      if (mode === 'day') return t.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
      if (mode === 'week') return 'Wk ' + getISOWeek(t) + ' ' + t.getFullYear().toString().slice(-2);
      if (mode === 'month') return t.toLocaleString(undefined, { month: 'short', year: '2-digit' });
      if (mode === 'quarter') return 'Q' + (Math.floor(t.getMonth()/3)+1) + ' ' + t.getFullYear().toString().slice(-2);
      return String(t.getFullYear());
    };
    return { ticks, fmt: fmtTick };
  }, [min, max, zoom]);
  function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
  }

  // Hover chain lookup
  const [hoverId, setHoverId] = useState(null);
  const idSet = useMemo(() => new Set(data.map(d => Number(d.ActivityID))), [data]);
  const graph = useMemo(() => {
    const succ = new Map();
    const pred = new Map();
    const push = (m, k, v) => { const arr = m.get(k) || []; arr.push(v); m.set(k, arr); };
    for (const e of rels) {
      if (!idSet.has(e.PredID) || !idSet.has(e.SuccID)) continue;
      push(succ, e.PredID, e.SuccID);
      push(pred, e.SuccID, e.PredID);
    }
    return { succ, pred };
  }, [rels, idSet]);
  const relatedIds = useMemo(() => {
    if (!hoverId) return new Set();
    const seen = new Set([hoverId]);
    const q = [hoverId];
    while (q.length) {
      const n = q.shift();
      for (const m of (graph.succ.get(n) || [])) if (!seen.has(m)) { seen.add(m); q.push(m); }
      for (const m of (graph.pred.get(n) || [])) if (!seen.has(m)) { seen.add(m); q.push(m); }
    }
    return seen;
  }, [hoverId, graph]);

  const linkColor = { FS: "#7c3aed", SS: "#10b981", FF: "#06b6d4", SF: "#f97316" };

  return (
    <div className="rounded-2xl border bg-card">
      <div ref={wrapperRef} className="w-full overflow-auto relative max-h-[70vh] rounded-2xl">
        <div className="sticky top-0 z-10 bg-card">
          <svg width={width} height={axisHeight} className="block pointer-events-none">
            <rect x={0} y={0} width={width} height={axisHeight} className="fill-muted" />
            {buildAxis.ticks.map((tick, idx) => (
              <g key={idx}>
                <line
                  x1={scaleXz(tick, width)}
                  x2={scaleXz(tick, width)}
                  y1={0}
                  y2={axisHeight}
                  className="stroke-muted-foreground/30"
                />
                <text
                  x={scaleXz(tick, width) + 6}
                  y={axisHeight - 18}
                  className="fill-foreground text-[12px]"
                >
                  {buildAxis.fmt(tick)}
                </text>
              </g>
            ))}
            {showToday && (
              <g>
                <line
                  x1={scaleXz(today, width)}
                  x2={scaleXz(today, width)}
                  y1={0}
                  y2={axisHeight}
                  stroke="#111827"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                />
                <text
                  x={scaleXz(today, width) + 6}
                  y={14}
                  className="text-[11px]"
                  fill="#111827"
                >
                  Today
                </text>
              </g>
            )}
          </svg>
        </div>
        <svg width={width} height={chartHeight} className="block">
          {/* Arrowhead defs for links */}
          <defs>
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" />
            </marker>
          </defs>

          {/* Vertical grid + today line */}
          {buildAxis.ticks.map((tick, idx) => (
            <line
              key={idx}
              x1={scaleXz(tick, width)}
              x2={scaleXz(tick, width)}
              y1={0}
              y2={chartHeight}
              className="stroke-muted-foreground/20"
            />
          ))}
          {showToday && (
            <line
              x1={scaleXz(today, width)}
              x2={scaleXz(today, width)}
              y1={0}
              y2={chartHeight}
              stroke="#111827"
              strokeDasharray="4 4"
              strokeWidth={1.5}
            />
          )}

          {/* Logic links (behind bars) */}
          {showLinks && (() => {
          const idxById = new Map();
          data.forEach((d, i) => idxById.set(Number(d.ActivityID), i));
          const elems = [];
          for (const e of rels) {
            const i1 = idxById.get(e.PredID);
            const i2 = idxById.get(e.SuccID);
            if (i1 == null || i2 == null) continue;
            const t1 = data[i1];
            const t2 = data[i2];
            const es1 = parseDate(t1.ES), ef1 = parseDate(t1.EF);
            const es2 = parseDate(t2.ES), ef2 = parseDate(t2.EF);

            // Anchor points by relationship type
            let xStart = scaleXz(ef1, width), yStart = chartTop + i1 * rowHeight + 14;
            let xEnd = scaleXz(es2, width), yEnd = chartTop + i2 * rowHeight + 14;
            const rt = (e.RelType || "FS").toUpperCase();
            if (rt === "SS") { xStart = scaleXz(es1, width); xEnd = scaleXz(es2, width); }
            else if (rt === "FF") { xStart = scaleXz(ef1, width); xEnd = scaleXz(ef2, width); }
            else if (rt === "SF") { xStart = scaleXz(es1, width); xEnd = scaleXz(ef2, width); }

            const midX = (xStart + xEnd) / 2;
            const active = !hoverId || relatedIds.has(e.PredID) || relatedIds.has(e.SuccID);
            const stroke = linkColor[rt] || "currentColor";
            const d = "M " + xStart + " " + yStart + " C " + midX + " " + yStart + ", " + midX + " " + yEnd + ", " + xEnd + " " + yEnd;
            elems.push(
              <g key={String(e.PredID) + "-" + String(e.SuccID)} opacity={active ? 0.9 : 0.15}>
                <path d={d} fill="none" stroke={stroke} strokeWidth={active ? 2 : 1} markerEnd="url(#arrowhead)" />
                {e.Lag_d ? (
                  <text x={midX} y={(yStart + yEnd) / 2 - 4} className="text-[10px]" fill={stroke}>
                    {rt}{e.Lag_d >= 0 ? "+" : ""}{e.Lag_d}d
                  </text>
                ) : null}
              </g>
            );
          }
          return <g>{elems}</g>;
        })()}

        {/* Rows */}
        {data.map((t, i) => {
          const es = parseDate(t.ES);
          const ef = parseDate(t.EF);
          const x1 = scaleXz(es, width);
          const x2 = scaleXz(ef, width);
          const y = chartTop + i * rowHeight + 6;
          const tfVal = Number(t.TotalFloat_d);
          const isCritical = tfVal <= 0;
          const isNear = !isCritical && tfVal > 0 && tfVal <= Number(threshold);
          const color = isCritical ? "#ef4444" : isNear ? "#f59e0b" : "#3b82f6";
          const ms = !!t.Milestone || Number(t.DurDays) === 0;
          const pct = Math.max(0, Math.min(100, Number(t.PctComplete ?? 0)));
          const idText = t.ActivityID != null ? String(t.ActivityID) : "";

          const leftText = (() => {
          switch (leftLabel) {
            case "name":
              return String(t.TaskName ?? "");
            case "id":
              return "";
            case "es":
              return fmt(es);
            case "ef":
              return fmt(ef);
            case "pct":
              return isNaN(pct) ? "" : pct.toFixed(0) + "%";
            case "none":
            default:
              return "";
          }
        })();
          const leftColumnX = idText ? leftPadding + idColumnWidth + gapBetween : leftPadding;
          const labelMaxWidth = Math.max(40, effectiveLabelWidth - 10);
          const rightText = (() => {
          switch (rightLabel) {
            case "name":
              return String(t.TaskName ?? "");
            case "id":
              return String(t.ActivityID ?? "");
            case "es":
              return fmt(es);
            case "ef":
              return fmt(ef);
            case "pct":
              return isNaN(pct) ? "" : pct.toFixed(0) + "%";
            case "none":
            default:
              return "";
          }
        })();

          return (
            <TooltipProvider delayDuration={80} key={t.ActivityID}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <g onMouseEnter={() => setHoverId(t.ActivityID)} onMouseLeave={() => setHoverId(null)} opacity={hoverId ? (relatedIds.has(t.ActivityID) ? 1 : 0.35) : 1}>
                    {/* ID column */}
                    {idText && (
                      <text x={leftPadding} y={y + 12} className="fill-foreground text-[12px] font-mono truncate" style={{ maxWidth: idColumnWidth - 8 }}>
                        {idText}
                      </text>
                    )}

                    {/* left label / task name */}
                    {leftText && (
                      <text x={leftColumnX} y={y + 12} className="fill-foreground text-[12px] truncate" style={{ maxWidth: labelMaxWidth }}>
                        {leftText}
                      </text>
                    )}

                    {/* bar or milestone */}
                    {!ms ? (
                      <>
                        <motion.rect
                          initial={{ opacity: 0, x: x1 - 8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.4, delay: i * 0.005 }}
                          x={x1}
                          y={y}
                          width={Math.max(6, x2 - x1)}
                          height={16}
                          rx={barRadius}
                          ry={barRadius}
                          style={{
                            fill: color,
                            opacity: 0.25,
                            stroke:
                              hoverId && relatedIds.has(t.ActivityID)
                                ? "#111827"
                                : "none",
                            strokeWidth:
                              hoverId && relatedIds.has(t.ActivityID) ? 1 : 0,
                          }}
                        />
                        {pct > 0 && (
                          <rect
                            x={x1}
                            y={y}
                            width={Math.max(6, x2 - x1) * (pct / 100)}
                            height={16}
                            rx={barRadius}
                            ry={barRadius}
                            style={{ fill: color }}
                          />
                        )}
                      </>
                    ) : (
                      <motion.path
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.3 }}
                        d={"M " + x1 + " " + (y + 8) + " l 8 -8 l 8 8 l -8 8 z"}
                        style={{
                          fill: color,
                          stroke:
                            hoverId && relatedIds.has(t.ActivityID)
                              ? "#111827"
                              : "none",
                          strokeWidth:
                            hoverId && relatedIds.has(t.ActivityID) ? 1 : 0,
                        }}
                      />
                    )}

                    {/* right label */}
                    {rightText && (
                      <text x={ms ? x1 + 20 : x2 + 8} y={y + 12} className="fill-foreground text-[12px] truncate" style={{ maxWidth: 220 }}>
                        {rightText}
                      </text>
                    )}
                  </g>
                </TooltipTrigger>
                <TooltipContent className="rounded-xl">
                  <div className="text-sm space-y-1">
                    <div className="font-medium">{t.ActivityID} — {t.TaskName}</div>
                    <div className="grid grid-cols-2 gap-3 text-muted-foreground">
                      <div>
                        <div>ES: <span className="text-foreground">{fmt(es)}</span></div>
                        <div>EF: <span className="text-foreground">{fmt(ef)}</span></div>
                      </div>
                      <div>
                        <div>LS: <span className="text-foreground">{fmt(parseDate(t.LS))}</span></div>
                        <div>LF: <span className="text-foreground">{fmt(parseDate(t.LF))}</span></div>
                      </div>
                    </div>
                    <div className="flex gap-3 pt-1">
                      <Badge variant="secondary" className="rounded-full">Dur {t.DurDays}d</Badge>
                      <Badge variant="outline" className="rounded-full">TF {t.TotalFloat_d}d</Badge>
                      <Badge variant="outline" className="rounded-full">FF {t.FreeFloat_d}d</Badge>
                      {ms && <Badge className="rounded-full">Milestone</Badge>}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </svg>
    </div>
  </div>
  );
}

function FloatChart({ data }) {
  const bins = useMemo(() => {
    const map = new Map();
    data.forEach((d) => {
      const tf = Number(d.TotalFloat_d ?? 0);
      const key = tf > 20 ? ">20" : String(tf);
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([tf, count]) => ({ tf, count })).sort((a,b) => {
      if (a.tf === ">20" && b.tf !== ">20") return 1;
      if (b.tf === ">20" && a.tf !== ">20") return -1;
      return Number(a.tf) - Number(b.tf);
    });
  }, [data]);

  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 pb-2"><Timer className="w-4 h-4" /><div className="font-medium">Float distribution</div></div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bins}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="tf" tickLine={false} axisLine={false} label={{ value: "Total Float (days)", position: "insideBottom", dy: 8 }} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
              <RtTooltip />
              <Bar dataKey="count" radius={[6,6,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Page() {
  const [rows, setRows] = useState(sampleData);
  const [simRows, setSimRows] = useState(null);
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(5);
  const [filter, setFilter] = useState("all");
  const [leftLabel, setLeftLabel] = useState("name");
  const [rightLabel, setRightLabel] = useState("none");
  const [showLinks, setShowLinks] = useState(false);
  const [rels, setRels] = useState([]);
  const [wbsFilter, setWbsFilter] = useState("all");
  const [zoom, setZoom] = useState(1);
  const [linksNotice, setLinksNotice] = useState("");
  const [fileName, setFileName] = useState("Sample schedule");
  const [scenarioActivity, setScenarioActivity] = useState("");
  const [scenarioMode, setScenarioMode] = useState("delay");
  const [scenarioDays, setScenarioDays] = useState(10);
  const [scenarioTitle, setScenarioTitle] = useState("");
  const [scenarioLibrary, setScenarioLibrary] = useState([]);
  const [activeScenario, setActiveScenario] = useState(null);
  const [scenarioStatus, setScenarioStatus] = useState("");
  const [isSimulating, setIsSimulating] = useState(false);
  const [labelColumnWidth, setLabelColumnWidth] = useState(220);
  const exportRef = useRef(null);
  const activeRows = simRows ?? rows;
  const activityOptions = useMemo(() => {
    return rows
      .filter((r) => Number.isFinite(Number(r.ActivityID)))
      .map((r) => ({
        id: Number(r.ActivityID),
        label: `${r.ActivityID} — ${r.TaskName || "Untitled"}`,
      }))
      .sort((a, b) => a.id - b.id);
  }, [rows]);
  const scenarioFormValid = Boolean(scenarioActivity && Math.abs(Number(scenarioDays)) > 0);
  const maxScenariosReached = scenarioLibrary.length >= 10;

  // KPIs
  const kpis = useMemo(() => {
    const total = activeRows.length;
    const crit = activeRows.filter((r) => Number(r.TotalFloat_d) === 0).length;
    const near = activeRows.filter((r) => Number(r.TotalFloat_d) > 0 && Number(r.TotalFloat_d) <= threshold).length;
    const ms = activeRows.filter((r) => r.Milestone || Number(r.DurDays) === 0).length;
    const start = new Date(Math.min(...activeRows.map((r) => parseDate(r.ES)?.getTime() ?? Infinity)));
    const finish = new Date(Math.max(...activeRows.map((r) => parseDate(r.EF)?.getTime() ?? -Infinity)));
    return { total, crit, near, ms, start, finish };
  }, [activeRows, threshold]);

  const wbsLevels = useMemo(() => {
    const set = new Set();
    activeRows.forEach((r) => {
      const lv = Number(r.WBSLevel ?? r["WBS Level"]);
      if (!isNaN(lv)) set.add(lv);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [activeRows]);

  // Filters
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let s = activeRows;
    if (wbsFilter !== "all") {
      s = s.filter((r) => String(r.WBSLevel ?? r["WBS Level"]) === String(wbsFilter));
    }
    if (q) {
      s = s.filter(
        (r) =>
          String(r.ActivityID).includes(q) ||
          (r.TaskName ?? "").toLowerCase().includes(q)
      );
    }
    const tfVal = (r) => Number(r.TotalFloat_d);
    if (filter === "critical") s = s.filter((r) => tfVal(r) <= 0);
    if (filter === "near") s = s.filter((r) => tfVal(r) > 0 && tfVal(r) <= threshold);
    if (filter === "non") s = s.filter((r) => tfVal(r) > threshold);
    if (filter === "milestones")
      s = s.filter((r) => r.Milestone === true || Number(r.DurDays) === 0);
    return s;
  }, [activeRows, query, filter, threshold, wbsFilter]);

  const handleUploadXLSX = async (file) => {
    setFileName(file?.name || "Uploaded schedule");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const names = wb.SheetNames;
    const prefer = [
      'Schedule - CPM Results','CPM_Schedule_Results','CPM Results','Schedule_Results',
      'Activities','Tasks','Task_Table'
    ];
    let sheetName = names.find(n => prefer.includes(n)) ?? names[0];
    const sheet = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const mapped = raw.map(r => {
      if (!r.ES && (r.Start || r['Start'])) r.ES = r.ES || r.Start || r['Start'];
      if (!r.EF && (r.Finish || r['Finish'])) r.EF = r.EF || r.Finish || r['Finish'];
      if (!('DurDays' in r) && (r.Duration || r['Duration'])) {
        const s = String(r.Duration || r['Duration']).toLowerCase();
        const m = s.match(/(-?[0-9]+)/);
        r.DurDays = m ? Number(m[1]) : Number(r.Duration || 0);
      }
      return r;
    });
    const cleaned = mapped.map(normalizeRow);
    setRows(cleaned);
    setSimRows(null);
    setActiveScenario(null);
    setScenarioStatus("");
    setScenarioActivity("");
    setScenarioTitle("");
    setScenarioMode("delay");
    setScenarioDays(10);

    // relationships: prefer dedicated sheet, else parse Predecessors column
    let edges = readRelationshipSheet(wb);
    if (!edges.length) edges = buildLinksFromPredecessors(mapped);
    setRels(edges);
    setShowLinks(edges.length > 0);
    setLinksNotice(edges.length ? "" : "No relationships found in workbook (no dedicated sheet or Predecessors column). Links are hidden.");
  };

  const exportPNG = async () => {
    if (!exportRef.current) return;
    const node = exportRef.current;
    const dataUrl = await htmlToImage.toPng(node, { pixelRatio: 2 });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "schedule-visualization.png";
    a.click();
  };

  const runScenario = async (scenario) => {
    if (!scenario || !Number.isFinite(Number(scenario.activityId))) {
      setScenarioStatus("Select a valid activity ID and impact before running a scenario.");
      return;
    }
    const exists = rows.some((r) => Number(r.ActivityID) === Number(scenario.activityId));
    if (!exists) {
      setScenarioStatus(`Activity ${scenario.activityId} is not present in the current dataset.`);
      return;
    }
    setIsSimulating(true);
    setScenarioStatus("Re-running forward/backward passes...");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const simulated = simulateScenario(rows, rels, scenario);
    setSimRows(simulated);
    setActiveScenario(scenario);
    setIsSimulating(false);
    setScenarioStatus(
      `Scenario "${scenario.title}" applied (${scenario.deltaDays >= 0 ? "+" : ""}${scenario.deltaDays}d on activity ${scenario.activityId}).`
    );
  };

  const clearScenarioView = () => {
    setSimRows(null);
    setActiveScenario(null);
    setScenarioStatus("Scenario view reset. Showing baseline schedule.");
  };

  const handleRunScenario = async () => {
    if (!scenarioFormValid) {
      setScenarioStatus("Choose an activity and an impact greater than 0 days.");
      return;
    }
    const impactDays = Math.abs(Number(scenarioDays));
    const deltaDays = scenarioMode === "delay" ? impactDays : -impactDays;
    const scenario = {
      id: `adhoc-${Date.now()}`,
      title: scenarioTitle.trim() || `Scenario for #${scenarioActivity}`,
      activityId: Number(scenarioActivity),
      deltaDays,
      createdAt: Date.now(),
    };
    await runScenario(scenario);
  };

  const handleSaveScenario = () => {
    if (!scenarioFormValid) {
      setScenarioStatus("Choose an activity and impact before saving the scenario.");
      return;
    }
    if (maxScenariosReached) {
      setScenarioStatus("Scenario library full (10). Delete one to add a new scenario.");
      return;
    }
    const impactDays = Math.abs(Number(scenarioDays));
    const deltaDays = scenarioMode === "delay" ? impactDays : -impactDays;
    const scenario = {
      id: `scenario-${Date.now()}`,
      title: scenarioTitle.trim() || `Scenario ${scenarioLibrary.length + 1}`,
      activityId: Number(scenarioActivity),
      deltaDays,
      createdAt: Date.now(),
    };
    setScenarioLibrary((prev) => [...prev, scenario]);
    setScenarioStatus(`Scenario "${scenario.title}" saved.`);
  };

  const handleDeleteScenario = (id) => {
    setScenarioLibrary((prev) => prev.filter((scenario) => scenario.id !== id));
  };

  // ---- Tiny runtime tests (console; no hooks inside) ----
  useEffect(() => {
    const t1 = normalizeRow({ Duration: "10 days", Start: "2025-01-01", Finish: "2025-01-15", ID: 1, Name: "Test" });
    console.assert(t1.DurDays === 10, "normalizeRow should parse Duration string to DurDays");
    console.assert(!!t1.ES && !!t1.ES && !!t1.EF, "normalizeRow should map Start/Finish to ES/EF");

    const t2 = normalizeRow({ DurDays: 0, Milestone: "true", ES: "2025-02-01", EF: "2025-02-01", ActivityID: 2, TaskName: "MS" });
    console.assert(t2.Milestone === true, "normalizeRow should set Milestone true when DurDays=0 or flag true");

    const dom = computeDomain([{ ES: "2025-01-01", EF: "2025-01-10" }, { ES: "2025-01-05", EF: "2025-01-20" }]);
    console.assert(!!dom.min && !!dom.max && typeof dom.scaleX === 'function', "computeDomain should return min/max/scaleX");
  }, []);

  return (
    <div className="p-5 space-y-4">
      {/* Dashboard */}
      <div className="pb-4 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Image
            src="/RCP_Logo_Black.png"
            alt="RCP logo"
            width={140}
            height={40}
            priority
            className="h-10 w-auto object-contain"
          />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Gantt Viewer Pro</h1>
            <p className="text-sm text-muted-foreground">{fileName || "Sample schedule"}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={exportPNG} variant="secondary" className="rounded-2xl"><Download className="w-4 h-4 mr-2"/>Export PNG</Button>
        </div>
      </div>

      {/* Notice if workbook lacked links */}
      {linksNotice && (
        <div className="text-sm text-amber-600">Heads up: {linksNotice}</div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Activities" value={kpis.total} icon={Filter} />
        <KPI label="Critical (TF=0)" value={kpis.crit} icon={AlertTriangle} tone="ring-1 ring-red-200/60" />
        <KPI label={`Near-critical (<= ${threshold}d)`} value={kpis.near} icon={AlertTriangle} tone="ring-1 ring-amber-200/60" />
        <KPI label="Milestones" value={kpis.ms} icon={CalendarDays} />
      </div>

      {/* Controls */}
      <Card className="rounded-2xl">
        <CardContent className="p-4 grid gap-3 md:grid-cols-8">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground"/>
            <Input placeholder="Search by ID or Task name" value={query} onChange={(e)=>setQuery(e.target.value)} className="rounded-xl" />
          </div>
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-muted-foreground"/>
            <div className="w-full">
              <div className="text-xs text-muted-foreground mb-1">Near-critical threshold: {threshold}d</div>
              <Slider value={[threshold]} onValueChange={(v)=>setThreshold(v[0])} min={1} max={20} step={1} className="px-2" />
            </div>
          </div>
          <Tabs value={filter} onValueChange={setFilter} className="w-full">
            <TabsList className="rounded-xl w-full flex flex-wrap gap-2 bg-muted/40 p-1">
              <TabsTrigger className="flex-1 min-w-[90px] justify-center" value="all">All</TabsTrigger>
              <TabsTrigger className="flex-1 min-w-[90px] justify-center" value="critical">Critical</TabsTrigger>
              <TabsTrigger className="flex-1 min-w-[90px] justify-center" value="near">Near</TabsTrigger>
              <TabsTrigger className="flex-1 min-w-[90px] justify-center" value="non">Non</TabsTrigger>
              <TabsTrigger className="flex-1 min-w-[90px] justify-center" value="milestones">Milestones</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground w-24">Left label</div>
            <Select value={leftLabel} onValueChange={setLeftLabel}>
              <SelectTrigger className="rounded-xl"><SelectValue placeholder="Name" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="id">ID</SelectItem>
                <SelectItem value="es">Start Date</SelectItem>
                <SelectItem value="ef">Finish Date</SelectItem>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="pct">Percent complete</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground w-24">Right label</div>
            <Select value={rightLabel} onValueChange={setRightLabel}>
              <SelectTrigger className="rounded-xl"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="id">ID</SelectItem>
                <SelectItem value="es">Start Date</SelectItem>
                <SelectItem value="ef">Finish Date</SelectItem>
                <SelectItem value="pct">Percent complete</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground w-24">Logic links</div>
            <Switch checked={showLinks} onCheckedChange={setShowLinks} />
          </div>
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground w-24">WBS Level</div>
            <Select value={wbsFilter} onValueChange={setWbsFilter}>
              <SelectTrigger className="rounded-xl"><SelectValue placeholder="All levels" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {wbsLevels.map((lv) => (
                  <SelectItem key={lv} value={String(lv)}>Level {lv}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <Timer className="w-4 h-4 text-muted-foreground"/>
            <div className="w-full">
              <div className="text-xs text-muted-foreground mb-1">Timescale zoom: {zoom.toFixed(2)}x</div>
              <Slider value={[zoom]} onValueChange={(v)=>setZoom(Number(v[0]))} min={0.5} max={4} step={0.1} className="px-2" />
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-xs text-muted-foreground mb-1">Name column width: {labelColumnWidth}px</div>
            <Slider value={[labelColumnWidth]} onValueChange={(v)=>setLabelColumnWidth(Number(v[0]))} min={140} max={360} step={10} className="px-2" />
          </div>
        </CardContent>
      </Card>

      {/* Data ingestion */}
      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-col md:flex-row gap-3 items-start md:items-center justify-between">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="rounded-full">Data</Badge>
            <div className="text-sm text-muted-foreground">Upload a single Excel export that includes tasks and predecessors.</div>
          </div>
          <div className="flex gap-2">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <Upload className="w-4 h-4"/>
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={async (e)=>{
                const file = e.target.files?.[0];
                if (!file) return;
                await handleUploadXLSX(file);
              }} />
              <span className="text-sm">Upload Excel</span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Scenario lab */}
      <Card className="rounded-2xl border-dashed">
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold">Scenario lab</div>
              <p className="text-xs text-muted-foreground">Select an activity, apply a delay/acceleration, then re-run CPM. Save up to 10 scenarios.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {activeScenario && (
                <Badge variant="outline" className="rounded-full">
                  Active: {activeScenario.title}
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                onClick={clearScenarioView}
                disabled={!simRows}
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                Reset
              </Button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Activity ID</div>
              <Select value={scenarioActivity} onValueChange={setScenarioActivity}>
                <SelectTrigger className="rounded-xl">
                  <SelectValue placeholder="Select activity" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {activityOptions.map((opt) => (
                    <SelectItem key={opt.id} value={String(opt.id)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Impact</div>
              <div className="flex gap-2">
                <Select value={scenarioMode} onValueChange={setScenarioMode}>
                  <SelectTrigger className="rounded-xl w-32">
                    <SelectValue placeholder="Impact" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delay">Delay</SelectItem>
                    <SelectItem value="accelerate">Accelerate</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  className="rounded-xl"
                  value={scenarioDays}
                  onChange={(e) => setScenarioDays(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="Days"
                />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Scenario title</div>
              <Input
                className="rounded-xl"
                placeholder="e.g. Rain delay"
                value={scenarioTitle}
                onChange={(e) => setScenarioTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Button
                className="rounded-2xl"
                onClick={handleRunScenario}
                disabled={!scenarioFormValid || isSimulating}
              >
                <Play className="w-4 h-4 mr-2" />
                {isSimulating ? "Simulating..." : "Run scenario"}
              </Button>
              <Button
                className="rounded-2xl"
                type="button"
                variant="secondary"
                onClick={handleSaveScenario}
                disabled={!scenarioFormValid || maxScenariosReached}
              >
                <PlusCircle className="w-4 h-4 mr-2" />
                Save to library
              </Button>
            </div>
          </div>
          {scenarioStatus && <div className="text-xs text-muted-foreground">{scenarioStatus}</div>}
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                Scenario library ({scenarioLibrary.length}/10)
              </div>
              <Badge variant="secondary" className="rounded-full">
                {isSimulating ? "Running CPM..." : simRows ? "Scenario view" : "Baseline"}
              </Badge>
            </div>
            {scenarioLibrary.length === 0 ? (
              <div className="text-xs text-muted-foreground">No saved scenarios yet. Configure an impact and click save.</div>
            ) : (
              <div className="space-y-2">
                {scenarioLibrary.map((scenario) => (
                  <div
                    key={scenario.id}
                    className="flex flex-col gap-2 rounded-2xl border p-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <div className="text-sm font-medium">{scenario.title}</div>
                      <div className="text-xs text-muted-foreground">
                        Activity {scenario.activityId} ·{" "}
                        {scenario.deltaDays >= 0 ? `Delay +${scenario.deltaDays}d` : `Accelerate ${Math.abs(scenario.deltaDays)}d`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="rounded-full"
                        variant={activeScenario?.id === scenario.id ? "default" : "outline"}
                        onClick={() => runScenario(scenario)}
                        disabled={isSimulating}
                      >
                        <Play className="w-3 h-3 mr-1" />
                        {activeScenario?.id === scenario.id ? "Active" : "Run"}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="rounded-full"
                        onClick={() => handleDeleteScenario(scenario.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Legends */}
      <div className="flex flex-nowrap items-center gap-4 overflow-x-auto">
        <LegendItem color="#ef4444" label="Critical (TF=0)"/>
        <LegendItem color="#f59e0b" label={`Near-critical (TF <= ${threshold}d)`}/>
        <LegendItem color="#3b82f6" label="Non-critical"/>
        <LegendItem color="#111827" label="Milestone"/>
        <LegendItem color="#7c3aed" label="FS link"/>
        <LegendItem color="#10b981" label="SS link"/>
        <LegendItem color="#06b6d4" label="FF link"/>
        <LegendItem color="#f97316" label="SF link"/>
      </div>
      </div>

      {/* Main viz export container */}
      <div ref={exportRef} className="space-y-4">
        <Gantt data={filtered} threshold={threshold} leftLabel={leftLabel} rightLabel={rightLabel} showLinks={showLinks} rels={rels} zoom={zoom} labelWidth={labelColumnWidth} />
        <FloatChart data={filtered} />
      </div>

      <p className="text-xs text-muted-foreground">Tip: toggle links and hover a task to highlight its connected chain. Export PNG for reporting.</p>
    </div>
  );
}
