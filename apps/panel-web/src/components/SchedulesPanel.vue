<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ScheduleAction, ScheduleInput, ScheduleView } from "@gamepanel/shared";
import { Archive, CalendarClock, MessageSquare, Pencil, Plus, RotateCw, Save, Terminal, Trash2 } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string }>();
const list = ref<ScheduleView[]>([]);
const error = ref("");
const editing = ref<string | "new" | null>(null);
const confirmDelete = ref<string | null>(null);
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ACTIONS: { value: ScheduleAction; label: string; icon: unknown }[] = [
  { value: "backup", label: "Back up", icon: Archive },
  { value: "restart", label: "Restart (warns players 1 minute before)", icon: RotateCw },
  { value: "save", label: "Save the world", icon: Save },
  { value: "message", label: "Send a chat message", icon: MessageSquare },
  { value: "command", label: "Run a console command", icon: Terminal },
];
const blank = (): ScheduleInput => ({ action: "backup", payload: "", kind: "daily", minutes: 60, time: "04:00", days: [0, 1, 2, 3, 4, 5, 6], tz: localTz, enabled: true });
const form = ref<ScheduleInput>(blank());

async function load() {
  try {
    list.value = await api.schedules(props.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

function startNew() {
  form.value = blank();
  editing.value = "new";
}
function startEdit(s: ScheduleView) {
  const { id: _i, serverId: _s, lastRunAt: _l, lastResult: _r, ...rest } = s;
  form.value = { ...rest, days: [...rest.days] };
  editing.value = s.id;
}
function toggleDay(d: number) {
  const days = form.value.days.includes(d) ? form.value.days.filter((x) => x !== d) : [...form.value.days, d].sort();
  if (days.length) form.value.days = days;
}

async function save() {
  error.value = "";
  try {
    if (editing.value === "new") await api.createSchedule(props.id, form.value);
    else if (editing.value) await api.updateSchedule(props.id, editing.value, form.value);
    editing.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function toggle(s: ScheduleView) {
  const { id, serverId: _s, lastRunAt: _l, lastResult: _r, ...rest } = s;
  await api.updateSchedule(props.id, id, { ...rest, enabled: !s.enabled }).catch((e: Error) => (error.value = e.message));
  await load();
}

async function remove(id: string) {
  await api.deleteSchedule(props.id, id).catch((e: Error) => (error.value = e.message));
  confirmDelete.value = null;
  await load();
}

const describe = (s: ScheduleInput) =>
  s.kind === "interval"
    ? `Every ${s.minutes >= 60 && s.minutes % 60 === 0 ? `${s.minutes / 60} hour${s.minutes === 60 ? "" : "s"}` : `${s.minutes} minutes`}`
    : `${s.days.length === 7 ? "Every day" : s.days.map((d) => DAYS[d]).join(", ")} at ${s.time} (${s.tz})`;
const actionOf = (a: ScheduleAction) => ACTIONS.find((x) => x.value === a)!;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
</script>

<template>
  <section class="schedules">
    <div class="row">
      <button class="btn gold" type="button" @click="startNew"><Plus /> Add a schedule</button>
      <span class="muted">Times are in your time zone: {{ localTz }}</span>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="panel sform" @submit.prevent="save">
      <p class="label"><CalendarClock />{{ editing === "new" ? "New schedule" : "Edit schedule" }}</p>
      <label for="s-action" class="label">What</label>
      <select id="s-action" v-model="form.action">
        <option v-for="a in ACTIONS" :key="a.value" :value="a.value">{{ a.label }}</option>
      </select>
      <template v-if="form.action === 'message' || form.action === 'command'">
        <label for="s-payload" class="label">{{ form.action === "message" ? "Message" : "Command" }}</label>
        <input id="s-payload" v-model="form.payload" maxlength="200" :placeholder="form.action === 'message' ? 'Vote for the next build!' : 'time set day'" required />
      </template>
      <fieldset class="when">
        <legend class="label">When</legend>
        <label class="radio"><input v-model="form.kind" type="radio" value="daily" /> At a time</label>
        <label class="radio"><input v-model="form.kind" type="radio" value="interval" /> Every so often</label>
      </fieldset>
      <template v-if="form.kind === 'daily'">
        <div class="row">
          <label for="s-time" class="label">Time</label>
          <input id="s-time" v-model="form.time" type="time" required class="time" />
        </div>
        <div class="days" role="group" aria-label="Days">
          <button v-for="(d, i) in DAYS" :key="d" type="button" :class="{ on: form.days.includes(i) }" :aria-pressed="form.days.includes(i)" @click="toggleDay(i)">{{ d }}</button>
        </div>
      </template>
      <div v-else class="row">
        <label for="s-min" class="label">Every</label>
        <select id="s-min" v-model.number="form.minutes">
          <option :value="15">15 minutes</option>
          <option :value="30">30 minutes</option>
          <option :value="60">hour</option>
          <option :value="120">2 hours</option>
          <option :value="180">3 hours</option>
          <option :value="360">6 hours</option>
          <option :value="720">12 hours</option>
        </select>
      </div>
      <div class="row">
        <button class="btn gold" type="submit"><Save /> Save schedule</button>
        <button class="btn" type="button" @click="editing = null">Cancel</button>
      </div>
    </form>

    <article v-for="s in list" :key="s.id" class="panel srow" :class="{ off: !s.enabled }">
      <component :is="actionOf(s.action).icon" class="ic-gold" />
      <div class="grow">
        <p class="stitle">{{ actionOf(s.action).label }}<span v-if="s.payload" class="mono muted">: {{ s.payload }}</span></p>
        <p class="muted small">{{ describe(s) }} &middot; last run {{ when(s.lastRunAt) }}<span v-if="s.lastResult"> &middot; {{ s.lastResult }}</span></p>
      </div>
      <button type="button" role="switch" class="switch" :aria-checked="s.enabled" @click="toggle(s)">{{ s.enabled ? "On" : "Off" }}</button>
      <button class="btn small" type="button" :aria-label="`Edit schedule`" @click="startEdit(s)"><Pencil /></button>
      <template v-if="confirmDelete !== s.id">
        <button class="btn small danger" type="button" aria-label="Delete schedule" @click="confirmDelete = s.id"><Trash2 /></button>
      </template>
      <template v-else>
        <button class="btn small danger" type="button" @click="remove(s.id)">Yes, delete</button>
        <button class="btn small" type="button" @click="confirmDelete = null">No</button>
      </template>
    </article>
    <p v-if="!list.length && !editing" class="panel muted">No schedules yet. A nightly backup at 04:00 is a good first one.</p>
  </section>
</template>

<style scoped>
.schedules { display: flex; flex-direction: column; gap: 12px; }
.sform { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
.when { border: 0; padding: 0; margin: 0; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.radio { display: inline-flex; gap: 6px; align-items: center; }
.radio input { width: auto; accent-color: var(--gold); }
.time { width: 140px; }
.days { display: flex; gap: 4px; flex-wrap: wrap; }
.days button { font: 600 12px var(--mono); padding: 6px 10px; border: 1px solid var(--line); background: var(--abyss); color: var(--ink2); cursor: pointer; }
.days button.on { background: var(--gold); color: var(--sea); border-color: var(--gold); }
.days button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.srow { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.srow.off { opacity: 0.6; }
.grow { flex: 1; min-width: 200px; }
.stitle { margin: 0; font-weight: 700; }
.small { font-size: 13px; margin: 2px 0 0; }
.switch { font: 700 12px var(--font); border: 1px solid var(--line); background: var(--abyss); color: var(--ink2); padding: 5px 10px; cursor: pointer; }
.switch[aria-checked="true"] { background: var(--ok); color: var(--sea); border-color: var(--ok); }
.btn.small { padding: 3px 9px; font-size: 12px; }
</style>
