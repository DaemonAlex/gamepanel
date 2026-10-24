<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { PluginReadiness, ServerType, VersionJob, VersionsView } from "@gamepanel/shared";
import { ArrowRightLeft, CircleArrowUp, CircleCheck, CircleHelp, CircleX, ListChecks, LoaderCircle, TriangleAlert } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string; type: string; version: string; running: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const type = ref(props.type as ServerType);
const version = ref(props.version);
const job = ref<VersionJob | null>(null);
const error = ref("");
const confirm = ref(false);
const versions = ref<VersionsView | null>(null);
const checked = ref<{ to: string; items: PluginReadiness[] } | null>(null);
const checking = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const TYPES: ServerType[] = ["PAPER", "PURPUR", "VANILLA", "FABRIC", "FORGE", "NEOFORGE"];
const changed = computed(() => type.value !== props.type || version.value.trim() !== props.version);
const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
const downgrade = computed(() => version.value !== "LATEST" && props.version !== "LATEST" && cmp(version.value.trim(), props.version) < 0);
const familyChange = computed(() => {
  const fam = (t: string) => (["PAPER", "PURPUR"].includes(t) ? "plugins" : ["FABRIC", "FORGE", "NEOFORGE"].includes(t) ? t : "vanilla");
  return fam(type.value) !== fam(props.type);
});
const active = computed(() => job.value && (job.value.state === "backing-up" || job.value.state === "applying"));
// The version list only applies while the type is unchanged.
const listed = computed(() => !!versions.value?.listed && type.value === props.type);
const hasPlugins = computed(() => type.value !== "VANILLA" && !familyChange.value);
const canCheck = computed(() => hasPlugins.value && /^\d+\.\d+(\.\d+)?$/.test(version.value.trim()) && version.value.trim() !== props.version);

const label = (v: string) => {
  const tags = [];
  if (v === props.version) tags.push("current");
  if (v === versions.value?.suggested) tags.push("suggested");
  if (v === versions.value?.latest) tags.push("newest");
  return tags.length ? `${v} (${tags.join(", ")})` : v;
};
const counts = computed(() => {
  const items = checked.value?.items ?? [];
  return { ready: items.filter((i) => i.status === "ready").length, notYet: items.filter((i) => i.status === "not-yet").length, unknown: items.filter((i) => i.status === "unknown").length };
});

async function poll() {
  clearTimeout(timer);
  try {
    job.value = await api.versionJob(props.id);
    if (job.value?.state === "done") emit("changed");
  } catch {
    // keep the last state
  }
  if (active.value) timer = setTimeout(poll, 3000);
}
async function loadVersions() {
  try {
    versions.value = await api.versions(props.id);
  } catch {
    versions.value = null; // fall back to typing a version
  }
}
onMounted(() => {
  void poll();
  void loadVersions();
});
onUnmounted(() => clearTimeout(timer));

// A plugin check belongs to one version; picking another clears it.
watch(version, () => {
  confirm.value = false;
  if (checked.value && checked.value.to !== version.value.trim()) checked.value = null;
});

async function check() {
  const to = version.value.trim();
  checking.value = true;
  error.value = "";
  try {
    checked.value = { to, items: await api.checkPlugins(props.id, to) };
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    checking.value = false;
  }
}

// The banner: pick the suggested version and check plugins against it.
async function prepareSuggested() {
  if (!versions.value?.suggested) return;
  type.value = props.type as ServerType;
  version.value = versions.value.suggested;
  await check();
}

