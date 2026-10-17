<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { PowerAction, ServerView } from "@gamepanel/shared";
import { api } from "../api.js";
import ConsolePanel from "../components/ConsolePanel.vue";
import { barClass, copy, gib, pct, stateOf, uptime } from "../format.js";

const props = defineProps<{ id: string }>();
const server = ref<ServerView | null>(null);
const error = ref("");
const busy = ref<PowerAction | null>(null);
const confirmKill = ref(false);
const copied = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    server.value = await api.server(props.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 5_000);
});
onUnmounted(() => clearInterval(timer));

const state = computed(() => (server.value ? stateOf(server.value) : "loading"));
const isUp = computed(() => ["running", "starting", "restarting"].includes(state.value));
const mem = computed(() => (server.value?.stats ? pct(server.value.stats.memoryBytes, server.value.stats.memoryLimitBytes) : 0));

async function power(action: PowerAction) {
  confirmKill.value = false;
  busy.value = action;
  try {
    await api.power(props.id, action);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

async function copyAddress() {
  if (!server.value) return;
  copied.value = await copy(server.value.address);
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <main class="wrap">
    <RouterLink to="/" class="label">&larr; All servers</RouterLink>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="server">
      <section class="head">
        <span class="pin big" :class="state" aria-hidden="true"></span>
        <div class="grow">
          <p class="label">{{ server.nodeName }} &middot; {{ server.type }} {{ server.version }}</p>
          <h1>{{ server.name }}</h1>
          <p class="muted">
            {{ state }}<template v-if="server.status?.startedAt && isUp"> &middot; up {{ uptime(server.status.startedAt) }}</template>
            <template v-if="server.stats?.version"> &middot; {{ server.stats.version }}</template>
          </p>
        </div>
      </section>

      <section class="addr">
        <span class="label">Address</span>
        <span class="mono big-addr">{{ server.address }}</span>
        <button class="btn" type="button" @click="copyAddress">{{ copied ? "Copied" : "Copy" }}</button>
      </section>

      <section class="panel row">
        <button class="btn gold" type="button" :disabled="isUp || !!busy" @click="power('start')">Start</button>
        <button class="btn" type="button" :disabled="!isUp || !!busy" @click="power('stop')">Stop</button>
        <button class="btn" type="button" :disabled="!isUp || !!busy" @click="power('restart')">Restart</button>
        <template v-if="!confirmKill">
          <button class="btn danger" type="button" :disabled="!isUp || !!busy" @click="confirmKill = true">Kill</button>
        </template>
        <template v-else>
          <span>Kill skips saving the world. Sure?</span>
          <button class="btn danger" type="button" @click="power('kill')">Yes, kill it</button>
          <button class="btn" type="button" @click="confirmKill = false">Cancel</button>
        </template>
        <span v-if="busy" class="muted">{{ busy }}...</span>
      </section>

      <section class="stats">
        <div class="panel">
          <p class="label">Players</p>
          <p class="num">{{ server.stats?.players ? `${server.stats.players.online} / ${server.stats.players.max}` : "-" }}</p>
          <p v-if="server.stats?.players?.names.length" class="muted small">{{ server.stats.players.names.join(", ") }}</p>
        </div>
        <div class="panel">
          <p class="label">CPU</p>
          <p class="num">{{ server.stats ? `${server.stats.cpuPercent}%` : "-" }}</p>
          <p class="muted small">{{ server.cpus }} cores allowed</p>
        </div>
        <div class="panel">
          <p class="label">RAM</p>
          <p class="num">{{ server.stats ? gib(server.stats.memoryBytes) : "-" }}</p>
          <div :class="barClass(mem)"><span :style="{ width: `${mem}%` }"></span></div>
          <p class="muted small">{{ server.memoryMb }} MB heap</p>
        </div>
        <div class="panel">
          <p class="label">Port</p>
          <p class="num mono">{{ server.port }}</p>
          <p class="muted small">{{ server.publicIp }}</p>
        </div>
      </section>

      <ConsolePanel :id="server.id" class="panel" />
    </template>
  </main>
</template>

<style scoped>
.head { display: flex; gap: 16px; align-items: center; }
.grow { flex: 1; min-width: 0; }
.head h1 { overflow-wrap: anywhere; }
.head p { margin: 0; }
.pin.big { width: 22px; height: 22px; }
.addr { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; background: var(--deep); border: 1px solid var(--line); border-left: 4px solid var(--gold); padding: 12px 14px; }
.big-addr { font-size: 18px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.stats p { margin: 0; }
.num { font: 900 26px var(--font); font-variant-numeric: tabular-nums; margin: 4px 0 6px !important; }
.small { font-size: 13px; }
</style>
