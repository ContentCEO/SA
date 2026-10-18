CREATE TABLE "job_runs" (
	"function_id" text NOT NULL,
	"day" date NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "job_runs_function_id_day_pk" PRIMARY KEY("function_id","day")
);
