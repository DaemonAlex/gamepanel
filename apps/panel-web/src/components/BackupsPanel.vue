<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { BackupsView } from "@gamepanel/shared";
import { Archive, ArchiveRestore, Download, LoaderCircle, Plus, Trash2 } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string; running: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const view = ref<BackupsView | null>(null);
const error = ref("");
const notice = ref("");
const confirmRestore = ref<string | null>(null);
const confirmDelete = ref<string | null>(null);
const keep = ref(7);
let timer: ReturnType<typeof setTimeout> | undefined;

const activeJob = computed(() => view.value?.jobs.find((j) => j.state === "running") ?? null);
const lastJob = computed(() => view.value?.jobs[0] ?? null);

async function load() {
  clearTimeout(timer);
  try {
    const wasRunning = !!activeJob.value;
    view.value = await api.backups(props.id);
    keep.value = view.value.keep;
    error.value = "";
    if (wasRunning && !activeJob.value && lastJob.value) {
      const j = lastJob.value;
      notice.value = j.state === "done" ? (j.kind === "backup" ? "Backup finished." : "Restore finished. Start the server when ready.") : `${j.kind} failed: ${j.error}`;
      if (j.kind === "restore") emit("changed");
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
  // Poll fast while a job runs, slowly otherwise.
  timer = setTimeout(() => document.visibilityState === "visible" ? void load() : (timer = setTimeout(load, 5000)), activeJob.value ? 2000 : 15000);
}
onMounted(load);
onUnmounted(() => clearTimeout(timer));

async function run(fn: () => Promise<unknown>, ok: string) {
  error.value = "";
  try {
    await fn();
    notice.value = ok;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const backupNow = () => run(() => api.startBackup(props.id), "Backup started.");
const restore = (name: string) => run(() => api.restoreBackup(props.id, name), "Restore started.").then(() => (confirmRestore.value = null));
const remove = (name: string) => run(() => api.removeBackup(props.id, name), "Backup deleted.").then(() => (confirmDelete.value = null));
const saveKeep = () => run(() => api.setBackupKeep(props.id, keep.value), `Keeping the newest ${keep.value}.`);

const size = (n: number) => (n > 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : `${(n / 2 ** 20).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <section class="backups">
    <div class="panel row top">
      <button class="btn gold" type="button" :disabled="!!activeJob" @click="backupNow"><Plus /> Back up now</button>
      <span class="muted grow">{{ running ? "The world is saved and held still while the backup runs; players can stay on." : "The server is stopped, so the backup is a clean copy." }}</span>
      <form class="row keep" @submit.prevent="saveKeep">
        <label for="keep" class="label">Keep newest</label>
        <input id="keep" v-model.number="keep" type="number" min="1" max="100" />
        <button class="btn small" type="submit" :disabled="keep === view?.keep">Save</button>
      </form>
    </div>

    <p v-if="activeJob" class="panel job" role="status">
      <LoaderCircle class="spin ic-gold" />
      {{ activeJob.kind === "backup" ? `Backing up: ${size(activeJob.bytes)} written so far` : `Restoring ${activeJob.backup}` }}
    </p>
    <p v-if="notice" class="panel note" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <article class="panel">
      <p class="label"><Archive />Backups ({{ view?.backups.length ?? 0 }})</p>
      <div v-for="b in view?.backups ?? []" :key="b.name" class="brow">
        <span class="bwhen">{{ when(b.createdAt) }}</span>
        <span class="tag">{{ b.reason }}</span>
        <span class="muted mono">{{ size(b.bytes) }}</span>
        <span class="acts">
          <a class="btn small" :href="api.backupDownloadUrl(id, b.name)"><Download /> Download</a>
          <button class="btn small" type="button" :disabled="!!activeJob" @click="(confirmRestore = b.name), (confirmDelete = null)"><ArchiveRestore /> Restore</button>
          <button class="btn small danger" type="button" :aria-label="`Delete backup from ${when(b.createdAt)}`" @click="(confirmDelete = b.name), (confirmRestore = null)"><Trash2 /></button>
        </span>
        <div v-if="confirmRestore === b.name" class="confirm">
          <p v-if="running" class="error">Stop the server first. Restoring replaces its files.</p>
          <p v-else>Replace the server's files with this backup? The files it has now are moved aside on the node, not deleted.</p>
          <div class="row">
            <button class="btn small gold" type="button" :disabled="running" @click="restore(b.name)">Yes, restore</button>
            <button class="btn small" type="button" @click="confirmRestore = null">Cancel</button>
          </div>
        </div>
        <div v-if="confirmDelete === b.name" class="confirm">
          <p>Delete this backup for good?</p>
          <div class="row">
            <button class="btn small danger" type="button" @click="remove(b.name)">Yes, delete</button>
            <button class="btn small" type="button" @click="confirmDelete = null">Cancel</button>
          </div>
        </div>
      </div>
      <p v-if="view && !view.backups.length" class="muted">No backups yet. Make one now, or add a backup schedule in the Schedules tab.</p>
    </article>
    <p class="muted small">Backups leave out files the server downloads again on start (libraries, versions, cache) and logs. Stored on the node.</p>
  </section>
</template>

<style scoped>
.backups { display: flex; flex-direction: column; gap: 14px; }
.top { align-items: center; }
.grow { flex: 1; min-width: 200px; }
.keep input { width: 80px; padding: 5px 8px; }
.keep .label { margin: 0; }
.job, .note { margin: 0; display: flex; gap: 10px; align-items: center; border-left: 4px solid var(--gold); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.brow { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line-soft); }
.bwhen { font-weight: 700; min-width: 180px; }
.tag { font: 600 11px var(--mono); color: var(--gold); border: 1px solid var(--gold); padding: 1px 6px; }
.acts { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.confirm { width: 100%; background: var(--abyss); padding: 10px; }
.confirm p { margin: 0 0 8px; }
.btn.small { padding: 3px 9px; font-size: 12px; }
.small { font-size: 13px; margin: 0; }
</style>
