<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { MetricPoint, MetricRange } from "@gamepanel/shared";
import { api } from "../api.js";
import LineChart from "./LineChart.vue";

const props = defineProps<{ id: string }>();
const range = ref<MetricRange>("1h");
const points = ref<MetricPoint[]>([]);
const error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    points.value = await api.metrics(props.id, range.value);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
});
onUnmounted(() => clearInterval(timer));
watch(range, () => void load());

const series = (pick: (p: MetricPoint) => number | null) => points.value.map((p) => ({ t: p.t, v: pick(p) }));
const gb = (v: number) => `${(v / 2 ** 30).toFixed(2)} GB`;
const memLimit = computed(() => Math.max(0, ...points.value.map((p) => p.memLimitBytes)) || null);
</script>

<template>
  <section class="graphs">
    <div class="row head">
      <p class="label">Performance</p>
      <div class="ranges" role="group" aria-label="Time range">
        <button v-for="r in (['1h', '24h', '7d'] as const)" :key="r" type="button" :class="{ on: range === r }" :aria-pressed="range === r" @click="range = r">
          {{ r === "1h" ? "1 hour" : r === "24h" ? "24 hours" : "7 days" }}
        </button>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="grid">
      <LineChart title="TPS" :points="series((p) => p.tps)" :max="20" color="var(--ok)" :format="(v) => v.toFixed(1)" />
      <LineChart title="Tick time" :points="series((p) => p.mspt)" :limit="50" color="var(--ink2)" :format="(v) => `${v.toFixed(1)} ms`" />
      <LineChart title="Players" :points="series((p) => p.players)" color="var(--gold)" :format="(v) => String(Math.round(v))" />
      <LineChart title="CPU" :points="series((p) => p.cpu)" color="var(--gold)" :format="(v) => `${v.toFixed(1)}%`" />
      <LineChart title="RAM" :points="series((p) => p.memBytes)" :limit="memLimit" color="var(--ink2)" :format="gb" />
      <LineChart title="Disk" :points="series((p) => p.diskBytes)" color="var(--ink2)" :format="gb" />
    </div>
    <p class="muted small">Sampled every 30 seconds, kept 8 days. Dashed red lines: the RAM limit, and 50 ms (above it the server lags).</p>
  </section>
</template>

<style scoped>
.graphs { display: flex; flex-direction: column; gap: 10px; }
.head { justify-content: space-between; }
.head .label { margin: 0; }
.ranges { display: flex; gap: 4px; }
.ranges button { font: 600 12px var(--mono); padding: 5px 10px; background: transparent; color: var(--ink2); border: 1px solid var(--line); cursor: pointer; }
.ranges button.on { background: var(--gold); color: var(--sea); border-color: var(--gold); }
.ranges button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.small { font-size: 13px; margin: 0; }
</style>
