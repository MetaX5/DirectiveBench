CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`benchmark_run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`variant` text NOT NULL,
	`repetition` integer NOT NULL,
	`fixture_version_id` text NOT NULL,
	`execution_status` text NOT NULL,
	`score` real,
	`passed` integer,
	`duration_ms` integer NOT NULL,
	`changed_files` text NOT NULL,
	`trace` text NOT NULL,
	`usage` text,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`benchmark_run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_benchmark_run_idx` ON `agent_runs` (`benchmark_run_id`);--> statement-breakpoint
CREATE TABLE `artifact_benchmark_assignments` (
	`artifact_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `suite_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suite_id`) REFERENCES `benchmark_suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifact_categories` (
	`artifact_id` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `category_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifact_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`latest_version_id` text NOT NULL,
	`commit_sha` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`latest_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_occurrences_repo_path_unique` ON `artifact_occurrences` (`repository_id`,`path`);--> statement-breakpoint
CREATE TABLE `artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`format` text NOT NULL,
	`primary_file` text NOT NULL,
	`files` text NOT NULL,
	`parsed_metadata` text NOT NULL,
	`source_repository_id` text,
	`source_path` text,
	`source_commit_sha` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_versions_artifact_hash_unique` ON `artifact_versions` (`artifact_id`,`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_versions_artifact_version_unique` ON `artifact_versions` (`artifact_id`,`version`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`notes` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_slug_unique` ON `artifacts` (`slug`);--> statement-breakpoint
CREATE TABLE `assertion_results` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`assertion_id` text NOT NULL,
	`type` text NOT NULL,
	`passed` integer NOT NULL,
	`score` real NOT NULL,
	`weight` real NOT NULL,
	`required` integer NOT NULL,
	`deterministic` integer NOT NULL,
	`message` text NOT NULL,
	`details` text,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assertion_results_agent_run_idx` ON `assertion_results` (`agent_run_id`);--> statement-breakpoint
CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`suite_version_id` text NOT NULL,
	`artifact_version_id` text NOT NULL,
	`agent_adapter_id` text NOT NULL,
	`agent_version` text,
	`model` text,
	`environment` text NOT NULL,
	`status` text NOT NULL,
	`verdict` text,
	`comparability_key` text,
	`summary` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`suite_version_id`) REFERENCES `benchmark_suite_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `benchmark_runs_artifact_version_idx` ON `benchmark_runs` (`artifact_version_id`);--> statement-breakpoint
CREATE INDEX `benchmark_runs_started_idx` ON `benchmark_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `benchmark_suite_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`definition` text NOT NULL,
	`fixtures` text NOT NULL,
	`source_path` text,
	`execution_approved_at` text,
	`execution_approval_source` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `benchmark_suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_suite_versions_suite_hash_unique` ON `benchmark_suite_versions` (`suite_id`,`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_suite_versions_suite_version_unique` ON `benchmark_suite_versions` (`suite_id`,`version`);--> statement-breakpoint
CREATE TABLE `benchmark_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_suites_slug_unique` ON `benchmark_suites` (`slug`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`predefined` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE TABLE `fixture_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_path` text,
	`file_count` integer NOT NULL,
	`total_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`runner_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`cancel_requested_at` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`heartbeat_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_created_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`location` text NOT NULL,
	`instance_url` text,
	`default_branch` text,
	`selected_branch` text,
	`last_commit_sha` text,
	`last_sync_at` text,
	`sync_status` text DEFAULT 'never' NOT NULL,
	`sync_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_provider_location_unique` ON `repositories` (`provider`,`location`);