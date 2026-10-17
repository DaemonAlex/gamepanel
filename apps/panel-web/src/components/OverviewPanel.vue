<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ServerInfo, ServerView } from "@gamepanel/shared";
import { api } from "../api.js";
import { copy, gib, uptime } from "../format.js";
import GraphsPanel from "./GraphsPanel.vue";

const props = defineProps<{ server: ServerView }>();
const info = ref<ServerInfo | null>(null);
const error = ref("");
const copied = ref<"address" | "share" | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    info.value = await api.info(props.server.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
});
onUnmounted(() => clearInterval(timer));

const p = computed(() => info.value?.properties ?? {});
const plainText = (t: string) => t.replace(/§[0-9a-fk-orx]/gi, "").replace(/\\u00a7[0-9a-fk-or]/gi, "");
const motd = computed(() => plainText(p.value["motd"] ?? ""));
const mcVersion = computed(() => info.value?.build?.match(/MC: ([\d.]+)/)?.[1] ?? props.server.version);
const whitelist = computed(() => p.value["white-list"] === "true");
const up = computed(() => props.server.status?.state === "running");

// Text an owner can paste to a friend.
const shareText = computed(
  () =>
    `Join ${props.server.name} on Minecraft Java Edition ${mcVersion.value}:\n` +
    `1. Open Minecraft ${mcVersion.value} (Java Edition)\n` +
    `2. Multiplayer > Add Server\n` +
    `3. Server Address: ${props.server.address}\n` +
    (whitelist.value ? `You need to be on the whitelist first: send your Minecraft name to the owner.\n` : ""),
);

async function doCopy(what: "address" | "share") {
  copied.value = (await copy(what === "address" ? props.server.address : shareText.value)) ? what : null;
  setTimeout(() => (copied.value = null), 1500);
}

const tpsClass = (t: number) => (t >= 19 ? "ok" : t >= 15 ? "warn" : "bad");
const crashed = computed(() => {
  const e = info.value?.lastExit;
  return e && (e.code !== 0 || e.oomKilled) ? e : null;
});
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// Skin heads come from mc-heads.net, by player id when known.
const head = (pl: { name: string; uuid: string | null }) => `https://mc-heads.net/avatar/${encodeURIComponent(pl.uuid ?? pl.name)}/40`;
const yesNo = (v: string | undefined) => (v === "true" ? "on" : v === "false" ? "off" : (v ?? "-"));
</script>

