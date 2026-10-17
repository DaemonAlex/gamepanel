<script setup lang="ts">
import { computed, ref } from "vue";

// A small line chart: one series over time, area fill, latest point marked,
// value under the pointer. Missing values (null) leave a gap.
const props = withDefaults(
  defineProps<{
    title: string;
    points: { t: string; v: number | null }[];
    format: (v: number) => string;
    color?: string;
    // Fixed top of the scale (e.g. 20 for TPS); otherwise from the data.
    max?: number;
    // A reference line (e.g. the RAM limit).
    limit?: number | null;
  }>(),
  { color: "var(--gold)", limit: null },
);

const W = 300;
const H = 110;
const PAD = { l: 4, r: 4, t: 8, b: 4 };
const hover = ref<number | null>(null);

const values = computed(() => props.points.map((p) => p.v).filter((v): v is number => v !== null));
const top = computed(() => {
  const m = props.max ?? Math.max(...values.value, props.limit ?? 0, 0);
  return m > 0 ? m * (props.max ? 1 : 1.15) : 1;
});
const times = computed(() => props.points.map((p) => new Date(p.t).getTime()));
const t0 = computed(() => Math.min(...times.value));
const t1 = computed(() => Math.max(...times.value));
const x = (t: number) => PAD.l + (t1.value > t0.value ? ((t - t0.value) / (t1.value - t0.value)) * (W - PAD.l - PAD.r) : (W - PAD.l - PAD.r) / 2);
const y = (v: number) => PAD.t + (1 - v / top.value) * (H - PAD.t - PAD.b);

// Line segments split at gaps.
const segments = computed(() => {
  const segs: string[][] = [];
  let cur: string[] = [];
  props.points.forEach((p, i) => {
    if (p.v === null) {
      if (cur.length) segs.push(cur);
      cur = [];
      return;
    }
    cur.push(`${x(times.value[i]!).toFixed(1)},${y(p.v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur);
  return segs;
});
const areas = computed(() =>
  segments.value.map((s) => {
    const first = s[0]!.split(",")[0];
    const last = s[s.length - 1]!.split(",")[0];
    return `M${first},${H - PAD.b} L${s.join(" L")} L${last},${H - PAD.b} Z`;
  }),
);
const lastIndex = computed(() => {
  for (let i = props.points.length - 1; i >= 0; i--) if (props.points[i]!.v !== null) return i;
  return -1;
});
const shown = computed(() => (hover.value !== null ? hover.value : lastIndex.value));
const shownPoint = computed(() => (shown.value >= 0 ? props.points[shown.value] : undefined));

function onMove(e: MouseEvent) {
  const box = (e.currentTarget as SVGElement).getBoundingClientRect();
  const px = ((e.clientX - box.left) / box.width) * W;
  let best = -1;
  let dist = Infinity;
  props.points.forEach((p, i) => {
    if (p.v === null) return;
    const d = Math.abs(x(times.value[i]!) - px);
    if (d < dist) (dist = d), (best = i);
  });
  hover.value = best >= 0 ? best : null;
}

const timeLabel = (t: number) => {
  const spanH = (t1.value - t0.value) / 3_600_000;
  return new Date(t).toLocaleString(undefined, spanH > 30 ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit" });
};
</script>

<template>
  <figure class="chart">
    <figcaption>
      <span class="label">{{ title }}</span>
      <span class="val">{{ shownPoint && shownPoint.v !== null ? format(shownPoint.v) : "-" }}</span>
      <span v-if="hover !== null && shownPoint" class="muted when">{{ new Date(shownPoint.t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }}</span>
    </figcaption>
    <svg v-if="values.length" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`${title} over time`" @mousemove="onMove" @mouseleave="hover = null">
      <line v-for="f in [0.25, 0.5, 0.75]" :key="f" :x1="0" :x2="W" :y1="PAD.t + f * (H - PAD.t - PAD.b)" :y2="PAD.t + f * (H - PAD.t - PAD.b)" class="grid" />
      <line v-if="limit" :x1="0" :x2="W" :y1="y(limit)" :y2="y(limit)" class="limit" />
      <path v-for="(a, i) in areas" :key="`a${i}`" :d="a" :fill="color" class="area" />
      <polyline v-for="(s, i) in segments" :key="`l${i}`" :points="s.join(' ')" fill="none" :stroke="color" stroke-width="2" vector-effect="non-scaling-stroke" />
      <circle v-if="shown >= 0 && shownPoint && shownPoint.v !== null" :cx="x(times[shown]!)" :cy="y(shownPoint.v)" r="3.5" :fill="color" class="dot" />
    </svg>
    <p v-else class="empty muted">No data yet. Samples start when the server runs.</p>
    <div v-if="values.length" class="axis muted"><span>{{ timeLabel(t0) }}</span><span>{{ timeLabel(t1) }}</span></div>
  </figure>
</template>

<style scoped>
.chart { margin: 0; background: var(--deep); border: 1px solid var(--line); padding: 10px 12px 8px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
figcaption { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.val { font: 900 20px var(--font); font-variant-numeric: tabular-nums; margin-left: auto; }
.when { font-size: 12px; width: 100%; text-align: right; }
svg { width: 100%; height: 110px; display: block; cursor: crosshair; }
.grid { stroke: var(--line-soft); stroke-width: 1; vector-effect: non-scaling-stroke; }
.limit { stroke: var(--bad); stroke-width: 1; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
.area { opacity: 0.14; }
.dot { stroke: var(--deep); stroke-width: 2; }
.axis { display: flex; justify-content: space-between; font: 11px var(--mono); }
.empty { height: 110px; display: grid; place-items: center; margin: 0; font-size: 13px; text-align: center; }
</style>
