-- Transfer Drizzle's migration bookkeeping to the non-login migrator
-- capability. A one-shot privileged bootstrap identity applies this migration;
-- subsequent deployer logins must explicitly SET ROLE unlisted_migrator.

ALTER SCHEMA drizzle OWNER TO unlisted_migrator;
--> statement-breakpoint
ALTER TABLE drizzle.__drizzle_migrations OWNER TO unlisted_migrator;
--> statement-breakpoint
DO $$
DECLARE
  migration_sequence regclass;
BEGIN
  migration_sequence :=
    pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id')::regclass;
  IF migration_sequence IS NULL THEN
    RAISE EXCEPTION 'Drizzle migration sequence is missing';
  END IF;
  EXECUTE format('ALTER SEQUENCE %s OWNER TO unlisted_migrator', migration_sequence);
END
$$;
--> statement-breakpoint

REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM PUBLIC, unlisted_app, unlisted_admin;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE drizzle.__drizzle_migrations
  FROM PUBLIC, unlisted_app, unlisted_admin;
--> statement-breakpoint
DO $$
DECLARE
  migration_sequence regclass;
BEGIN
  migration_sequence :=
    pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id')::regclass;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC, unlisted_app, unlisted_admin',
    migration_sequence
  );
END
$$;
--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA drizzle TO unlisted_migrator;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format(
    'GRANT CREATE ON DATABASE %I TO unlisted_migrator',
    current_database()
  );
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE drizzle.__drizzle_migrations TO unlisted_migrator;
--> statement-breakpoint
DO $$
DECLARE
  migration_sequence regclass;
BEGIN
  migration_sequence :=
    pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id')::regclass;
  EXECUTE format(
    'GRANT USAGE, SELECT, UPDATE ON SEQUENCE %s TO unlisted_migrator',
    migration_sequence
  );
END
$$;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE unlisted_migrator IN SCHEMA drizzle
  REVOKE ALL ON TABLES FROM PUBLIC, unlisted_app, unlisted_admin;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE unlisted_migrator IN SCHEMA drizzle
  REVOKE ALL ON SEQUENCES FROM PUBLIC, unlisted_app, unlisted_admin;
