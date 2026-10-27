\getenv app_password URLX_APP_PASSWORD
\getenv migrator_password URLX_MIGRATOR_PASSWORD

SELECT format(
	'CREATE ROLE urlx_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
	:'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urlx_app')
\gexec
SELECT format('ALTER ROLE urlx_app PASSWORD %L', :'app_password')
\gexec

SELECT format(
	'CREATE ROLE urlx_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
	:'migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urlx_migrator')
\gexec
SELECT format('ALTER ROLE urlx_migrator PASSWORD %L', :'migrator_password')
\gexec

SELECT format(
	'GRANT CONNECT ON DATABASE %I TO urlx_app, urlx_migrator',
	current_database()
)
\gexec
SELECT format(
	'GRANT CREATE ON DATABASE %I TO urlx_migrator',
	current_database()
)
\gexec
ALTER SCHEMA public OWNER TO urlx_migrator;
GRANT USAGE ON SCHEMA public TO urlx_app;

\unset app_password
\unset migrator_password
