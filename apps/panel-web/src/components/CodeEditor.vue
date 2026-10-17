<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";

const props = defineProps<{ text: string; filename: string }>();
const emit = defineEmits<{ change: [text: string]; save: [] }>();
const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

// Highlighting by file extension; anything else is plain text.
function language(name: string): Extension[] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "json" || ext === "mcmeta") return [json()];
  if (ext === "yml" || ext === "yaml") return [yaml()];
  if (ext === "properties" || ext === "cfg" || ext === "conf" || ext === "ini") return [StreamLanguage.define(properties)];
  if (ext === "toml") return [StreamLanguage.define(toml)];
  if (ext === "sh") return [StreamLanguage.define(shell)];
  return [];
}

// Cartographer colours for the editor.
const theme = EditorView.theme(
  {
    "&": { backgroundColor: "#071416", color: "#d9efe6", height: "100%", fontSize: "13px" },
    ".cm-content": { fontFamily: '"Chivo Mono", ui-monospace, monospace', caretColor: "#f2c14e" },
    ".cm-gutters": { backgroundColor: "#0b1f22", color: "#5f9a8d", border: "none" },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff10" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#2f6b6688" },
    ".cm-cursor": { borderLeftColor: "#f2c14e" },
  },
  { dark: true },
);

function build(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      theme,
      ...language(props.filename),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (emit("save"), true) }]),
      EditorView.updateListener.of((u) => u.docChanged && emit("change", u.state.doc.toString())),
    ],
  });
}

onMounted(() => {
  view = new EditorView({ state: build(props.text), parent: host.value! });
});
onUnmounted(() => view?.destroy());

// A different file was opened: start fresh.
watch(
  () => props.filename,
  () => view?.setState(build(props.text)),
);
</script>

<template>
  <div ref="host" class="editor"></div>
</template>

<style scoped>
.editor { height: 520px; border: 1px solid var(--line); border-left: 3px solid var(--gold); overflow: hidden; }
@media (max-width: 560px) { .editor { height: 380px; } }
</style>
