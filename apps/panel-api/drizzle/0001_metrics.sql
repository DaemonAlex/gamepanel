CREATE TABLE "node_samples" (
	"node_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"mem_total_bytes" bigint NOT NULL,
	"mem_allocated_bytes" bigint NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"disk_free_bytes" bigint NOT NULL,
	"running" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_samples" (
	"server_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu" real NOT NULL,
	"mem_bytes" bigint NOT NULL,
	"mem_limit_bytes" bigint NOT NULL,
	"players" integer,
	"tps" real,
	"mspt" real,
	"disk_bytes" bigint NOT NULL,
	"restarts" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "node_samples_node_at" ON "node_samples" USING btree ("node_id","at");--> statement-breakpoint
CREATE INDEX "server_samples_server_at" ON "server_samples" USING btree ("server_id","at");