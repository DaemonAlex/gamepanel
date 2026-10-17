<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { CatalogHit, PluginsView } from "@gamepanel/shared";
import { CircleArrowUp, Download, ExternalLink, LoaderCircle, Power, PowerOff, Puzzle, Search, Trash2 } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string; running: boolean }>();
const view = ref<PluginsView | null>(null);
const error = ref("");
const notice = ref("");
const busy = ref<string | null>(null);
const q = ref("");
const hits = ref<CatalogHit[] | null>(null);
const searching = ref(false);
const confirmDelete = ref<string | null>(null);

async function load() {
  try {
    view.value = await api.plugins(props.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

async function act(key: string, fn: () => Promise<unknown>, ok: string) {
  busy.value = key;
  error.value = "";
  try {
    await fn();
    notice.value = `${ok}${props.running ? " Restart the server to load the change." : ""}`;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

async function find() {
  if (!q.value.trim()) return;
  searching.value = true;
  error.value = "";
  try {
    hits.value = await api.searchPlugins(props.id, q.value.trim());
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    searching.value = false;
  }
}

type Item = PluginsView["items"][number];
const doUpdate = (p: Item) => act(p.file, () => api.updatePlugin(props.id, p.file), `${p.name} updated to ${p.update?.version}.`);
const doToggle = (p: Item) => act(p.file, () => api.setPluginEnabled(props.id, p.file, !p.enabled), `${p.name} turned ${p.enabled ? "off" : "on"}.`);
const doDelete = (p: Item) => act(p.file, () => api.deletePlugin(props.id, p.file), `${p.name} moved to the trash.`).then(() => (confirmDelete.value = null));
const doInstall = (h: CatalogHit) => act(`${h.source}:${h.id}`, () => api.installPlugin(props.id, h.source, h.id), `${h.title} installed.`);

const updates = () => view.value?.items.filter((i) => i.update).length ?? 0;
const size = (n: number) => (n > 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const installed = (h: CatalogHit) => !!view.value?.items.some((i) => i.name.toLowerCase().replace(/[^a-z0-9]/g, "") === h.title.toLowerCase().replace(/[^a-z0-9]/g, ""));
</script>

<template>
  <section class="plugins">
    <p v-if="view && !view.folder" class="panel muted">Vanilla servers do not run plugins or mods. Change the server type in Settings to Paper (plugins) or Fabric/Forge (mods).</p>
    <p v-if="notice" class="panel note" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="view?.folder">
      <article class="panel">
        <div class="row between">
          <p class="label"><Puzzle />Installed {{ view.folder }} ({{ view.items.length }}) &middot; Minecraft {{ view.mcVersion }}</p>
          <span v-if="updates()" class="tag gold-tag">{{ updates() }} update{{ updates() === 1 ? "" : "s" }} available</span>
        </div>
        <div v-for="p in view.items" :key="p.file" class="prow" :class="{ off: !p.enabled }">
          <div class="grow">
            <p class="pname">{{ p.name }} <span class="muted mono">{{ p.version }}</span></p>
            <p class="muted small mono">{{ p.file }} &middot; {{ size(p.bytes) }}<span v-if="!p.enabled"> &middot; turned off</span></p>
          </div>
          <button v-if="p.update" class="btn small gold" type="button" :disabled="!!busy" @click="doUpdate(p)">
            <LoaderCircle v-if="busy === p.file" class="spin" /><CircleArrowUp v-else /> Update to {{ p.update.version }}<span v-if="p.update.major" class="major"> (big jump: read its changes first)</span>
          </button>
          <button class="btn small" type="button" :disabled="!!busy" @click="doToggle(p)">
            <PowerOff v-if="p.enabled" /><Power v-else /> {{ p.enabled ? "Turn off" : "Turn on" }}
          </button>
          <template v-if="confirmDelete !== p.file">
            <button class="btn small danger" type="button" :aria-label="`Delete ${p.name}`" @click="confirmDelete = p.file"><Trash2 /></button>
          </template>
          <template v-else>
            <button class="btn small danger" type="button" @click="doDelete(p)">Yes, delete</button>
            <button class="btn small" type="button" @click="confirmDelete = null">No</button>
          </template>
        </div>
        <p v-if="!view.items.length" class="muted">Nothing installed yet.</p>
        <p class="muted small">Updates come from Modrinth, matched by file. Plugins from elsewhere show no update.</p>
      </article>

      <article class="panel">
        <p class="label"><Search />Find {{ view.folder }} for Minecraft {{ view.mcVersion }} on Modrinth{{ view.folder === "plugins" ? " and Hangar" : "" }}</p>
        <form class="row" @submit.prevent="find">
          <input v-model="q" class="grow" :placeholder="view.folder === 'plugins' ? 'WorldGuard, LuckPerms, Dynmap...' : 'Sodium, Lithium, JEI...'" aria-label="Search" />
          <button class="btn gold" type="submit" :disabled="searching"><LoaderCircle v-if="searching" class="spin" /><Search v-else /> Search</button>
        </form>
        <div v-for="h in hits ?? []" :key="`${h.source}:${h.id}`" class="hit">
          <img v-if="h.icon" :src="h.icon" alt="" width="40" height="40" loading="lazy" />
          <span v-else class="noicon"><Puzzle /></span>
          <div class="grow">
            <p class="pname">{{ h.title }} <span class="tag">{{ h.source }}</span></p>
            <p class="muted small">{{ h.description }}</p>
            <p class="muted small">by {{ h.author }} &middot; {{ big(h.downloads) }} downloads &middot; <a :href="h.url" target="_blank" rel="noopener">page <ExternalLink class="tiny" /></a></p>
          </div>
          <button class="btn small gold" type="button" :disabled="!!busy" @click="doInstall(h)">
            <LoaderCircle v-if="busy === `${h.source}:${h.id}`" class="spin" /><Download v-else /> {{ installed(h) ? "Install again" : "Install" }}
          </button>
        </div>
        <p v-if="hits && !hits.length" class="muted">Nothing found for this Minecraft version.</p>
        <p class="muted small">Files are only taken from the sites' own servers and checked against their published hash.</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.plugins { display: flex; flex-direction: column; gap: 14px; }
.plugins > .panel { display: flex; flex-direction: column; gap: 10px; }
.note { margin: 0; border-left: 4px solid var(--gold); }
.between { justify-content: space-between; }
.between .label { margin: 0; }
.prow, .hit { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line-soft); }
.prow.off { opacity: 0.6; }
.hit img { image-rendering: auto; border: 1px solid var(--line-soft); }
.noicon { width: 40px; height: 40px; display: grid; place-items: center; background: var(--abyss); color: var(--ink2); }
.grow { flex: 1; min-width: 200px; }
.pname { margin: 0; font-weight: 700; }
.small { font-size: 13px; margin: 2px 0 0; }
.tag { font: 600 10px var(--mono); color: var(--ink2); border: 1px solid var(--line); padding: 0 5px; text-transform: uppercase; }
.gold-tag { color: var(--gold); border-color: var(--gold); font-size: 11px; padding: 2px 8px; }
.major { font-weight: 400; margin-left: 4px; }
.tiny { width: 12px; height: 12px; vertical-align: -1px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.btn.small { padding: 3px 9px; font-size: 12px; }
</style>
