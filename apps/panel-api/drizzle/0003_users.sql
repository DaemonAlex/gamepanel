CREATE TABLE "invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"email" text NOT NULL,
	"role" "role" DEFAULT 'owner' NOT NULL,
	"user_id" text,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_access" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"perms" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "disk_gb" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_servers" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_memory_mb" integer DEFAULT 4096 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_disk_gb" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_access" ADD CONSTRAINT "server_access_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_access" ADD CONSTRAINT "server_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_access_pair" ON "server_access" USING btree ("server_id","user_id");--> statement-breakpoint
CREATE INDEX "server_access_user" ON "server_access" USING btree ("user_id");