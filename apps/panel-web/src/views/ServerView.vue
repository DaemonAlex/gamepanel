<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from "vue";
import type { PowerAction, ServerView } from "@gamepanel/shared";
import { api } from "../api.js";
import ConsolePanel from "../components/ConsolePanel.vue";
import { Archive, ArrowLeft, CalendarClock, FolderOpen, Puzzle, ScrollText, LayoutDashboard, Play, RotateCw, Skull, SlidersHorizontal, Square, Terminal, Users } from "lucide-vue-next";
import OverviewPanel from "../components/OverviewPanel.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import { stateOf, uptime } from "../format.js";

const props = defineProps<{ id: string }>();
const server = ref<ServerView | null>(null);
const error = ref("");
const busy = ref<PowerAction | null>(null);
const confirmKill = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

// The file manager carries the code editor, so it loads only when opened.
const FilesPanel = defineAsyncComponent(() => import("../components/FilesPanel.vue"));
const SettingsPanel = defineAsyncComponent(() => import("../components/SettingsPanel.vue"));
const BackupsPanel = defineAsyncComponent(() => import("../components/BackupsPanel.vue"));
const SchedulesPanel = defineAsyncComponent(() => import("../components/SchedulesPanel.vue"));
const PluginsPanel = defineAsyncComponent(() => import("../components/PluginsPanel.vue"));
const LogsPanel = defineAsyncComponent(() => import("../components/LogsPanel.vue"));
const VersionPanel = defineAsyncComponent(() => import("../components/VersionPanel.vue"));

// Tabs; the choice is kept in the address (#files) so a reload stays put.
const tabs = ["overview", "console", "players", "plugins", "files", "backups", "schedules", "logs", "settings"] as const;
type Tab = (typeof tabs)[number];
const tab = ref<Tab>(tabs.includes(location.hash.slice(1) as Tab) ? (location.hash.slice(1) as Tab) : "overview");
const tabIcon = { overview: LayoutDashboard, console: Terminal, players: Users, settings: SlidersHorizontal, files: FolderOpen, backups: Archive, schedules: CalendarClock, plugins: Puzzle, logs: ScrollText } as const;
function pick(t: Tab) {
  tab.value = t;
  history.replaceState(null, "", `#${t}`);
}

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

</script>

<template>
  <main class="wrap">
    <RouterLink to="/" class="label"><ArrowLeft />All servers</RouterLink>
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

      <section class="panel row">
        <button class="btn gold" type="button" :disabled="isUp || !!busy" @click="power('start')"><Play /> Start</button>
        <button class="btn" type="button" :disabled="!isUp || !!busy" @click="power('stop')"><Square /> Stop</button>
        <button class="btn" type="button" :disabled="!isUp || !!busy" @click="power('restart')"><RotateCw /> Restart</button>
        <template v-if="!confirmKill">
          <button class="btn danger" type="button" :disabled="!isUp || !!busy" @click="confirmKill = true"><Skull /> Kill</button>
        </template>
        <template v-else>
          <span>Kill skips saving the world. Sure?</span>
          <button class="btn danger" type="button" @click="power('kill')">Yes, kill it</button>
          <button class="btn" type="button" @click="confirmKill = false">Cancel</button>
        </template>
        <span v-if="busy" class="muted">{{ busy }}...</span>
      </section>

      <nav class="tabs" role="tablist" aria-label="Server sections">
        <button v-for="t in tabs" :key="t" type="button" role="tab" :aria-selected="tab === t" :class="{ on: tab === t }" @click="pick(t)"><component :is="tabIcon[t]" /> {{ t }}</button>
      </nav>

      <OverviewPanel v-if="tab === 'overview'" :server="server" />

      <ConsolePanel v-if="tab === 'console'" :id="server.id" class="panel" />
      <PlayersPanel v-if="tab === 'players'" :id="server.id" />
      <VersionPanel v-if="tab === 'settings'" :id="server.id" :type="server.type" :version="server.version" :running="isUp" @changed="load" />
      <PluginsPanel v-if="tab === 'plugins'" :id="server.id" :running="isUp" />
      <LogsPanel v-if="tab === 'logs'" :id="server.id" />
      <SettingsPanel v-if="tab === 'settings'" :id="server.id" :running="isUp" @restarted="load" />
      <BackupsPanel v-if="tab === 'backups'" :id="server.id" :running="isUp" @changed="load" />
      <SchedulesPanel v-if="tab === 'schedules'" :id="server.id" />
      <FilesPanel v-if="tab === 'files'" :id="server.id" class="panel" />
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
.tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.tabs button { display: inline-flex; align-items: center; gap: 6px; font: 600 13px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; padding: 8px 14px; background: transparent; color: var(--ink2); border: 1px solid transparent; border-bottom: 0; cursor: pointer; }
.tabs button.on { background: var(--gold); color: var(--sea); }
.tabs button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
</style>
