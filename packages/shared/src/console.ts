import { z } from "zod";

// Messages on the console WebSocket, in both directions.

// Agent to client: one line of server output, or a notice about the stream.
export type ConsoleOut =
  | { t: "line"; line: string }
  | { t: "notice"; text: string };

// Client to agent: one command typed into the console.
export const consoleInSchema = z.object({
  t: z.literal("cmd"),
  // A single line. Newlines would let one message smuggle in several commands.
  cmd: z.string().min(1).max(1000).regex(/^[^\r\n]+$/),
});
export type ConsoleIn = z.infer<typeof consoleInSchema>;
