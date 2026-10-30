import {
	assertDatabaseIdentity,
	type DatabaseRoleIdentity,
	type UrlxDbPool,
} from "@urlx/db";

const appRoleIdentityQuery = `
	SELECT current_user AS role,
		session_user AS "sessionRole",
		roles.rolsuper AS superuser,
		roles.rolcreaterole AS "createRole",
		roles.rolcreatedb AS "createDatabase",
		roles.rolreplication AS replication,
		roles.rolbypassrls AS "bypassRls",
		has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabase",
		has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreatePublicSchema"
	FROM pg_catalog.pg_roles AS roles
	WHERE roles.rolname = current_user
`;

export async function assertApiDatabaseRole(
	pool: Pick<UrlxDbPool, "query">,
): Promise<void> {
	try {
		const result = await pool.query<DatabaseRoleIdentity>(appRoleIdentityQuery);
		const identity = result.rows[0];
		if (!identity) throw new Error("Missing PostgreSQL role identity");
		assertDatabaseIdentity(identity, "urlx_app");
	} catch {
		// Do not attach the pg error: it can include SQL, values, or connection data.
		throw new Error(
			"API startup requires the restricted urlx_app database role",
		);
	}
}
