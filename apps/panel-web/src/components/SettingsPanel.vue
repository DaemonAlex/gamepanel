<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { managedProperties, propertyFields, propertyGroups } from "@gamepanel/shared";
import { api } from "../api.js";

const props = defineProps<{ id: string; running: boolean }>();
const emit = defineEmits<{ restarted: [] }>();
const saved = ref<Record<string, string>>({});
const draft = ref<Record<string, string>>({});
const error = ref("");
const notice = ref("");
const needRestart = ref(false);
const busy = ref(false);

async function load() {
  try {
    saved.value = (await api.properties(props.id)).values;
    draft.value = { ...saved.value };
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

const changed = computed(() => propertyFields.filter((f) => (draft.value[f.key] ?? "") !== (saved.value[f.key] ?? "")).map((f) => f.key));
const fieldsIn = (g: string) => propertyFields.filter((f) => f.group === g);
const others = computed(() =>
  Object.entries(saved.value).filter(([k]) => !propertyFields.some((f) => f.key === k)).sort(([a], [b]) => a.localeCompare(b)),
);
const isManaged = (k: string) => (managedProperties as readonly string[]).includes(k);

async function save() {
  busy.value = true;
  error.value = "";
  try {
    const changes = Object.fromEntries(changed.value.map((k) => [k, draft.value[k] ?? ""]));
    const r = await api.setProperties(props.id, changes);
    notice.value = `Saved ${r.changed.length} setting${r.changed.length === 1 ? "" : "s"}. The old file is kept in backups.`;
    needRestart.value = true;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function restart() {
  busy.value = true;
  try {
    await api.power(props.id, "restart");
    needRestart.value = false;
    notice.value = "Restarting. New settings apply as it comes back up.";
    emit("restarted");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// MOTD preview: Minecraft colour codes as colours.
const COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000aa", "2": "#00aa00", "3": "#00aaaa", "4": "#aa0000", "5": "#aa00aa", "6": "#ffaa00", "7": "#aaaaaa",
  "8": "#555555", "9": "#5555ff", a: "#55ff55", b: "#55ffff", c: "#ff5555", d: "#ff55ff", e: "#ffff55", f: "#ffffff",
};
const motdParts = computed(() => {
  const parts: { text: string; color: string; bold: boolean; italic: boolean }[] = [];
  let color = "#aaaaaa";
  let bold = false;
  let italic = false;
  const segs = (draft.value["motd"] ?? "").split("§");
  segs.forEach((seg, i) => {
    let text = seg;
    if (i > 0 && seg.length) {
      const code = seg[0]!.toLowerCase();
      text = seg.slice(1);
      if (COLORS[code]) (color = COLORS[code]!), (bold = false), (italic = false);
      else if (code === "l") bold = true;
      else if (code === "o") italic = true;
      else if (code === "r") (color = "#aaaaaa"), (bold = false), (italic = false);
    }
    if (text) parts.push({ text, color, bold, italic });
  });
  return parts;
});
</script>

<template>
  <section class="settings">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="notice" class="panel notice row" role="status">
      <span class="grow">{{ notice }}</span>
      <button v-if="needRestart && running" class="btn gold" type="button" :disabled="busy" @click="restart">Restart now</button>
      <span v-else-if="needRestart" class="muted">Applies next time it starts.</span>
    </div>

    <form class="groups" @submit.prevent="save">
      <fieldset v-for="g in propertyGroups" :key="g" class="panel group">
        <legend class="label">{{ g }}</legend>
        <div v-if="g === 'General'" class="motd-preview" aria-label="How the MOTD looks in the server list">
          <span v-for="(p, i) in motdParts" :key="i" :style="{ color: p.color, fontWeight: p.bold ? 700 : 400, fontStyle: p.italic ? 'italic' : 'normal' }">{{ p.text }}</span>
          <span v-if="!motdParts.length" class="muted">A Minecraft Server</span>
        </div>
        <div v-for="f in fieldsIn(g)" :key="f.key" class="field" :class="{ changed: changed.includes(f.key) }">
          <label :for="`p-${f.key}`">{{ f.label }}</label>
          <template v-if="f.type === 'bool'">
            <button
              :id="`p-${f.key}`"
              type="button"
              role="switch"
              class="switch"
              :aria-checked="draft[f.key] === 'true'"
              @click="draft[f.key] = draft[f.key] === 'true' ? 'false' : 'true'"
            >
              <span>{{ draft[f.key] === "true" ? "On" : "Off" }}</span>
            </button>
          </template>
          <select v-else-if="f.type === 'enum'" :id="`p-${f.key}`" v-model="draft[f.key]">
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input v-else-if="f.type === 'number'" :id="`p-${f.key}`" v-model="draft[f.key]" type="number" :min="f.min" :max="f.max" step="1" />
          <input v-else :id="`p-${f.key}`" v-model="draft[f.key]" :maxlength="f.max" />
          <p v-if="f.help" class="help muted">{{ f.help }}</p>
        </div>
      </fieldset>

      <div class="savebar row">
        <span class="muted">{{ changed.length ? `${changed.length} unsaved change${changed.length === 1 ? "" : "s"}` : "No changes" }}</span>
        <button class="btn" type="button" :disabled="!changed.length || busy" @click="draft = { ...saved }">Undo changes</button>
        <button class="btn gold" type="submit" :disabled="!changed.length || busy">{{ busy ? "Saving" : "Save settings" }}</button>
      </div>
    </form>

    <details class="panel">
      <summary class="label">Everything else in server.properties ({{ others.length }})</summary>
      <dl class="others">
        <div v-for="[k, v] in others" :key="k">
          <dt class="mono">{{ k }}<span v-if="isManaged(k)" class="tag">set by the panel</span></dt>
          <dd class="mono">{{ k === "rcon.password" ? "hidden" : v || "(empty)" }}</dd>
        </div>
      </dl>
      <p class="muted small">Locked ones keep the port, the console and live stats working. The rest can be edited in Files.</p>
    </details>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 14px; }
.notice { margin: 0; border-left: 4px solid var(--gold); }
.grow { flex: 1; min-width: 0; }
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; align-items: start; }
.group { margin: 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.group legend { padding: 0 6px; }
.motd-preview { background: #1b1b1b; border: 1px solid #000; padding: 10px; font: 15px var(--mono); min-height: 1.5em; overflow-wrap: anywhere; }
.field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 160px); gap: 4px 12px; align-items: center; padding-left: 8px; border-left: 3px solid transparent; }
.field.changed { border-left-color: var(--gold); }
.field label { font-size: 15px; }
.field input, .field select { padding: 6px 8px; }
.help { grid-column: 1 / -1; font-size: 13px; margin: 0; }
.switch { font: 700 13px var(--font); border: 1px solid var(--line); background: var(--abyss); color: var(--ink2); padding: 6px 10px; cursor: pointer; text-align: center; }
.switch[aria-checked="true"] { background: var(--ok); color: var(--sea); border-color: var(--ok); }
.switch:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.savebar { grid-column: 1 / -1; justify-content: flex-end; position: sticky; bottom: 0; background: var(--deep); border: 1px solid var(--line); padding: 10px 12px; }
.others { margin: 10px 0 0; display: flex; flex-direction: column; }
.others div { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-top: 1px solid var(--line-soft); font-size: 13px; }
.others dd { margin: 0; text-align: right; overflow-wrap: anywhere; min-width: 0; color: var(--ink2); }
.tag { font: 600 10px var(--mono); color: var(--gold); border: 1px solid var(--gold); padding: 0 5px; margin-left: 8px; }
.small { font-size: 13px; }
@media (max-width: 480px) { .field { grid-template-columns: 1fr; } }
</style>
