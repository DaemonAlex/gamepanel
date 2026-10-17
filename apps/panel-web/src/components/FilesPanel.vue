<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { files, type FileEntry } from "../api.js";
import CodeEditor from "./CodeEditor.vue";

const props = defineProps<{ id: string }>();
const path = ref("");
const entries = ref<FileEntry[]>([]);
const error = ref("");
const notice = ref("");
const loading = ref(false);

// Editing
const editing = ref<string | null>(null);
const text = ref("");
const original = ref("");
const saving = ref(false);
const dirty = computed(() => editing.value !== null && text.value !== original.value);
const confirmClose = ref(false);

// Row actions
const renaming = ref<string | null>(null);
const renameTo = ref("");
const deleting = ref<string | null>(null);
const creating = ref<"folder" | "file" | null>(null);
const newName = ref("");
const uploads = ref<{ name: string; sent: number; total: number; error?: string }[]>([]);
const MAX_EDIT = 2 * 1024 * 1024;

const crumbs = computed(() => {
  const parts = path.value ? path.value.split("/") : [];
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
});
const join = (name: string) => (path.value ? `${path.value}/${name}` : name);

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function load(to = path.value) {
  loading.value = true;
  error.value = "";
  try {
    entries.value = await files.list(props.id, to);
    path.value = to;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(() => load(""));

async function open(e: FileEntry) {
  if (e.type === "dir") return load(join(e.name));
  if (e.type === "link") {
    error.value = "Links are not followed here.";
    return;
  }
  if (e.size > MAX_EDIT) {
    notice.value = `${e.name} is too big to edit here. Use Download.`;
    return;
  }
  try {
    const r = await files.read(props.id, join(e.name));
    editing.value = join(e.name);
    text.value = original.value = r.text;
    confirmClose.value = false;
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function save() {
  if (!editing.value || saving.value) return;
  saving.value = true;
  try {
    await files.write(props.id, editing.value, text.value);
    original.value = text.value;
    notice.value = `Saved ${editing.value}. Restart the server for config changes to apply.`;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

function close(force = false) {
  if (dirty.value && !force) {
    confirmClose.value = true;
    return;
  }
  editing.value = null;
  confirmClose.value = false;
  void load();
}

async function create() {
  const name = newName.value.trim();
  if (!name || name.includes("/")) {
    error.value = "Use a plain name, without slashes.";
    return;
  }
  try {
    if (creating.value === "folder") {
      await files.mkdir(props.id, join(name));
      await load();
    } else {
      await files.write(props.id, join(name), "");
      editing.value = join(name);
      text.value = original.value = "";
    }
    creating.value = null;
    newName.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function doRename(e: FileEntry) {
  const to = renameTo.value.trim();
  if (!to || to.includes("/") || to === e.name) {
    renaming.value = null;
    return;
  }
  try {
    await files.rename(props.id, join(e.name), join(to));
    renaming.value = null;
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function doDelete(e: FileEntry) {
  try {
    await files.remove(props.id, join(e.name));
    deleting.value = null;
    notice.value = `${e.name} moved to the trash. Ask an admin to bring it back if needed.`;
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function onUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const chosen = Array.from(input.files ?? []);
  input.value = "";
  for (const f of chosen) {
    const row = { name: f.name, sent: 0, total: f.size } as { name: string; sent: number; total: number; error?: string };
    uploads.value.push(row);
    try {
      await files.upload(props.id, join(f.name), f, (sent) => (row.sent = sent));
    } catch (e) {
      row.error = (e as Error).message;
    }
  }
  uploads.value = uploads.value.filter((u) => u.error);
  await load();
}
</script>

<template>
  <section class="files">
    <template v-if="editing">
      <div class="row bar">
        <span class="mono crumb">{{ editing }}</span>
        <span v-if="dirty" class="label gold">Not saved</span>
        <button class="btn gold" type="button" :disabled="!dirty || saving" @click="save">{{ saving ? "Saving" : "Save" }}</button>
        <template v-if="!confirmClose">
          <button class="btn" type="button" @click="close()">Close</button>
        </template>
        <template v-else>
          <span>Close without saving?</span>
          <button class="btn danger" type="button" @click="close(true)">Yes, discard</button>
          <button class="btn" type="button" @click="confirmClose = false">Keep editing</button>
        </template>
      </div>
      <CodeEditor :text="original" :filename="editing" @change="(t) => (text = t)" @save="save" />
      <p class="muted small">Ctrl+S saves. Most config changes need a restart.</p>
    </template>

    <template v-else>
      <nav class="row crumbs" aria-label="Folder">
        <button class="link" type="button" @click="load('')">server</button>
        <template v-for="c in crumbs" :key="c.path">
          <span class="muted">/</span>
          <button class="link" type="button" @click="load(c.path)">{{ c.name }}</button>
        </template>
      </nav>

      <div class="row">
        <button class="btn" type="button" @click="(creating = 'folder'), (newName = '')">New folder</button>
        <button class="btn" type="button" @click="(creating = 'file'), (newName = '')">New file</button>
        <label class="btn gold upload">
          Upload
          <input type="file" multiple @change="onUpload" />
        </label>
        <button class="btn" type="button" :disabled="loading" @click="load()">Refresh</button>
      </div>

      <form v-if="creating" class="row" @submit.prevent="create">
        <label class="label" for="newname">{{ creating === "folder" ? "Folder name" : "File name" }}</label>
        <input id="newname" v-model="newName" class="grow" maxlength="120" autofocus />
        <button class="btn gold" type="submit">Create</button>
        <button class="btn" type="button" @click="creating = null">Cancel</button>
      </form>

      <div v-for="u in uploads" :key="u.name" class="upl">
        <span class="mono">{{ u.name }}</span>
        <span v-if="u.error" class="error">{{ u.error }}</span>
        <template v-else>
          <span class="muted">{{ size(u.sent) }} of {{ size(u.total) }}</span>
          <div class="bar-line"><span :style="{ width: `${u.total ? Math.round((u.sent / u.total) * 100) : 100}%` }"></span></div>
        </template>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="muted" role="status">{{ notice }}</p>

      <div class="table" role="table" aria-label="Files">
        <div v-if="path" class="tr" role="row">
          <button class="link name" type="button" @click="load(path.split('/').slice(0, -1).join('/'))">.. up one folder</button>
        </div>
        <div v-for="e in entries" :key="e.name" class="tr" role="row">
          <span class="icon" :class="e.type" aria-hidden="true"></span>
          <template v-if="renaming === e.name">
            <form class="row grow" @submit.prevent="doRename(e)">
              <input v-model="renameTo" class="grow mono" />
              <button class="btn small gold" type="submit">Rename</button>
              <button class="btn small" type="button" @click="renaming = null">Cancel</button>
            </form>
          </template>
          <template v-else>
            <button class="link name mono" type="button" @click="open(e)">{{ e.name }}</button>
            <span class="muted meta">{{ e.type === "dir" ? "folder" : size(e.size) }}</span>
            <span class="muted meta when">{{ when(e.modified) }}</span>
            <span class="acts">
              <a v-if="e.type === 'file'" class="btn small" :href="files.downloadUrl(id, join(e.name))">Download</a>
              <button class="btn small" type="button" @click="(renaming = e.name), (renameTo = e.name)">Rename</button>
              <template v-if="deleting !== e.name">
                <button class="btn small danger" type="button" @click="deleting = e.name">Delete</button>
              </template>
              <template v-else>
                <button class="btn small danger" type="button" @click="doDelete(e)">Yes, delete</button>
                <button class="btn small" type="button" @click="deleting = null">No</button>
              </template>
            </span>
          </template>
        </div>
        <p v-if="!entries.length && !loading" class="muted empty">This folder is empty.</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.files { display: flex; flex-direction: column; gap: 12px; }
.bar { justify-content: flex-end; }
.crumb { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.gold { color: var(--gold); }
.crumbs { gap: 6px; }
.link { background: none; border: 0; color: var(--gold); font: inherit; cursor: pointer; padding: 2px 0; text-align: left; }
.link:hover { text-decoration: underline; }
.link:focus-visible { outline: 2px solid var(--gold); }
.grow { flex: 1; min-width: 0; }
.upload { position: relative; overflow: hidden; }
.upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.upl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; background: var(--deep); border: 1px solid var(--line); padding: 8px 10px; }
.upl .mono { overflow-wrap: anywhere; }
.bar-line { grid-column: 1 / -1; height: 5px; background: var(--abyss); }
.bar-line span { display: block; height: 100%; background: var(--gold); }
.table { display: flex; flex-direction: column; border: 1px solid var(--line); background: var(--deep); }
.tr { display: flex; align-items: center; gap: 12px; padding: 7px 10px; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
.tr:first-child { border-top: 0; }
.name { flex: 1; min-width: 140px; overflow-wrap: anywhere; color: var(--ink); }
.meta { font-size: 13px; font-variant-numeric: tabular-nums; min-width: 70px; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; }
.btn.small { padding: 3px 9px; font-size: 12px; }
.icon { width: 10px; height: 10px; flex: none; background: var(--ink2); }
.icon.dir { background: var(--gold); transform: rotate(45deg); }
.icon.link { background: var(--bad); }
.empty { padding: 10px; margin: 0; }
.small { font-size: 13px; margin: 0; }
@media (max-width: 560px) { .when { display: none; } }
</style>
