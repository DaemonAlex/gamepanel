import { eq } from "drizzle-orm";
import { AgentClient } from "../agent/client.js";
import { open } from "../auth/crypto.js";
import { schema, type Db } from "../db/index.js";

export type NodeRow = typeof schema.nodes.$inferSelect;

// One agent client per node, built on first use.
export class Nodes {
  private clients = new Map<string, AgentClient>();

  constructor(
    private readonly db: Db,
    private readonly appSecret: string,
    // Tests swap in a fake.
    private readonly makeClient: (row: NodeRow, token: string) => AgentClient = (row, token) =>
      new AgentClient({ url: row.agentUrl, token, caPem: row.agentCaPem }),
  ) {}

  async all(): Promise<NodeRow[]> {
    return this.db.select().from(schema.nodes);
  }

  async get(id: string): Promise<NodeRow | undefined> {
    const [row] = await this.db.select().from(schema.nodes).where(eq(schema.nodes.id, id));
    return row;
  }

  client(row: NodeRow): AgentClient {
    let c = this.clients.get(row.id);
    if (!c) {
      c = this.makeClient(row, open(this.appSecret, row.agentTokenEnc));
      this.clients.set(row.id, c);
    }
    return c;
  }
}
