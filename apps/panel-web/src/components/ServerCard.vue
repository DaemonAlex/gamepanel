<script setup lang="ts">
import { computed, ref } from "vue";
import type { ServerView } from "@gamepanel/shared";
import { barClass, copy, gib, pct, stateOf } from "../format.js";

const props = defineProps<{ server: ServerView; spark?: { cpu: number[]; players: number[] } | undefined }>();

// Last hour of CPU as a tiny line (one point a minute).
const sparkLine = computed(() => {
  const v = props.spark?.cpu ?? [];
  if (v.length < 2) return "";
  const top = Math.max(...v, 1);
  return v.map((n, i) => `${((i / (v.length - 1)) * 100).toFixed(1)},${(28 - (n / top) * 26).toFixed(1)}`).join(" ");
});
const peakPlayers = computed(() => Math.max(0, ...(props.spark?.players ?? [])));
const state = computed(() => stateOf(props.server));
const mem = computed(() => (props.server.stats ? pct(props.server.stats.memoryBytes, props.server.stats.memoryLimitBytes) : 0));
const copied = ref(false);

async function copyAddress() {
  copied.value = await copy(props.server.address);
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <article class="card">
    <RouterLink :to="`/servers/${server.id}`" class="head">
      <span class="pin" :class="state" aria-hidden="true"></span>
      <span class="name">{{ server.name }}</span>
      <span class="label state">{{ state }}</span>
    </RouterLink>
    <div class="addr">
      <span class="mono">{{ server.address }}</span>
      <button class="btn small" type="button" :aria-label="`Copy address of ${server.name}`" @click="copyAddress">
        {{ copied ? "Copied" : "Copy" }}
      </button>
    </div>
    <dl>
      <div><dt class="label">Type</dt><dd>{{ server.type }} {{ server.version }}</dd></div>
      <div>
        <dt class="label">Players</dt>
        <dd>{{ server.stats?.players ? `${server.stats.players.online} / ${server.stats.players.max}` : "-" }}</dd>
      </div>
      <div><dt class="label">CPU</dt><dd>{{ server.stats ? `${server.stats.cpuPercent}%` : "-" }}</dd></div>
      <div><dt class="label">Port</dt><dd class="mono">{{ server.port }}</dd></div>
    </dl>
    <div>
      <div class="row between">
        <span class="label">RAM</span>
        <span class="mono small-text">{{ server.stats ? `${gib(server.stats.memoryBytes)} of ${gib(server.stats.memoryLimitBytes)}` : `${server.memoryMb} MB heap` }}</span>
      </div>
      <div :class="barClass(mem)"><span :style="{ width: `${mem}%` }"></span></div>
    </div>
    <div v-if="sparkLine" class="spark">
      <span class="label">CPU, last hour</span>
      <span class="label">peak {{ peakPlayers }} players</span>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline :points="sparkLine" fill="none" stroke="var(--gold)" stroke-width="1.5" vector-effect="non-scaling-stroke" /></svg>
    </div>
    <p v-if="server.error" class="error">{{ server.error }}</p>
  </article>
</template>

<style scoped>
.card { background: var(--deep); border: 1px solid var(--line); padding: 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.head { display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--ink); }
.name { font: 900 20px var(--font); flex: 1; min-width: 0; overflow-wrap: anywhere; }
.state { white-space: nowrap; }
.addr { display: flex; gap: 8px; align-items: center; justify-content: space-between; background: var(--abyss); border-left: 3px solid var(--gold); padding: 6px 8px; }
.addr .mono { font-size: 14px; overflow-wrap: anywhere; min-width: 0; }
.btn.small { padding: 4px 10px; font-size: 13px; }
dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; }
dd { margin: 2px 0 0; font-size: 15px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.between { justify-content: space-between; margin-bottom: 4px; }
.small-text { font-size: 13px; color: var(--ink2); }
.spark { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; }
.spark svg { grid-column: 1 / -1; width: 100%; height: 30px; display: block; }
@media (max-width: 420px) { dl { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
