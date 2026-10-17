<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ServerType, VersionJob } from "@gamepanel/shared";
import { ArrowRightLeft, LoaderCircle, TriangleAlert } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string; type: string; version: string; running: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const type = ref(props.type as ServerType);
const version = ref(props.version);
const job = ref<VersionJob | null>(null);
const error = ref("");
const confirm = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const TYPES: ServerType[] = ["PAPER", "PURPUR", "VANILLA", "FABRIC", "FORGE", "NEOFORGE"];
const changed = computed(() => type.value !== props.type || version.value.trim() !== props.version);
const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
const downgrade = computed(() => version.value !== "LATEST" && props.version !== "LATEST" && cmp(version.value.trim(), props.version) < 0);
const familyChange = computed(() => {
  const fam = (t: string) => (["PAPER", "PURPUR"].includes(t) ? "plugins" : ["FABRIC", "FORGE", "NEOFORGE"].includes(t) ? t : "vanilla");
  return fam(type.value) !== fam(props.type);
});
const active = computed(() => job.value && (job.value.state === "backing-up" || job.value.state === "applying"));

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
onMounted(poll);
onUnmounted(() => clearTimeout(timer));

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
    <div class="row">
      <select v-model="type" aria-label="Server type" class="w">
        <option v-for="t in TYPES" :key="t" :value="t">{{ t.charAt(0) + t.slice(1).toLowerCase() }}</option>
      </select>
      <input v-model="version" aria-label="Minecraft version" class="w" list="mcversions" />
      <datalist id="mcversions"><option value="LATEST"></option><option value="1.21.4"></option><option value="1.21.1"></option><option value="1.20.1"></option></datalist>
      <template v-if="!confirm">
        <button class="btn gold" type="button" :disabled="!changed || running || !!active" @click="confirm = true">Change</button>
      </template>
      <template v-else>
        <button class="btn gold" type="button" @click="start">Yes: back up, then change</button>
        <button class="btn" type="button" @click="confirm = false">Cancel</button>
      </template>
    </div>
    <p v-if="running" class="muted small">Stop the server to change its type or version.</p>
    <p v-if="changed && downgrade" class="warnline"><TriangleAlert /> Going back to an older version can break worlds. The backup taken first lets you undo it.</p>
    <p v-if="changed && familyChange" class="warnline"><TriangleAlert /> Plugins and mods do not carry across types. They stay in their folders but will not load.</p>
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
.small { font-size: 13px; margin: 0; display: flex; gap: 8px; align-items: center; }
.warnline { color: var(--warn); margin: 0; display: flex; gap: 8px; align-items: center; font-size: 14px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
