CREATE TABLE `agent_run_files` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`path` text NOT NULL,
	`change` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`kept` text NOT NULL,
	`reason` text,
	`content` text,
	`stored_bytes` integer DEFAULT 0 NOT NULL,
	`redactions` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_files_agent_run_path_unique` ON `agent_run_files` (`agent_run_id`,`path`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `output_files_kept` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `output_files_reason` text;