async function start() {
  error.value = "";
  confirm.value = false;
  try {
    job.value = await api.changeVersion(props.id, type.value, version.value.trim().toUpperCase() === "LATEST" ? "LATEST" : version.value.trim());
    timer = setTimeout(poll, 3000);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <article class="panel ver">
    <p class="label"><ArrowRightLeft />Server type and Minecraft version</p>

    <div v-if="versions?.suggested && !active && version === props.version" class="banner" role="status">
      <CircleArrowUp class="big" />
      <p class="grow">
        <strong>Minecraft {{ versions.suggested }} is available.</strong>
        You're on {{ props.version }}<template v-if="versions.latest && versions.latest !== versions.suggested">; the newest is {{ versions.latest }}</template>.
      </p>
      <button class="btn gold" type="button" :disabled="checking" @click="prepareSuggested"><ListChecks /> Check my plugins for {{ versions.suggested }}</button>
    </div>
    <p v-else-if="versions?.listed && !versions.suggested && props.version !== 'LATEST'" class="muted small"><CircleCheck /> You're on the newest version Paper has released.</p>

    <div class="row">
      <select v-model="type" aria-label="Server type" class="w">
        <option v-for="t in TYPES" :key="t" :value="t">{{ t.charAt(0) + t.slice(1).toLowerCase() }}</option>
      </select>
      <select v-if="listed" v-model="version" aria-label="Minecraft version" class="w">
        <option v-if="!versions!.available.includes(props.version)" :value="props.version">{{ props.version }} (current)</option>
        <option v-for="v in versions!.available" :key="v" :value="v">{{ label(v) }}</option>
      </select>
      <template v-else>
        <input v-model="version" aria-label="Minecraft version" class="w" list="mcversions" />
        <datalist id="mcversions"><option value="LATEST"></option><option value="1.21.4"></option><option value="1.21.1"></option><option value="1.20.1"></option></datalist>
      </template>
      <button v-if="canCheck" class="btn" type="button" :disabled="checking" @click="check">
        <LoaderCircle v-if="checking" class="spin" /><ListChecks v-else /> Check my plugins
      </button>
      <template v-if="!confirm">
        <button class="btn gold" type="button" :disabled="!changed || running || !!active" @click="confirm = true">Change</button>
      </template>
      <template v-else>
        <button class="btn gold" type="button" @click="start">Yes: back up, then change</button>
        <button class="btn" type="button" @click="confirm = false">Cancel</button>
      </template>
    </div>

    <div v-if="checking && !checked" class="muted small" role="status"><LoaderCircle class="spin" /> Checking each plugin on Modrinth and Hangar...</div>
    <section v-if="checked && checked.to === version.trim()" class="check" aria-live="polite">
      <p class="summary">
        Plugins on {{ checked.to }}:
        <span class="chip ok">{{ counts.ready }} ready</span>
        <span v-if="counts.notYet" class="chip no">{{ counts.notYet }} not yet</span>
        <span v-if="counts.unknown" class="chip unk">{{ counts.unknown }} check by hand</span>
      </p>
      <div v-for="p in checked.items" :key="p.file" class="crow">
        <span class="pname">{{ p.name }} <span class="muted mono">{{ p.installed }}</span></span>
        <span v-if="p.status === 'ready'" class="chip ok"><CircleCheck /> {{ p.version }}</span>
        <span v-else-if="p.status === 'not-yet'" class="chip no"><CircleX /> no version yet</span>
        <span v-else class="chip unk"><CircleHelp /> not listed</span>
      </div>
      <p v-if="!checked.items.length" class="muted small">No plugins installed.</p>
      <p class="muted small">"Ready" means the plugin's author has published a version for {{ checked.to }}; update those from the Plugins tab after the change. "Not listed" plugins aren't on Modrinth or Hangar, so check their own page.</p>
    </section>

    <p v-if="running" class="muted small">Stop the server to change its type or version.</p>
    <p v-if="changed && downgrade" class="warnline"><TriangleAlert /> Going back to an older version can break worlds. The backup taken first lets you undo it.</p>
    <p v-if="changed && familyChange" class="warnline"><TriangleAlert /> Plugins and mods do not carry across types. They stay in their folders but will not load.</p>
    <p v-if="changed && !downgrade && checked?.to === version.trim() && counts.notYet" class="warnline">
      <TriangleAlert /> {{ counts.notYet }} plugin{{ counts.notYet === 1 ? " has" : "s have" }} no version for {{ checked.to }} yet and may not load until {{ counts.notYet === 1 ? "it's" : "they're" }} updated.
    </p>
    <p v-if="changed && !downgrade && !familyChange" class="muted small">The first start on a new version upgrades the world. That can't be undone except by restoring the backup taken before the change.</p>

    <p v-if="job" class="muted small" role="status">
      <LoaderCircle v-if="active" class="spin" />
      <template v-if="job.state === 'backing-up'">Backing up before the change...</template>
      <template v-else-if="job.state === 'applying'">Switching to {{ job.to.type }} {{ job.to.version }}...</template>
      <template v-else-if="job.state === 'done'">Changed to {{ job.to.type }} {{ job.to.version }}. Backup taken first: {{ job.backup }}. Start the server; the first start downloads the new version.</template>
      <template v-else>Change failed: {{ job.error }}</template>
    </p>
    <p v-if="error" class="error">{{ error }}</p>
  </article>
</template>

<style scoped>
.ver { display: flex; flex-direction: column; gap: 10px; }
.w { width: auto; min-width: 140px; }
.grow { flex: 1; min-width: 200px; margin: 0; }
.small { font-size: 13px; margin: 0; display: flex; gap: 8px; align-items: center; }
.warnline { color: var(--warn); margin: 0; display: flex; gap: 8px; align-items: center; font-size: 14px; }
.banner { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 12px 14px; border: 1px solid var(--gold); border-left-width: 4px; }
.banner .big { width: 22px; height: 22px; color: var(--gold); flex: none; }
.check { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line-soft); padding-top: 10px; }
.summary { margin: 0 0 4px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-weight: 700; }
.crow { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 5px 0; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
.pname { font-weight: 700; min-width: 0; }
.mono { font-family: var(--mono); font-weight: 400; }
.chip { display: inline-flex; gap: 4px; align-items: center; font: 600 12px var(--mono); padding: 1px 8px; border: 1px solid currentColor; }
.chip svg { width: 13px; height: 13px; }
.chip.ok { color: var(--ok); }
.chip.no { color: var(--bad); }
.chip.unk { color: var(--warn); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
