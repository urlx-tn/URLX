REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO urlx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
	public."user",
	public.session,
	public.account,
	public.verification,
	public.forms,
	public.form_versions,
	public.form_responses
TO urlx_app;
GRANT SELECT, INSERT ON TABLE
	public.links,
	public.bio_pages,
	public.bio_links,
	public.form_aliases
TO urlx_app;
GRANT SELECT ON TABLE
	public.form_alias_tombstones,
	public.form_monthly_usage
TO urlx_app;
GRANT SELECT ON TABLE public.form_limits TO urlx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE urlx_migrator IN SCHEMA public
	GRANT SELECT ON TABLES TO urlx_app;
REVOKE ALL ON FUNCTION public.guard_form_response_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_form_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_form_alias(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_form_monthly_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_form_publish() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tombstone_form_aliases_before_delete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_form_response_insert() TO urlx_app;
GRANT EXECUTE ON FUNCTION public.lock_form_owner(text) TO urlx_app;
GRANT EXECUTE ON FUNCTION public.lock_form_alias(text) TO urlx_app;
GRANT EXECUTE ON FUNCTION public.increment_form_monthly_usage() TO urlx_app;
GRANT EXECUTE ON FUNCTION public.guard_form_publish() TO urlx_app;
GRANT EXECUTE ON FUNCTION public.tombstone_form_aliases_before_delete() TO urlx_app;
