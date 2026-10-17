<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { Dashboard, PowerAction } from "@gamepanel/shared";
import { api } from "../api.js";
import { HardDrive, Megaphone, MemoryStick, OctagonAlert, Play, Plus, RotateCw, Search, Server, ShieldCheck, Square, TriangleAlert } from "lucide-vue-next";
import LineChart from "../components/LineChart.vue";
import ServerCard from "../components/ServerCard.vue";
import type { NodeMetricPoint } from "@gamepanel/shared";
import { barClass, gib, pct } from "../format.js";
import { session } from "../session.js";

const data = ref<Dashboard | null>(null);
const error = ref("");
const filter = ref("");
const message = ref("");
const notice = ref("");
const confirmAll = ref<PowerAction | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

const nodeHistory = ref<Record<string, NodeMetricPoint[]>>({});

async function load() {
  try {
    data.value = await api.dashboard();
    error.value = "";
    for (const n of data.value.nodes ?? []) {
      api.nodeMetrics(n.id, "24h").then((h) => (nodeHistory.value = { ...nodeHistory.value, [n.id]: h })).catch(() => {});
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(() => {
  void load();
  // Refresh while the page is open and visible.
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
});
onUnmounted(() => clearInterval(timer));

// Find servers by name, id, port, address, type or memory.
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const all = data.value?.servers ?? [];
  if (!q) return all;
  return all.filter((s) =>
    [s.name, s.id, String(s.port), s.address, s.publicIp, s.type, s.version, `${s.memoryMb}`, s.nodeName, s.ownerEmail].some((f) => f.toLowerCase().includes(q)),
  );
});

const running = computed(() => (data.value?.servers ?? []).filter((s) => s.status?.state === "running").length);
const players = computed(() => (data.value?.servers ?? []).reduce((n, s) => n + (s.stats?.players?.online ?? 0), 0));

async function doAll(action: PowerAction) {
  confirmAll.value = null;
  const r = await api.powerAll(action).catch((e: Error) => ({ results: [], error: e.message }));
  const failed = r.results.filter((x) => !x.ok).length;
  notice.value = "error" in r ? r.error : `${action}: ${r.results.length - failed} done${failed ? `, ${failed} failed` : ""}`;
  await load();
}

async function broadcast() {
  if (!message.value.trim()) return;
  try {
    const r = await api.broadcast(message.value.trim());
    notice.value = `Message sent to ${r.results.filter((x) => x.ok).length} running server(s)`;
    message.value = "";
  } catch (e) {
    notice.value = (e as Error).message;
  }
}
</script>

<template>
  <main class="wrap">
    <section class="title row">
      <div class="grow">
        <p class="label">The overworld</p>
        <h1>Servers</h1>
        <p v-if="data" class="muted">{{ data.servers.length }} server{{ data.servers.length === 1 ? "" : "s" }} &middot; {{ running }} running &middot; {{ players }} players online</p>
      </div>
      <RouterLink v-if="session.me.value?.role !== 'subuser'" to="/new" class="btn gold"><Plus /> New server</RouterLink>
    </section>

    <section v-if="data?.warnings.length" class="warnings" role="status" aria-live="polite">
      <component :is="w.serverId ? 'RouterLink' : 'div'" v-for="(w, i) in data.warnings" :key="i" :to="w.serverId ? `/servers/${w.serverId}` : undefined" class="warning" :class="w.level">
        <OctagonAlert v-if="w.level === 'bad'" class="ic-bad" aria-hidden="true" />
        <TriangleAlert v-else class="ic-gold" aria-hidden="true" />
        <span>{{ w.text }}</span>
      </component>
    </section>
    <p v-else-if="data" class="label allclear"><ShieldCheck />All clear: no warnings</p>

    <section class="grid">
      <ServerCard v-for="s in shown" :key="s.id" :server="s" :spark="data?.sparks[s.id]" />
    </section>

    <section v-if="data?.nodes" class="nodes">
      <article v-for="n in data.nodes" :key="n.id" class="panel node">
        <div class="row between">
          <h2 class="row"><Server class="ic-gold" /> {{ n.name }}</h2>
          <span class="label">{{ n.publicIp }} &middot; ports {{ n.portMin }}-{{ n.portMax }}</span>
        </div>
        <p v-if="n.error" class="error">{{ n.error }}</p>
        <template v-else-if="n.info">
          <div class="meter">
            <span class="label"><MemoryStick />RAM promised</span>
            <span class="mono">{{ gib(n.info.servers.allocatedMemoryBytes) }} of {{ gib(n.info.memoryBytes) }}</span>
            <div :class="barClass(pct(n.info.servers.allocatedMemoryBytes, n.info.memoryBytes))">
              <span :style="{ width: `${pct(n.info.servers.allocatedMemoryBytes, n.info.memoryBytes)}%` }"></span>
            </div>
          </div>
          <div class="meter">
            <span class="label"><HardDrive />Disk used</span>
            <span class="mono">{{ gib(n.info.disk.totalBytes - n.info.disk.freeBytes) }} of {{ gib(n.info.disk.totalBytes) }}</span>
            <div :class="barClass(pct(n.info.disk.totalBytes - n.info.disk.freeBytes, n.info.disk.totalBytes))">
              <span :style="{ width: `${pct(n.info.disk.totalBytes - n.info.disk.freeBytes, n.info.disk.totalBytes)}%` }"></span>
            </div>
          </div>
          <p class="muted small">{{ n.info.servers.running }} of {{ n.info.servers.total }} running &middot; {{ n.info.cpus }} CPUs</p>
          <div v-if="nodeHistory[n.id]?.length" class="node-graphs">
            <LineChart title="RAM promised, 24 h" :points="nodeHistory[n.id]!.map((p) => ({ t: p.t, v: p.memAllocatedBytes }))" :limit="n.info.memoryBytes" color="var(--gold)" :format="gib" />
            <LineChart title="Disk used, 24 h" :points="nodeHistory[n.id]!.map((p) => ({ t: p.t, v: p.diskUsedBytes }))" :limit="n.info.disk.totalBytes" color="var(--ink2)" :format="gib" />
          </div>
        </template>
      </article>
    </section>

    <section class="panel tools">
      <label class="label" for="filter"><Search />Find a server</label>
      <input id="filter" v-model="filter" type="search" placeholder="Name, port, IP, type, memory" />
      <form class="row" @submit.prevent="broadcast">
        <label class="label" for="broadcast"><Megaphone />Message to all servers</label>
        <input id="broadcast" v-model="message" maxlength="200" placeholder="Restart in 5 minutes" class="grow" />
        <button class="btn" type="submit"><Megaphone /> Send</button>
      </form>
      <div class="row">
        <span class="label">All servers</span>
        <template v-if="!confirmAll">
          <button class="btn" type="button" @click="confirmAll = 'start'"><Play /> Start all</button>
          <button class="btn" type="button" @click="confirmAll = 'restart'"><RotateCw /> Restart all</button>
          <button class="btn danger" type="button" @click="confirmAll = 'stop'"><Square /> Stop all</button>
        </template>
        <template v-else>
          <span>{{ confirmAll }} every server you can see?</span>
          <button class="btn gold" type="button" @click="doAll(confirmAll)">Yes, {{ confirmAll }} all</button>
          <button class="btn" type="button" @click="confirmAll = null">Cancel</button>
        </template>
      </div>
      <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    </section>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="muted">Loading the map...</p>
    <p v-if="data && !data.servers.length" class="panel muted">No servers yet. Use New server to place the first waypoint.</p>


  </main>
</template>

<style scoped>
.title { align-items: flex-end; }
.warnings { display: flex; flex-direction: column; gap: 6px; }
.warning { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--deep); border: 1px solid var(--line); border-left: 4px solid var(--warn); color: var(--ink); text-decoration: none; }
.warning.bad { border-left-color: var(--bad); }
.allclear { margin: 0; color: var(--ok); }
.node-graphs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
.grow { flex: 1; min-width: 0; }
.nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.node { display: flex; flex-direction: column; gap: 10px; }
.between { justify-content: space-between; }
.meter { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; }
.meter > div { grid-column: 1 / -1; }
.meter .mono { font-size: 13px; }
.small { font-size: 14px; margin: 0; }
.tools { display: flex; flex-direction: column; gap: 12px; }
.tools .row .label { min-width: 120px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
@media (max-width: 400px) { .grid, .nodes { grid-template-columns: 1fr; } }
</style>
