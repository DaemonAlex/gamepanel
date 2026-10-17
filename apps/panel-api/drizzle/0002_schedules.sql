CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"action" text NOT NULL,
	"payload" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"minutes" integer DEFAULT 60 NOT NULL,
	"time" text DEFAULT '04:00' NOT NULL,
	"days" jsonb NOT NULL,
	"tz" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "backup_keep" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_server" ON "schedules" USING btree ("server_id");