<template>
  <section class="ov">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <article class="panel conn">
      <p class="label">Connection info</p>
      <div class="addr-row">
        <span class="mono addr">{{ server.address }}</span>
        <button class="btn gold" type="button" @click="doCopy('address')">{{ copied === "address" ? "Copied" : "Copy address" }}</button>
      </div>
      <dl class="facts">
        <div><dt class="label">Edition</dt><dd>Java</dd></div>
        <div><dt class="label">Minecraft</dt><dd>{{ mcVersion }}</dd></div>
        <div><dt class="label">Whitelist</dt><dd :class="whitelist ? 'warn' : ''">{{ whitelist ? "on: invite only" : "off: anyone can join" }}</dd></div>
        <div><dt class="label">IP and port</dt><dd class="mono">{{ server.publicIp }}:{{ server.port }}</dd></div>
      </dl>
      <details>
        <summary class="label">Join steps to send a friend</summary>
        <pre class="share mono">{{ shareText }}</pre>
        <button class="btn" type="button" @click="doCopy('share')">{{ copied === "share" ? "Copied" : "Copy join steps" }}</button>
      </details>
    </article>

    <div class="tiles">
      <div class="panel tile">
        <p class="label">TPS 1m / 5m / 15m</p>
        <p v-if="info?.live?.tps" class="num">
          <span v-for="(t, i) in info.live.tps" :key="i" :class="tpsClass(t)">{{ t.toFixed(1) }}<span v-if="i < 2" class="muted"> / </span></span>
        </p>
        <p v-else class="num muted">-</p>
        <p class="muted small">20 is perfect</p>
      </div>
      <div class="panel tile">
        <p class="label">Tick time</p>
        <p class="num" :class="info?.live?.msptAvg != null && info.live.msptAvg > 50 ? 'bad' : ''">{{ info?.live?.msptAvg != null ? `${info.live.msptAvg} ms` : "-" }}</p>
        <p class="muted small">under 50 ms keeps 20 TPS</p>
      </div>
      <div class="panel tile">
        <p class="label">Players</p>
        <p class="num">{{ info?.live ? `${info.live.online} / ${info.live.max}` : server.stats?.players ? `${server.stats.players.online} / ${server.stats.players.max}` : "-" }}</p>
        <p class="muted small">{{ p["online-mode"] === "true" ? "real accounts only" : "offline mode" }}</p>
      </div>
      <div class="panel tile">
        <p class="label">Up time</p>
        <p class="num">{{ up ? uptime(server.status?.startedAt) : "stopped" }}</p>
        <p class="muted small">{{ info?.restartCount ?? 0 }} automatic restarts</p>
      </div>
      <div class="panel tile">
        <p class="label">CPU</p>
        <p class="num">{{ server.stats ? `${server.stats.cpuPercent}%` : "-" }}</p>
        <p class="muted small">{{ server.cpus }} cores allowed</p>
      </div>
      <div class="panel tile">
        <p class="label">RAM</p>
        <p class="num">{{ server.stats ? gib(server.stats.memoryBytes) : "-" }}</p>
        <p class="muted small">of {{ server.stats ? gib(server.stats.memoryLimitBytes) : `${server.memoryMb} MB heap` }}</p>
      </div>
    </div>

    <GraphsPanel :id="server.id" />

    <p v-if="crashed" class="panel bad-box">
      Last stop was not clean ({{ crashed.oomKilled ? "ran out of memory" : `exit code ${crashed.code}` }}) on {{ when(crashed.at) }}.
    </p>

    <article class="panel">
      <p class="label">Online now</p>
      <div v-if="info?.live?.players.length" class="players">
        <div v-for="pl in info.live.players" :key="pl.name" class="player">
          <img :src="head(pl)" :alt="`${pl.name}'s skin`" width="40" height="40" loading="lazy" />
          <span>{{ pl.name }}</span>
        </div>
      </div>
      <p v-else class="muted">{{ up ? "Nobody online right now." : "The server is stopped." }}</p>
    </article>

    <div class="cols">
      <article class="panel">
        <p class="label">Server</p>
        <dl class="list">
          <div><dt>Type</dt><dd>{{ server.type }}</dd></div>
          <div><dt>Build</dt><dd class="mono">{{ info?.build ?? server.version }}</dd></div>
          <div><dt>Java</dt><dd>{{ info?.java ?? "-" }}</dd></div>
          <div><dt>MOTD</dt><dd>{{ motd || "-" }}</dd></div>
          <div><dt>Game mode</dt><dd>{{ p["gamemode"] ?? "-" }}</dd></div>
          <div><dt>Difficulty</dt><dd>{{ p["difficulty"] ?? "-" }}</dd></div>
          <div><dt>PvP</dt><dd>{{ yesNo(p["pvp"]) }}</dd></div>
          <div><dt>View distance</dt><dd>{{ p["view-distance"] ?? "-" }} chunks</dd></div>
          <div><dt>Owner</dt><dd>{{ server.ownerEmail }}</dd></div>
          <div><dt>Node</dt><dd>{{ server.nodeName }}</dd></div>
        </dl>
      </article>

      <article class="panel">
        <p class="label">Worlds &middot; {{ info ? gib(info.diskBytes) : "-" }} on disk in total</p>
        <dl class="list">
          <div v-for="w in info?.worlds ?? []" :key="w.name"><dt class="mono">{{ w.name }}</dt><dd>{{ gib(w.bytes) }}</dd></div>
        </dl>
        <p v-if="info && !info.worlds.length" class="muted">No worlds yet.</p>
      </article>
    </div>

    <article v-if="info && (info.plugins.length || info.mods.length)" class="panel">
      <p class="label">{{ info.plugins.length ? `Plugins (${info.plugins.length})` : "" }} {{ info.mods.length ? `Mods (${info.mods.length})` : "" }}</p>
      <div class="chips">
        <span v-for="x in [...info.plugins, ...info.mods]" :key="x.file" class="chip">{{ x.name }} <span class="muted mono">{{ x.version }}</span></span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.ov { display: flex; flex-direction: column; gap: 14px; }
.conn { display: flex; flex-direction: column; gap: 10px; border-left: 4px solid var(--gold); }
.addr-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.addr { font-size: 22px; font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 0; }
dd { margin: 2px 0 0; }
.share { background: var(--abyss); border: 1px solid var(--line); padding: 10px; white-space: pre-wrap; font-size: 13px; margin: 8px 0; }
details summary { cursor: pointer; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.tile p { margin: 0; }
.num { font: 900 24px var(--font); font-variant-numeric: tabular-nums; margin: 4px 0 !important; }
.small { font-size: 13px; }
.ok { color: var(--ok); }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.bad-box { border-color: var(--bad); color: var(--bad); margin: 0; }
.players { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.player { display: flex; align-items: center; gap: 8px; background: var(--abyss); padding: 6px 10px 6px 6px; border: 1px solid var(--line-soft); }
.player img { image-rendering: pixelated; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.list { margin: 8px 0 0; display: flex; flex-direction: column; }
.list div { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid var(--line-soft); }
.list dt { color: var(--ink2); }
.list dd { text-align: right; overflow-wrap: anywhere; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { background: var(--abyss); border: 1px solid var(--line-soft); padding: 4px 8px; font-size: 14px; }
</style>
