<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { DatabaseInfo, DatabasesView, QueryResult, TableInfo, TableRows } from "@gamepanel/shared";
import { ChevronLeft, ChevronRight, Copy, Database, Eye, EyeOff, KeyRound, LoaderCircle, Pencil, Play, Plus, RefreshCw, Table2, Trash2, TriangleAlert } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string }>();
const view = ref<DatabasesView | null>(null);
const error = ref("");
const notice = ref("");
const busy = ref<string | null>(null);

// --- databases -------------------------------------------------------------------
const label = ref("");
const created = ref<(DatabaseInfo & { password: string }) | null>(null);
const shown = ref<Record<string, string>>({});
const confirmReset = ref<string | null>(null);
const confirmDelete = ref<string | null>(null);
const deleteTyped = ref("");

async function load() {
  try {
    view.value = await api.databases(props.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

async function act<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = key;
  error.value = "";
  notice.value = "";
  try {
    return await fn();
  } catch (e) {
    error.value = (e as Error).message;
    return undefined;
  } finally {
    busy.value = null;
  }
}

async function create() {
  const r = await act("create", () => api.createDatabase(props.id, label.value.trim()));
  if (r) {
    created.value = r;
    label.value = "";
    await load();
  }
}
async function togglePassword(name: string) {
  if (shown.value[name]) {
    const { [name]: _, ...rest } = shown.value;
    shown.value = rest;
    return;
  }
  const r = await act(`pw:${name}`, () => api.databasePassword(props.id, name));
  if (r) shown.value = { ...shown.value, [name]: r.password };
}
async function resetPassword(name: string) {
  const r = await act(`reset:${name}`, () => api.resetDatabasePassword(props.id, name));
  confirmReset.value = null;
  if (r) {
    shown.value = { ...shown.value, [name]: r.password };
    notice.value = `New password set for ${name}. Update it in every plugin config that uses this database, then restart the server.`;
  }
}
async function remove(name: string) {
  const r = await act(`delete:${name}`, () => api.deleteDatabase(props.id, name));
  confirmDelete.value = null;
  deleteTyped.value = "";
  if (r) {
    if (open.value === name) open.value = null;
    notice.value = `${name} deleted. A snapshot was kept on the node: ${r.snapshot}`;
    await load();
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = "Copied.";
  } catch {
    notice.value = "Copy didn't work here; select the text instead.";
  }
}

// --- browsing one database ---------------------------------------------------------
const open = ref<string | null>(null);
const tables = ref<TableInfo[]>([]);
const table = ref<string | null>(null);
const rows = ref<TableRows | null>(null);
const page = ref(0);

async function openDb(name: string) {
  open.value = name;
  table.value = null;
  rows.value = null;
  result.value = null;
  const t = await act(`tables:${name}`, () => api.databaseTables(props.id, name));
  tables.value = t ?? [];
}
async function openTable(name: string, p = 0) {
  if (!open.value) return;
  table.value = name;
  page.value = p;
  editing.value = null;
  confirmRowDelete.value = null;
  const r = await act(`rows:${name}`, () => api.databaseRows(props.id, open.value!, name, p));
  if (r) rows.value = r;
}
const pages = computed(() => (rows.value ? Math.max(1, Math.ceil(rows.value.total / rows.value.pageSize)) : 1));

// --- editing a row -------------------------------------------------------------------
const editing = ref<number | null>(null);
const draft = ref<Record<string, string | null>>({});
const confirmSave = ref(false);
const confirmRowDelete = ref<number | null>(null);

const keyOf = (r: (string | null)[]) => Object.fromEntries((rows.value?.primaryKey ?? []).map((k) => [k, r[rows.value!.columns.indexOf(k)] ?? null]));
function startEdit(i: number) {
  if (!rows.value) return;
  editing.value = i;
  confirmSave.value = false;
  draft.value = Object.fromEntries(rows.value.columns.map((c, j) => [c, rows.value!.rows[i]![j] ?? null]));
}
const changes = computed(() => {
  if (editing.value === null || !rows.value) return {};
  const before = rows.value.rows[editing.value]!;
  return Object.fromEntries(Object.entries(draft.value).filter(([c, v]) => v !== (before[rows.value!.columns.indexOf(c)] ?? null)));
});
async function saveRow() {
  if (editing.value === null || !rows.value || !open.value || !table.value) return;
  const r = await act("save", () => api.updateDatabaseRow(props.id, open.value!, table.value!, keyOf(rows.value!.rows[editing.value!]!), changes.value));
  confirmSave.value = false;
  if (r) {
    notice.value = `Row saved. The table was copied first: ${r.snapshot}`;
    await openTable(table.value, page.value);
  }
}
async function deleteRow(i: number) {
  if (!rows.value || !open.value || !table.value) return;
  const r = await act("rowdelete", () => api.deleteDatabaseRow(props.id, open.value!, table.value!, keyOf(rows.value!.rows[i]!)));
  confirmRowDelete.value = null;
  if (r) {
    notice.value = `Row deleted. The table was copied first: ${r.snapshot}`;
    await openTable(table.value, page.value);
  }
}
const binary = (c: string) => !!rows.value?.columnInfo.find((x) => x.name === c)?.binary;
const nullable = (c: string) => !!rows.value?.columnInfo.find((x) => x.name === c)?.nullable;

// --- query box -------------------------------------------------------------------------
const sql = ref("");
const allowChanges = ref(false);
const confirmRun = ref(false);
const result = ref<QueryResult | null>(null);

async function run() {
  if (!open.value || !sql.value.trim()) return;
  if (allowChanges.value && !confirmRun.value) {
    confirmRun.value = true;
    return;
  }
  confirmRun.value = false;
  const r = await act("query", () => api.databaseQuery(props.id, open.value!, sql.value, allowChanges.value));
  if (r) {
    result.value = r;
    if (r.snapshot) notice.value = `Done. The whole database was saved first: ${r.snapshot}`;
    if (table.value) await openTable(table.value, page.value);
  }
}

const size = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const count = (n: number) => n.toLocaleString();
</script>

<template>
  <section class="dbs">
    <p v-if="notice" class="panel note" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Databases -->
    <article class="panel">
      <p class="label"><Database />Databases</p>
      <p class="muted small">
        Plugins on this server reach their database at host <code>gp-db</code>, port <code>3306</code>. Only this server can reach it; nothing on the internet can. Every database is included in this
        server's backups.
      </p>
      <p v-if="view && !view.ready && !view.databases.length" class="muted small">Creating the first database also starts the database service on this machine. That takes about a minute the first time.</p>

      <div v-for="d in view?.databases ?? []" :key="d.name" class="db" :class="{ sel: open === d.name }">
        <div class="row between">
          <p class="dname"><Database class="ic" /> {{ d.name }} <span class="muted mono">{{ size(d.bytes) }} &middot; {{ d.tables }} tables</span></p>
          <button class="btn small gold" type="button" :disabled="!!busy" @click="openDb(d.name)"><Table2 /> {{ open === d.name ? "Refresh" : "Open" }}</button>
        </div>
        <dl class="conn">
          <dt>Host</dt><dd class="mono">{{ d.host }}</dd>
          <dt>Port</dt><dd class="mono">{{ d.port }}</dd>
          <dt>Database</dt><dd class="mono">{{ d.name }}</dd>
          <dt>Username</dt><dd class="mono">{{ d.user }}</dd>
          <dt>Password</dt>
          <dd class="mono pw">
            <span>{{ shown[d.name] ?? "••••••••••••" }}</span>
            <button class="btn small" type="button" :disabled="!!busy" :aria-label="shown[d.name] ? 'Hide password' : 'Show password'" @click="togglePassword(d.name)"><EyeOff v-if="shown[d.name]" /><Eye v-else /></button>
            <button v-if="shown[d.name]" class="btn small" type="button" aria-label="Copy password" @click="copy(shown[d.name]!)"><Copy /></button>
          </dd>
        </dl>
        <div class="row">
          <template v-if="confirmReset !== d.name">
            <button class="btn small" type="button" :disabled="!!busy" @click="confirmReset = d.name"><KeyRound /> New password</button>
          </template>
          <template v-else>
            <span class="warnline"><TriangleAlert /> Plugins using the old password will lose access until their config is updated.</span>
            <button class="btn small danger" type="button" @click="resetPassword(d.name)">Yes, new password</button>
            <button class="btn small" type="button" @click="confirmReset = null">Cancel</button>
          </template>
          <template v-if="confirmDelete !== d.name">
            <button class="btn small danger" type="button" :disabled="!!busy" @click="(confirmDelete = d.name), (deleteTyped = '')"><Trash2 /> Delete</button>
          </template>
          <template v-else>
            <span class="warnline"><TriangleAlert /> Deletes every table in it. Type <b class="mono">{{ d.name }}</b> to confirm:</span>
            <input v-model="deleteTyped" class="w" :aria-label="`Type ${d.name} to confirm`" />
            <button class="btn small danger" type="button" :disabled="deleteTyped !== d.name || !!busy" @click="remove(d.name)"><LoaderCircle v-if="busy === `delete:${d.name}`" class="spin" /> Delete it</button>
            <button class="btn small" type="button" @click="confirmDelete = null">Cancel</button>
          </template>
        </div>
      </div>
      <p v-if="view && !view.databases.length" class="muted">No databases yet.</p>

      <form class="row" @submit.prevent="create">
        <span class="mono prefix">{{ props.id.replace(/-/g, "_") }}_</span>
        <input v-model="label" class="w" placeholder="coreprotect" aria-label="New database name" pattern="[a-z][a-z0-9_]{0,19}" />
        <button class="btn gold" type="submit" :disabled="!label.trim() || !!busy"><LoaderCircle v-if="busy === 'create'" class="spin" /><Plus v-else /> Create database</button>
      </form>
      <p v-if="created" class="panel note small">
        Created <b class="mono">{{ created.name }}</b>. Put these in the plugin's config: host <b class="mono">{{ created.host }}</b>, port <b class="mono">{{ created.port }}</b>, database
        <b class="mono">{{ created.name }}</b>, user <b class="mono">{{ created.user }}</b>, password <b class="mono">{{ created.password }}</b>
        <button class="btn small" type="button" aria-label="Copy password" @click="copy(created.password)"><Copy /></button>
      </p>
    </article>

    <!-- Tables and rows -->
    <article v-if="open" class="panel">
      <div class="row between">
        <p class="label"><Table2 />Tables in {{ open }}</p>
        <button class="btn small" type="button" :disabled="!!busy" @click="openDb(open)"><RefreshCw /> Refresh</button>
      </div>
      <div class="tables">
        <button v-for="t in tables" :key="t.name" type="button" class="tbl" :class="{ on: table === t.name }" @click="openTable(t.name)">
          <span class="mono">{{ t.name }}</span>
          <span class="muted small">{{ count(t.rows) }} rows &middot; {{ size(t.bytes) }}</span>
        </button>
        <p v-if="!tables.length" class="muted small">No tables yet. The plugin creates them the first time it starts with this database.</p>
      </div>

      <template v-if="rows && table">
        <div class="row between">
          <p class="small muted">
            {{ table }}: about {{ count(rows.total) }} rows. Page {{ page + 1 }} of {{ count(pages) }}.
            <span v-if="!rows.primaryKey.length"> This table has no primary key, so rows can only be changed with a query.</span>
          </p>
          <span class="row">
            <button class="btn small" type="button" :disabled="page === 0 || !!busy" aria-label="Previous page" @click="openTable(table, page - 1)"><ChevronLeft /></button>
            <button class="btn small" type="button" :disabled="page + 1 >= pages || !!busy" aria-label="Next page" @click="openTable(table, page + 1)"><ChevronRight /></button>
          </span>
        </div>
        <div class="grid-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th v-if="rows.primaryKey.length"></th>
                <th v-for="c in rows.columns" :key="c" :title="rows.columnInfo.find((x) => x.name === c)?.type">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(r, i) in rows.rows" :key="i">
                <tr :class="{ editing: editing === i }">
                  <td v-if="rows.primaryKey.length" class="acts">
                    <button class="btn small" type="button" aria-label="Edit row" :disabled="!!busy" @click="startEdit(i)"><Pencil /></button>
                    <button class="btn small danger" type="button" aria-label="Delete row" :disabled="!!busy" @click="confirmRowDelete = i"><Trash2 /></button>
                  </td>
                  <td v-for="(v, j) in r" :key="j" :class="{ nul: v === null }" :title="v ?? 'NULL'">{{ v ?? "NULL" }}</td>
                </tr>
                <tr v-if="confirmRowDelete === i" class="confirm">
                  <td :colspan="rows.columns.length + 1">
                    <span class="warnline"><TriangleAlert /> Delete this row for good? A copy of the table is saved first.</span>
                    <button class="btn small danger" type="button" @click="deleteRow(i)"><LoaderCircle v-if="busy === 'rowdelete'" class="spin" /> Yes, delete row</button>
                    <button class="btn small" type="button" @click="confirmRowDelete = null">Cancel</button>
                  </td>
                </tr>
                <tr v-if="editing === i" class="edit">
                  <td :colspan="rows.columns.length + 1">
                    <div class="fields">
                      <label v-for="c in rows.columns" :key="c" class="field">
                        <span class="mono small">{{ c }}<span v-if="rows.primaryKey.includes(c)" class="muted"> (key)</span></span>
                        <input v-if="!binary(c)" :value="draft[c] ?? ''" :disabled="draft[c] === null" @input="draft[c] = ($event.target as HTMLInputElement).value" />
                        <span v-else class="muted small">binary, can't be edited here</span>
                        <label v-if="nullable(c) && !binary(c)" class="small nullbox"><input type="checkbox" :checked="draft[c] === null" @change="draft[c] = ($event.target as HTMLInputElement).checked ? null : ''" /> NULL</label>
                      </label>
                    </div>
                    <div class="row">
                      <template v-if="!confirmSave">
                        <button class="btn small gold" type="button" :disabled="!Object.keys(changes).length" @click="confirmSave = true">Save {{ Object.keys(changes).length }} change{{ Object.keys(changes).length === 1 ? "" : "s" }}</button>
                        <button class="btn small" type="button" @click="editing = null">Cancel</button>
                      </template>
                      <template v-else>
                        <span class="warnline"><TriangleAlert /> This changes live data the plugin uses. A copy of the table is saved first.</span>
                        <button class="btn small danger" type="button" @click="saveRow"><LoaderCircle v-if="busy === 'save'" class="spin" /> Yes, save</button>
                        <button class="btn small" type="button" @click="confirmSave = false">Back</button>
                      </template>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-if="!rows.rows.length" class="muted small">This page is empty.</p>
      </template>
    </article>

    <!-- Query -->
    <article v-if="open" class="panel">
      <p class="label"><Play />Run a query on {{ open }}</p>
      <textarea v-model="sql" class="sql mono" rows="4" placeholder="SELECT * FROM co_user WHERE user = 'Eric';" aria-label="SQL query" @input="confirmRun = false"></textarea>
      <label class="small allow"><input v-model="allowChanges" type="checkbox" @change="confirmRun = false" /> Allow changes (UPDATE, DELETE, INSERT, ALTER...)</label>
      <p v-if="allowChanges" class="danger-box small">
        <TriangleAlert /> Changes are permanent and the plugin sees them immediately. The whole database is saved first, which can take a minute or two on a big one. If you aren't sure what a query
        does, leave this off: without it, queries can only read.
      </p>
      <div class="row">
        <template v-if="!confirmRun">
          <button class="btn" :class="allowChanges ? 'danger' : 'gold'" type="button" :disabled="!sql.trim() || !!busy" @click="run">
            <LoaderCircle v-if="busy === 'query'" class="spin" /><Play v-else /> {{ allowChanges ? "Run and change data" : "Run (read only)" }}
          </button>
        </template>
        <template v-else>
          <span class="warnline"><TriangleAlert /> Run this and change data?</span>
          <button class="btn danger" type="button" @click="run">Yes, run it</button>
          <button class="btn" type="button" @click="confirmRun = false">Cancel</button>
        </template>
      </div>
      <template v-if="result">
        <p v-if="result.affected !== undefined" class="small">{{ count(result.affected) }} row{{ result.affected === 1 ? "" : "s" }} changed.</p>
        <div v-if="result.columns.length" class="grid-wrap">
          <table class="grid">
            <thead>
              <tr><th v-for="c in result.columns" :key="c">{{ c }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in result.rows" :key="i"><td v-for="(v, j) in r" :key="j" :class="{ nul: v === null }" :title="v ?? 'NULL'">{{ v ?? "NULL" }}</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="result.columns.length" class="muted small">{{ count(result.rows.length) }} row{{ result.rows.length === 1 ? "" : "s" }}<span v-if="result.truncated"> (first 1,000 shown)</span>.</p>
      </template>
    </article>
  </section>
</template>

<style scoped>
.dbs { display: flex; flex-direction: column; gap: 14px; }
.dbs > .panel { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.note { margin: 0; border-left: 4px solid var(--gold); }
.between { justify-content: space-between; }
.small { font-size: 13px; margin: 0; }
.mono { font-family: var(--mono); }
code { font-family: var(--mono); }
.label { margin: 0; }
.db { border-top: 1px solid var(--line-soft); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.db.sel .dname { color: var(--gold); }
.dname { margin: 0; font-weight: 700; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ic { width: 16px; height: 16px; }
.conn { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: 13px; }
.conn dt { color: var(--ink2); }
.conn dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pw { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.prefix { color: var(--ink2); }
.w { width: auto; min-width: 140px; }
.warnline { color: var(--warn); display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
.danger-box { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--bad); border-left-width: 4px; color: var(--bad); padding: 8px 10px; }
.tables { display: flex; flex-wrap: wrap; gap: 6px; }
.tbl { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 10px; background: transparent; border: 1px solid var(--line); color: var(--ink); cursor: pointer; }
.tbl.on { border-color: var(--gold); }
.tbl:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.grid-wrap { overflow-x: auto; border: 1px solid var(--line-soft); max-height: 60vh; }
.grid { border-collapse: collapse; font: 12px var(--mono); font-variant-numeric: tabular-nums; min-width: 100%; }
.grid th, .grid td { padding: 4px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; white-space: nowrap; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
.grid th { position: sticky; top: 0; background: var(--deep); color: var(--ink2); }
.grid td.nul { color: var(--ink2); font-style: italic; }
.grid tr.editing td { background: var(--abyss); }
.grid tr.edit td, .grid tr.confirm td { white-space: normal; max-width: none; background: var(--abyss); }
.acts { display: flex; gap: 4px; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px 14px; margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.nullbox, .allow { display: inline-flex; gap: 6px; align-items: center; }
.sql { width: 100%; min-height: 90px; resize: vertical; }
.btn.small { padding: 3px 9px; font-size: 12px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
