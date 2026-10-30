export type DatabaseRoleIdentity = {
	role: string;
	sessionRole: string;
	superuser: boolean;
	createRole: boolean;
	createDatabase: boolean;
	replication: boolean;
	bypassRls: boolean;
	canCreateDatabase: boolean;
	canCreatePublicSchema: boolean;
};

export type ApplicationDatabaseRole = "urlx_app" | "urlx_migrator";

export function assertDatabaseIdentity(
	identity: DatabaseRoleIdentity,
	expectedRole: ApplicationDatabaseRole,
): void {
	if (
		identity.role !== expectedRole ||
		identity.sessionRole !== expectedRole ||
		identity.superuser ||
		identity.createRole ||
		identity.createDatabase ||
		identity.replication ||
		identity.bypassRls ||
		(expectedRole === "urlx_app" &&
			(identity.canCreateDatabase || identity.canCreatePublicSchema))
	)
		throw new Error(
			`Database connection must use the restricted ${expectedRole} role`,
		);
}
