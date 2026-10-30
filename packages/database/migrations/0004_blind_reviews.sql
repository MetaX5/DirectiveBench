CREATE TABLE `blind_review_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`position` integer NOT NULL,
	`case_id` text NOT NULL,
	`a_agent_run_id` text NOT NULL,
	`b_agent_run_id` text NOT NULL,
	`verdict` text,
	`note` text,
	`decided_at` text,
	FOREIGN KEY (`review_id`) REFERENCES `blind_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`a_agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b_agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blind_review_pairs_sides_differ" CHECK("blind_review_pairs"."a_agent_run_id" <> "blind_review_pairs"."b_agent_run_id"),
	CONSTRAINT "blind_review_pairs_verdict_known" CHECK("blind_review_pairs"."verdict" is null or "blind_review_pairs"."verdict" in ('a', 'b', 'tie'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blind_review_pairs_review_position_unique` ON `blind_review_pairs` (`review_id`,`position`);--> statement-breakpoint
CREATE TABLE `blind_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`benchmark_run_id` text NOT NULL,
	`created_at` text NOT NULL,
	`revealed_at` text,
	FOREIGN KEY (`benchmark_run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blind_reviews_benchmark_run_unique` ON `blind_reviews` (`benchmark_run_id`);